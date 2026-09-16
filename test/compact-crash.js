'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {spawnSync} = require('child_process');
const {performance} = require('perf_hooks');
const mtdb = require('..');

const tempDir = path.join(__dirname, '.tmp-compact-crash');
const basePath = path.join(tempDir, 'base.mtdb');
const workerPath = path.join(__dirname, 'compact-crash-worker.js');

const OBJECT_COUNT = 5000;
const SHARD_COUNT = 32;

const payloadA = 'A'.repeat(64);
const payloadB = 'B'.repeat(64);

function getObjectPath(id) {
  const shard = (id % SHARD_COUNT)
    .toString(16)
    .padStart(2, '0');

  return `objects/${shard}/${id}.json`;
}

function getExpectedValue(id) {
  if (id % 5 === 0) {
    return undefined;
  }

  if (id % 2 === 0) {
    return {
      id,
      version: 2,
      payload: payloadB
    };
  }

  return {
    id,
    version: 1,
    payload: payloadA
  };
}

function createFixture() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  const startedAt = performance.now();
  const db = mtdb.open(basePath);

  db.mkdir('objects');

  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    db.mkdir(
      `objects/${shard.toString(16).padStart(2, '0')}`
    );
  }

  for (let id = 0; id < OBJECT_COUNT; id += 1) {
    db.write(
      getObjectPath(id),
      {
        id,
        version: 1,
        payload: payloadA
      }
    );
  }

  for (let id = 0; id < OBJECT_COUNT; id += 2) {
    db.write(
      getObjectPath(id),
      {
        id,
        version: 2,
        payload: payloadB
      }
    );
  }

  for (let id = 0; id < OBJECT_COUNT; id += 5) {
    db.delete(
      getObjectPath(id)
    );
  }

  db.close();

  console.log(
    `Лог: Базовая fixture создана за ${((performance.now() - startedAt) / 1000).toFixed(2)} с`
  );

  console.log(
    `Лог: Размер fixture: ${formatBytes(fs.statSync(basePath).size)}`
  );
}

function createCase(name) {
  const databasePath = path.join(
    tempDir,
    `${name}.mtdb`
  );

  fs.rmSync(databasePath, {
    force: true
  });

  fs.rmSync(
    `${databasePath}.compact.tmp`,
    {
      force: true
    }
  );

  fs.copyFileSync(
    basePath,
    databasePath
  );

  return databasePath;
}

