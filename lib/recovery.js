'use strict';

const fs = require('fs');

const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  RECORD_TYPES
} = require('./constants.js');

const {hashPath} = require('./checksum.js');

const {
  parseRecordHeader,
  verifyRecordChecksum
} = require('./format.js');

const {
  normalizeDirectoryPath,
  normalizeJsonPath
} = require('./paths.js');

function createRecoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rebuildIndex(fd) {
  const stats = fs.fstatSync(fd);

  if (stats.size < DATA_OFFSET) {
    throw createRecoveryError('MTDB_CORRUPTED_FILE', 'Размер файла MTDB меньше минимально допустимого');
  }

  const indexSize = BUCKET_COUNT * BUCKET_SIZE;
  const rebuiltIndex = Buffer.alloc(indexSize);

  let fileSize = stats.size;
  let offset = DATA_OFFSET;
  let lastCommittedEnd = DATA_OFFSET;
  let pendingRecord = null;
  let records = 0;
  let committedRecords = 0;
  let incompleteTail = false;

  while (offset < fileSize) {
    const remaining = fileSize - offset;

    if (remaining < RECORD_HEADER_SIZE) {
      incompleteTail = true;
      break;
    }

    const headerBuffer = Buffer.alloc(RECORD_HEADER_SIZE);

    readExactly(
      fd,
      headerBuffer,
      offset
    );

    const header = parseRecordHeader(headerBuffer);

    const recordSize =
      RECORD_HEADER_SIZE +
      header.pathLength +
      header.dataLength;

    if (offset + recordSize > fileSize) {
      incompleteTail = true;
      break;
    }

    const bodyBuffer = Buffer.alloc(
      header.pathLength + header.dataLength
    );

    readExactly(
      fd,
      bodyBuffer,
      offset + RECORD_HEADER_SIZE
    );

    const pathBuffer = bodyBuffer.subarray(
      0,
      header.pathLength
    );

    const dataBuffer = bodyBuffer.subarray(
      header.pathLength
    );

    const record = {
      ...header,
      pathBuffer,
      dataBuffer,
      path: pathBuffer.toString('utf8')
    };

    verifyRecordChecksum(record);

    if (record.type === RECORD_TYPES.COMMIT) {
      if (!pendingRecord) {
        throw createRecoveryError(
          'MTDB_CORRUPTED_LOG',
          `COMMIT без ожидающей записи на позиции ${offset}`
        );
      }

      if (record.path !== pendingRecord.path) {
        throw createRecoveryError(
          'MTDB_CORRUPTED_LOG',
          `COMMIT на позиции ${offset} относится к другому пути`
        );
      }

      if (record.previousOffset !== pendingRecord.offset) {
        throw createRecoveryError(
          'MTDB_CORRUPTED_LOG',
          `COMMIT на позиции ${offset} содержит некорректную ссылку на запись`
        );
      }

      writeBucketToBuffer(
        rebuiltIndex,
        pendingRecord.bucketIndex,
        pendingRecord.offset
      );

      pendingRecord = null;
      committedRecords += 1;
      lastCommittedEnd = offset + recordSize;
    }

    else {
      if (pendingRecord) {
        throw createRecoveryError(
          'MTDB_CORRUPTED_LOG',
          `Запись ${record.path} обнаружена до COMMIT предыдущей операции`
        );
      }

      validateStoredPath(
        record.type,
        record.path
      );

      const bucketIndex = hashPath(record.path) % BUCKET_COUNT;

      const expectedPreviousOffset = readBucketFromBuffer(
        rebuiltIndex,
        bucketIndex
      );

      if (record.previousOffset !== expectedPreviousOffset) {
        throw createRecoveryError(
          'MTDB_CORRUPTED_LOG',
          `Некорректная цепочка записей для ${record.path}`
        );
      }

      pendingRecord = {
        offset,
        path: record.path,
        type: record.type,
        bucketIndex
      };
    }

    records += 1;
    offset += recordSize;
  }

  let modified = false;
  let truncatedBytes = 0;

  if (incompleteTail || pendingRecord) {
    truncatedBytes = fileSize - lastCommittedEnd;

    if (truncatedBytes > 0) {
      fs.ftruncateSync(
        fd,
        lastCommittedEnd
      );

      fileSize = lastCommittedEnd;
      modified = true;
    }
  }

  const currentIndex = Buffer.alloc(indexSize);

  readExactly(
    fd,
    currentIndex,
    INDEX_OFFSET
  );

  const indexChanged = !currentIndex.equals(rebuiltIndex);

  if (indexChanged) {
    writeExactly(
      fd,
      rebuiltIndex,
      INDEX_OFFSET
    );

    modified = true;
  }

  if (modified) {
    fs.fsyncSync(fd);
  }

  return {
    recovered: modified,
    indexChanged,
    truncatedBytes,
    records,
    committedRecords,
    endOffset: fileSize
  };
}

function validateStoredPath(type, storedPath) {
  let normalized;

  try {
    if (type === RECORD_TYPES.DIRECTORY) {
      normalized = normalizeDirectoryPath(storedPath);
    }

    else if (
      type === RECORD_TYPES.WRITE ||
      type === RECORD_TYPES.DELETE
    ) {
      normalized = normalizeJsonPath(storedPath);
    }

    else {
      throw createRecoveryError(
        'MTDB_CORRUPTED_RECORD',
        `Некорректный тип записи ${type}`
      );
    }
  }

  catch (error) {
    if (
      error.code === 'MTDB_CORRUPTED_RECORD' ||
      error.code === 'MTDB_CORRUPTED_LOG'
    ) {
      throw error;
    }

    const wrappedError = createRecoveryError(
      'MTDB_CORRUPTED_RECORD',
      `В MTDB хранится некорректный путь: ${storedPath}`
    );

    wrappedError.cause = error;

    throw wrappedError;
  }

  if (normalized !== storedPath) {
    throw createRecoveryError(
      'MTDB_CORRUPTED_RECORD',
      `Путь ${storedPath} хранится в ненормализованном виде`
    );
  }
}

function readBucketFromBuffer(indexBuffer, bucketIndex) {
  const position = bucketIndex * BUCKET_SIZE;
  const value = indexBuffer.readBigUInt64LE(position);

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createRecoveryError(
      'MTDB_CORRUPTED_INDEX',
      'Смещение индекса превышает поддерживаемый диапазон'
    );
  }

  return Number(value);
}

function writeBucketToBuffer(indexBuffer, bucketIndex, offset) {
  const position = bucketIndex * BUCKET_SIZE;

  indexBuffer.writeBigUInt64LE(
    BigInt(offset),
    position
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
      throw createRecoveryError(
        'MTDB_UNEXPECTED_EOF',
        `Неожиданный конец файла MTDB на позиции ${position + offset}`
      );
    }

    offset += bytesRead;
  }
}

function writeExactly(fd, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesWritten = fs.writeSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );

    if (bytesWritten === 0) {
      throw createRecoveryError(
        'MTDB_WRITE_FAILED',
        `Не удалось продолжить запись MTDB на позиции ${position + offset}`
      );
    }

    offset += bytesWritten;
  }
}

module.exports = {
  rebuildIndex
};