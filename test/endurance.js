'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {spawn} = require('child_process');
const {performance} = require('perf_hooks');
const mtdb = require('..');

const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  RECORD_TYPES
} = require('../lib/constants.js');

const durationSeconds = Number(process.argv[2] || 600);
const objectCount = Number(process.argv[3] || 100000);

const SHARD_COUNT = 256;
const CRASH_MIN_MS = 35000;
const CRASH_MAX_MS = 50000;
const MIN_SEGMENT_MS = 5000;

const tempDir = path.join(__dirname, '.tmp-endurance');
const databasePath = path.join(tempDir, 'endurance.mtdb');
const workerPath = path.join(__dirname, 'endurance-worker.js');

const HISTOGRAM_LIMITS = [
  0.01,
  0.02,
  0.05,
  0.1,
  0.2,
  0.5,
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  250,
  500,
  1000,
  2000,
  5000,
  Infinity
];

if (!Number.isFinite(durationSeconds) || durationSeconds < 30) {
  throw new Error('Длительность теста должна быть не меньше 30 секунд');
}

if (!Number.isSafeInteger(objectCount) || objectCount <= 0) {
  throw new Error('Количество объектов должно быть положительным целым числом');
}

function createAggregateMetric() {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0,
    histogram: new Array(HISTOGRAM_LIMITS.length).fill(0)
  };
}

const metrics = {
  read: createAggregateMetric(),
  write: createAggregateMetric(),
  delete: createAggregateMetric()
};

const workerOpenTimes = [];

let maxRss = 0;
let maxHeapUsed = 0;
let maxExternal = 0;
let reportedOperations = 0;
let crashCount = 0;

function getObjectPath(id) {
  const shard = (id % SHARD_COUNT).toString(16).padStart(2, '0');
  return `objects/${shard}/${id}.json`;
}

function createSeedValue(id) {
  return {
    id,
    version: 0,
    runId: 0,
    payload: 'S'.repeat(128)
  };
}

function mergeMetric(target, source) {
  if (!source || source.count === 0) return;

  target.count += source.count;
  target.sum += source.sum;
  target.min = Math.min(target.min, source.min);
  target.max = Math.max(target.max, source.max);

  for (let i = 0; i < target.histogram.length; i += 1) {
    target.histogram[i] += source.histogram[i];
  }
}

function mergeWorkerStats(stats) {
  reportedOperations += stats.operations;

  maxRss = Math.max(
    maxRss,
    stats.rss || 0
  );

  maxHeapUsed = Math.max(
    maxHeapUsed,
    stats.heapUsed || 0
  );

  maxExternal = Math.max(
    maxExternal,
    stats.external || 0
  );

  mergeMetric(
    metrics.read,
    stats.metrics.read
  );

  mergeMetric(
    metrics.write,
    stats.metrics.write
  );

  mergeMetric(
    metrics.delete,
    stats.metrics.delete
  );
}

function percentileFromHistogram(metric, percentile) {
  if (metric.count === 0) return null;

  const target = Math.ceil(metric.count * percentile);
  let seen = 0;

  for (let i = 0; i < metric.histogram.length; i += 1) {
    seen += metric.histogram[i];

    if (seen >= target) {
      return HISTOGRAM_LIMITS[i];
    }
  }

  return Infinity;
}

function exactStats(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

  const sum = sorted.reduce(
    (total, value) => total + value,
    0
  );

  return {
    min: sorted[0],
    median,
    avg: sum / sorted.length,
    max: sorted[sorted.length - 1]
  };
}