function runCrashWorker(databasePath, crashPoint) {
  const result = spawnSync(
    process.execPath,
    [
      workerPath,
      databasePath,
      crashPoint
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
    result.stdout.includes(`MTDB_COMPACT_TEST_CRASH ${crashPoint}`),
    `Worker не дошёл до точки ${crashPoint}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Worker ${crashPoint} неожиданно завершился успешно`
  );
}

function verifyDatabase(databasePath) {
  const db = mtdb.open(databasePath);

  try {
    for (let id = 0; id < OBJECT_COUNT; id += 1) {
      const actual = db.read(
        getObjectPath(id)
      );

      const expected =
        getExpectedValue(id);

      assert.deepStrictEqual(
        actual,
        expected,
        `Данные отличаются: ${getObjectPath(id)}`
      );
    }
  }

  finally {
    db.close();
  }
}

function verifyCompactCanRunAgain(databasePath) {
  let db = mtdb.open(databasePath);

  const beforeSize =
    fs.statSync(databasePath).size;

  const result =
    db.compact();

  db.close();

  assert.ok(
    result.afterSize < beforeSize,
    'Повторный compact не уменьшил базу'
  );

  assert.strictEqual(
    fs.existsSync(`${databasePath}.compact.tmp`),
    false,
    'После повторного compact остался temp-файл'
  );

  verifyDatabase(databasePath);

  db = mtdb.open(databasePath);

  const probePath =
    'objects/00/post-compact.json';

  db.write(
    probePath,
    {
      ok: true,
      stage: 'after-compact'
    }
  );

  assert.deepStrictEqual(
    db.read(probePath),
    {
      ok: true,
      stage: 'after-compact'
    }
  );

  assert.strictEqual(
    db.delete(probePath),
    true
  );

  assert.strictEqual(
    db.read(probePath),
    undefined
  );

  db.close();

  db = mtdb.open(databasePath);

  assert.strictEqual(
    db.read(probePath),
    undefined
  );

  db.close();
}

function testCrashDuringTempWrite() {
  const databasePath =
    createCase('during-temp-write');

  const originalSize =
    fs.statSync(databasePath).size;

  runCrashWorker(
    databasePath,
    'during_temp_write'
  );

  assert.strictEqual(
    fs.statSync(databasePath).size,
    originalSize,
    'Основная база изменилась при аварии во время записи temp'
  );

  assert.strictEqual(
    fs.existsSync(`${databasePath}.compact.tmp`),
    true,
    'После аварии ожидался незавершённый temp-файл'
  );

  verifyDatabase(databasePath);
  verifyCompactCanRunAgain(databasePath);

  console.log(
    'Лог: PASS compact — crash во время записи temp'
  );
}

function testCrashBeforeRename() {
  const databasePath =
    createCase('before-rename');

  const originalSize =
    fs.statSync(databasePath).size;

  runCrashWorker(
    databasePath,
    'before_rename'
  );

  assert.strictEqual(
    fs.statSync(databasePath).size,
    originalSize,
    'Основная база изменилась до rename'
  );

  assert.strictEqual(
    fs.existsSync(`${databasePath}.compact.tmp`),
    true,
    'Перед rename должен остаться готовый temp-файл'
  );

  verifyDatabase(databasePath);
  verifyCompactCanRunAgain(databasePath);

  console.log(
    'Лог: PASS compact — crash после подготовки temp, до rename'
  );
}

function testCrashAfterRename() {
  const databasePath =
    createCase('after-rename');

  const originalSize =
    fs.statSync(databasePath).size;

  runCrashWorker(
    databasePath,
    'after_rename'
  );

  const compactSize =
    fs.statSync(databasePath).size;

  assert.ok(
    compactSize < originalSize,
    'После rename основной файл не стал compact-версией'
  );

  assert.strictEqual(
    fs.existsSync(`${databasePath}.compact.tmp`),
    false,
    'После rename temp-файл не должен существовать'
  );

  verifyDatabase(databasePath);

  let db = mtdb.open(databasePath);

  const probePath =
    'objects/00/after-rename.json';

  db.write(
    probePath,
    {
      ok: true,
      stage: 'after-rename-crash'
    }
  );

  assert.deepStrictEqual(
    db.read(probePath),
    {
      ok: true,
      stage: 'after-rename-crash'
    }
  );

  db.close();

  db = mtdb.open(databasePath);

  assert.deepStrictEqual(
    db.read(probePath),
    {
      ok: true,
      stage: 'after-rename-crash'
    }
  );

  db.delete(probePath);
  db.close();

  console.log(
    'Лог: PASS compact — crash сразу после rename'
  );
}

function testNormalCompactContinuation() {
  const databasePath =
    createCase('normal-continuation');

  let db = mtdb.open(databasePath);

  const originalSize =
    fs.statSync(databasePath).size;

  const result =
    db.compact();

  assert.ok(
    result.afterSize < originalSize,
    'Compact не уменьшил размер базы'
  );

  db.write(
    'objects/00/continuation.json',
    {
      value: 123
    }
  );

  assert.deepStrictEqual(
    db.read('objects/00/continuation.json'),
    {
      value: 123
    }
  );

  assert.strictEqual(
    db.delete('objects/00/continuation.json'),
    true
  );

  db.close();

  db = mtdb.open(databasePath);

  assert.strictEqual(
    db.read('objects/00/continuation.json'),
    undefined
  );

  db.close();

  verifyDatabase(databasePath);

  console.log(
    'Лог: PASS compact — база продолжает работать после штатной замены'
  );
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} Б`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(2)} КБ`;
  }

  return `${(value / 1024 / 1024).toFixed(2)} МБ`;
}

function main() {
  console.log(
    'Лог: Запуск compact crash/recovery тестов MTDB'
  );

  console.log('');

  createFixture();

  console.log('');

  testCrashDuringTempWrite();
  testCrashBeforeRename();
  testCrashAfterRename();
  testNormalCompactContinuation();

  console.log('');
  console.log(
    'Лог: Все compact crash/recovery тесты завершены'
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