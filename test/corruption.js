'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mtdb = require('..');

const {
  VERSION,
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  MAX_PATH_LENGTH,
  MAX_JSON_SIZE,
  HEADER_STATE_OFFSET,
  HEADER_STATES,
  RECORD_TYPES
} = require('../lib/constants.js');

const {hashPath} = require('../lib/checksum.js');
const {
  createRecord,
  parseRecordHeader
} = require('../lib/format.js');

const tempDir = path.join(__dirname, '.tmp-corruption');
const targetPath = 'users/target.json';

const oldValue = {
  version: 1,
  payload: 'A'.repeat(128)
};

const newValue = {
  version: 2,
  payload: 'B'.repeat(128)
};

function createFixture(name, secondVersion = false) {
  const databasePath = path.join(
    tempDir,
    `${name}.mtdb`
  );

  fs.rmSync(databasePath, {
    force: true
  });

  const db = mtdb.open(databasePath);

  db.mkdir('users');
  db.write(targetPath, oldValue);

  if (secondVersion) {
    db.write(targetPath, newValue);
  }

  db.close();

  return databasePath;
}

function writeBuffer(databasePath, position, buffer) {
  const fd = fs.openSync(
    databasePath,
    'r+'
  );

  try {
    let offset = 0;

    while (offset < buffer.length) {
      const bytesWritten = fs.writeSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        position + offset
      );

      assert.ok(
        bytesWritten > 0,
        `Не удалось записать данные на позиции ${position + offset}`
      );

      offset += bytesWritten;
    }

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function readBuffer(databasePath, position, length) {
  const fd = fs.openSync(
    databasePath,
    'r'
  );

  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;

    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        position + offset
      );

      assert.ok(
        bytesRead > 0,
        `Неожиданный EOF на позиции ${position + offset}`
      );

      offset += bytesRead;
    }

    return buffer;
  }

  finally {
    fs.closeSync(fd);
  }
}

function writeUInt32(databasePath, position, value) {
  const buffer = Buffer.alloc(4);

  buffer.writeUInt32LE(
    value,
    0
  );

  writeBuffer(
    databasePath,
    position,
    buffer
  );
}

function writeUInt64(databasePath, position, value) {
  const buffer = Buffer.alloc(8);

  buffer.writeBigUInt64LE(
    BigInt(value),
    0
  );

  writeBuffer(
    databasePath,
    position,
    buffer
  );
}

function flipByte(databasePath, position) {
  const buffer = readBuffer(
    databasePath,
    position,
    1
  );

  buffer[0] ^= 0x01;

  writeBuffer(
    databasePath,
    position,
    buffer
  );
}

function markDirty(databasePath) {
  writeBuffer(
    databasePath,
    HEADER_STATE_OFFSET,
    Buffer.from([
      HEADER_STATES.DIRTY
    ])
  );
}

function getBucketIndex(filePath) {
  return hashPath(filePath) % BUCKET_COUNT;
}

function getBucketPosition(filePath) {
  return INDEX_OFFSET + getBucketIndex(filePath) * BUCKET_SIZE;
}

function getCurrentRecordOffset(databasePath, filePath) {
  const buffer = readBuffer(
    databasePath,
    getBucketPosition(filePath),
    BUCKET_SIZE
  );

  const value =
    buffer.readBigUInt64LE(0);

  assert.ok(
    value > 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER),
    'Некорректный current record offset'
  );

  return Number(value);
}

function readRecordInfoAtOffset(databasePath, recordOffset) {
  const headerBuffer = readBuffer(
    databasePath,
    recordOffset,
    RECORD_HEADER_SIZE
  );

  const header =
    parseRecordHeader(headerBuffer);

  const bodyBuffer = readBuffer(
    databasePath,
    recordOffset + RECORD_HEADER_SIZE,
    header.pathLength + header.dataLength
  );

  const pathBuffer =
    bodyBuffer.subarray(
      0,
      header.pathLength
    );

  const dataBuffer =
    bodyBuffer.subarray(
      header.pathLength
    );

  const recordSize =
    RECORD_HEADER_SIZE +
    header.pathLength +
    header.dataLength;

  return {
    ...header,
    recordOffset,
    recordSize,
    commitOffset: recordOffset + recordSize,
    pathBuffer,
    dataBuffer,
    path: pathBuffer.toString('utf8')
  };
}

