'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mtdb = require('..');

const databasePath = path.join(__dirname, 'stress.mtdb');
const usersCount = 10000;

try {
  fs.unlinkSync(databasePath);
}

catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.time('Создание базы');

let db = mtdb.open(databasePath);

db.mkdir('users');
db.mkdir('sessions');
db.mkdir('statistics/daily');

console.timeEnd('Создание базы');

console.time('Запись 10000 JSON');

for (let i = 0; i < usersCount; i += 1) {
  db.write(`users/${i}.json`, {
    id: i,
    username: `user_${i}`,
    balance: i * 10,
    enabled: i % 2 === 0
  });
}

console.timeEnd('Запись 10000 JSON');

console.time('Чтение 10000 JSON');

for (let i = 0; i < usersCount; i += 1) {
  const user = db.read(`users/${i}.json`);

  assert.strictEqual(user.id, i);
  assert.strictEqual(user.username, `user_${i}`);
  assert.strictEqual(user.balance, i * 10);
  assert.strictEqual(user.enabled, i % 2 === 0);
}

console.timeEnd('Чтение 10000 JSON');

console.time('Перезапись 5000 JSON');

for (let i = 0; i < usersCount; i += 2) {
  db.write(`users/${i}.json`, {
    id: i,
    balance: 999999,
    changed: true
  });
}

console.timeEnd('Перезапись 5000 JSON');

console.time('Проверка перезаписи');

for (let i = 0; i < usersCount; i += 2) {
  const user = db.read(`users/${i}.json`);

  assert.strictEqual(user.id, i);
  assert.strictEqual(user.balance, 999999);
  assert.strictEqual(user.changed, true);
}

console.timeEnd('Проверка перезаписи');

console.time('Удаление 2500 JSON');

for (let i = 0; i < 5000; i += 2) {
  assert.strictEqual(
    db.delete(`users/${i}.json`),
    true
  );
}

console.timeEnd('Удаление 2500 JSON');

console.time('Проверка удаления');

for (let i = 0; i < 5000; i += 2) {
  assert.strictEqual(
    db.read(`users/${i}.json`),
    undefined
  );
}

console.timeEnd('Проверка удаления');

db.close();

console.time('Повторное открытие');

db = mtdb.open(databasePath);

console.timeEnd('Повторное открытие');

assert.strictEqual(
  db.read('users/0.json'),
  undefined
);

assert.deepStrictEqual(
  db.read('users/6000.json'),
  {
    id: 6000,
    balance: 999999,
    changed: true
  }
);

assert.deepStrictEqual(
  db.read('users/6001.json'),
  {
    id: 6001,
    username: 'user_6001',
    balance: 60010,
    enabled: false
  }
);

db.close();

const stats = fs.statSync(databasePath);

console.log(`Размер базы: ${(stats.size / 1024 / 1024).toFixed(2)} МБ`);
console.log('MTDB stress test: OK');