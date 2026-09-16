'use strict';

const {
  FILE_MAGIC,
  RECORD_MAGIC,
  VERSION,
  HEADER_SIZE,
  BUCKET_COUNT,
  DATA_OFFSET,
  RECORD_HEADER_SIZE,
  MAX_PATH_LENGTH,
  MAX_JSON_SIZE,
  HEADER_STATE_OFFSET,
  HEADER_STATES,
  RECORD_TYPES
} = require('./constants.js');
const {crc32} = require('./checksum.js');

function createFormatError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createHeader() {
  const buffer = Buffer.alloc(HEADER_SIZE);

  FILE_MAGIC.copy(buffer, 0);
  buffer.writeUInt32LE(VERSION, 4);
  buffer.writeUInt32LE(BUCKET_COUNT, 8);
  buffer.writeUInt8(HEADER_STATES.CLEAN, HEADER_STATE_OFFSET);
  buffer.writeBigUInt64LE(BigInt(DATA_OFFSET), 16);

  return buffer;
}

function validateHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== HEADER_SIZE) {
    throw createFormatError('MTDB_INVALID_HEADER', 'Некорректный заголовок MTDB');
  }

  if (!buffer.subarray(0, 4).equals(FILE_MAGIC)) {
    throw createFormatError('MTDB_INVALID_MAGIC', 'Файл не является MTDB');
  }

  const version = buffer.readUInt32LE(4);

  if (version !== VERSION) {
    throw createFormatError('MTDB_UNSUPPORTED_VERSION', `Версия MTDB ${version} не поддерживается`);
  }

  const bucketCount = buffer.readUInt32LE(8);

  if (bucketCount !== BUCKET_COUNT) {
    throw createFormatError('MTDB_INVALID_INDEX', 'Некорректный размер индексной таблицы MTDB');
  }

  const dataOffset = readSafeUInt64(buffer, 16, 'MTDB_INVALID_HEADER');

  if (dataOffset !== DATA_OFFSET) {
    throw createFormatError('MTDB_INVALID_HEADER', 'Некорректное смещение области данных MTDB');
  }
  
  const state = buffer.readUInt8(HEADER_STATE_OFFSET);
  if (state !== HEADER_STATES.CLEAN && state !== HEADER_STATES.DIRTY) {
    throw createFormatError('MTDB_INVALID_HEADER_STATE', `Некорректное состояние MTDB: ${state}`);
  }

  return {state};
}

function createRecord(type, filePath, data, previousOffset) {
  if (!Object.values(RECORD_TYPES).includes(type)) {
    throw createFormatError('MTDB_INVALID_RECORD_TYPE', 'Некорректный тип записи MTDB');
  }

  const pathBuffer = Buffer.from(filePath, 'utf8');
  const dataBuffer = data || Buffer.alloc(0);

  if (pathBuffer.length === 0 || pathBuffer.length > MAX_PATH_LENGTH) {
    throw createFormatError('MTDB_INVALID_RECORD_PATH', 'Некорректная длина пути записи MTDB');
  }

  if (dataBuffer.length > MAX_JSON_SIZE) {
    throw createFormatError('MTDB_JSON_TOO_LARGE', `Размер JSON превышает лимит ${MAX_JSON_SIZE} байт`);
  }

  const checksumMeta = Buffer.alloc(17);

  checksumMeta.writeUInt8(type, 0);
  checksumMeta.writeUInt32LE(pathBuffer.length, 1);
  checksumMeta.writeUInt32LE(dataBuffer.length, 5);
  checksumMeta.writeBigUInt64LE(BigInt(previousOffset), 9);

  const checksum = crc32([
    checksumMeta,
    pathBuffer,
    dataBuffer
  ]);

  const header = Buffer.alloc(RECORD_HEADER_SIZE);

  RECORD_MAGIC.copy(header, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32LE(pathBuffer.length, 8);
  header.writeUInt32LE(dataBuffer.length, 12);
  header.writeBigUInt64LE(BigInt(previousOffset), 16);
  header.writeUInt32LE(checksum, 24);

  return Buffer.concat([
    header,
    pathBuffer,
    dataBuffer
  ]);
}

function parseRecordHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== RECORD_HEADER_SIZE) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Некорректный заголовок записи MTDB');
  }

  if (!buffer.subarray(0, 4).equals(RECORD_MAGIC)) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Повреждена сигнатура записи MTDB');
  }

  const type = buffer.readUInt8(4);

  if (!Object.values(RECORD_TYPES).includes(type)) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Некорректный тип записи MTDB');
  }

  const pathLength = buffer.readUInt32LE(8);
  const dataLength = buffer.readUInt32LE(12);
  const previousOffset = readSafeUInt64(buffer, 16, 'MTDB_CORRUPTED_RECORD');
  const checksum = buffer.readUInt32LE(24);

  if (pathLength === 0 || pathLength > MAX_PATH_LENGTH) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Некорректная длина пути записи MTDB');
  }

  if (dataLength > MAX_JSON_SIZE) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Некорректный размер JSON записи MTDB');
  }

  if ((type === RECORD_TYPES.DIRECTORY || type === RECORD_TYPES.DELETE || type === RECORD_TYPES.COMMIT) && dataLength !== 0) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', 'Служебная запись MTDB содержит данные');
  }

  return {
    type,
    pathLength,
    dataLength,
    previousOffset,
    checksum
  };
}

function verifyRecordChecksum(record) {
  const checksumMeta = Buffer.alloc(17);

  checksumMeta.writeUInt8(record.type, 0);
  checksumMeta.writeUInt32LE(record.pathLength, 1);
  checksumMeta.writeUInt32LE(record.dataLength, 5);
  checksumMeta.writeBigUInt64LE(BigInt(record.previousOffset), 9);

  const checksum = crc32([
    checksumMeta,
    record.pathBuffer,
    record.dataBuffer
  ]);

  if (checksum !== record.checksum) {
    throw createFormatError('MTDB_CORRUPTED_RECORD', `Контрольная сумма записи ${record.path} не совпадает`);
  }
}

function readSafeUInt64(buffer, offset, errorCode) {
  const value = buffer.readBigUInt64LE(offset);

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createFormatError(errorCode, 'Смещение MTDB превышает поддерживаемый диапазон');
  }

  return Number(value);
}

module.exports = {
  createHeader,
  validateHeader,
  createRecord,
  parseRecordHeader,
  verifyRecordChecksum
};