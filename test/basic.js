'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mtdb = require('..');

const databasePath = path.join(__dirname, 'data.mtdb');

try {
  fs.unlinkSync(databasePath);
}

catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let db = mtdb.open(databasePath);

assert.strictEqual(
  db.mkdir('users/archive/2026'),
  true
);

assert.strictEqual(
  db.mkdir('users/archive/2026'),
  false
);

db.write('settings.json', {
  enabled: true
});

db.write('users/123.json', {
  id: 123,
  balance: 100
});

assert.deepStrictEqual(
  db.read('settings.json'),
  {
    enabled: true
  }
);

assert.deepStrictEqual(
  db.read('users/123.json'),
  {
    id: 123,
    balance: 100
  }
);

db.write('users/123.json', {
  id: 123,
  balance: 500
});

assert.deepStrictEqual(
  db.read('users/123.json'),
  {
    id: 123,
    balance: 500
  }
);

assert.strictEqual(
  db.delete('users/123.json'),
  true
);

assert.strictEqual(
  db.delete('users/123.json'),
  false
);

assert.strictEqual(
  db.read('users/123.json'),
  undefined
);

assert.throws(
  () => {
    db.write('missing/1.json', {
      id: 1
    });
  },
  (error) => {
    return error.code === 'MTDB_DIRECTORY_NOT_FOUND';
  }
);

assert.strictEqual(
  db.close(),
  true
);

assert.throws(
  () => {
    db.read('settings.json');
  },
  (error) => {
    return error.code === 'MTDB_CLOSED';
  }
);

db = mtdb.open(databasePath);

assert.deepStrictEqual(
  db.read('settings.json'),
  {
    enabled: true
  }
);

assert.strictEqual(
  db.read('users/123.json'),
  undefined
);

db.close();

console.log('MTDB basic test: OK');