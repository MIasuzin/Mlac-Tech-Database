'use strict';

const fs = require('fs');
const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  MAX_JSON_SIZE,
  HEADER_STATE_OFFSET,
  HEADER_STATES,
  RECORD_TYPES
} = require('./constants.js');
const {rebuildIndex} = require('./recovery.js');
const {hashPath} = require('./checksum.js');
const {
  createHeader,
  createRecord,
  parseRecordHeader,
  verifyRecordChecksum
} = require('./format.js');
const {
  normalizeDirectoryPath,
  normalizeListDirectoryPath,
  normalizeJsonPath,
  getParentPath,
  getDirectoryChain
} = require('./paths.js');

function createDatabaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class Database {
  constructor(filePath, fd, onClose) {
    this.filePath = filePath;
    this.fd = fd;
    this.onClose = onClose;
    this.closed = false;
    this.dirty = false;
    this.recoveryRequired = false;
    this.operationQueue = [];
    this.processingQueue = false;
    this.endOffset = fs.fstatSync(fd).size;

    if (this.endOffset < DATA_OFFSET) {
      throw createDatabaseError('MTDB_CORRUPTED_FILE', 'Размер файла MTDB меньше минимально допустимого');
    }
  }

  mkdir(directoryPath) {
    const normalizedPath = normalizeDirectoryPath(directoryPath);
    return this.runOperation(() => this.mkdirInternal(normalizedPath));
  }

  list(directoryPath) {
    const normalizedPath = normalizeListDirectoryPath(directoryPath);
    return this.runOperation(() => this.listInternal(normalizedPath));
  }

  read(filePath) {
    const normalizedPath = normalizeJsonPath(filePath);
    return this.runOperation(() => this.readInternal(normalizedPath));
  }

  write(filePath, value) {
    const normalizedPath = normalizeJsonPath(filePath);

    let serialized;

    try {
      serialized = JSON.stringify(value);
    }

    catch (error) {
      const wrappedError = createDatabaseError('MTDB_INVALID_JSON', `Не удалось сериализовать JSON ${normalizedPath}: ${error.message}`);
      wrappedError.cause = error;
      throw wrappedError;
    }

    if (serialized === undefined) {
      throw createDatabaseError('MTDB_INVALID_JSON', `Значение ${normalizedPath} нельзя сериализовать в JSON`);
    }

    const dataBuffer = Buffer.from(serialized, 'utf8');

    if (dataBuffer.length > MAX_JSON_SIZE) {
      throw createDatabaseError('MTDB_JSON_TOO_LARGE', `Размер JSON ${normalizedPath} превышает лимит ${MAX_JSON_SIZE} байт`);
    }

    return this.runOperation(() => this.writeInternal(normalizedPath, dataBuffer));
  }

  delete(filePath) {
    const normalizedPath = normalizeJsonPath(filePath);
    return this.runOperation(() => this.deleteInternal(normalizedPath));
  }

  compact() {
    return this.runOperation(() => this.compactInternal());
  }

  close() {
    if (this.closed) return false;

    return this.runOperation(() => {
      if (this.dirty && !this.recoveryRequired) {
        this.writeDatabaseState(HEADER_STATES.CLEAN);
        fs.fsyncSync(this.fd);
        this.dirty = false;
      }

      fs.closeSync(this.fd);

      this.closed = true;
      this.fd = null;

      if (this.onClose) this.onClose(this.filePath);

      return true;
    }, true);
  }

  runOperation(operation, allowRecoveryRequired = false) {
    this.assertOpen();

    if (this.processingQueue) {
      throw createDatabaseError('MTDB_REENTRANT_OPERATION', 'Вложенная операция MTDB внутри активной операции запрещена');
    }

    if (this.recoveryRequired && !allowRecoveryRequired) {
      throw createDatabaseError('MTDB_RECOVERY_REQUIRED', 'MTDB требует закрытия и повторного открытия после ошибки записи');
    }

    const task = {
      operation,
      completed: false,
      result: undefined,
      error: null
    };

    this.operationQueue.push(task);
    this.processQueue();

    if (!task.completed) {
      throw createDatabaseError('MTDB_OPERATION_INCOMPLETE', 'Операция MTDB не была завершена');
    }

    if (task.error) throw task.error;

    return task.result;
  }

  processQueue() {
    if (this.processingQueue) return;

    this.processingQueue = true;

    try {
      while (this.operationQueue.length > 0) {
        const task = this.operationQueue.shift();

        try {
          task.result = this.executeOperation(task.operation);
        }

        catch (error) {
          task.error = error;
        }

        task.completed = true;
      }
    }

    finally {
      this.processingQueue = false;
    }
  }

  executeOperation(operation) {
    try {
      return operation();
    }

    catch (error) {
      if (error?.code !== 'MTDB_CORRUPTED_INDEX') throw error;

      const recovery = rebuildIndex(this.fd);

      this.endOffset = recovery.endOffset;
      this.recoveryRequired = false;

      return operation();
    }
  }

  mkdirInternal(directoryPath) {
    const directories = getDirectoryChain(directoryPath);
    let created = false;

    for (const currentPath of directories) {
      const current = this.findRecord(currentPath);

      if (current && current.type === RECORD_TYPES.DIRECTORY) continue;

      if (current && current.type === RECORD_TYPES.WRITE) {
        throw createDatabaseError('MTDB_PATH_IS_FILE', `Путь ${currentPath} уже занят JSON-файлом`);
      }

      this.appendMutation(RECORD_TYPES.DIRECTORY, currentPath, Buffer.alloc(0));
      created = true;
    }

    return created;
  }

  listInternal(directoryPath) {
    if (directoryPath) {
      const directory = this.findRecord(directoryPath);

      if (!directory || directory.type === RECORD_TYPES.DELETE) {
        throw createDatabaseError('MTDB_DIRECTORY_NOT_FOUND', `Каталог ${directoryPath} не существует`);
      }

      if (directory.type !== RECORD_TYPES.DIRECTORY) {
        throw createDatabaseError('MTDB_PATH_IS_FILE', `Путь ${directoryPath} не является каталогом`);
      }
    }

    const prefix = directoryPath ? `${directoryPath}/` : '';
    const result = [];

    for (let bucketIndex = 0; bucketIndex < BUCKET_COUNT; bucketIndex += 1) {
      let offset = this.readBucket(bucketIndex);

      if (offset === 0) continue;

      const seenPaths = new Set();

      while (offset !== 0) {
        const record = this.readRecord(offset);

        if (record.type === RECORD_TYPES.COMMIT) {
          throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Bucket ${bucketIndex} указывает на COMMIT-запись`);
        }
        this.assertRecordBucket(record, bucketIndex);
        if (!seenPaths.has(record.path)) {
          seenPaths.add(record.path);

          if (record.type === RECORD_TYPES.WRITE && record.path.startsWith(prefix)) {
            const relativePath = record.path.slice(prefix.length);

            if (relativePath && !relativePath.includes('/')) {
              result.push(record.path);
            }
          }
        }

        if (record.previousOffset !== 0 && record.previousOffset >= offset) {
          throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Некорректная цепочка bucket ${bucketIndex}`);
        }

        offset = record.previousOffset;
      }
    }

    result.sort();

    return result;
  }

  readInternal(filePath) {
    const record = this.findRecord(filePath);

    if (!record || record.type === RECORD_TYPES.DELETE) {
      return undefined;
    }

    if (record.type === RECORD_TYPES.DIRECTORY) {
      throw createDatabaseError('MTDB_PATH_IS_DIRECTORY', `Путь ${filePath} является каталогом`);
    }

    try {
      return JSON.parse(record.dataBuffer.toString('utf8'));
    }

    catch (error) {
      const wrappedError = createDatabaseError('MTDB_CORRUPTED_JSON', `В MTDB хранится повреждённый JSON ${filePath}: ${error.message}`);
      wrappedError.cause = error;
      throw wrappedError;
    }
  }

  writeInternal(filePath, dataBuffer) {
    const parentPath = getParentPath(filePath);

    if (parentPath) {
      const parent = this.findRecord(parentPath);

      if (!parent || parent.type === RECORD_TYPES.DELETE) {
        throw createDatabaseError('MTDB_DIRECTORY_NOT_FOUND', `Каталог ${parentPath} не существует`);
      }

      if (parent.type !== RECORD_TYPES.DIRECTORY) {
        throw createDatabaseError('MTDB_PATH_IS_FILE', `Родительский путь ${parentPath} не является каталогом`);
      }
    }

    const current = this.findRecord(filePath);

    if (current && current.type === RECORD_TYPES.DIRECTORY) {
      throw createDatabaseError('MTDB_PATH_IS_DIRECTORY', `Путь ${filePath} уже занят каталогом`);
    }

    this.appendMutation(RECORD_TYPES.WRITE, filePath, dataBuffer);

    return true;
  }

  deleteInternal(filePath) {
    const current = this.findRecord(filePath);

    if (!current || current.type === RECORD_TYPES.DELETE) {
      return false;
    }

    if (current.type === RECORD_TYPES.DIRECTORY) {
      throw createDatabaseError('MTDB_PATH_IS_DIRECTORY', `Путь ${filePath} является каталогом`);
    }

    this.appendMutation(RECORD_TYPES.DELETE, filePath, Buffer.alloc(0));

    return true;
  }

  compactInternal() {
    const beforeSize = fs.fstatSync(this.fd).size;
    const tempPath = `${this.filePath}.compact.tmp`;
    const compactIndex = Buffer.alloc(BUCKET_COUNT * BUCKET_SIZE);

    let tempFd = null;
    let compactEndOffset = DATA_OFFSET;
    let scannedRecords = 0;
    let writtenRecords = 0;
    let files = 0;
    let directories = 0;
    let deleted = 0;
    let historical = 0;

    fs.rmSync(tempPath, {
      force: true
    });

    try {
      tempFd = fs.openSync(tempPath, 'wx+');

      const header = createHeader();
      const emptyIndex = Buffer.alloc(BUCKET_COUNT * BUCKET_SIZE);

      this.writeExactlyToFd(
        tempFd,
        header,
        0
      );

      this.writeExactlyToFd(
        tempFd,
        emptyIndex,
        INDEX_OFFSET
      );

      for (let bucketIndex = 0; bucketIndex < BUCKET_COUNT; bucketIndex += 1) {
        let offset = this.readBucket(bucketIndex);

        if (offset === 0) {
          continue;
        }

        const seenPaths = new Set();
        const currentOffsets = [];
        let chainDepth = 0;

        while (offset !== 0) {
          const record = this.readRecord(offset);

          if (record.type === RECORD_TYPES.COMMIT) {
            throw createDatabaseError(
              'MTDB_CORRUPTED_INDEX',
              `Bucket ${bucketIndex} указывает на COMMIT-запись`
            );
          }
          this.assertRecordBucket(record, bucketIndex);
          scannedRecords += 1;
          chainDepth += 1;

          if (chainDepth > 5000000) {
            throw createDatabaseError(
              'MTDB_CORRUPTED_INDEX',
              `Слишком длинная цепочка bucket ${bucketIndex}`
            );
          }

          if (!seenPaths.has(record.path)) {
            seenPaths.add(record.path);

            if (record.type === RECORD_TYPES.DELETE) {
              deleted += 1;
            }

            else if (
              record.type === RECORD_TYPES.WRITE ||
              record.type === RECORD_TYPES.DIRECTORY
            ) {
              currentOffsets.push(offset);
            }

            else {
              throw createDatabaseError(
                'MTDB_CORRUPTED_RECORD',
                `Некорректный тип записи ${record.type}`
              );
            }
          }

          else {
            historical += 1;
          }

          if (
            record.previousOffset !== 0 &&
            record.previousOffset >= offset
          ) {
            throw createDatabaseError(
              'MTDB_CORRUPTED_INDEX',
              `Некорректная цепочка bucket ${bucketIndex}`
            );
          }

          offset = record.previousOffset;
        }

        for (let i = currentOffsets.length - 1; i >= 0; i -= 1) {
          const record = this.readRecord(currentOffsets[i]);

          this.assertRecordBucket(record, bucketIndex);

          const result = this.writeCompactRecord(
            tempFd,
            compactIndex,
            compactEndOffset,
            bucketIndex,
            record
          );

          compactEndOffset = result.endOffset;
          writtenRecords += 1;

          if (record.type === RECORD_TYPES.WRITE) {
            files += 1;
          }

          else {
            directories += 1;
          }
        }
      }

      this.writeExactlyToFd(
        tempFd,
        compactIndex,
        INDEX_OFFSET
      );

      fs.ftruncateSync(
        tempFd,
        compactEndOffset
      );

      fs.fsyncSync(tempFd);

      const validation = rebuildIndex(tempFd);

      if (
        validation.indexChanged ||
        validation.truncatedBytes !== 0
      ) {
        throw createDatabaseError(
          'MTDB_COMPACT_VALIDATION_FAILED',
          'Проверка compact-файла обнаружила несогласованность'
        );
      }

      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = null;

      const afterSize = fs.statSync(tempPath).size;

      this.replaceWithCompactFile(
        tempPath
      );

      return {
        beforeSize,
        afterSize,
        reclaimedBytes: beforeSize - afterSize,
        scannedRecords,
        writtenRecords,
        files,
        directories,
        deleted,
        historical
      };
    }

    catch (error) {
      if (tempFd !== null) {
        try {
          fs.closeSync(tempFd);
        }

        catch {}
      }

      try {
        fs.rmSync(tempPath, {
          force: true
        });
      }

      catch {}

      throw error;
    }
  }

  writeCompactRecord(fd, indexBuffer, endOffset, bucketIndex, record) {
    const indexPosition = bucketIndex * BUCKET_SIZE;
    const previousOffsetBigInt = indexBuffer.readBigUInt64LE(indexPosition);

    if (previousOffsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw createDatabaseError(
        'MTDB_COMPACT_FAILED',
        'Compact index содержит слишком большое смещение'
      );
    }

    const previousOffset = Number(previousOffsetBigInt);

    const dataBuffer =
      record.type === RECORD_TYPES.WRITE
        ? record.dataBuffer
        : Buffer.alloc(0);

    const recordBuffer = createRecord(
      record.type,
      record.path,
      dataBuffer,
      previousOffset
    );

    const recordOffset = endOffset;

    this.writeExactlyToFd(
      fd,
      recordBuffer,
      recordOffset
    );

    const commitBuffer = createRecord(
      RECORD_TYPES.COMMIT,
      record.path,
      Buffer.alloc(0),
      recordOffset
    );

    const commitOffset =
      recordOffset +
      recordBuffer.length;

    this.writeExactlyToFd(
      fd,
      commitBuffer,
      commitOffset
    );

    indexBuffer.writeBigUInt64LE(
      BigInt(recordOffset),
      indexPosition
    );

    return {
      recordOffset,
      endOffset:
        commitOffset +
        commitBuffer.length
    };
  }

  writeExactlyToFd(fd, buffer, position) {
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
        throw createDatabaseError(
          'MTDB_WRITE_FAILED',
          `Не удалось продолжить запись MTDB на позиции ${position + offset}`
        );
      }

      offset += bytesWritten;
    }
  }

  replaceWithCompactFile(tempPath) {
    const previousDirty = this.dirty;

    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);

    this.fd = null;

    try {
      fs.renameSync(
        tempPath,
        this.filePath
      );
    }

    catch (error) {
      try {
        this.fd = fs.openSync(
          this.filePath,
          'r+'
        );

        this.endOffset =
          fs.fstatSync(this.fd).size;

        this.dirty = previousDirty;
      }

      catch (reopenError) {
        this.closed = true;

        if (this.onClose) {
          this.onClose(this.filePath);
        }

        reopenError.cause = error;

        throw reopenError;
      }

      throw error;
    }

    try {
      this.fd = fs.openSync(
        this.filePath,
        'r+'
      );

      this.endOffset =
        fs.fstatSync(this.fd).size;

      this.dirty = false;
      this.recoveryRequired = false;
    }

    catch (error) {
      this.closed = true;

      if (this.onClose) {
        this.onClose(this.filePath);
      }

      throw error;
    }
  }

  appendMutation(type, filePath, dataBuffer) {
    this.ensureDirty();

    try {
      const bucketIndex = this.getBucketIndex(filePath);
      const previousOffset = this.readBucket(bucketIndex);

      const recordBuffer = createRecord(type, filePath, dataBuffer, previousOffset);
      const recordOffset = this.endOffset;

      this.writeExactly(recordBuffer, recordOffset);

      const commitOffset = recordOffset + recordBuffer.length;
      const commitBuffer = createRecord(RECORD_TYPES.COMMIT, filePath, Buffer.alloc(0), recordOffset);

      this.writeExactly(commitBuffer, commitOffset);

      this.endOffset = commitOffset + commitBuffer.length;

      fs.fsyncSync(this.fd);

      this.writeBucket(bucketIndex, recordOffset);
      fs.fsyncSync(this.fd);

      return recordOffset;
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  ensureDirty() {
    if (this.dirty) return;

    try {
      this.writeDatabaseState(HEADER_STATES.DIRTY);
      fs.fsyncSync(this.fd);
      this.dirty = true;
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  writeDatabaseState(state) {
    const buffer = Buffer.from([state]);
    this.writeExactly(buffer, HEADER_STATE_OFFSET);
  }

  findRecord(filePath) {
    const bucketIndex = this.getBucketIndex(filePath);
    let offset = this.readBucket(bucketIndex);

    while (offset !== 0) {
      const record = this.readRecord(offset);

      if (record.type === RECORD_TYPES.COMMIT) {
        throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Индекс MTDB указывает на COMMIT-запись по смещению ${offset}`);
      }

      this.assertRecordBucket(record, bucketIndex);
      if (record.path === filePath) {
        return record;
      }

      if (record.previousOffset !== 0 && record.previousOffset >= offset) {
        throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Некорректная цепочка индекса для ${filePath}`);
      }

      offset = record.previousOffset;
    }

    return null;
  }

  assertRecordBucket(record, bucketIndex) {
    const actualBucketIndex = this.getBucketIndex(record.path);

    if (actualBucketIndex !== bucketIndex) {
      throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Запись ${record.path} находится в некорректном bucket ${bucketIndex}`);
    }
  }

  readRecord(offset) {
    if (!Number.isSafeInteger(offset) || offset < DATA_OFFSET || offset + RECORD_HEADER_SIZE > this.endOffset) {
      throw createDatabaseError('MTDB_CORRUPTED_INDEX', `Индекс MTDB указывает на некорректное смещение ${offset}`);
    }

    const headerBuffer = Buffer.alloc(RECORD_HEADER_SIZE);

    this.readExactly(headerBuffer, offset);

    const header = parseRecordHeader(headerBuffer);
    const recordSize = RECORD_HEADER_SIZE + header.pathLength + header.dataLength;

    if (offset + recordSize > this.endOffset) {
      throw createDatabaseError('MTDB_CORRUPTED_RECORD', `Запись MTDB по смещению ${offset} выходит за границы файла`);
    }

    const bodyBuffer = Buffer.alloc(header.pathLength + header.dataLength);

    this.readExactly(bodyBuffer, offset + RECORD_HEADER_SIZE);

    const pathBuffer = bodyBuffer.subarray(0, header.pathLength);
    const dataBuffer = bodyBuffer.subarray(header.pathLength);

    const record = {
      ...header,
      pathBuffer,
      dataBuffer,
      path: pathBuffer.toString('utf8')
    };

    verifyRecordChecksum(record);

    return record;
  }

  getBucketIndex(filePath) {
    return hashPath(filePath) % BUCKET_COUNT;
  }

  readBucket(bucketIndex) {
    const buffer = Buffer.alloc(BUCKET_SIZE);
    const position = INDEX_OFFSET + bucketIndex * BUCKET_SIZE;

    this.readExactly(buffer, position);

    const value = buffer.readBigUInt64LE(0);

    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw createDatabaseError('MTDB_CORRUPTED_INDEX', 'Смещение индекса MTDB превышает поддерживаемый диапазон');
    }

    return Number(value);
  }

  writeBucket(bucketIndex, offset) {
    const buffer = Buffer.alloc(BUCKET_SIZE);

    buffer.writeBigUInt64LE(BigInt(offset), 0);

    const position = INDEX_OFFSET + bucketIndex * BUCKET_SIZE;

    this.writeExactly(buffer, position);
  }

  readExactly(buffer, position) {
    let offset = 0;

    while (offset < buffer.length) {
      const bytesRead = fs.readSync(this.fd, buffer, offset, buffer.length - offset, position + offset);

      if (bytesRead === 0) {
        throw createDatabaseError('MTDB_UNEXPECTED_EOF', `Неожиданный конец файла MTDB на позиции ${position + offset}`);
      }

      offset += bytesRead;
    }
  }

  writeExactly(buffer, position) {
    let offset = 0;

    while (offset < buffer.length) {
      const bytesWritten = fs.writeSync(this.fd, buffer, offset, buffer.length - offset, position + offset);

      if (bytesWritten === 0) {
        throw createDatabaseError('MTDB_WRITE_FAILED', `Не удалось продолжить запись MTDB на позиции ${position + offset}`);
      }

      offset += bytesWritten;
    }
  }

  assertOpen() {
    if (this.closed || this.fd === null) {
      throw createDatabaseError('MTDB_CLOSED', 'MTDB уже закрыта');
    }
  }
}

module.exports = Database;