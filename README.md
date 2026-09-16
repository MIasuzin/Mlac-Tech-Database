# MTDB

MTDB is a compact single-file JSON storage library for Node.js.

It provides a synchronous filesystem-like API for storing JSON documents inside a single `.mtdb` file, with crash recovery, checksums, compaction and single-writer protection.

```js
const mtdb = require('mtdb');

const db = mtdb.open('./data.mtdb');

db.mkdir('users');

db.write('users/1.json', {
  id: 1,
  name: 'Alice'
});

console.log(
  db.read('users/1.json')
);

db.close();
```

## Features

* Single `.mtdb` database file
* Synchronous API
* JSON document storage
* Virtual directories
* Crash recovery
* Record checksums
* Durable writes with commit records
* Rebuildable hash index
* Single-writer protection between processes
* Automatic stale writer-lock recovery
* Database compaction
* No runtime dependencies
* CommonJS API

## Installation

```bash
npm install mtdb
```

## Quick start

```js
const mtdb = require('mtdb');

const db = mtdb.open('./data.mtdb');

db.mkdir('users');

db.write('users/1.json', {
  id: 1,
  username: 'alice',
  active: true
});

const user = db.read('users/1.json');

console.log(user);

db.close();
```

Output:

```js
{
  id: 1,
  username: 'alice',
  active: true
}
```

## API

MTDB exposes one module-level function:

```js
mtdb.open(filePath);
```

An opened database exposes:

```js
db.mkdir(path);
db.list(path);
db.read(path);
db.write(path, value);
db.delete(path);
db.compact();
db.close();
```

Full API documentation:

```text
API.md
```

Error reference:

```text
ERRORS.md
```

## Opening a database

```js
const db = mtdb.open('./data.mtdb');
```

If the file does not exist, MTDB creates a new database.

Database files must use the `.mtdb` extension.

Only one writer may open a database at a time.

A second writer receives:

```text
MTDB_ALREADY_OPEN
```

## Directories

The database root exists implicitly.

Root-level JSON can therefore be written directly:

```js
db.write('settings.json', {
  enabled: true
});
```

Nested JSON requires its parent directory to exist:

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

`mkdir()` creates the complete missing directory chain:

```js
db.mkdir('data/users/archive');
```

## Writing JSON

```js
db.write('users/1.json', {
  id: 1,
  name: 'Alice'
});
```

Values are serialized using:

```js
JSON.stringify(value)
```

Writing to an existing path replaces its current logical value:

```js
db.write('users/1.json', {
  version: 1
});

db.write('users/1.json', {
  version: 2
});
```

The current value is now:

```js
{
  version: 2
}
```

Previous physical versions remain in the append-only history until compaction.

## Reading JSON

```js
const value = db.read('users/1.json');
```

If the JSON does not exist or has been deleted:

```js
db.read('users/missing.json');
```

returns:

```js
undefined
```

## Listing JSON

`list()` returns JSON files directly inside a directory.

It is not recursive.

```js
db.mkdir('users');
db.mkdir('users/archive');

db.write('users/1.json', {});
db.write('users/2.json', {});
db.write('users/archive/3.json', {});

console.log(
  db.list('users')
);
```

Result:

```js
[
  'users/1.json',
  'users/2.json'
]
```

To list the implicit root:

```js
db.list('');
```

## Deleting JSON

```js
db.delete('users/1.json');
```

Returns:

```js
true
```

when an existing JSON document was deleted.

Returns:

```js
false
```

when the document does not exist or is already deleted.

Deleted values remain as tombstones in the physical history until compaction.

## Compaction

MTDB uses an append-only mutation history.

Repeated writes and deletes therefore increase the database file size over time.

Use:

```js
const result = db.compact();
```

to rebuild the database with only its current logical state.

Example result:

```js
{
  beforeSize: 106723328,
  afterSize: 22512947,
  reclaimedBytes: 84210381,
  scannedRecords: 412455,
  writtenRecords: 76195,
  files: 75938,
  directories: 257,
  deleted: 24062,
  historical: 312198
}
```

`compact()` is synchronous and blocks other operations on the same database instance until it completes.

MTDB validates the new compacted file before replacing the current database.

## Closing

```js
db.close();
```

A successful first close returns:

```js
true
```

Calling it again returns:

```js
false
```

After close, database operations throw:

```text
MTDB_CLOSED
```

## Crash recovery

MTDB uses a record + commit journal protocol.

A mutation is not considered committed simply because its data record exists.

When a database is opened after an unclean shutdown, MTDB scans the journal and rebuilds its index from committed operations.

Incomplete trailing operations are discarded.

Committed records with damaged structure or invalid checksums are not silently ignored.

Depending on the corruption, opening the database may fail with errors such as:

```text
MTDB_CORRUPTED_RECORD
MTDB_CORRUPTED_LOG
MTDB_CORRUPTED_FILE
```

See `ERRORS.md` for details.

## Recovery-required state

An I/O error may occur after only part of a mutation has reached disk.

When MTDB can no longer safely continue using the current runtime state, the database instance enters a recovery-required state.

Further operations throw:

```text
MTDB_RECOVERY_REQUIRED
```

Only `close()` should then be used.

Reopen the database before continuing:

```js
db.close();

const db2 = mtdb.open('./data.mtdb');
```

Recovery is performed during `open()` when required.

## Writer protection

MTDB allows only one writer for a physical database file.

Protection includes:

* duplicate opens in the same process;
* writer processes competing for the same database;
* stale writer locks after process termination;
* rejection of symbolic-link writer aliases;
* rejection of hard-linked database files.

MTDB intentionally prefers refusing access over risking multiple concurrent writers.

## Paths

MTDB uses virtual relative paths.

Valid examples:

```text
settings.json
users/1.json
users/archive/1.json
```

Backslashes are normalized to `/`:

```js
db.read('users\\1.json');
```

is equivalent to:

```js
db.read('users/1.json');
```

Invalid examples:

```text
/users/1.json
C:/users/1.json
C:users/1.json
users//1.json
users/../1.json
users/
```

JSON paths must end with `.json`.

Path segments `.` and `..` are not allowed.

## Limits

Maximum JSON size:

```text
100 MiB
```

Maximum normalized path size:

```text
1024 UTF-8 bytes
```

Database format:

```text
MTDB format version 2
```

## Current limitations

MTDB currently:

* uses a synchronous API;
* supports JSON only;
* supports one writer per database;
* has no read-only API;
* has no transactions;
* has no query language;
* has no secondary indexes;
* has no `find()` API;
* has no `exists()` API;
* has no watchers;
* has no directory deletion API;
* does not run compaction automatically.

MTDB is intended as a small embedded storage layer rather than a replacement for a relational or distributed database.

## Error handling

All MTDB-specific errors expose:

```js
error.code
```

Example:

```js
try {
  db.write('users/1.json', value);
}

catch (error) {
  if (error.code === 'MTDB_JSON_TOO_LARGE') {
    console.error('JSON is too large');
  }

  throw error;
}
```

Do not rely on `error.message` for program logic.

See:

```text
ERRORS.md
```

for the complete error reference.

## Database files

A database normally consists of:

```text
data.mtdb
```

During operation MTDB may also temporarily create internal files such as:

```text
data.mtdb.lock
data.mtdb.lock.guard
data.mtdb.create.tmp
data.mtdb.compact.tmp
```

These files are implementation details.

Do not modify or remove them while an MTDB process may be using the database.

## Documentation

* `API.md` — public API reference
* `ERRORS.md` — error codes and recovery behavior
* `FORMAT.md` — on-disk format
* `CHANGELOG.md` — release history
