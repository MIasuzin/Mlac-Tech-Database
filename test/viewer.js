'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const HEADER_SIZE = 4096;
const BUCKET_COUNT = 65536;
const BUCKET_SIZE = 8;
const DATA_OFFSET = HEADER_SIZE + BUCKET_COUNT * BUCKET_SIZE;
const RECORD_HEADER_SIZE = 32;
const MAX_PATH_LENGTH = 1024;
const MAX_JSON_SIZE = 100 * 1024 * 1024;

const RECORD_TYPES = Object.freeze({
  DIRECTORY: 1,
  WRITE: 2,
  DELETE: 3
});

const databasePath = path.resolve(process.argv[2] || './data.mtdb');
const port = Number(process.argv[3]) || 3210;

let fd = null;
let databaseSize = 0;
let files = new Map();
let directories = new Set();

function readExactly(buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);

    if (bytesRead === 0) {
      throw new Error(`Неожиданный конец файла на позиции ${position + offset}`);
    }

    offset += bytesRead;
  }
}

function validateDatabase() {
  const stats = fs.fstatSync(fd);

  if (!stats.isFile()) {
    throw new Error('Указанный путь не является файлом');
  }

  if (stats.size < DATA_OFFSET) {
    throw new Error('Файл слишком мал для MTDB');
  }

  databaseSize = stats.size;

  const header = Buffer.alloc(HEADER_SIZE);
  readExactly(header, 0);

  if (header.toString('ascii', 0, 4) !== 'MTDB') {
    throw new Error('Файл не является MTDB');
  }

  const version = header.readUInt32LE(4);
  const bucketCount = header.readUInt32LE(8);
  const dataOffset = Number(header.readBigUInt64LE(16));

  if (version !== 1) {
    throw new Error(`Неподдерживаемая версия MTDB: ${version}`);
  }

  if (bucketCount !== BUCKET_COUNT) {
    throw new Error(`Некорректное количество bucket: ${bucketCount}`);
  }

  if (dataOffset !== DATA_OFFSET) {
    throw new Error(`Некорректное начало области данных: ${dataOffset}`);
  }
}

function scanDatabase() {
  const nextFiles = new Map();
  const nextDirectories = new Set();

  const stats = fs.fstatSync(fd);
  databaseSize = stats.size;

  let offset = DATA_OFFSET;
  let records = 0;

  while (offset < databaseSize) {
    if (offset + RECORD_HEADER_SIZE > databaseSize) {
      throw new Error(`Обрезанный заголовок записи на позиции ${offset}`);
    }

    const header = Buffer.alloc(RECORD_HEADER_SIZE);
    readExactly(header, offset);

    if (header.toString('ascii', 0, 4) !== 'MTR1') {
      throw new Error(`Некорректная сигнатура записи на позиции ${offset}`);
    }

    const type = header.readUInt8(4);
    const pathLength = header.readUInt32LE(8);
    const dataLength = header.readUInt32LE(12);

    if (![RECORD_TYPES.DIRECTORY, RECORD_TYPES.WRITE, RECORD_TYPES.DELETE].includes(type)) {
      throw new Error(`Некорректный тип записи ${type} на позиции ${offset}`);
    }

    if (pathLength === 0 || pathLength > MAX_PATH_LENGTH) {
      throw new Error(`Некорректная длина пути на позиции ${offset}`);
    }

    if (dataLength > MAX_JSON_SIZE) {
      throw new Error(`Некорректный размер JSON на позиции ${offset}`);
    }

    const recordSize = RECORD_HEADER_SIZE + pathLength + dataLength;

    if (offset + recordSize > databaseSize) {
      throw new Error(`Запись на позиции ${offset} выходит за границы файла`);
    }

    const pathBuffer = Buffer.alloc(pathLength);
    readExactly(pathBuffer, offset + RECORD_HEADER_SIZE);

    const entryPath = pathBuffer.toString('utf8');

    if (type === RECORD_TYPES.DIRECTORY) {
      nextDirectories.add(entryPath);
    }

    if (type === RECORD_TYPES.WRITE) {
      nextFiles.set(entryPath, {
        path: entryPath,
        recordOffset: offset,
        dataOffset: offset + RECORD_HEADER_SIZE + pathLength,
        size: dataLength
      });
    }

    if (type === RECORD_TYPES.DELETE) {
      nextFiles.delete(entryPath);
    }

    records += 1;
    offset += recordSize;
  }

  files = nextFiles;
  directories = nextDirectories;

  return {
    records,
    files: files.size,
    directories: directories.size,
    size: databaseSize
  };
}

