'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {performance} = require('perf_hooks');
const mtdb = require('..');

const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  HEADER_STATE_OFFSET,
  HEADER_STATES,
  RECORD_TYPES
} = require('../lib/constants.js');

const {hashPath} = require('../lib/checksum.js');
const {parseRecordHeader} = require('../lib/format.js');

const tempDir = path.join(__dirname, '.tmp-collision');
const databasePath = path.join(tempDir, 'collision.mtdb');

const COLLISION_COUNT = 128;
const DIRECTORY = 'collision';
const PAYLOAD_V1 = 'A'.repeat(64);
const PAYLOAD_V2 = 'B'.repeat(64);
const PAYLOAD_V3 = 'C'.repeat(64);

function findCollisionPaths() {
  const targetBucket = hashPath(`${DIRECTORY}/seed.json`) % BUCKET_COUNT;
  const paths = [];

  let candidate = 0;

  const startedAt = performance.now();

  while (paths.length < COLLISION_COUNT + 1) {
    const filePath = `${DIRECTORY}/item-${candidate}.json`;

    if (hashPath(filePath) % BUCKET_COUNT === targetBucket) {
      paths.push(filePath);
    }

    candidate += 1;
  }

  return {
    targetBucket,
    paths: paths.slice(0, COLLISION_COUNT),
    missingPath: paths[COLLISION_COUNT],
    candidatesChecked: candidate,
    durationMs: performance.now() - startedAt
  };
}

function createExpected(paths) {
  return paths.map((filePath, index) => {
    return {
      filePath,
      value: {
        index,
        version: 1,
        payload: PAYLOAD_V1
      }
    };
  });
}