function formatBytes(value) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} МБ`;

  return `${(value / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function formatMs(value) {
  if (value === null || value === undefined) return '-';
  if (value === Infinity) return '>5000 мс';
  if (value < 1) return `${value.toFixed(3)} мс`;

  return `${value.toFixed(2)} мс`;
}

function randomCrashDuration(remainingMs) {
  const random =
    CRASH_MIN_MS +
    Math.random() *
    (CRASH_MAX_MS - CRASH_MIN_MS);

  return Math.min(
    Math.floor(random),
    remainingMs
  );
}

function seedDatabase() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  const startedAt = performance.now();
  const db = mtdb.open(databasePath);

  db.mkdir('objects');

  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    db.mkdir(
      `objects/${shard.toString(16).padStart(2, '0')}`
    );
  }

  for (let id = 0; id < objectCount; id += 1) {
    db.write(
      getObjectPath(id),
      createSeedValue(id)
    );

    if ((id + 1) % 10000 === 0 || id + 1 === objectCount) {
      console.log(
        `Лог: Подготовлено ${id + 1}/${objectCount} JSON`
      );
    }
  }

  db.close();

  return performance.now() - startedAt;
}

function runCrashSegment(durationMs, runId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        workerPath,
        databasePath,
        String(objectCount),
        String(runId)
      ],
      {
        cwd: __dirname,
        windowsHide: true,
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let workerError = null;
    let killedByParent = false;

    function handleLine(line) {
      if (!line) return;

      if (line.startsWith('READY ')) {
        const data = JSON.parse(
          line.slice(6)
        );

        workerOpenTimes.push(
          data.openMs
        );

        return;
      }

      if (line.startsWith('STAT ')) {
        mergeWorkerStats(
          JSON.parse(line.slice(5))
        );

        return;
      }

      if (line.startsWith('ERROR ')) {
        workerError = JSON.parse(
          line.slice(6)
        );
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf('\n');

        if (newlineIndex === -1) break;

        const line = stdoutBuffer
          .slice(0, newlineIndex)
          .trim();

        stdoutBuffer = stdoutBuffer.slice(
          newlineIndex + 1
        );

        handleLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      killedByParent = true;
      crashCount += 1;

      child.kill('SIGKILL');
    }, durationMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (stdoutBuffer.trim()) {
        handleLine(
          stdoutBuffer.trim()
        );
      }

      if (workerError) {
        reject(
          new Error(
            `Worker ${runId}: ${workerError.code || 'ERROR'} ${workerError.message}\n${workerError.stack || ''}`
          )
        );

        return;
      }

      if (!killedByParent) {
        reject(
          new Error(
            `Worker ${runId} завершился сам: code=${code}, signal=${signal}\n${stderrBuffer}`
          )
        );

        return;
      }

      resolve();
    });
  });
}

function verifyDatabase() {
  const openStartedAt = performance.now();
  const db = mtdb.open(databasePath);
  const recoveryOpenMs = performance.now() - openStartedAt;

  let live = 0;
  let deleted = 0;

  const verifyStartedAt = performance.now();

  for (let id = 0; id < objectCount; id += 1) {
    const filePath = getObjectPath(id);
    const value = db.read(filePath);

    if (value === undefined) {
      deleted += 1;
      continue;
    }

    assert.strictEqual(
      value.id,
      id,
      `Некорректный id у ${filePath}`
    );

    assert.ok(
      Number.isSafeInteger(value.version),
      `Некорректная version у ${filePath}`
    );

    assert.ok(
      Number.isSafeInteger(value.runId),
      `Некорректный runId у ${filePath}`
    );

    live += 1;
  }

  const verifyMs =
    performance.now() -
    verifyStartedAt;

  db.close();

  return {
    recoveryOpenMs,
    verifyMs,
    live,
    deleted
  };
}

