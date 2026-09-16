'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {spawnSync} = require('child_process');
const mtdb = require('..');

const {
  BUCKET_COUNT,
  BUCKET_SIZE,
  INDEX_OFFSET
} = require('../lib/constants.js');

const {hashPath} = require('../lib/checksum.js');

const tempDir = path.join(__dirname, '.tmp-regression');
const createWorkerPath = path.join(__dirname, 'regression-create-worker.js');

function assertErrorCode(operation, code) {
  assert.throws(
    operation,
    (error) => {
      return error?.code === code;
    }
  );
}

function readBucketOffset(databasePath, filePath) {
  const bucketIndex = hashPath(filePath) % BUCKET_COUNT;
  const buffer = Buffer.alloc(BUCKET_SIZE);
  const fd = fs.openSync(databasePath, 'r');

  try {
    fs.readSync(
      fd,
      buffer,
      0,
      buffer.length,
      INDEX_OFFSET + bucketIndex * BUCKET_SIZE
    );
  }

  finally {
    fs.closeSync(fd);
  }

  const value = buffer.readBigUInt64LE(0);

  assert.ok(
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  );

  return Number(value);
}

function writeBucketOffset(databasePath, filePath, offset) {
  const bucketIndex = hashPath(filePath) % BUCKET_COUNT;
  const buffer = Buffer.alloc(BUCKET_SIZE);

  buffer.writeBigUInt64LE(
    BigInt(offset),
    0
  );

  const fd = fs.openSync(databasePath, 'r+');

  try {
    fs.writeSync(
      fd,
      buffer,
      0,
      buffer.length,
      INDEX_OFFSET + bucketIndex * BUCKET_SIZE
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function testRecoveryRequiredPoison() {
  const databasePath = path.join(tempDir, 'recovery-required.mtdb');

  let db = mtdb.open(databasePath);

  db.mkdir('users');

  db.write(
    'users/base.json',
    {
      value: 1
    }
  );

  const originalFsyncSync = fs.fsyncSync;
  let failed = false;

  fs.fsyncSync = function(...args) {
    if (!failed) {
      failed = true;

      const error = new Error('Injected fsync failure');
      error.code = 'EIO';
      throw error;
    }

    return originalFsyncSync.apply(fs, args);
  };

  try {
    assertErrorCode(
      () => {
        db.write(
          'users/failed.json',
          {
            value: 2
          }
        );
      },
      'EIO'
    );
  }

  finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assertErrorCode(
    () => {
      db.read('users/base.json');
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assertErrorCode(
    () => {
      db.write(
        'users/second.json',
        {
          value: 3
        }
      );
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assertErrorCode(
    () => {
      db.delete('users/base.json');
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assertErrorCode(
    () => {
      db.mkdir('other');
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assertErrorCode(
    () => {
      db.list('users');
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assertErrorCode(
    () => {
      db.compact();
    },
    'MTDB_RECOVERY_REQUIRED'
  );

  assert.strictEqual(
    db.close(),
    true
  );

  db = mtdb.open(databasePath);

  assert.deepStrictEqual(
    db.read('users/base.json'),
    {
      value: 1
    }
  );

  db.write(
    'users/after-recovery.json',
    {
      ok: true
    }
  );

  assert.deepStrictEqual(
    db.read('users/after-recovery.json'),
    {
      ok: true
    }
  );

  db.close();

  console.log(
    'Лог: PASS recoveryRequired блокирует работу до reopen'
  );
}

function testReentrantQueue() {
  const databasePath = path.join(tempDir, 'reentrant.mtdb');
  const db = mtdb.open(databasePath);

  db.mkdir('users');

  db.write(
    'users/base.json',
    {
      value: 1
    }
  );

  const originalReadInternal = db.readInternal;
  let nestedError = null;

  db.readInternal = function(filePath) {
    try {
      db.write(
        'users/nested.json',
        {
          value: 2
        }
      );
    }

    catch (error) {
      nestedError = error;
    }

    return originalReadInternal.call(
      this,
      filePath
    );
  };

  assert.deepStrictEqual(
    db.read('users/base.json'),
    {
      value: 1
    }
  );

  db.readInternal = originalReadInternal;

  assert.strictEqual(
    nestedError?.code,
    'MTDB_REENTRANT_OPERATION'
  );

  assert.strictEqual(
    db.read('users/nested.json'),
    undefined,
    'Reentrant write был выполнен после возврата ошибки'
  );

  db.close();

  console.log(
    'Лог: PASS reentrant operation не попадает в очередь'
  );
}

function testWrongBucketRecovery() {
  const databasePath = path.join(tempDir, 'wrong-bucket.mtdb');

  const firstPath = 'users/first.json';
  const secondPath = 'users/second.json';

  assert.notStrictEqual(
    hashPath(firstPath) % BUCKET_COUNT,
    hashPath(secondPath) % BUCKET_COUNT,
    'Тестовые пути неожиданно попали в один bucket'
  );

  let db = mtdb.open(databasePath);

  db.mkdir('users');

  db.write(
    firstPath,
    {
      id: 1
    }
  );

  db.write(
    secondPath,
    {
      id: 2
    }
  );

  db.close();

  const firstOffset = readBucketOffset(
    databasePath,
    firstPath
  );

  const secondOffset = readBucketOffset(
    databasePath,
    secondPath
  );

  assert.notStrictEqual(
    firstOffset,
    secondOffset
  );

  writeBucketOffset(
    databasePath,
    firstPath,
    secondOffset
  );

  db = mtdb.open(databasePath);

  assert.deepStrictEqual(
    db.read(firstPath),
    {
      id: 1
    }
  );

  db.close();

  assert.strictEqual(
    readBucketOffset(databasePath, firstPath),
    firstOffset,
    'rebuildIndex не восстановил правильный bucket'
  );

  console.log(
    'Лог: PASS valid record из чужого bucket обнаружен и индекс восстановлен'
  );
}

function testPathNormalizationAndRootList() {
  const databasePath = path.join(tempDir, 'paths.mtdb');
  const db = mtdb.open(databasePath);

  db.write(
    'settings.json',
    {
      root: true
    }
  );

  db.mkdir('users');

  db.write(
    'users/1.json',
    {
      id: 1
    }
  );

  assert.deepStrictEqual(
    db.list(''),
    [
      'settings.json'
    ]
  );

  assertErrorCode(
    () => {
      db.write(
        'C:evil.json',
        {}
      );
    },
    'MTDB_INVALID_PATH'
  );

  assertErrorCode(
    () => {
      db.write(
        'C:/evil.json',
        {}
      );
    },
    'MTDB_INVALID_PATH'
  );

  assertErrorCode(
    () => {
      db.mkdir('users/');
    },
    'MTDB_INVALID_PATH'
  );

  assertErrorCode(
    () => {
      db.write(
        'users//evil.json',
        {}
      );
    },
    'MTDB_INVALID_PATH'
  );

  db.close();

  console.log(
    'Лог: PASS path normalization и implicit root list'
  );
}

function testWriterLockAliasesAndGuard() {
  const databasePath = path.join(tempDir, 'alias.mtdb');
  const symlinkPath = path.join(tempDir, 'alias-symlink.mtdb');
  const hardlinkPath = path.join(tempDir, 'alias-hardlink.mtdb');
  const guardPath = `${databasePath}.lock.guard`;

  let db = mtdb.open(databasePath);

  db.write(
    'root.json',
    {
      ok: true
    }
  );

  db.close();

  let symlinkSupported = true;

  try {
    fs.symlinkSync(
      databasePath,
      symlinkPath,
      'file'
    );
  }

  catch (error) {
    if (
      error.code === 'EPERM' ||
      error.code === 'EACCES' ||
      error.code === 'UNKNOWN'
    ) {
      symlinkSupported = false;
    }

    else {
      throw error;
    }
  }

  if (symlinkSupported) {
    assertErrorCode(
      () => {
        mtdb.open(symlinkPath);
      },
      'MTDB_SYMLINK_UNSUPPORTED'
    );

    fs.rmSync(
      symlinkPath,
      {
        force: true
      }
    );

    console.log(
      'Лог: PASS symbolic link для writer запрещён'
    );
  }

  else {
    console.log(
      'Лог: SKIP symbolic link — Windows не разрешил создание symlink'
    );
  }

  fs.linkSync(
    databasePath,
    hardlinkPath
  );

  assertErrorCode(
    () => {
      mtdb.open(hardlinkPath);
    },
    'MTDB_HARDLINK_UNSUPPORTED'
  );

  assertErrorCode(
    () => {
      mtdb.open(databasePath);
    },
    'MTDB_HARDLINK_UNSUPPORTED'
  );

  fs.rmSync(
    hardlinkPath,
    {
      force: true
    }
  );

  db = mtdb.open(databasePath);
  db.close();

  console.log(
    'Лог: PASS hard link для writer запрещён'
  );

  fs.writeFileSync(
    guardPath,
    'stale-guard',
    'utf8'
  );

  assertErrorCode(
    () => {
      mtdb.open(databasePath);
    },
    'MTDB_LOCK_GUARD_EXISTS'
  );

  fs.rmSync(
    guardPath,
    {
      force: true
    }
  );

  db = mtdb.open(databasePath);
  db.close();

  console.log(
    'Лог: PASS lock guard переводит recovery в fail-safe'
  );
}

function testCrashSafeCreation() {
  const databasePath = path.join(tempDir, 'create-crash.mtdb');
  const tempPath = `${databasePath}.create.tmp`;
  const lockPath = `${databasePath}.lock`;
  const guardPath = `${lockPath}.guard`;

  const result = spawnSync(
    process.execPath,
    [
      createWorkerPath,
      databasePath
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
    result.stdout.includes('MTDB_CREATE_CRASH'),
    `Worker не дошёл до crash point.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  assert.strictEqual(
    fs.existsSync(databasePath),
    false,
    'После crash остался частично созданный основной .mtdb'
  );

  assert.strictEqual(
    fs.existsSync(tempPath),
    true,
    'После crash ожидался незавершённый .create.tmp'
  );

  assert.strictEqual(
    fs.existsSync(lockPath),
    true,
    'После SIGKILL ожидался stale writer-lock'
  );

  assert.strictEqual(
    fs.existsSync(guardPath),
    false,
    'После crash не должен оставаться lock guard'
  );

  const db = mtdb.open(databasePath);

  db.write(
    'root.json',
    {
      created: true
    }
  );

  assert.deepStrictEqual(
    db.read('root.json'),
    {
      created: true
    }
  );

  db.close();

  assert.strictEqual(
    fs.existsSync(databasePath),
    true
  );

  assert.strictEqual(
    fs.existsSync(tempPath),
    false,
    'Старый create temp не был очищен'
  );

  assert.strictEqual(
    fs.existsSync(lockPath),
    false,
    'Stale writer-lock не был восстановлен'
  );

  console.log(
    'Лог: PASS crash-safe создание новой MTDB'
  );
}

function main() {
  fs.rmSync(
    tempDir,
    {
      recursive: true,
      force: true
    }
  );

  fs.mkdirSync(
    tempDir,
    {
      recursive: true
    }
  );

  console.log(
    'Лог: Запуск regression-тестов MTDB'
  );

  console.log('');

  testRecoveryRequiredPoison();
  testReentrantQueue();
  testWrongBucketRecovery();
  testPathNormalizationAndRootList();
  testWriterLockAliasesAndGuard();
  testCrashSafeCreation();

  console.log('');
  console.log(
    'Лог: Все regression-тесты завершены'
  );

  console.log(
    'MTDB regression test: OK'
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