function readCurrentRecordInfo(databasePath, filePath) {
  return readRecordInfoAtOffset(
    databasePath,
    getCurrentRecordOffset(
      databasePath,
      filePath
    )
  );
}

function assertOpenError(databasePath, allowedCodes) {
  assert.throws(
    () => {
      const db = mtdb.open(databasePath);

      try {
        db.close();
      }

      catch {}
    },
    (error) => {
      return allowedCodes.includes(
        error?.code
      );
    }
  );
}

function assertReadError(databasePath, filePath, allowedCodes) {
  const db = mtdb.open(databasePath);

  try {
    assert.throws(
      () => {
        db.read(filePath);
      },
      (error) => {
        return allowedCodes.includes(
          error?.code
        );
      }
    );
  }

  finally {
    db.close();
  }
}

function testInvalidHeaderMagic() {
  const databasePath =
    createFixture('invalid-header-magic');

  writeBuffer(
    databasePath,
    0,
    Buffer.from('XXXX')
  );

  assertOpenError(
    databasePath,
    [
      'MTDB_INVALID_MAGIC'
    ]
  );

  console.log(
    'Лог: PASS повреждённый header magic обнаружен'
  );
}

function testInvalidHeaderVersion() {
  const databasePath =
    createFixture('invalid-header-version');

  writeUInt32(
    databasePath,
    4,
    VERSION + 1
  );

  assertOpenError(
    databasePath,
    [
      'MTDB_UNSUPPORTED_VERSION'
    ]
  );

  console.log(
    'Лог: PASS неподдерживаемая версия header обнаружена'
  );
}

function testInvalidBucketCount() {
  const databasePath =
    createFixture('invalid-bucket-count');

  writeUInt32(
    databasePath,
    8,
    BUCKET_COUNT + 1
  );

  assertOpenError(
    databasePath,
    [
      'MTDB_INVALID_INDEX'
    ]
  );

  console.log(
    'Лог: PASS повреждённый bucket count обнаружен'
  );
}

function testInvalidHeaderState() {
  const databasePath =
    createFixture('invalid-header-state');

  writeBuffer(
    databasePath,
    HEADER_STATE_OFFSET,
    Buffer.from([
      255
    ])
  );

  assertOpenError(
    databasePath,
    [
      'MTDB_INVALID_HEADER_STATE'
    ]
  );

  console.log(
    'Лог: PASS повреждённый header state обнаружен'
  );
}

function testInvalidDataOffset() {
  const databasePath =
    createFixture('invalid-data-offset');

  writeUInt64(
    databasePath,
    16,
    DATA_OFFSET + 1
  );

  assertOpenError(
    databasePath,
    [
      'MTDB_INVALID_HEADER'
    ]
  );

  console.log(
    'Лог: PASS повреждённый data offset обнаружен'
  );
}

function testBrokenRecordMagic() {
  const databasePath =
    createFixture('broken-record-magic');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  writeBuffer(
    databasePath,
    record.recordOffset,
    Buffer.from('XXXX')
  );

  assertReadError(
    databasePath,
    targetPath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS повреждённый record magic обнаружен'
  );
}

function testBrokenRecordType() {
  const databasePath =
    createFixture('broken-record-type');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  writeBuffer(
    databasePath,
    record.recordOffset + 4,
    Buffer.from([
      255
    ])
  );

  assertReadError(
    databasePath,
    targetPath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS повреждённый record type обнаружен'
  );
}

