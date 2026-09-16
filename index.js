'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('./lib/database.js');
const {rebuildIndex} = require('./lib/recovery.js');
const {
  HEADER_SIZE,
  BUCKET_COUNT,
  BUCKET_SIZE,
  HEADER_STATE_OFFSET,
  HEADER_STATES,
  DATA_OFFSET
} = require('./lib/constants.js');
const {
  createHeader,
  validateHeader
} = require('./lib/format.js');

const openedDatabases = new Map();

function createOpenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function open(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw createOpenError('MTDB_INVALID_FILE_PATH', 'Не передан корректный путь к MTDB');
  }

  const resolvedPath = resolveDatabasePath(filePath.trim());
  const pathKey = getPathKey(resolvedPath);
  if (openedDatabases.has(pathKey)) {
    throw createOpenError('MTDB_ALREADY_OPEN', `MTDB уже открыта в этом процессе: ${resolvedPath}`);
  }

  let fd;
  let writerLock;

  try {
    writerLock = acquireWriterLock(resolvedPath);
    fd = openOrCreateFile(resolvedPath);

    const header = validateDatabaseFile(fd);

    if (header.state === HEADER_STATES.DIRTY) {
      rebuildIndex(fd);
      writeDatabaseState(fd, HEADER_STATES.CLEAN);
      fs.fsyncSync(fd);
    }

    const db = new Database(resolvedPath, fd, () => {
      openedDatabases.delete(pathKey);
      releaseWriterLock(writerLock);
    });

    openedDatabases.set(pathKey, db);

    return db;
  }

  catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch {}
    }

    if (writerLock) {
      try {
        releaseWriterLock(writerLock);
      }

      catch {}
    }

    throw error;
  }
}

function acquireWriterLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const guard = acquireLockGuard(lockPath);

  try {
    let current = null;

    try {
      current = readWriterLock(lockPath);
    }

    catch (error) {
      if (error.code !== 'MTDB_LOCK_CHANGED') throw error;
    }

    if (current) {
      if (isProcessAlive(current.pid)) {
        throw createOpenError('MTDB_ALREADY_OPEN', `MTDB уже открыта процессом ${current.pid}: ${filePath}`);
      }

      try {
        fs.rmSync(lockPath);
      }

      catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    return createWriterLock(lockPath);
  }

  finally {
    releaseLockGuard(guard);
  }
}

function acquireLockGuard(lockPath) {
  const guardPath = `${lockPath}.guard`;

  let fd;

  try {
    fd = fs.openSync(guardPath, 'wx');
  }

  catch (error) {
    if (error.code === 'EEXIST') {
      throw createOpenError('MTDB_LOCK_GUARD_EXISTS', `Writer-lock MTDB уже находится в процессе восстановления: ${guardPath}`);
    }

    throw error;
  }

  return {
    path: guardPath,
    fd
  };
}

function releaseLockGuard(guard) {
  try {
    fs.closeSync(guard.fd);
  }

  catch {}

  try {
    fs.rmSync(guard.path, {
      force: true
    });
  }

  catch {}
}

function createWriterLock(lockPath) {
  const info = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: Date.now()
  };

  const data = Buffer.from(`${JSON.stringify(info)}\n`, 'utf8');

  let fd;
  let created = false;

  try {
    fd = fs.openSync(lockPath, 'wx');
    created = true;

    writeExactly(fd, data, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    fd = undefined;

    return {
      path: lockPath,
      pid: info.pid,
      token: info.token
    };
  }

  catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch {}
    }

    if (created) {
      try {
        fs.rmSync(lockPath);
      }

      catch {}
    }

    throw error;
  }
}

function readWriterLock(lockPath) {
  let content;

  try {
    content = fs.readFileSync(lockPath, 'utf8');
  }

  catch (error) {
    if (error.code === 'ENOENT') {
      throw createOpenError('MTDB_LOCK_CHANGED', `Writer-lock MTDB исчез во время проверки: ${lockPath}`);
    }

    throw error;
  }

  let info;

  try {
    info = JSON.parse(content);
  }

  catch {
    throw createOpenError('MTDB_CORRUPTED_LOCK', `Повреждён writer-lock MTDB: ${lockPath}`);
  }

  if (!Number.isSafeInteger(info?.pid) || info.pid <= 0 || typeof info?.token !== 'string' || !info.token) {
    throw createOpenError('MTDB_CORRUPTED_LOCK', `Некорректный writer-lock MTDB: ${lockPath}`);
  }

  return info;
}

