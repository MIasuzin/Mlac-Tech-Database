'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {performance} = require('perf_hooks');
const mtdb = require('mtdb');

const rootDir = __dirname;
const databasePath = path.join(rootDir, 'real-test.mtdb');

const storageDirectories = [
  'users',
  'sessions',
  'promocodes',
  'invoices',
  'statistics'
];

const storageFiles = [
  'settings.json',
  'clients.json'
];

function getJsonFilesRecursive(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const result = [];
  const entries = fs.readdirSync(directoryPath, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      result.push(...getJsonFilesRecursive(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      result.push(entryPath);
    }
  }

  return result;
}

function toMtdbPath(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
}

function formatBytes(value) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} КБ`;
  return `${(value / 1024 / 1024).toFixed(2)} МБ`;
}

function formatDuration(start, end) {
  return `${(end - start).toFixed(3)} мс`;
}

function collectStorageFiles() {
  const files = [];

  for (const directoryName of storageDirectories) {
    const directoryPath = path.join(rootDir, directoryName);
    files.push(...getJsonFilesRecursive(directoryPath));
  }

  for (const fileName of storageFiles) {
    const filePath = path.join(rootDir, fileName);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push(filePath);
    }
  }

  return files;
}

function removeOldTestDatabase() {
  if (!fs.existsSync(databasePath)) return;

  fs.unlinkSync(databasePath);
}

function main() {
  console.log('Лог: Начинаем проверку MTDB на реальных данных');

  const files = collectStorageFiles();

  if (files.length === 0) {
    throw new Error('Не найдено ни одного JSON-файла для проверки');
  }

  let sourceSize = 0;

  for (const filePath of files) {
    sourceSize += fs.statSync(filePath).size;
  }

  console.log(`Лог: Найдено JSON-файлов: ${files.length}`);
  console.log(`Лог: Общий размер исходных JSON: ${formatBytes(sourceSize)}`);

  removeOldTestDatabase();

  let db = mtdb.open(databasePath);

  for (const directoryName of storageDirectories) {
    db.mkdir(directoryName);
  }

  let start = performance.now();

  for (const filePath of files) {
    const mtdbPath = toMtdbPath(filePath);
    const parentPath = path.posix.dirname(mtdbPath);

    if (parentPath !== '.') {
      db.mkdir(parentPath);
    }

    const value = readJsonFile(filePath);

    db.write(mtdbPath, value);
  }

  let end = performance.now();

  console.log(`Лог: Импорт завершён за ${formatDuration(start, end)}`);
  console.log(`Лог: Скорость импорта: ${(files.length / ((end - start) / 1000)).toFixed(0)} JSON/с`);

  db.close();

  const databaseSize = fs.statSync(databasePath).size;

  console.log(`Лог: Размер MTDB после импорта: ${formatBytes(databaseSize)}`);

  start = performance.now();

  db = mtdb.open(databasePath);

  end = performance.now();

  console.log(`Лог: Повторное открытие MTDB: ${formatDuration(start, end)}`);

  start = performance.now();

  for (const filePath of files) {
    const mtdbPath = toMtdbPath(filePath);
    const sourceValue = readJsonFile(filePath);
    const mtdbValue = db.read(mtdbPath);

    assert.deepStrictEqual(
      mtdbValue,
      sourceValue,
      `Данные отличаются: ${mtdbPath}`
    );
  }

  end = performance.now();

  console.log(`Лог: Полная сверка MTDB завершена за ${formatDuration(start, end)}`);
  console.log(`Лог: Проверено JSON-файлов: ${files.length}`);

  start = performance.now();

  for (const filePath of files) {
    readJsonFile(filePath);
  }

  end = performance.now();

  const fsReadDuration = end - start;

  console.log(`Лог: Чтение всех JSON через fs: ${fsReadDuration.toFixed(3)} мс`);

  start = performance.now();

  for (const filePath of files) {
    db.read(toMtdbPath(filePath));
  }

  end = performance.now();

  const mtdbReadDuration = end - start;

  console.log(`Лог: Чтение всех JSON через MTDB: ${mtdbReadDuration.toFixed(3)} мс`);

  if (mtdbReadDuration > 0) {
    console.log(`Лог: Соотношение fs/MTDB: ${(fsReadDuration / mtdbReadDuration).toFixed(2)}x`);
  }

  db.close();

  console.log('');
  console.log('Лог: Все реальные данные совпадают');
  console.log(`Лог: Исходные JSON: ${formatBytes(sourceSize)}`);
  console.log(`Лог: MTDB: ${formatBytes(databaseSize)}`);
  console.log('Лог: Исходные файлы не изменялись');
}

try {
  main();
}

catch (error) {
  console.error(`Ошибка: ${error.stack || error.message}`);
  process.exitCode = 1;
}