function analyzeIndex() {
  const fd = fs.openSync(
    databasePath,
    'r'
  );

  try {
    const fileSize = fs.fstatSync(fd).size;

    const indexBuffer = Buffer.alloc(
      BUCKET_COUNT * BUCKET_SIZE
    );

    readExactly(
      fd,
      indexBuffer,
      INDEX_OFFSET
    );

    const chainLengths = [];

    let totalLinks = 0;

    for (
      let bucketIndex = 0;
      bucketIndex < BUCKET_COUNT;
      bucketIndex += 1
    ) {
      const bucketOffset =
        bucketIndex *
        BUCKET_SIZE;

      const firstOffsetBigInt =
        indexBuffer.readBigUInt64LE(
          bucketOffset
        );

      if (firstOffsetBigInt === 0n) {
        continue;
      }

      assert.ok(
        firstOffsetBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
        `Bucket ${bucketIndex} содержит слишком большой offset`
      );

      let offset =
        Number(firstOffsetBigInt);

      let depth = 0;

      while (offset !== 0) {
        assert.ok(
          offset >= DATA_OFFSET &&
          offset + RECORD_HEADER_SIZE <= fileSize,
          `Bucket ${bucketIndex} указывает за границы базы`
        );

        const header = Buffer.alloc(
          RECORD_HEADER_SIZE
        );

        readExactly(
          fd,
          header,
          offset
        );

        assert.strictEqual(
          header.toString('ascii', 0, 4),
          'MTR1',
          `Некорректный record magic в bucket ${bucketIndex}`
        );

        const type =
          header.readUInt8(4);

        assert.notStrictEqual(
          type,
          RECORD_TYPES.COMMIT,
          `Bucket ${bucketIndex} указывает на COMMIT`
        );

        const previousOffsetBigInt =
          header.readBigUInt64LE(16);

        assert.ok(
          previousOffsetBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
          `Bucket ${bucketIndex} содержит слишком большой previousOffset`
        );

        const previousOffset =
          Number(previousOffsetBigInt);

        if (previousOffset !== 0) {
          assert.ok(
            previousOffset < offset,
            `Некорректная цепочка bucket ${bucketIndex}`
          );
        }

        depth += 1;
        totalLinks += 1;

        assert.ok(
          depth <= 5000000,
          `Слишком длинная цепочка bucket ${bucketIndex}`
        );

        offset = previousOffset;
      }

      chainLengths.push(depth);
    }

    chainLengths.sort(
      (a, b) => a - b
    );

    return {
      nonEmptyBuckets: chainLengths.length,
      totalLinks,
      avg:
        chainLengths.length === 0
          ? 0
          : totalLinks / chainLengths.length,
      median: getSortedPercentile(
        chainLengths,
        0.50
      ),
      p95: getSortedPercentile(
        chainLengths,
        0.95
      ),
      p99: getSortedPercentile(
        chainLengths,
        0.99
      ),
      max:
        chainLengths.length === 0
          ? 0
          : chainLengths[chainLengths.length - 1]
    };
  }

  finally {
    fs.closeSync(fd);
  }
}

function readExactly(fd, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );

    if (bytesRead === 0) {
      throw new Error(
        `Неожиданный EOF на позиции ${position + offset}`
      );
    }

    offset += bytesRead;
  }
}

function getSortedPercentile(sorted, percentile) {
  if (sorted.length === 0) return 0;

  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * percentile) - 1
  );

  return sorted[index];
}

function printMetric(name, metric) {
  if (metric.count === 0) {
    console.log(
      `${name}: нет данных`
    );

    return;
  }

  console.log(`${name}:`);
  console.log(`  операций: ${metric.count}`);
  console.log(`  min: ${formatMs(metric.min)}`);
  console.log(`  median: <= ${formatMs(percentileFromHistogram(metric, 0.50))}`);
  console.log(`  avg: ${formatMs(metric.sum / metric.count)}`);
  console.log(`  p95: <= ${formatMs(percentileFromHistogram(metric, 0.95))}`);
  console.log(`  p99: <= ${formatMs(percentileFromHistogram(metric, 0.99))}`);
  console.log(`  max: ${formatMs(metric.max)}`);
}

