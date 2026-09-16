'use strict';

const mtdb = require('..');

const [databasePath] = process.argv.slice(2);

if (!databasePath) {
  console.error('Ошибка: Не передан путь MTDB');
  process.exit(2);
}

const db = mtdb.open(databasePath);

process.stdout.write('MTDB_LOCK_READY\n');

setInterval(() => {
  db.read('users/base.json');
}, 1000);