function testBrokenPathLength() {
  const databasePath =
    createFixture('broken-path-length');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  writeUInt32(
    databasePath,
    record.recordOffset + 8,
    MAX_PATH_LENGTH + 1
  );

  assertReadError(
    databasePath,
    targetPath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS некорректный pathLength обнаружен'
  );
}

function testBrokenDataLength() {
  const databasePath =
    createFixture('broken-data-length');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  writeUInt32(
    databasePath,
    record.recordOffset + 12,
    MAX_JSON_SIZE + 1
  );

  assertReadError(
    databasePath,
    targetPath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS некорректный dataLength обнаружен'
  );
}

function testBrokenChecksum() {
  const databasePath =
    createFixture('broken-checksum');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  assert.ok(
    record.dataLength > 0,
    'Тестовая запись должна содержать JSON'
  );

  flipByte(
    databasePath,
    record.recordOffset +
    RECORD_HEADER_SIZE +
    record.pathLength
  );

  assertReadError(
    databasePath,
    targetPath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS повреждённый checksum обнаружен'
  );
}

function testInvalidBucketOffsetRecovery() {
  const databasePath =
    createFixture('invalid-bucket-offset');

  const fileSize =
    fs.statSync(databasePath).size;

  writeUInt64(
    databasePath,
    getBucketPosition(targetPath),
    fileSize + 4096
  );

  const db =
    mtdb.open(databasePath);

  try {
    assert.deepStrictEqual(
      db.read(targetPath),
      oldValue
    );
  }

  finally {
    db.close();
  }

  console.log(
    'Лог: PASS повреждённый bucket offset автоматически восстановлен'
  );
}

function testBucketPointsToCommitRecovery() {
  const databasePath =
    createFixture('bucket-points-to-commit');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  writeUInt64(
    databasePath,
    getBucketPosition(targetPath),
    record.commitOffset
  );

  const db =
    mtdb.open(databasePath);

  try {
    assert.deepStrictEqual(
      db.read(targetPath),
      oldValue
    );
  }

  finally {
    db.close();
  }

  console.log(
    'Лог: PASS bucket, указывающий на COMMIT, восстановлен'
  );
}

function testInvalidPreviousOffset() {
  const databasePath =
    createFixture('invalid-previous-offset');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  const replacement =
    createRecord(
      record.type,
      record.path,
      record.dataBuffer,
      record.recordOffset
    );

  assert.strictEqual(
    replacement.length,
    record.recordSize
  );

  writeBuffer(
    databasePath,
    record.recordOffset,
    replacement
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_LOG'
    ]
  );

  console.log(
    'Лог: PASS повреждённый previousOffset обнаружен recovery'
  );
}

function testInvalidStoredPath() {
  const databasePath =
    createFixture('invalid-stored-path');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  const invalidPath =
    'users//arget.json';

  assert.strictEqual(
    Buffer.byteLength(invalidPath, 'utf8'),
    record.pathLength
  );

  const replacement =
    createRecord(
      record.type,
      invalidPath,
      record.dataBuffer,
      record.previousOffset
    );

  assert.strictEqual(
    replacement.length,
    record.recordSize
  );

  writeBuffer(
    databasePath,
    record.recordOffset,
    replacement
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS некорректный stored path обнаружен recovery'
  );
}

function testCommitPathMismatch() {
  const databasePath =
    createFixture('commit-path-mismatch');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  const wrongPath =
    'users/targat.json';

  assert.strictEqual(
    Buffer.byteLength(wrongPath, 'utf8'),
    record.pathLength
  );

  const replacement =
    createRecord(
      RECORD_TYPES.COMMIT,
      wrongPath,
      Buffer.alloc(0),
      record.recordOffset
    );

  writeBuffer(
    databasePath,
    record.commitOffset,
    replacement
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_LOG'
    ]
  );

  console.log(
    'Лог: PASS COMMIT с другим path обнаружен'
  );
}

