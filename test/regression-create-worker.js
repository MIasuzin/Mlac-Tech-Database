'use strict';

const fs = require('fs');
const path = require('path');
const mtdb = require('..');

const databasePath = process.argv[2];

if (!databasePath) {
  console.error('Ошибка: Не передан путь MTDB');
  process.exit(2);
}

const resolvedPath = path.resolve(databasePath);
const tempPath = `${resolvedPath}.create.tmp`;

const originalOpenSync = fs.openSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;

let tempFd = null;

function isSamePath(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function crash() {
  const marker = Buffer.from('MTDB_CREATE_CRASH\n');

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
  const filePath = args[0];

  if (typeof filePath === 'string' && isSamePath(filePath, tempPath)) {
    tempFd = fd;
  }

  return fd;
};

fs.writeSync = function(...args) {
  const [fd, buffer, offset, length, position] = args;

  if (fd !== tempFd || !Buffer.isBuffer(buffer) || position !== 0) {
    return originalWriteSync.apply(fs, args);
  }

  const partialLength = Math.min(
    16,
    length
  );

  originalWriteSync(
    fd,
    buffer,
    offset,
    partialLength,
    position
  );

  originalFsyncSync(fd);

  crash();

  return partialLength;
};

mtdb.open(resolvedPath);

console.error('Ошибка: worker не дошёл до crash point');
process.exit(3);