# MTDB File Format

This document describes the on-disk format used by MTDB.

Current format version:

```text
2
```

The format is little-endian.

An MTDB database consists of three main regions:

```text
+-----------------------------+
| Header                      |
| 4096 bytes                  |
+-----------------------------+
| Hash bucket index           |
| 65536 × 8 bytes             |
+-----------------------------+
| Append-only record journal  |
| variable size               |
+-----------------------------+
```

The first data record starts at:

```text
528384
```

bytes from the beginning of the file.

---

# General layout

Constants:

```text
HEADER_SIZE        = 4096
BUCKET_COUNT       = 65536
BUCKET_SIZE        = 8
INDEX_OFFSET       = 4096
DATA_OFFSET        = 528384
RECORD_HEADER_SIZE = 32
MAX_PATH_LENGTH    = 1024
MAX_JSON_SIZE      = 104857600
```

`DATA_OFFSET` is calculated as:

```text
HEADER_SIZE + BUCKET_COUNT × BUCKET_SIZE
```

which gives:

```text
4096 + 65536 × 8 = 528384
```

The file must be at least `DATA_OFFSET` bytes long.

---

# Header

The database header occupies the first:

```text
4096 bytes
```

of the file.

Layout:

| Offset | Size | Type      | Field          |
| -----: | ---: | --------- | -------------- |
|    `0` |    4 | bytes     | File magic     |
|    `4` |    4 | uint32 LE | Format version |
|    `8` |    4 | uint32 LE | Bucket count   |
|   `12` |    1 | uint8     | Database state |
|   `13` |    3 | reserved  | Reserved       |
|   `16` |    8 | uint64 LE | Data offset    |
|   `24` | 4072 | reserved  | Reserved       |

## File magic

Bytes:

```text
4D 54 44 42
```

ASCII:

```text
MTDB
```

A file without this signature is not considered an MTDB database.

## Version

Current value:

```text
2
```

Stored as:

```text
uint32 little-endian
```

Files using another version are rejected with:

```text
MTDB_UNSUPPORTED_VERSION
```

Format versions are not assumed to be backward compatible.

## Bucket count

Current value:

```text
65536
```

Stored as:

```text
uint32 little-endian
```

A different value is considered an invalid index configuration.

## Database state

Stored at byte:

```text
12
```

Values:

| Value | Name    |
| ----: | ------- |
|   `0` | `CLEAN` |
|   `1` | `DIRTY` |

Any other value is invalid.

### CLEAN

`CLEAN` means the previous writer completed its lifecycle normally and no recovery is required solely because of the header state.

### DIRTY

`DIRTY` means the database may contain mutations written after the last clean state.

When a database is opened in `DIRTY` state, MTDB reconstructs its index from the append-only journal before returning the database instance.

## Data offset

Stored at:

```text
16
```

as:

```text
uint64 little-endian
```

Current value:

```text
528384
```

The value must exactly match the data offset expected by the current format version.

---

# Hash bucket index

The index begins at:

```text
4096
```

and contains:

```text
65536
```

buckets.

Each bucket is:

```text
8 bytes
```

and stores one:

```text
uint64 little-endian
```

file offset.

Total size:

```text
65536 × 8 = 524288 bytes
```

The index therefore occupies:

```text
4096 .. 528383
```

The record journal begins immediately after it.

## Bucket value

A value of:

```text
0
```

means that the bucket is empty.

Any non-zero value points to the most recent ordinary record in that bucket.

The index must never point directly to a `COMMIT` record.

## Bucket selection

Paths are hashed using 32-bit FNV-1a over the UTF-8 encoded normalized path.

The bucket is selected as:

```text
hashPath(path) % 65536
```

Different paths may map to the same bucket.

Collisions are resolved through record chains using `previousOffset`.

## Bucket chains

Every ordinary record stores the previous head of its bucket in:

```text
previousOffset
```

Example:

```text
bucket[123]
    |
    v
record C
    |
    previousOffset
    v
record B
    |
    previousOffset
    v
record A
    |
    previousOffset = 0
```

The index points only to the newest record.

Older records remain reachable through the linked chain until compaction removes obsolete history.

Offsets must always point backward:

```text
previousOffset < currentRecordOffset
```

except:

```text
previousOffset = 0
```

which terminates the chain.

---

# Record journal

The journal starts at:

```text
DATA_OFFSET = 528384
```

Records are appended sequentially.

There is no free-space allocator.

Normal mutations do not overwrite existing journal records.

A record consists of:

```text
32-byte header
UTF-8 path
optional data
```

Layout:

```text
+----------------------+
| Record header        |
| 32 bytes             |
+----------------------+
| Path                 |
| pathLength bytes     |
+----------------------+
| Data                 |
| dataLength bytes     |
+----------------------+
```

