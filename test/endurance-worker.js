'use strict';

const fs = require('fs');
const {performance} = require('perf_hooks');
const mtdb = require('..');

const [databasePath, objectCountRaw, runIdRaw] = process.argv.slice(2);
const objectCount = Number(objectCountRaw);
const runId = Number(runIdRaw);

const SHARD_COUNT = 256;
const CHECKPOINT_EVERY = 5000;
const PAYLOAD = 'X'.repeat(128);

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

if (!databasePath || !Number.isSafeInteger(objectCount) || objectCount <= 0 || !Number.isSafeInteger(runId) || runId <= 0) {
  console.error('Ошибка: Некорректные аргументы endurance-worker');
  process.exit(2);
}

function createMetric() {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0,
    histogram: new Array(HISTOGRAM_LIMITS.length).fill(0)
  };
}

function recordMetric(metric, duration) {
  metric.count += 1;
  metric.sum += duration;
  metric.min = Math.min(metric.min, duration);
  metric.max = Math.max(metric.max, duration);

  for (let i = 0; i < HISTOGRAM_LIMITS.length; i += 1) {
    if (duration <= HISTOGRAM_LIMITS[i]) {
      metric.histogram[i] += 1;
      break;
    }
  }
}

function serializeMetric(metric) {
  return {
    count: metric.count,
    sum: metric.sum,
    min: metric.count === 0 ? null : metric.min,
    max: metric.count === 0 ? null : metric.max,
    histogram: metric.histogram
  };
}

function getObjectPath(id) {
  const shard = (id % SHARD_COUNT).toString(16).padStart(2, '0');
  return `objects/${shard}/${id}.json`;
}

function writeLine(prefix, value) {
  const line = `${prefix}${JSON.stringify(value)}\n`;
  const buffer = Buffer.from(line, 'utf8');

  fs.writeSync(
    1,
    buffer,
    0,
    buffer.length,
    null
  );
}

const openStartedAt = performance.now();
const db = mtdb.open(databasePath);
const openDuration = performance.now() - openStartedAt;

writeLine('READY ', {
  runId,
  openMs: openDuration
});

let batchOperations = 0;
let totalOperations = 0;
let writeVersion = 0;

let metrics = {
  read: createMetric(),
  write: createMetric(),
  delete: createMetric()
};

function flushStats() {
  if (batchOperations === 0) return;

  const memory = process.memoryUsage();

  writeLine('STAT ', {
    runId,
    operations: batchOperations,
    totalOperations,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    metrics: {
      read: serializeMetric(metrics.read),
      write: serializeMetric(metrics.write),
      delete: serializeMetric(metrics.delete)
    }
  });

  batchOperations = 0;

  metrics = {
    read: createMetric(),
    write: createMetric(),
    delete: createMetric()
  };
}

try {
  while (true) {
    const id = Math.floor(Math.random() * objectCount);
    const filePath = getObjectPath(id);
    const operation = Math.random();

    if (operation < 0.60) {
      const startedAt = performance.now();
      const value = db.read(filePath);

      recordMetric(
        metrics.read,
        performance.now() - startedAt
      );

      if (value !== undefined) {
        if (value.id !== id || !Number.isSafeInteger(value.version)) {
          throw new Error(`Некорректные данные ${filePath}`);
        }
      }
    }

    else if (operation < 0.90) {
      writeVersion += 1;

      const startedAt = performance.now();

      db.write(filePath, {
        id,
        version: runId * 1000000000 + writeVersion,
        runId,
        payload: PAYLOAD
      });

      recordMetric(
        metrics.write,
        performance.now() - startedAt
      );
    }

    else {
      const startedAt = performance.now();

      db.delete(filePath);

      recordMetric(
        metrics.delete,
        performance.now() - startedAt
      );
    }

    batchOperations += 1;
    totalOperations += 1;

    if (batchOperations >= CHECKPOINT_EVERY) {
      flushStats();
    }
  }
}

catch (error) {
  writeLine('ERROR ', {
    runId,
    message: error.message,
    code: error.code || null,
    stack: error.stack || null
  });

  process.exit(1);
}