function testCommitPreviousOffsetMismatch() {
  const databasePath =
    createFixture('commit-offset-mismatch');

  const record =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  const replacement =
    createRecord(
      RECORD_TYPES.COMMIT,
      record.path,
      Buffer.alloc(0),
      record.recordOffset + 1
    );

  assert.strictEqual(
    replacement.length,
    RECORD_HEADER_SIZE + record.pathLength
  );

  writeBuffer(
    databasePath,
    record.commitOffset,
    replacement
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_LOG'
    ]
  );

  console.log(
    'Лог: PASS COMMIT с неправильным record offset обнаружен'
  );
}

function testCommitWithoutPendingRecord() {
  const databasePath =
    createFixture('commit-without-pending');

  const firstRecord =
    readRecordInfoAtOffset(
      databasePath,
      DATA_OFFSET
    );

  assert.strictEqual(
    firstRecord.type,
    RECORD_TYPES.DIRECTORY
  );

  const replacement =
    createRecord(
      RECORD_TYPES.COMMIT,
      firstRecord.path,
      Buffer.alloc(0),
      firstRecord.previousOffset
    );

  assert.strictEqual(
    replacement.length,
    firstRecord.recordSize
  );

  writeBuffer(
    databasePath,
    firstRecord.recordOffset,
    replacement
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_LOG'
    ]
  );

  console.log(
    'Лог: PASS COMMIT без pending record обнаружен'
  );
}

function testCorruptedHistoricalRecord() {
  const databasePath =
    createFixture(
      'corrupted-historical-record',
      true
    );

  const current =
    readCurrentRecordInfo(
      databasePath,
      targetPath
    );

  assert.ok(
    current.previousOffset !== 0,
    'У второй версии отсутствует previousOffset'
  );

  const historical =
    readRecordInfoAtOffset(
      databasePath,
      current.previousOffset
    );

  assert.ok(
    historical.dataLength > 0,
    'Историческая запись должна содержать JSON'
  );

  flipByte(
    databasePath,
    historical.recordOffset +
    RECORD_HEADER_SIZE +
    historical.pathLength
  );

  markDirty(databasePath);

  assertOpenError(
    databasePath,
    [
      'MTDB_CORRUPTED_RECORD'
    ]
  );

  console.log(
    'Лог: PASS повреждённая историческая запись не была проигнорирована'
  );
}

function testTruncatedUncommittedTailRecovery() {
  const databasePath =
    createFixture(
      'truncated-tail',
      true
    );

  markDirty(databasePath);

  const fileSize =
    fs.statSync(databasePath).size;

  fs.truncateSync(
    databasePath,
    fileSize - 7
  );

  const db =
    mtdb.open(databasePath);

  try {
    assert.deepStrictEqual(
      db.read(targetPath),
      oldValue
    );
  }

  finally {
    db.close();
  }

  console.log(
    'Лог: PASS оборванный незакоммиченный хвост отброшен'
  );
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
    'Лог: Запуск corruption-тестов MTDB'
  );

  console.log('');

  testInvalidHeaderMagic();
  testInvalidHeaderVersion();
  testInvalidBucketCount();
  testInvalidHeaderState();
  testInvalidDataOffset();

  console.log('');

  testBrokenRecordMagic();
  testBrokenRecordType();
  testBrokenPathLength();
  testBrokenDataLength();
  testBrokenChecksum();

  console.log('');

  testInvalidBucketOffsetRecovery();
  testBucketPointsToCommitRecovery();

  console.log('');

  testInvalidPreviousOffset();
  testInvalidStoredPath();
  testCommitPathMismatch();
  testCommitPreviousOffsetMismatch();
  testCommitWithoutPendingRecord();
  testCorruptedHistoricalRecord();
  testTruncatedUncommittedTailRecovery();

  console.log('');
  console.log(
    'Лог: Все corruption-тесты завершены'
  );

  console.log(
    'MTDB corruption test: OK'
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