function verifyDatabase(db, expected, missingPath) {
  for (const item of expected) {
    assert.deepStrictEqual(
      db.read(item.filePath),
      item.value,
      `Некорректное значение ${item.filePath}`
    );
  }

  assert.strictEqual(
    db.read(missingPath),
    undefined,
    'Несуществующий collision-path неожиданно найден'
  );
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

function getChainDepth(filePath, bucketIndex) {
  const fd = fs.openSync(
    filePath,
    'r'
  );

  try {
    const fileSize = fs.fstatSync(fd).size;

    const bucketBuffer = Buffer.alloc(
      BUCKET_SIZE
    );

    readExactly(
      fd,
      bucketBuffer,
      INDEX_OFFSET + bucketIndex * BUCKET_SIZE
    );

    const firstOffsetBigInt =
      bucketBuffer.readBigUInt64LE(0);

    assert.ok(
      firstOffsetBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
      'Bucket offset превышает безопасный диапазон'
    );

    let offset = Number(
      firstOffsetBigInt
    );

    let depth = 0;

    while (offset !== 0) {
      assert.ok(
        offset >= DATA_OFFSET &&
        offset + RECORD_HEADER_SIZE <= fileSize,
        `Некорректный offset ${offset}`
      );

      const headerBuffer = Buffer.alloc(
        RECORD_HEADER_SIZE
      );

      readExactly(
        fd,
        headerBuffer,
        offset
      );

      const header =
        parseRecordHeader(headerBuffer);

      assert.notStrictEqual(
        header.type,
        RECORD_TYPES.COMMIT,
        'Bucket указывает на COMMIT'
      );

      if (header.previousOffset !== 0) {
        assert.ok(
          header.previousOffset < offset,
          'Цепочка previousOffset направлена вперёд'
        );
      }

      depth += 1;

      assert.ok(
        depth < 100000,
        'Обнаружена потенциально циклическая bucket-chain'
      );

      offset =
        header.previousOffset;
    }

    return depth;
  }

  finally {
    fs.closeSync(fd);
  }
}

function forceRecovery(filePath) {
  const fd = fs.openSync(
    filePath,
    'r+'
  );

  try {
    const buffer = Buffer.from([
      HEADER_STATES.DIRTY
    ]);

    fs.writeSync(
      fd,
      buffer,
      0,
      buffer.length,
      HEADER_STATE_OFFSET
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} Б`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(2)} КБ`;
  }

  return `${(value / 1024 / 1024).toFixed(2)} МБ`;
}

function main() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  console.log(
    'Лог: Запуск collision-тестов MTDB'
  );

  console.log('');

  const collision =
    findCollisionPaths();

  console.log(
    `Лог: Найдено ${COLLISION_COUNT} collision-path для bucket ${collision.targetBucket}`
  );

  console.log(
    `Лог: Проверено кандидатов: ${collision.candidatesChecked}`
  );

  console.log(
    `Лог: Поиск collision: ${(collision.durationMs / 1000).toFixed(2)} с`
  );

  console.log('');

  const expected =
    createExpected(collision.paths);

  let db =
    mtdb.open(databasePath);

  db.mkdir(DIRECTORY);

  const writeStartedAt =
    performance.now();

  for (const item of expected) {
    db.write(
      item.filePath,
      item.value
    );
  }

  console.log(
    `Лог: Первичная запись: ${(performance.now() - writeStartedAt).toFixed(2)} мс`
  );

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  console.log(
    'Лог: PASS чтение всех collision-path'
  );

  const overwriteIndexes = [
    0,
    Math.floor(COLLISION_COUNT / 2),
    COLLISION_COUNT - 1
  ];

  for (const index of overwriteIndexes) {
    expected[index].value = {
      index,
      version: 2,
      payload: PAYLOAD_V2
    };

    db.write(
      expected[index].filePath,
      expected[index].value
    );
  }

  console.log(
    'Лог: PASS overwrite начала, середины и конца collision-chain'
  );

  let deletedCount = 0;

  for (let index = 0; index < expected.length; index += 1) {
    if (index % 7 !== 0) {
      continue;
    }

    db.delete(
      expected[index].filePath
    );

    expected[index].value =
      undefined;

    deletedCount += 1;
  }

  console.log(
    `Лог: PASS delete collision-path: ${deletedCount}`
  );

  expected[0].value = {
    index: 0,
    version: 3,
    payload: PAYLOAD_V3
  };

  db.write(
    expected[0].filePath,
    expected[0].value
  );

  console.log(
    'Лог: PASS повторная запись после tombstone'
  );

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  db.close();

  const chainBefore =
    getChainDepth(
      databasePath,
      collision.targetBucket
    );

  console.log(
    `Лог: Bucket-chain до compact: ${chainBefore}`
  );

  assert.ok(
    chainBefore >= COLLISION_COUNT,
    'Collision-chain неожиданно короче числа созданных collision-path'
  );

  const reopenStartedAt =
    performance.now();

  db =
    mtdb.open(databasePath);

  console.log(
    `Лог: Clean reopen: ${(performance.now() - reopenStartedAt).toFixed(3)} мс`
  );

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  db.close();

  console.log(
    'Лог: PASS clean reopen'
  );

  forceRecovery(databasePath);

  const recoveryStartedAt =
    performance.now();

  db =
    mtdb.open(databasePath);

  const recoveryMs =
    performance.now() -
    recoveryStartedAt;

  console.log(
    `Лог: Forced recovery: ${recoveryMs.toFixed(2)} мс`
  );

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  console.log(
    'Лог: PASS rebuildIndex с длинной collision-chain'
  );

  const beforeCompactSize =
    fs.statSync(databasePath).size;

  const compactStartedAt =
    performance.now();

  const compact =
    db.compact();

  const compactMs =
    performance.now() -
    compactStartedAt;

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  db.close();

  const afterCompactSize =
    fs.statSync(databasePath).size;

  const chainAfter =
    getChainDepth(
      databasePath,
      collision.targetBucket
    );

  const liveCount =
    expected.reduce(
      (count, item) => {
        return count + (
          item.value === undefined
            ? 0
            : 1
        );
      },
      0
    );

  const directoryInTargetBucket =
    hashPath(DIRECTORY) % BUCKET_COUNT ===
    collision.targetBucket;

  const expectedCompactChain =
    liveCount +
    (
      directoryInTargetBucket
        ? 1
        : 0
    );

  assert.strictEqual(
    chainAfter,
    expectedCompactChain,
    'После compact collision-chain содержит исторические записи'
  );

  assert.strictEqual(
    compact.afterSize,
    afterCompactSize
  );

  assert.ok(
    afterCompactSize <
    beforeCompactSize,
    'Compact не уменьшил collision-базу'
  );

  console.log(
    `Лог: Compact: ${compactMs.toFixed(2)} мс`
  );

  console.log(
    `Лог: Размер до compact: ${formatBytes(beforeCompactSize)}`
  );

  console.log(
    `Лог: Размер после compact: ${formatBytes(afterCompactSize)}`
  );

  console.log(
    `Лог: Bucket-chain после compact: ${chainAfter}`
  );

  console.log(
    'Лог: PASS compact удалил историю collision-chain'
  );

  db =
    mtdb.open(databasePath);

  verifyDatabase(
    db,
    expected,
    collision.missingPath
  );

  db.close();

  console.log(
    'Лог: PASS финальный reopen'
  );

  console.log('');
  console.log(
    'Лог: Все collision-тесты завершены'
  );

  console.log(
    'MTDB collision test: OK'
  );
}

try {
  main();
}

catch (error) {
  console.error(
    `Ошибка: ${error.stack || error.message}`
  );

  process.exitCode = 1;
}