function readJson(entryPath) {
  const entry = files.get(entryPath);

  if (!entry) {
    return null;
  }

  const buffer = Buffer.alloc(entry.size);
  readExactly(buffer, entry.dataOffset);

  const raw = buffer.toString('utf8');

  try {
    return JSON.parse(raw);
  }

  catch (error) {
    throw new Error(`Некорректный JSON ${entryPath}: ${error.message}`);
  }
}

function sendJson(res, statusCode, value) {
  const data = JSON.stringify(value);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });

  res.end(data);
}

function formatFileSize(value) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} КБ`;
  return `${(value / 1024 / 1024).toFixed(2)} МБ`;
}

function createHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MTDB Viewer</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  height: 100vh;
  overflow: hidden;
  font-family: Consolas, "Courier New", monospace;
  background: #111;
  color: #ddd;
}

header {
  height: 54px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 18px;
  border-bottom: 1px solid #333;
  background: #181818;
}

header strong {
  color: #fff;
}

header span {
  color: #888;
  font-size: 13px;
}

button, input {
  font: inherit;
}

button {
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  padding: 6px 10px;
  cursor: pointer;
}

button:hover {
  background: #2d2d2d;
}

main {
  display: grid;
  grid-template-columns: 360px 1fr;
  height: calc(100vh - 54px);
}

aside {
  overflow: auto;
  padding: 12px;
  border-right: 1px solid #333;
  background: #161616;
}

#search {
  width: 100%;
  margin-bottom: 12px;
  padding: 8px;
  border: 1px solid #444;
  outline: none;
  background: #202020;
  color: #fff;
}

.tree {
  font-size: 13px;
}

.tree ul {
  margin: 0;
  padding-left: 18px;
  list-style: none;
}

.tree > ul {
  padding-left: 0;
}

.directory > .name {
  color: #e0b95c;
  cursor: pointer;
  user-select: none;
}

.file {
  color: #8ab4f8;
  padding: 3px 4px;
  cursor: pointer;
}

.file:hover {
  background: #292929;
}

.file.active {
  background: #343434;
  color: #fff;
}

.content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.file-header {
  min-height: 42px;
  display: flex;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid #333;
  color: #aaa;
}

pre {
  flex: 1;
  margin: 0;
  overflow: auto;
  padding: 18px;
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
  color: #ddd;
}

.empty {
  color: #666;
  padding: 8px;
}
</style>
</head>
<body>

<header>
  <strong>MTDB Viewer</strong>
  <span id="stats">Загрузка...</span>
  <button id="refresh">Обновить</button>
</header>

<main>
  <aside>
    <input id="search" type="text" placeholder="Поиск файла...">
    <div id="tree" class="tree"></div>
  </aside>

  <section class="content">
    <div id="fileHeader" class="file-header">Выберите JSON</div>
    <pre id="content"></pre>
  </section>
</main>

<script>
'use strict';

let state = null;
let selectedPath = null;

const treeElement = document.getElementById('tree');
const contentElement = document.getElementById('content');
const fileHeaderElement = document.getElementById('fileHeader');
const statsElement = document.getElementById('stats');
const searchElement = document.getElementById('search');

async function loadState() {
  const response = await fetch('/api/tree', {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error('Не удалось получить структуру MTDB');
  }

  state = await response.json();

  statsElement.textContent =
    state.files.length + ' файлов • ' +
    state.directories.length + ' каталогов • ' +
    state.sizeFormatted;

  renderTree();
}

function createNode() {
  return {
    directories: new Map(),
    files: []
  };
}

function buildTree() {
  const root = createNode();

  function ensureDirectory(directoryPath) {
    let node = root;

    if (!directoryPath) {
      return node;
    }

    for (const segment of directoryPath.split('/')) {
      if (!node.directories.has(segment)) {
        node.directories.set(segment, createNode());
      }

      node = node.directories.get(segment);
    }

    return node;
  }

  for (const directoryPath of state.directories) {
    ensureDirectory(directoryPath);
  }

  for (const file of state.files) {
    const parts = file.path.split('/');
    const fileName = parts.pop();
    const directoryPath = parts.join('/');
    const node = ensureDirectory(directoryPath);

    node.files.push({
      name: fileName,
      path: file.path,
      size: file.size
    });
  }

  return root;
}

function renderTree() {
  treeElement.replaceChildren();

  const search = searchElement.value.trim().toLowerCase();

  if (search) {
    renderSearch(search);
    return;
  }

  const root = buildTree();
  const list = document.createElement('ul');

  renderNode(root, list);

  treeElement.appendChild(list);
}

function renderNode(node, parent) {
  const directoryEntries = [...node.directories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const fileEntries = [...node.files].sort((a, b) => a.name.localeCompare(b.name));

  for (const [name, directory] of directoryEntries) {
    const item = document.createElement('li');
    item.className = 'directory';

    const title = document.createElement('div');
    title.className = 'name';
    title.textContent = '▾ ' + name;

    const children = document.createElement('ul');

    title.addEventListener('click', () => {
      const hidden = children.hidden;
      children.hidden = !hidden;
      title.textContent = (hidden ? '▾ ' : '▸ ') + name;
    });

    renderNode(directory, children);

    item.appendChild(title);
    item.appendChild(children);
    parent.appendChild(item);
  }

  for (const file of fileEntries) {
    parent.appendChild(createFileElement(file));
  }
}

function renderSearch(search) {
  const files = state.files.filter((file) => {
    return file.path.toLowerCase().includes(search);
  });

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Ничего не найдено';
    treeElement.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');

  for (const file of files) {
    list.appendChild(createFileElement({
      name: file.path,
      path: file.path,
      size: file.size
    }));
  }

  treeElement.appendChild(list);
}

function createFileElement(file) {
  const item = document.createElement('li');
  item.className = 'file';

  if (selectedPath === file.path) {
    item.classList.add('active');
  }

  item.textContent = file.name;
  item.title = file.path + ' • ' + formatBytes(file.size);

  item.addEventListener('click', () => {
    openFile(file.path);
  });

  return item;
}

async function openFile(filePath) {
  const response = await fetch('/api/file?path=' + encodeURIComponent(filePath), {
    cache: 'no-store'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Не удалось прочитать файл');
  }

  const value = await response.json();

  selectedPath = filePath;
  fileHeaderElement.textContent = filePath;
  contentElement.textContent = JSON.stringify(value, null, 2);

  renderTree();
}

function formatBytes(value) {
  if (value < 1024) return value + ' Б';
  if (value < 1024 * 1024) return (value / 1024).toFixed(2) + ' КБ';
  return (value / 1024 / 1024).toFixed(2) + ' МБ';
}

document.getElementById('refresh').addEventListener('click', async () => {
  const response = await fetch('/api/refresh', {
    method: 'POST'
  });

  if (!response.ok) {
    return;
  }

  await loadState();

  if (selectedPath) {
    const exists = state.files.some((file) => file.path === selectedPath);

    if (exists) {
      await openFile(selectedPath);
    }

    else {
      selectedPath = null;
      fileHeaderElement.textContent = 'Выберите JSON';
      contentElement.textContent = '';
    }
  }
});

searchElement.addEventListener('input', renderTree);

loadState().catch((error) => {
  contentElement.textContent = error.stack || error.message;
});
</script>

</body>
</html>`;
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = createHtml();

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html)
      });

      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tree') {
      sendJson(res, 200, {
        database: databasePath,
        size: databaseSize,
        sizeFormatted: formatFileSize(databaseSize),
        directories: [...directories].sort(),
        files: [...files.values()]
          .map((entry) => {
            return {
              path: entry.path,
              size: entry.size
            };
          })
          .sort((a, b) => a.path.localeCompare(b.path))
      });

      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      const entryPath = url.searchParams.get('path');

      if (!entryPath || !files.has(entryPath)) {
        sendJson(res, 404, {
          error: 'JSON не найден'
        });

        return;
      }

      sendJson(res, 200, readJson(entryPath));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const stats = scanDatabase();

      sendJson(res, 200, {
        ok: true,
        ...stats
      });

      return;
    }

    sendJson(res, 404, {
      error: 'Не найдено'
    });
  }

  catch (error) {
    console.error(`Ошибка: ${error.stack || error.message}`);

    sendJson(res, 500, {
      error: error.message
    });
  }
}

function close() {
  if (fd !== null) {
    fs.closeSync(fd);
    fd = null;
  }
}

function main() {
  if (path.extname(databasePath).toLowerCase() !== '.mtdb') {
    throw new Error('Укажите файл с расширением .mtdb');
  }

  fd = fs.openSync(databasePath, 'r');

  validateDatabase();

  const stats = scanDatabase();

  const server = http.createServer(handleRequest);

  server.listen(port, '127.0.0.1', () => {
    console.log(`Лог: Открыта база ${databasePath}`);
    console.log(`Лог: Файлов: ${stats.files}, каталогов: ${stats.directories}, записей: ${stats.records}`);
    console.log(`Лог: Размер: ${formatFileSize(stats.size)}`);
    console.log(`Лог: Просмотрщик: http://127.0.0.1:${port}`);
  });

  function shutdown() {
    server.close(() => {
      close();
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
}

catch (error) {
  close();
  console.error(`Ошибка: ${error.stack || error.message}`);
  process.exitCode = 1;
}