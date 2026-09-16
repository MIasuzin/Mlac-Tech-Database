'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {spawn} = require('child_process');
const mtdb = require('..');

const tempDir = path.join(__dirname, '.tmp-writer-lock');
const databasePath = path.join(tempDir, 'writer-lock.mtdb');
const corruptedPath = path.join(tempDir, 'corrupted.mtdb');
const workerPath = path.join(__dirname, 'writer-lock-worker.js');

function createFixture() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  const db = mtdb.open(databasePath);

  db.mkdir('users');

  db.write(
    'users/base.json',
    {
      value: 1
    }
  );

  db.close();

  assert.strictEqual(
    fs.existsSync(`${databasePath}.lock`),
    false,
    'Writer-lock остался после штатного close'
  );
}

function assertAlreadyOpen(operation) {
  assert.throws(
    operation,
    (error) => {
      return error?.code === 'MTDB_ALREADY_OPEN';
    }
  );
}

function testSameProcessLock() {
  const db = mtdb.open(databasePath);

  try {
    assertAlreadyOpen(() => {
      mtdb.open(databasePath);
    });
  }

  finally {
    db.close();
  }

  assert.strictEqual(
    fs.existsSync(`${databasePath}.lock`),
    false
  );

  console.log(
    'Лог: PASS повторное открытие в одном процессе заблокировано'
  );
}

function startWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        workerPath,
        databasePath
      ],
      {
        windowsHide: true,
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');

      if (!resolved && stdout.includes('MTDB_LOCK_READY')) {
        resolved = true;
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (!resolved) {
        reject(error);
      }
    });

    child.on('close', (code, signal) => {
      if (!resolved) {
        reject(
          new Error(
            `Writer-lock worker завершился до READY: code=${code}, signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once('close', () => {
      resolve();
    });
  });
}

async function testCrossProcessLock() {
  const child = await startWorker();

  assert.strictEqual(
    fs.existsSync(`${databasePath}.lock`),
    true,
    'Worker не создал writer-lock'
  );

  assertAlreadyOpen(() => {
    mtdb.open(databasePath);
  });

  console.log(
    'Лог: PASS второй writer-процесс заблокирован'
  );

  child.kill('SIGKILL');

  await waitForExit(child);

  assert.strictEqual(
    fs.existsSync(`${databasePath}.lock`),
    true,
    'После SIGKILL stale lock неожиданно исчез'
  );

  const db = mtdb.open(databasePath);

  try {
    assert.deepStrictEqual(
      db.read('users/base.json'),
      {
        value: 1
      }
    );
  }

  finally {
    db.close();
  }

  assert.strictEqual(
    fs.existsSync(`${databasePath}.lock`),
    false,
    'Stale writer-lock не был очищен'
  );

  console.log(
    'Лог: PASS stale lock после SIGKILL автоматически восстановлен'
  );
}

function testFailedOpenReleasesLock() {
  fs.copyFileSync(
    databasePath,
    corruptedPath
  );

  const fd = fs.openSync(
    corruptedPath,
    'r+'
  );

  try {
    fs.writeSync(
      fd,
      Buffer.from('XXXX'),
      0,
      4,
      0
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }

  assert.throws(
    () => {
      mtdb.open(corruptedPath);
    },
    (error) => {
      return error?.code === 'MTDB_INVALID_MAGIC';
    }
  );

  assert.strictEqual(
    fs.existsSync(`${corruptedPath}.lock`),
    false,
    'Writer-lock остался после неудачного open'
  );

  console.log(
    'Лог: PASS ошибка open не оставляет writer-lock'
  );
}

function testCorruptedLock() {
  const lockPath = `${databasePath}.lock`;

  fs.writeFileSync(
    lockPath,
    'broken-lock',
    'utf8'
  );

  assert.throws(
    () => {
      mtdb.open(databasePath);
    },
    (error) => {
      return error?.code === 'MTDB_CORRUPTED_LOCK';
    }
  );

  assert.strictEqual(
    fs.existsSync(lockPath),
    true,
    'Повреждённый lock был небезопасно удалён'
  );

  fs.rmSync(
    lockPath,
    {
      force: true
    }
  );

  console.log(
    'Лог: PASS повреждённый writer-lock не удаляется автоматически'
  );
}

async function main() {
  console.log(
    'Лог: Запуск writer-lock тестов MTDB'
  );

  console.log('');

  createFixture();

  testSameProcessLock();
  await testCrossProcessLock();
  testFailedOpenReleasesLock();
  testCorruptedLock();

  console.log('');
  console.log(
    'Лог: Все writer-lock тесты завершены'
  );

  console.log(
    'MTDB writer-lock test: OK'
  );
}

main().catch((error) => {
  console.error(
    `Ошибка: ${error.stack || error.message}`
  );

  process.exitCode = 1;
});