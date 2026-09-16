'use strict';

const {MAX_PATH_LENGTH} = require('./constants.js');

function createPathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePath(value) {
  if (typeof value !== 'string') {
    throw createPathError('MTDB_INVALID_PATH', 'Путь должен быть строкой');
  }

  if (value.length === 0) {
    throw createPathError('MTDB_INVALID_PATH', 'Путь не может быть пустым');
  }

  if (value.includes('\0')) {
    throw createPathError('MTDB_INVALID_PATH', 'Путь содержит запрещённый нулевой символ');
  }

  const normalized = value.replace(/\\/g, '/');

  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw createPathError('MTDB_INVALID_PATH', 'Абсолютные, drive-relative и пустые пути запрещены');
  }

  if (normalized.endsWith('/') || normalized.includes('//')) {
    throw createPathError('MTDB_INVALID_PATH', 'Путь содержит пустой сегмент');
  }

  const segments = normalized.split('/');

  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw createPathError('MTDB_INVALID_PATH', 'Путь содержит запрещённый сегмент');
    }
  }

  if (Buffer.byteLength(normalized, 'utf8') > MAX_PATH_LENGTH) {
    throw createPathError('MTDB_PATH_TOO_LONG', `Путь превышает лимит ${MAX_PATH_LENGTH} байт`);
  }

  return normalized;
}

function normalizeDirectoryPath(value) {
  return normalizePath(value);
}

function normalizeListDirectoryPath(value) {
  if (value === '') return '';
  return normalizeDirectoryPath(value);
}

function normalizeJsonPath(value) {
  const normalized = normalizePath(value);

  if (!normalized.toLowerCase().endsWith('.json')) {
    throw createPathError('MTDB_JSON_EXTENSION_REQUIRED', 'Путь JSON должен оканчиваться на .json');
  }

  return normalized;
}

function getParentPath(value) {
  const separatorIndex = value.lastIndexOf('/');
  return separatorIndex === -1 ? null : value.slice(0, separatorIndex);
}

function getDirectoryChain(value) {
  const segments = value.split('/');
  const result = [];
  let current = '';

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    result.push(current);
  }

  return result;
}

module.exports = {
  normalizeDirectoryPath,
  normalizeListDirectoryPath,
  normalizeJsonPath,
  getParentPath,
  getDirectoryChain
};