Total record size:

```text
32 + pathLength + dataLength
```

---

# Record header

Each record begins with a fixed-size:

```text
32-byte
```

header.

Layout:

| Offset | Size | Type      | Field           |
| -----: | ---: | --------- | --------------- |
|    `0` |    4 | bytes     | Record magic    |
|    `4` |    1 | uint8     | Record type     |
|    `5` |    3 | reserved  | Reserved        |
|    `8` |    4 | uint32 LE | Path length     |
|   `12` |    4 | uint32 LE | Data length     |
|   `16` |    8 | uint64 LE | Previous offset |
|   `24` |    4 | uint32 LE | CRC32 checksum  |
|   `28` |    4 | reserved  | Reserved        |

## Record magic

ASCII:

```text
MTR1
```

Bytes:

```text
4D 54 52 31
```

A record with another signature is considered corrupted.

## Record type

Supported values:

| Value | Type        |
| ----: | ----------- |
|   `1` | `DIRECTORY` |
|   `2` | `WRITE`     |
|   `3` | `DELETE`    |
|   `4` | `COMMIT`    |

Unknown types are invalid.

## Path length

Stored as:

```text
uint32 little-endian
```

Limits:

```text
1 .. 1024 bytes
```

The length refers to the UTF-8 byte representation, not the JavaScript character count.

## Data length

Stored as:

```text
uint32 little-endian
```

Maximum:

```text
104857600 bytes
```

or:

```text
100 MiB
```

`DIRECTORY`, `DELETE` and `COMMIT` records must have:

```text
dataLength = 0
```

## Previous offset

Stored as:

```text
uint64 little-endian
```

Its meaning depends on the record type.

For ordinary records:

```text
DIRECTORY
WRITE
DELETE
```

`previousOffset` points to the previous ordinary record in the same hash bucket.

For:

```text
COMMIT
```

`previousOffset` points to the ordinary record being committed.

---

# Record types

## DIRECTORY

Represents the existence of a virtual directory.

Example logical path:

```text
users/archive
```

Properties:

```text
type = 1
dataLength = 0
```

Directories are explicit records except for the implicit database root.

The root itself has no `DIRECTORY` record.

## WRITE

Stores the current serialized JSON payload for a path.

Example:

```text
users/1.json
```

Properties:

```text
type = 2
```

The data section contains the UTF-8 output of:

```js
JSON.stringify(value)
```

A newer `WRITE` for the same path supersedes older versions logically but does not immediately remove them physically.

## DELETE

Represents a tombstone for a JSON path.

Properties:

```text
type = 3
dataLength = 0
```

A `DELETE` supersedes previous `WRITE` records for the same path.

The old records remain physically present until compaction.

## COMMIT

Confirms the immediately preceding ordinary mutation.

Properties:

```text
type = 4
dataLength = 0
```

Its path must match the path of the pending ordinary record.

Its:

```text
previousOffset
```

must equal the physical file offset of that ordinary record.

Example:

```text
WRITE users/1.json at offset 600000
COMMIT users/1.json previousOffset=600000
```

The bucket index points to:

```text
600000
```

not to the COMMIT record.

---

# Checksum

Every record contains a CRC32 checksum.

MTDB uses CRC32 with the reflected polynomial:

```text
0xEDB88320
```

The checksum is calculated over:

```text
metadata
path
data
```

The checksum metadata is exactly 17 bytes:

| Offset | Size | Field           |
| -----: | ---: | --------------- |
|    `0` |    1 | Record type     |
|    `1` |    4 | Path length     |
|    `5` |    4 | Data length     |
|    `9` |    8 | Previous offset |

All integer metadata fields use little-endian encoding.

Conceptually:

```text
CRC32(
  type +
  pathLength +
  dataLength +
  previousOffset +
  pathBytes +
  dataBytes
)
```

The record magic and stored checksum field itself are not part of the checksum input.

CRC32 is intended to detect accidental corruption.

It is not a cryptographic integrity mechanism.

---

# Mutation protocol

A logical mutation is represented by two physical records:

```text
ordinary record
COMMIT record
```

Ordinary record means one of:

```text
DIRECTORY
WRITE
DELETE
```

For a normal mutation, MTDB performs the following sequence.

## 1. Mark database DIRTY

If the current writer has not already marked the database dirty:

```text
header.state = DIRTY
fsync
```

The database remains `DIRTY` across further mutations until clean shutdown.

## 2. Append ordinary record

The ordinary mutation record is appended at the current end of file.

Its:

```text
previousOffset
```

is the current head of the corresponding hash bucket.

## 3. Append COMMIT

A matching `COMMIT` record is appended immediately after the ordinary record.

The commit contains:

