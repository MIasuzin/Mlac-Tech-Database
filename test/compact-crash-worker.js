'use strict';

const fs = require('fs');
const path = require('path');
const mtdb = require('..');
const {DATA_OFFSET} = require('../lib/constants.js');

const [databasePathRaw, crashPoint] = process.argv.slice(2);

const allowedCrashPoints = [
  'during_temp_write',
  'before_rename',
  'after_rename'
];

if (!databasePathRaw || !allowedCrashPoints.includes(crashPoint)) {
  console.error('Ошибка: Некорректные аргументы compact-crash-worker');
  process.exit(2);
}

const databasePath = path.resolve(databasePathRaw);
const tempPath = `${databasePath}.compact.tmp`;

const originalOpenSync = fs.openSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
const originalRenameSync = fs.renameSync;

let tempFd = null;

function isSamePath(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);

  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }

  return a === b;
}

function crash() {
  const marker = Buffer.from(`MTDB_COMPACT_TEST_CRASH ${crashPoint}\n`);

  originalWriteSync(
    1,
    marker,
    0,
    marker.length,
    null
  );

  try {
    process.kill(process.pid, 'SIGKILL');
  }

  catch {
    process.exit(97);
  }
}

fs.openSync = function(...args) {
  const fd = originalOpenSync.apply(fs, args);
  const [filePath] = args;

  if (typeof filePath === 'string' && isSamePath(filePath, tempPath)) {
    tempFd = fd;
  }

  return fd;
};

fs.writeSync = function(...args) {
  const [fd, buffer, offset, length, position] = args;

  const isCompactDataWrite =
    crashPoint === 'during_temp_write' &&
    fd === tempFd &&
    Buffer.isBuffer(buffer) &&
    Number.isInteger(position) &&
    position >= DATA_OFFSET;

  if (!isCompactDataWrite) {
    return originalWriteSync.apply(fs, args);
  }

  const partialLength = Math.min(
    7,
    length
  );

  const bytesWritten = originalWriteSync(
    fd,
    buffer,
    offset,
    partialLength,
    position
  );

  if (bytesWritten !== partialLength) {
    process.exit(98);
  }

  originalFsyncSync(fd);

  crash();

  return bytesWritten;
};

fs.renameSync = function(...args) {
  const [oldPath, newPath] = args;

  const isCompactRename =
    typeof oldPath === 'string' &&
    typeof newPath === 'string' &&
    isSamePath(oldPath, tempPath) &&
    isSamePath(newPath, databasePath);

  if (!isCompactRename) {
    return originalRenameSync.apply(fs, args);
  }

  if (crashPoint === 'before_rename') {
    crash();
  }

  const result = originalRenameSync.apply(fs, args);

  if (crashPoint === 'after_rename') {
    crash();
  }

  return result;
};

const db = mtdb.open(databasePath);

db.compact();

db.close();

console.error('Ошибка: compact-crash-worker завершился без аварии');
process.exit(3);