async function main() {
  const totalStartedAt =
    performance.now();

  const deadline =
    totalStartedAt +
    durationSeconds * 1000;

  console.log(
    `Лог: MTDB endurance test: ${durationSeconds} сек`
  );

  console.log(
    `Лог: Рабочий набор: ${objectCount} JSON`
  );

  console.log(
    'Лог: Mix: 60% read / 30% write / 10% delete'
  );

  console.log(
    `Лог: Crash interval: ${CRASH_MIN_MS / 1000}-${CRASH_MAX_MS / 1000} сек`
  );

  console.log('');

  const seedMs = seedDatabase();

  const seededSize =
    fs.statSync(databasePath).size;

  console.log(
    `Лог: Подготовка завершена за ${(seedMs / 1000).toFixed(2)} с`
  );

  console.log(
    `Лог: Размер после подготовки: ${formatBytes(seededSize)}`
  );

  console.log('');

  let runId = 0;

  while (true) {
    const remainingMs =
      deadline -
      performance.now();

    if (remainingMs < MIN_SEGMENT_MS) {
      break;
    }

    runId += 1;

    const segmentMs =
      randomCrashDuration(
        remainingMs
      );

    console.log(
      `Лог: Worker ${runId}, принудительный crash через ${(segmentMs / 1000).toFixed(1)} с`
    );

    await runCrashSegment(
      segmentMs,
      runId
    );
  }

  console.log('');
  console.log(
    'Лог: Нагрузка завершена, запускается финальный recovery и полная проверка'
  );

  const verification =
    verifyDatabase();

  const indexStats =
    analyzeIndex();

  const finalSize =
    fs.statSync(databasePath).size;

  const totalMs =
    performance.now() -
    totalStartedAt;

  const openStats =
    exactStats(workerOpenTimes);

  console.log('');
  console.log(
    '===== MTDB ENDURANCE RESULT ====='
  );

  console.log(
    `Фактическое время: ${(totalMs / 1000).toFixed(2)} с`
  );

  console.log(
    `Принудительных crash: ${crashCount}`
  );

  console.log(
    `Зафиксировано mixed-операций: ${reportedOperations}`
  );

  console.log(
    `Размер после seed: ${formatBytes(seededSize)}`
  );

  console.log(
    `Финальный размер: ${formatBytes(finalSize)}`
  );

  console.log(
    `Максимальный RSS worker: ${formatBytes(maxRss)}`
  );

  console.log(
    `Максимальный heapUsed worker: ${formatBytes(maxHeapUsed)}`
  );

  console.log(
    `Максимальный external worker: ${formatBytes(maxExternal)}`
  );

  console.log('');

  printMetric(
    'READ latency',
    metrics.read
  );

  printMetric(
    'WRITE latency',
    metrics.write
  );

  printMetric(
    'DELETE latency',
    metrics.delete
  );

  console.log('');

  if (openStats) {
    console.log(
      'Worker open/recovery:'
    );

    console.log(
      `  min: ${formatMs(openStats.min)}`
    );

    console.log(
      `  median: ${formatMs(openStats.median)}`
    );

    console.log(
      `  avg: ${formatMs(openStats.avg)}`
    );

    console.log(
      `  max: ${formatMs(openStats.max)}`
    );
  }

  console.log(
    `Финальный recovery open: ${formatMs(verification.recoveryOpenMs)}`
  );

  console.log(
    `Полная проверка ${objectCount} путей: ${formatMs(verification.verifyMs)}`
  );

  console.log(
    `Живых JSON: ${verification.live}`
  );

  console.log(
    `Удалённых JSON: ${verification.deleted}`
  );

  console.log('');
  console.log(
    'Hash-index chains:'
  );

  console.log(
    `  non-empty buckets: ${indexStats.nonEmptyBuckets}/${BUCKET_COUNT}`
  );

  console.log(
    `  links: ${indexStats.totalLinks}`
  );

  console.log(
    `  avg: ${indexStats.avg.toFixed(2)}`
  );

  console.log(
    `  median: ${indexStats.median}`
  );

  console.log(
    `  p95: ${indexStats.p95}`
  );

  console.log(
    `  p99: ${indexStats.p99}`
  );

  console.log(
    `  max: ${indexStats.max}`
  );

  console.log('');

  console.log(
    `Лог: База сохранена: ${databasePath}`
  );

  console.log(
    'MTDB endurance test: OK'
  );
}

main().catch((error) => {
  console.error(
    `Ошибка: ${error.stack || error.message}`
  );

  process.exitCode = 1;
});