```text
same path
previousOffset = ordinaryRecordOffset
```

## 4. Flush journal

MTDB performs:

```text
fsync
```

after both records have been written.

At this point the mutation is recoverable from the journal even if the bucket index has not yet been updated.

## 5. Update bucket

The bucket is changed to point to the newly committed ordinary record.

## 6. Flush index

MTDB performs another:

```text
fsync
```

After this step both the journal and runtime index reflect the mutation.

---

# Example mutation

Suppose:

```text
users/1.json
```

hashes to bucket:

```text
1234
```

and that bucket currently contains:

```text
700000
```

A new write is appended at:

```text
800000
```

The ordinary record contains:

```text
type           = WRITE
path           = users/1.json
previousOffset = 700000
```

A COMMIT follows it:

```text
type           = COMMIT
path           = users/1.json
previousOffset = 800000
```

After both records are durable:

```text
bucket[1234] = 800000
```

---

# Recovery

Recovery reconstructs the index from the journal rather than trusting the existing on-disk bucket table.

Recovery starts at:

```text
DATA_OFFSET
```

and scans records sequentially to the end of the file.

It maintains at most one pending ordinary record.

## Ordinary record

For each ordinary record recovery:

1. validates its record structure;
2. validates CRC32;
3. validates the stored path;
4. calculates its expected bucket;
5. determines the current rebuilt bucket head;
6. verifies that `previousOffset` matches that head;
7. stores the record as pending.

The rebuilt index is not updated yet.

## COMMIT record

For a COMMIT recovery requires:

* a pending ordinary record exists;
* paths are identical;
* `COMMIT.previousOffset` equals the pending record's physical offset.

Only then is the pending mutation considered committed.

The rebuilt bucket is updated to:

```text
pendingRecord.offset
```

The pending state is then cleared.

---

# Recovery invariants

Valid journal sequence:

```text
RECORD
COMMIT
RECORD
COMMIT
RECORD
COMMIT
```

Invalid examples include:

```text
COMMIT
```

without a pending record.

Or:

```text
RECORD
RECORD
```

without a COMMIT between them.

Or:

```text
WRITE users/1.json
COMMIT users/2.json
```

Or a COMMIT whose `previousOffset` does not point to the pending record.

These conditions produce:

```text
MTDB_CORRUPTED_LOG
```

---

# Incomplete tail

A process can terminate while writing the final mutation.

Examples:

```text
partial ordinary record
```

or:

```text
complete ordinary record
partial COMMIT
```

or:

```text
complete ordinary record
no COMMIT
```

If the corruption is limited to an incomplete uncommitted tail, recovery truncates the file back to the end of the last successfully committed mutation.

Conceptually:

```text
committed
committed
committed
uncommitted/torn data
                         ^
                         removed
```

The committed prefix is retained.

---

# Confirmed corruption

Recovery does not silently discard corruption inside already established journal history.

Examples:

* invalid record magic;
* invalid record type;
* invalid checksum;
* invalid stored path;
* invalid bucket chain;
* mismatched COMMIT;
* COMMIT without a pending record.

These conditions are reported as corruption rather than interpreted as an incomplete tail.

---

# Index reconstruction

During recovery MTDB creates a new in-memory bucket index initialized with zero offsets.

Committed mutations are replayed sequentially into it.

At the end, the rebuilt index is compared with the index stored in the `.mtdb` file.

If they differ, the on-disk index is replaced with the rebuilt index.

The replacement is flushed using:

```text
fsync
```

This makes the hash index a recoverable acceleration structure rather than the authoritative history of committed mutations.

The append-only journal is the source used to reconstruct it.

---

# CLEAN / DIRTY lifecycle

Normal lifecycle:

```text
open CLEAN database
       |
       v
first mutation
       |
       v
write DIRTY + fsync
       |
       v
mutations...
       |
       v
close()
       |
       v
write CLEAN + fsync
       |
       v
close fd
```

If the process terminates before the clean close:

```text
state remains DIRTY
```

The next writer performs journal recovery before changing the header back to:

```text
CLEAN
```

If an I/O error leaves the current runtime instance in an uncertain state, MTDB does not mark the file clean during `close()`.

That allows the next `open()` to perform recovery.

---

# Compaction

Normal mutations are append-only.

Therefore:

* old overwritten JSON versions;
* DELETE tombstones;
* obsolete DIRECTORY history

accumulate over time.

`compact()` creates a new database containing only the current logical state.

## Compact input

The current bucket chains are traversed.

For every path, only the newest logical record is relevant.

If the newest record is:

```text
DELETE
```

the path is not copied.

If it is:

```text
WRITE
```

or:

```text
DIRECTORY
```

the record is retained.

Historical versions are discarded.

---

# Compact output

The temporary compact file contains:

