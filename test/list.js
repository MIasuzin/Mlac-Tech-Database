'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mtdb = require('..');

const {
  HEADER_STATE_OFFSET,
  HEADER_STATES
} = require('../lib/constants.js');

const tempDir = path.join(__dirname, '.tmp-list');
const databasePath = path.join(tempDir, 'list.mtdb');

function forceRecovery(filePath) {
  const fd = fs.openSync(filePath, 'r+');

  try {
    const buffer = Buffer.from([
      HEADER_STATES.DIRTY
    ]);

    fs.writeSync(
      fd,
      buffer,
      0,
      buffer.length,
      HEADER_STATE_OFFSET
    );

    fs.fsyncSync(fd);
  }

  finally {
    fs.closeSync(fd);
  }
}

function assertList(db, directoryPath, expected) {
  assert.deepStrictEqual(
    db.list(directoryPath),
    expected
  );
}

function main() {
  fs.rmSync(tempDir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(tempDir, {
    recursive: true
  });

  console.log('Лог: Запуск list-тестов MTDB');
  console.log('');

  let db = mtdb.open(databasePath);

  db.mkdir('users');
  db.mkdir('users/archive');
  db.mkdir('invoices');
  db.mkdir('empty');

  db.write('users/300.json', {
    id: 300
  });

  db.write('users/100.json', {
    id: 100
  });

  db.write('users/200.json', {
    id: 200
  });

  db.write('users/archive/400.json', {
    id: 400
  });

  db.write('invoices/invoice-1.json', {
    id: 1
  });

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  console.log(
    'Лог: PASS list возвращает только непосредственные JSON каталога'
  );

  assertList(
    db,
    'users/archive',
    [
      'users/archive/400.json'
    ]
  );

  console.log(
    'Лог: PASS вложенный каталог перечисляется отдельно'
  );

  assertList(
    db,
    'empty',
    []
  );

  console.log(
    'Лог: PASS пустой каталог возвращает пустой массив'
  );

  db.write('users/200.json', {
    id: 200,
    version: 2
  });

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  console.log(
    'Лог: PASS overwrite не создаёт дубль в list'
  );

  db.delete('users/100.json');

  assertList(
    db,
    'users',
    [
      'users/200.json',
      'users/300.json'
    ]
  );

  console.log(
    'Лог: PASS tombstone исключает JSON из list'
  );

  db.write('users/100.json', {
    id: 100,
    restored: true
  });

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  console.log(
    'Лог: PASS повторная запись возвращает JSON в list'
  );

  assert.throws(
    () => {
      db.list('missing');
    },
    (error) => {
      return error?.code === 'MTDB_DIRECTORY_NOT_FOUND';
    }
  );

  console.log(
    'Лог: PASS отсутствующий каталог возвращает MTDB_DIRECTORY_NOT_FOUND'
  );

  assert.throws(
    () => {
      db.list('users/100.json');
    },
    (error) => {
      return error?.code === 'MTDB_PATH_IS_FILE';
    }
  );

  console.log(
    'Лог: PASS JSON нельзя использовать как каталог'
  );

  db.close();

  db = mtdb.open(databasePath);

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  db.close();

  console.log(
    'Лог: PASS list после clean reopen'
  );

  forceRecovery(databasePath);

  db = mtdb.open(databasePath);

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  console.log(
    'Лог: PASS list после rebuildIndex'
  );

  db.compact();

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  assertList(
    db,
    'users/archive',
    [
      'users/archive/400.json'
    ]
  );

  console.log(
    'Лог: PASS list после compact'
  );

  db.close();

  db = mtdb.open(databasePath);

  assertList(
    db,
    'users',
    [
      'users/100.json',
      'users/200.json',
      'users/300.json'
    ]
  );

  db.close();

  console.log(
    'Лог: PASS финальный reopen'
  );

  console.log('');
  console.log(
    'Лог: Все list-тесты завершены'
  );

  console.log(
    'MTDB list test: OK'
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