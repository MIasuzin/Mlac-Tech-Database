'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const {performance} = require('perf_hooks');
const mtdb = require('..');

const objectCount = 100000;

const sourcePath = path.join(
  __dirname,
  '.tmp-endurance',
  'endurance.mtdb'
);

const testPath = path.join(
  __dirname,
  '.tmp-endurance',
  'endurance-compact-test.mtdb'
);

function getObjectPath(id) {
  const shard = (id % 256)
    .toString(16)
    .padStart(2, '0');

  return `objects/${shard}/${id}.json`;
}

function calculateDigest(db) {
  const hash = crypto.createHash('sha256');

  let live = 0;
  let deleted = 0;

  for (let id = 0; id < objectCount; id += 1) {
    const filePath = getObjectPath(id);
    const value = db.read(filePath);

    hash.update(filePath);
    hash.update('\0');

    if (value === undefined) {
      hash.update('DELETED');
      deleted += 1;
    }

    else {
      assert.strictEqual(
        value.id,
        id,
        `Некорректный id ${filePath}`
      );

      hash.update(
        JSON.stringify(value)
      );

      live += 1;
    }

    hash.update('\n');
  }

  return {
    digest: hash.digest('hex'),
    live,
    deleted
  };
}

function formatBytes(value) {
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(2)} КБ`;
  }

  return `${(value / 1024 / 1024).toFixed(2)} МБ`;
}

function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Не найдена endurance-база: ${sourcePath}`
    );
  }

  fs.copyFileSync(
    sourcePath,
    testPath
  );

  console.log(
    `Лог: Создана тестовая копия ${formatBytes(fs.statSync(testPath).size)}`
  );

  let db = mtdb.open(testPath);

  const beforeStartedAt =
    performance.now();

  const before =
    calculateDigest(db);

  console.log(
    `Лог: Проверка до compact: ${(performance.now() - beforeStartedAt).toFixed(2)} мс`
  );

  const compactStartedAt =
    performance.now();

  const result =
    db.compact();

  const compactMs =
    performance.now() -
    compactStartedAt;

  console.log(
    `Лог: Compact завершён за ${(compactMs / 1000).toFixed(2)} с`
  );

  console.log(
    `Лог: Размер до: ${formatBytes(result.beforeSize)}`
  );

  console.log(
    `Лог: Размер после: ${formatBytes(result.afterSize)}`
  );

  console.log(
    `Лог: Освобождено: ${formatBytes(result.reclaimedBytes)}`
  );

  console.log(
    `Лог: Просканировано records: ${result.scannedRecords}`
  );

  console.log(
    `Лог: Записано актуальных records: ${result.writtenRecords}`
  );

  console.log(
    `Лог: JSON: ${result.files}`
  );

  console.log(
    `Лог: Каталоги: ${result.directories}`
  );

  console.log(
    `Лог: Tombstone удалено: ${result.deleted}`
  );

  console.log(
    `Лог: Исторических версий удалено: ${result.historical}`
  );

  db.close();

  const openStartedAt =
    performance.now();

  db = mtdb.open(testPath);

  console.log(
    `Лог: Повторное открытие: ${(performance.now() - openStartedAt).toFixed(3)} мс`
  );

  const afterStartedAt =
    performance.now();

  const after =
    calculateDigest(db);

  console.log(
    `Лог: Проверка после compact: ${(performance.now() - afterStartedAt).toFixed(2)} мс`
  );

  db.close();

  assert.strictEqual(
    after.digest,
    before.digest,
    'Данные после compact отличаются'
  );

  assert.strictEqual(
    after.live,
    before.live
  );

  assert.strictEqual(
    after.deleted,
    before.deleted
  );

  console.log('');
  console.log(
    `Лог: Живых JSON: ${after.live}`
  );

  console.log(
    `Лог: Удалённых JSON: ${after.deleted}`
  );

  console.log(
    'MTDB compact test: OK'
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