```text
new CLEAN header
new bucket index
current DIRECTORY records
current WRITE records
matching COMMIT records
```

No tombstones are required because deleted paths simply do not exist in the new logical history.

Every copied ordinary record receives a new physical offset.

Its new `previousOffset` is rebuilt according to the compact file's bucket chain.

The corresponding COMMIT points to the new ordinary record offset.

---

# Compact validation

Before replacing the original file, MTDB runs the same index reconstruction logic over the completed temporary database.

Validation requires:

```text
indexChanged = false
truncatedBytes = 0
```

If reconstruction changes the temporary index or truncates data, compaction fails with:

```text
MTDB_COMPACT_VALIDATION_FAILED
```

The invalid compact file must not replace the original database.

---

# Compact replacement

The compact file is written to:

```text
<database>.compact.tmp
```

After writing and validation:

1. temporary file is `fsync`ed;
2. temporary file is closed;
3. current database descriptor is flushed and closed;
4. temporary file is renamed over the main `.mtdb`;
5. the new main database is reopened.

This preserves the logical database through tested process-crash points around compact replacement.

Physical power-loss guarantees during the filesystem rename itself depend on the operating system, filesystem and storage hardware.

---

# New database creation

A new database is first initialized in:

```text
<database>.create.tmp
```

The temporary file receives:

```text
CLEAN header
empty bucket index
fsync
```

Only after successful initialization is it renamed to the final:

```text
<database>.mtdb
```

This avoids leaving a partially initialized main `.mtdb` after a process failure during first creation.

---

# Writer-lock files

Writer-lock files are not part of the `.mtdb` binary format.

They exist alongside the database.

Possible files:

```text
database.mtdb.lock
database.mtdb.lock.guard
```

Likewise:

```text
database.mtdb.create.tmp
database.mtdb.compact.tmp
```

are temporary implementation files.

Only:

```text
database.mtdb
```

uses the format described in this document.

---

# Integer limits

Physical file offsets are stored as unsigned 64-bit integers.

The current JavaScript implementation converts offsets to JavaScript `Number`.

Therefore offsets greater than:

```text
Number.MAX_SAFE_INTEGER
```

are rejected.

This is an implementation limit even though the binary field itself is 64-bit.

---

# Path representation

Paths are stored exactly in their normalized UTF-8 form.

Examples:

```text
settings.json
users
users/1.json
users/archive
users/archive/100.json
```

Stored paths must already be normalized.

Recovery verifies this by normalizing the decoded path again and requiring:

```text
normalizedPath === storedPath
```

Paths with:

```text
.
..
empty segments
absolute prefixes
drive prefixes
trailing separators
```

are not valid stored paths.

---

# Implicit root

The database root is not represented by a physical `DIRECTORY` record.

It exists implicitly.

Therefore:

```text
settings.json
```

can exist directly at root while:

```text
users/1.json
```

requires the explicit directory record:

```text
users
```

---

# Collision handling

MTDB does not require unique hashes.

Multiple different paths may share a bucket.

Example:

```text
bucket N
  |
  v
path-C
  |
  v
path-B
  |
  v
path-A
```

A lookup starts from the bucket head and follows `previousOffset` until:

* the requested path is found; or
* offset becomes `0`.

The newest record for a path wins.

A `DELETE` record therefore hides earlier `WRITE` records for the same path.

---

# Source of truth

The format has two related structures:

```text
journal
index
```

The journal stores mutation history.

The index stores the current head of each hash bucket.

The index is designed to be rebuildable from committed journal records.

After an unclean shutdown:

```text
journal > index
```

in terms of authority.

A committed journal mutation can therefore survive even when the process terminated before updating its bucket entry.

---

# Format compatibility

Current version:

```text
2
```

MTDB does not assume binary compatibility between different format versions.

A file with another version must not be opened by simply changing its version field.

Format migrations, if introduced in the future, must explicitly understand both the source and destination formats.

---

# Format v2 summary

```text
Header:
  4096 bytes

Index:
  65536 buckets
  8 bytes per bucket
  524288 bytes total

Data start:
  528384

Record:
  32-byte header
  UTF-8 path
  optional payload

Record types:
  1 DIRECTORY
  2 WRITE
  3 DELETE
  4 COMMIT

Path:
  max 1024 UTF-8 bytes

JSON:
  max 100 MiB

Checksum:
  CRC32

Hash:
  32-bit FNV-1a

Mutation:
  DIRTY
  RECORD
  COMMIT
  fsync
  bucket update
  fsync

Recovery:
  sequential journal scan
  only committed records applied
  incomplete uncommitted tail truncated
  index rebuilt from journal

Compaction:
  copies only current WRITE/DIRECTORY state
  removes tombstones and history
  validates new database before replacement
```
