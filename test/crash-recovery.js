'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {spawnSync} = require('child_process');
const mtdb = require('..');

const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  RECORD_HEADER_SIZE
} = require('../lib/constants.js');

const {hashPath} = require('../lib/checksum.js');
const {parseRecordHeader} = require('../lib/format.js');

const tempDir = path.join(__dirname, '.tmp-crash');
const workerPath = path.join(__dirname, 'crash-worker.js');
const targetPath = 'users/target.json';

const oldValue = {
  version: 1,
  payload: 'A'.repeat(128 * 1024)
};

const newValue = {
  version: 2,
  payload: 'B'.repeat(256 * 1024)
};

function createFixture(filePath, writeSecondVersion = false) {
  fs.rmSync(filePath, {
    force: true
  });

  const db = mtdb.open(filePath);

  db.mkdir('users');
  db.write(targetPath, oldValue);

  if (writeSecondVersion) {
    db.write(targetPath, newValue);
  }

  db.close();
}

function runCrashWorker(filePath, action, crashPoint) {
  const result = spawnSync(
    process.execPath,
    [
      workerPath,
      filePath,
      action,
      crashPoint
    ],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );

  if (result.error) {
    throw result.error;
  }

  assert.ok(
    result.stdout.includes('MTDB_TEST_CRASH'),
    `Дочерний процесс не дошёл до точки аварии.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  assert.notStrictEqual(
    result.status,
    0,
    'Crash-worker неожиданно завершился успешно'
  );
}

function readTarget(filePath) {
  const db = mtdb.open(filePath);

  try {
    return db.read(targetPath);
  }

  finally {
    db.close();
  }
}

function assertCorruptedRead(filePath, allowedCodes) {
  assert.throws(
    () => {
      const db = mtdb.open(filePath);

      try {
        db.read(targetPath);
      }

      finally {
        db.close();
      }
    },
    (error) => {
      return allowedCodes.includes(error.code);
    }
  );
}

function getBucketPosition(filePath) {
  const bucketIndex = hashPath(filePath) % BUCKET_COUNT;
  return INDEX_OFFSET + bucketIndex * BUCKET_SIZE;
}

function readCurrentRecordInfo(databasePath, filePath) {
  const fd = fs.openSync(databasePath, 'r');

  try {
    const bucketBuffer = Buffer.alloc(BUCKET_SIZE);

    fs.readSync(
      fd,
      bucketBuffer,
      0,
      BUCKET_SIZE,
      getBucketPosition(filePath)
    );

    const recordOffsetBigInt = bucketBuffer.readBigUInt64LE(0);

    assert.ok(
      recordOffsetBigInt <= BigInt(Number.MAX_SAFE_INTEGER),
      'Offset записи превышает безопасный диапазон'
    );

    const recordOffset = Number(recordOffsetBigInt);
    const headerBuffer = Buffer.alloc(RECORD_HEADER_SIZE);

    fs.readSync(
      fd,
      headerBuffer,
      0,
      RECORD_HEADER_SIZE,
      recordOffset
    );

    const header = parseRecordHeader(headerBuffer);

    return {
      recordOffset,
      dataOffset: recordOffset + RECORD_HEADER_SIZE + header.pathLength,
      dataLength: header.dataLength
    };
  }

  finally {
    fs.closeSync(fd);
  }
}

function corruptChecksumData(databasePath) {
  const record = readCurrentRecordInfo(
    databasePath,
    targetPath
  );

  assert.ok(
    record.dataLength > 0,
    'У тестовой записи отсутствуют данные'
  );

  const fd = fs.openSync(databasePath, 'r+');

  try {
    const byte = Buffer.alloc(1);

    fs.readSync(
      fd,
      byte,
      0,
      1,
      record.dataOffset
    );

    byte[0] ^= 0x01;

    fs.writeSync(
      fd,
      byte,
      0,
      1,
      record.dataOffset
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function corruptBucketOffset(databasePath) {
  const stats = fs.statSync(databasePath);
  const invalidOffset = stats.size + 4096;

  const buffer = Buffer.alloc(BUCKET_SIZE);

  buffer.writeBigUInt64LE(
    BigInt(invalidOffset),
    0
  );

  const fd = fs.openSync(databasePath, 'r+');

  try {
    fs.writeSync(
      fd,
      buffer,
      0,
      buffer.length,
      getBucketPosition(targetPath)
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function testWriteCrashBeforeCommit() {
  const databasePath = path.join(
    tempDir,
    'write-before-commit.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'write',
    'before_commit'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS write — незакоммиченная запись отброшена');
}

function testDeleteCrashBeforeCommit() {
  const databasePath = path.join(
    tempDir,
    'delete-before-commit.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'delete',
    'before_commit'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS delete — незакоммиченное удаление отброшено');
}

function testWriteCrashBeforeBucket() {
  const databasePath = path.join(
    tempDir,
    'write-before-bucket.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'write',
    'before_bucket'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    newValue
  );

  console.log('Лог: PASS write — commit сохранён, индекс восстановлен');
}

function testDeleteCrashBeforeBucket() {
  const databasePath = path.join(
    tempDir,
    'delete-before-bucket.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'delete',
    'before_bucket'
  );

  assert.strictEqual(
    readTarget(databasePath),
    undefined
  );

  console.log('Лог: PASS delete — commit сохранён, индекс восстановлен');
}

function testWriteCrashDuringBucket() {
  const databasePath = path.join(
    tempDir,
    'write-during-bucket.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'write',
    'during_bucket'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    newValue
  );

  console.log('Лог: PASS write — torn bucket восстановлен из commit');
}

function testDeleteCrashDuringBucket() {
  const databasePath = path.join(
    tempDir,
    'delete-during-bucket.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'delete',
    'during_bucket'
  );

  assert.strictEqual(
    readTarget(databasePath),
    undefined
  );

  console.log('Лог: PASS delete — torn bucket восстановлен из commit');
}

function testWriteCrashDuringRecord() {
  const databasePath = path.join(
    tempDir,
    'write-during-record.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'write',
    'during_record'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS write — оборванная запись отброшена');
}

function testDeleteCrashDuringRecord() {
  const databasePath = path.join(
    tempDir,
    'delete-during-record.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'delete',
    'during_record'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS delete — оборванная запись отброшена');
}

function testWriteCrashDuringCommit() {
  const databasePath = path.join(
    tempDir,
    'write-during-commit.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'write',
    'during_commit'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS write — оборванный commit отброшен');
}

function testDeleteCrashDuringCommit() {
  const databasePath = path.join(
    tempDir,
    'delete-during-commit.mtdb'
  );

  createFixture(databasePath);

  runCrashWorker(
    databasePath,
    'delete',
    'during_commit'
  );

  assert.deepStrictEqual(
    readTarget(databasePath),
    oldValue
  );

  console.log('Лог: PASS delete — оборванный commit отброшен');
}

function testBrokenChecksum() {
  const databasePath = path.join(
    tempDir,
    'broken-checksum.mtdb'
  );

  createFixture(
    databasePath,
    true
  );

  corruptChecksumData(databasePath);

  assertCorruptedRead(
    databasePath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log('Лог: PASS битый checksum обнаружен');
}

function testBrokenBucketOffset() {
  const databasePath = path.join(
    tempDir,
    'broken-offset.mtdb'
  );

  createFixture(
    databasePath,
    true
  );

  corruptBucketOffset(databasePath);

  assert.deepStrictEqual(
    readTarget(databasePath),
    newValue
  );

  console.log('Лог: PASS битый bucket offset восстановлен из журнала');
}

function main() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  console.log('Лог: Запуск crash/recovery тестов MTDB');
  console.log('');

  testWriteCrashBeforeCommit();
  testDeleteCrashBeforeCommit();

  testWriteCrashBeforeBucket();
  testDeleteCrashBeforeBucket();

  testWriteCrashDuringBucket();
  testDeleteCrashDuringBucket();

  testWriteCrashDuringRecord();
  testDeleteCrashDuringRecord();

  testWriteCrashDuringCommit();
  testDeleteCrashDuringCommit();
  testBrokenChecksum();
  testBrokenBucketOffset();

  console.log('');
  console.log('Лог: Все crash/recovery тесты завершены');
}

try {
  main();
}

catch (error) {
  console.error(`Ошибка: ${error.stack || error.message}`);
  process.exitCode = 1;
}