function releaseWriterLock(lock) {
  let current;

  try {
    current = readWriterLock(lock.path);
  }

  catch (error) {
    if (error.code === 'MTDB_LOCK_CHANGED' || error.code === 'ENOENT') return false;
    throw error;
  }

  if (current.pid !== lock.pid || current.token !== lock.token) {
    throw createOpenError('MTDB_LOCK_OWNERSHIP_LOST', `Writer-lock MTDB принадлежит другому владельцу: ${lock.path}`);
  }

  fs.rmSync(lock.path);

  return true;
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;

  try {
    process.kill(pid, 0);
    return true;
  }

  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;

    throw error;
  }
}

function resolveDatabasePath(filePath) {
  const resolvedPath = path.resolve(filePath);

  if (path.extname(resolvedPath).toLowerCase() !== '.mtdb') {
    throw createOpenError('MTDB_INVALID_FILE_EXTENSION', 'Файл MTDB должен иметь расширение .mtdb');
  }

  const parentPath = fs.realpathSync.native(path.dirname(resolvedPath));
  const canonicalPath = path.join(parentPath, path.basename(resolvedPath));

  let stats;

  try {
    stats = fs.lstatSync(canonicalPath);
  }

  catch (error) {
    if (error.code === 'ENOENT') return canonicalPath;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw createOpenError('MTDB_SYMLINK_UNSUPPORTED', `MTDB нельзя открывать через symbolic link: ${canonicalPath}`);
  }

  return canonicalPath;
}

function openOrCreateFile(filePath) {
  const tempPath = `${filePath}.create.tmp`;

  fs.rmSync(tempPath, {
    force: true
  });

  try {
    return fs.openSync(filePath, 'r+');
  }

  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let fd;

  try {
    fd = fs.openSync(tempPath, 'wx+');

    initializeDatabaseFile(fd);

    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(
      tempPath,
      filePath
    );

    return fs.openSync(filePath, 'r+');
  }

  catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch {}
    }

    try {
      fs.rmSync(tempPath, {
        force: true
      });
    }

    catch {}

    throw error;
  }
}

function initializeDatabaseFile(fd) {
  const header = createHeader();
  const index = Buffer.alloc(BUCKET_COUNT * BUCKET_SIZE);

  writeExactly(fd, header, 0);
  writeExactly(fd, index, HEADER_SIZE);

  fs.fsyncSync(fd);
}

function validateDatabaseFile(fd) {
  const stats = fs.fstatSync(fd);

  if (!stats.isFile()) {
    throw createOpenError('MTDB_PATH_NOT_FILE', 'Путь MTDB не является обычным файлом');
  }

  if (stats.nlink > 1) {
    throw createOpenError('MTDB_HARDLINK_UNSUPPORTED', 'MTDB нельзя использовать через hard link');
  }

  if (stats.size < DATA_OFFSET) {
    throw createOpenError('MTDB_CORRUPTED_FILE', 'Размер файла MTDB меньше минимально допустимого');
  }

  const header = Buffer.alloc(HEADER_SIZE);

  readExactly(fd, header, 0);

  return validateHeader(header);
}

function writeDatabaseState(fd, state) {
  const buffer = Buffer.from([state]);
  writeExactly(fd, buffer, HEADER_STATE_OFFSET);
}

function readExactly(fd, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);

    if (bytesRead === 0) {
      throw createOpenError('MTDB_UNEXPECTED_EOF', 'Неожиданный конец файла MTDB');
    }

    offset += bytesRead;
  }
}

function writeExactly(fd, buffer, position) {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesWritten = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);

    if (bytesWritten === 0) {
      throw createOpenError('MTDB_WRITE_FAILED', 'Не удалось завершить запись файла MTDB');
    }

    offset += bytesWritten;
  }
}

function getPathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

module.exports = {
  open
};