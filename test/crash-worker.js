'use strict';

const fs = require('fs');
const mtdb = require('..');

const {
  INDEX_OFFSET,
  DATA_OFFSET,
  RECORD_TYPES
} = require('../lib/constants.js');

const [databasePath, action, crashPoint] = process.argv.slice(2);

const allowedActions = [
  'write',
  'delete'
];

const allowedCrashPoints = [
  'during_record',
  'before_commit',
  'during_commit',
  'before_bucket',
  'during_bucket'
];

if (!databasePath || !allowedActions.includes(action) || !allowedCrashPoints.includes(crashPoint)) {
  console.error('Ошибка: Некорректные аргументы crash-worker');
  process.exit(2);
}

const targetPath = 'users/target.json';

const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;

function crash() {
  const marker = Buffer.from('MTDB_TEST_CRASH\n');

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

fs.writeSync = function(...args) {
  const [fd, buffer, offset, length, position] = args;

  const isRecordWrite =
    Buffer.isBuffer(buffer) &&
    length >= 5 &&
    buffer.subarray(offset, offset + 4).toString('ascii') === 'MTR1';

  const recordType = isRecordWrite ? buffer[offset + 4] : null;

  const isCommitWrite =
    isRecordWrite &&
    recordType === RECORD_TYPES.COMMIT;

  const isMutationWrite =
    isRecordWrite &&
    (
      recordType === RECORD_TYPES.WRITE ||
      recordType === RECORD_TYPES.DELETE
    );

  if (crashPoint === 'during_record' && isMutationWrite) {
    const partialLength = Math.min(7, length);

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
  }

  if (crashPoint === 'before_commit' && isCommitWrite) {
    crash();
  }

  if (crashPoint === 'during_commit' && isCommitWrite) {
    const partialLength = Math.min(7, length);

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
  }

  const isBucketWrite =
    Buffer.isBuffer(buffer) &&
    length === 8 &&
    Number.isInteger(position) &&
    position >= INDEX_OFFSET &&
    position < DATA_OFFSET;

  if (!isBucketWrite) {
    return originalWriteSync.apply(fs, args);
  }

  if (crashPoint === 'before_bucket') {
    crash();
  }

  if (crashPoint === 'during_bucket') {
    const partialLength = Math.min(2, length);

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
  }

  return originalWriteSync.apply(fs, args);
};


const db = mtdb.open(databasePath);

if (action === 'write') {
  db.write(targetPath, {
    version: 2,
    payload: 'B'.repeat(256 * 1024)
  });
}

else {
  db.delete(targetPath);
}

db.close();

console.error('Ошибка: crash-worker завершился без аварии');
process.exit(3);