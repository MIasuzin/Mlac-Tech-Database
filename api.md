# MTDB API

MTDB — синхронное однопроцессное JSON-хранилище для Node.js с хранением данных в одном `.mtdb` файле.

```js
const mtdb = require('mtdb');

const db = mtdb.open('./data.mtdb');
```

Публичный API:

```js
mtdb.open(filePath);

db.mkdir(path);
db.list(path);
db.read(path);
db.write(path, value);
db.delete(path);
db.compact();
db.close();
```

## Общие правила

### Синхронный API

Все методы MTDB синхронные.

```js
const value = db.read('users/1.json');

db.write('users/1.json', {
  id: 1
});
```

Методы не возвращают `Promise` и не требуют `await`.

### JSON only

MTDB хранит JSON-значения.

Путь JSON-файла должен оканчиваться на `.json`. Регистр расширения не имеет значения.

Допустимо:

```text
users/1.json
settings.JSON
data/items/test.Json
```

Недопустимо:

```text
users/1
users/1.txt
```

### Каталоги

Корневой каталог существует неявно.

Поэтому JSON можно записать непосредственно в root:

```js
db.write('settings.json', {
  enabled: true
});
```

Для вложенных JSON родительский каталог должен существовать:

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

`mkdir()` может создать всю цепочку каталогов:

```js
db.mkdir('data/users/archive');
```

### Пути

Внутренние пути MTDB используют `/`.

Обратные слеши автоматически преобразуются:

```js
db.read('users\\1.json');
```

эквивалентно:

```js
db.read('users/1.json');
```

Запрещены:

```text
/users/1.json
C:/users/1.json
C:users/1.json
users//1.json
users/./1.json
users/../1.json
users/
```

Пустые сегменты, `.` и `..` не допускаются.

Максимальный размер нормализованного пути — 1024 байта в UTF-8.

### Максимальный размер JSON

Максимальный размер сериализованного JSON — 100 MiB.

Размер проверяется после `JSON.stringify()` и UTF-8 кодирования.

### Single writer

`mtdb.open()` получает эксклюзивный writer-lock.

Один `.mtdb` файл не может одновременно быть открыт двумя writer-процессами.

Повторное открытие той же базы в одном процессе также запрещено.

MTDB не поддерживает открытие writer через symbolic link или hard link.

Отдельного read-only режима в текущем API нет.

### Состояние после ошибки записи

Если ошибка произошла во время изменения базы и MTDB больше не может гарантировать согласованность текущего runtime-состояния, экземпляр переводится в состояние `recovery required`.

После этого разрешён только:

```js
db.close();
```

Остальные операции завершаются ошибкой:

```text
MTDB_RECOVERY_REQUIRED
```

Для продолжения работы базу необходимо закрыть и открыть заново:

```js
db.close();

const db2 = mtdb.open('./data.mtdb');
```

При необходимости recovery выполняется во время `open()`.

---

# mtdb.open(filePath)

Открывает существующую MTDB или создаёт новую.

```js
const db = mtdb.open('./data.mtdb');
```

## Сигнатура

```js
mtdb.open(filePath)
```

## Аргументы

### filePath

Тип:

```text
string
```

Путь к файлу базы.

Файл должен иметь расширение:

```text
.mtdb
```

Пример:

```js
const db = mtdb.open('./storage/data.mtdb');
```

## Возвращаемое значение

Возвращает открытый экземпляр `Database`:

```js
const db = mtdb.open('./data.mtdb');
```

## Создание новой базы

Если файла ещё нет, MTDB создаёт новую базу.

```js
const db = mtdb.open('./new.mtdb');
```

Создание выполняется через временный файл. Частично созданный основной `.mtdb` не должен оставаться после сбоя во время инициализации.

## Recovery

Если предыдущий процесс завершился до корректного `close()`, база может остаться в состоянии `DIRTY`.

При следующем:

```js
mtdb.open('./data.mtdb');
```

MTDB проверяет журнал, восстанавливает индекс и удаляет незавершённый хвост, если он не был подтверждён commit-записью.

Повреждение подтверждённых данных не игнорируется и приводит к ошибке.

## Writer lock

Успешный `open()` получает эксклюзивный writer-lock.

Попытка второго открытия:

```js
mtdb.open('./data.mtdb');
mtdb.open('./data.mtdb');
```

приведёт к:

```text
MTDB_ALREADY_OPEN
```

После аварийного завершения процесса stale lock восстанавливается при следующем открытии, если MTDB может безопасно определить, что предыдущего writer-процесса больше нет.

## Основные ошибки

```text
MTDB_INVALID_FILE_PATH
MTDB_INVALID_FILE_EXTENSION
MTDB_ALREADY_OPEN
MTDB_SYMLINK_UNSUPPORTED
MTDB_HARDLINK_UNSUPPORTED
MTDB_LOCK_GUARD_EXISTS
MTDB_CORRUPTED_LOCK
MTDB_PATH_NOT_FILE
MTDB_CORRUPTED_FILE
MTDB_INVALID_MAGIC
MTDB_UNSUPPORTED_VERSION
MTDB_INVALID_HEADER
MTDB_INVALID_HEADER_STATE
MTDB_INVALID_INDEX
MTDB_CORRUPTED_LOG
MTDB_CORRUPTED_RECORD
```

Также могут быть переданы системные ошибки файловой системы Node.js.

---

# db.mkdir(path)

Создаёт виртуальный каталог внутри MTDB.

## Сигнатура

```js
db.mkdir(path)
```

## Пример

```js
db.mkdir('users');
```

Можно создать сразу несколько уровней:

```js
db.mkdir('data/users/archive');
```

В этом случае будут созданы отсутствующие каталоги:

```text
data
data/users
data/users/archive
```

## Аргументы

### path

Нормализованный виртуальный путь каталога.

```js
db.mkdir('users');
db.mkdir('users/archive');
```

Корневой каталог создаётся неявно и не передаётся в `mkdir()`.

## Возвращаемое значение

Возвращает:

```js
true
```

если был создан хотя бы один новый каталог.

Возвращает:

```js
false
```

если вся цепочка каталогов уже существовала.

Пример:

```js
db.mkdir('users'); // true
db.mkdir('users'); // false
```

## Конфликт с JSON

Если часть пути уже занята JSON-файлом:

```js
db.write('data.json', {
  value: 1
});

db.mkdir('data.json/users');
```

операция завершится:

```text
MTDB_PATH_IS_FILE
```

## Основные ошибки

```text
MTDB_INVALID_PATH
MTDB_PATH_TOO_LONG
MTDB_PATH_IS_FILE
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
```

---

# db.list(path)

Возвращает JSON-файлы непосредственно внутри каталога.

Метод не является рекурсивным.

## Сигнатура

```js
db.list(path)
```

## Пример

Для структуры:

```text
users/
  100.json
  200.json
  archive/
    300.json
```

вызов:

```js
db.list('users');
```

вернёт:

```js
[
  'users/100.json',
  'users/200.json'
]
```

`users/archive/300.json` в результат не попадёт.

Для него нужно отдельно вызвать:

```js
db.list('users/archive');
```

## Root

Пустая строка обозначает implicit root:

```js
db.write('settings.json', {});
db.write('config.json', {});

db.list('');
```

результат:

```js
[
  'config.json',
  'settings.json'
]
```

JSON во вложенных каталогах в root-список не включаются.

## Возвращаемое значение

Возвращает массив виртуальных путей JSON:

```js
[
  'users/100.json',
  'users/200.json'
]
```

Результат отсортирован по пути.

Пустой существующий каталог возвращает:

```js
[]
```

## Удалённые JSON

Tombstone-записи не возвращаются.

```js
db.write('users/1.json', {
  id: 1
});

db.delete('users/1.json');

db.list('users');
```

результат:

```js
[]
```

Если JSON затем записать заново, он снова появится в `list()`.

## Отсутствующий каталог

```js
db.list('missing');
```

выбрасывает:

```text
MTDB_DIRECTORY_NOT_FOUND
```

## Если path является JSON

```js
db.list('users/1.json');
```

выбрасывает:

```text
MTDB_PATH_IS_FILE
```

## Основные ошибки

```text
MTDB_INVALID_PATH
MTDB_PATH_TOO_LONG
MTDB_DIRECTORY_NOT_FOUND
MTDB_PATH_IS_FILE
MTDB_CORRUPTED_INDEX
MTDB_CORRUPTED_RECORD
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
```

---

# db.read(path)

Читает JSON из MTDB.

## Сигнатура

```js
db.read(path)
```

## Пример

```js
db.write('users/1.json', {
  id: 1,
  name: 'Alex'
});

const user = db.read('users/1.json');
```

Результат:

```js
{
  id: 1,
  name: 'Alex'
}
```

## Возвращаемое значение

Возвращается значение, полученное через `JSON.parse()` сохранённых данных.

Если JSON отсутствует:

```js
db.read('users/missing.json');
```

возвращается:

```js
undefined
```

Удалённый JSON также возвращает:

```js
undefined
```

## Каталог вместо JSON

Если указанный путь занят каталогом:

```js
db.mkdir('users');

db.read('users.json');
```

ошибка возникает только если именно запрошенный JSON-путь существует как каталог.

В этом случае используется:

```text
MTDB_PATH_IS_DIRECTORY
```

## Повреждённый JSON

Если физическая запись прошла проверки формата и checksum, но содержащаяся строка не является корректным JSON, выбрасывается:

```text
MTDB_CORRUPTED_JSON
```

## Основные ошибки

```text
MTDB_INVALID_PATH
MTDB_PATH_TOO_LONG
MTDB_JSON_EXTENSION_REQUIRED
MTDB_PATH_IS_DIRECTORY
MTDB_CORRUPTED_JSON
MTDB_CORRUPTED_RECORD
MTDB_CORRUPTED_INDEX
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
```

---

# db.write(path, value)

Сериализует значение в JSON и сохраняет его.

## Сигнатура

```js
db.write(path, value)
```

## Пример

```js
db.write('users/1.json', {
  id: 1,
  name: 'Alex',
  active: true
});
```

## JSON serialization

Используется стандартный:

```js
JSON.stringify(value)
```

Поэтому действуют стандартные правила JSON JavaScript.

Например:

```js
db.write('example.json', {
  value: undefined
});
```

сохранит объект без свойства `value`.

Циклический объект:

```js
const value = {};
value.self = value;

db.write('example.json', value);
```

приведёт к:

```text
MTDB_INVALID_JSON
```

Top-level значение, для которого `JSON.stringify()` возвращает `undefined`, также запрещено:

```js
db.write('test.json', undefined);
```

ошибка:

```text
MTDB_INVALID_JSON
```

## Родительский каталог

Root JSON можно записывать без `mkdir()`:

```js
db.write('settings.json', {});
```

Для вложенного пути каталог должен существовать:

```js
db.write('users/1.json', {});
```

если `users` не создан, выбрасывает:

```text
MTDB_DIRECTORY_NOT_FOUND
```

Правильно:

```js
db.mkdir('users');

db.write('users/1.json', {});
```

## Overwrite

Повторный `write()` того же path создаёт новую актуальную версию:

```js
db.write('users/1.json', {
  version: 1
});

db.write('users/1.json', {
  version: 2
});
```

После этого:

```js
db.read('users/1.json');
```

возвращает:

```js
{
  version: 2
}
```

Предыдущая версия физически может оставаться в журнале до `compact()`.

## Запись после delete

Разрешена:

```js
db.delete('users/1.json');

db.write('users/1.json', {
  restored: true
});
```

После этого JSON снова существует.

## Конфликт с каталогом

Если path уже является каталогом:

```js
db.mkdir('users/data.json');

db.write('users/data.json', {});
```

выбрасывается:

```text
MTDB_PATH_IS_DIRECTORY
```

## Максимальный размер

После `JSON.stringify()` размер UTF-8 представления не должен превышать 100 MiB.

При превышении:

```text
MTDB_JSON_TOO_LARGE
```

## Возвращаемое значение

После успешной записи:

```js
true
```

## Durability

`write()` является синхронной durable-операцией.

До успешного возврата MTDB записывает mutation record, commit и обновление bucket index с необходимыми `fsync`.

Если операция записи завершается ошибкой в момент, когда дальнейшее использование текущего runtime-состояния небезопасно, экземпляр переводится в:

```text
MTDB_RECOVERY_REQUIRED
```

После этого базу следует закрыть и открыть заново.

## Основные ошибки

```text
MTDB_INVALID_PATH
MTDB_PATH_TOO_LONG
MTDB_JSON_EXTENSION_REQUIRED
MTDB_INVALID_JSON
MTDB_JSON_TOO_LARGE
MTDB_DIRECTORY_NOT_FOUND
MTDB_PATH_IS_FILE
MTDB_PATH_IS_DIRECTORY
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
MTDB_WRITE_FAILED
```

Также могут быть переданы системные ошибки файловой системы.

---

# db.delete(path)

Удаляет JSON.

Физически MTDB записывает delete/tombstone mutation. Старые версии могут оставаться в журнале до `compact()`.

## Сигнатура

```js
db.delete(path)
```

## Пример

```js
db.delete('users/1.json');
```

## Возвращаемое значение

Возвращает:

```js
true
```

если существующий JSON был удалён.

```js
db.write('users/1.json', {
  id: 1
});

db.delete('users/1.json'); // true
```

Возвращает:

```js
false
```

если JSON отсутствует или уже удалён:

```js
db.delete('users/missing.json'); // false
```

## Чтение после delete

После:

```js
db.delete('users/1.json');
```

вызов:

```js
db.read('users/1.json');
```

возвращает:

```js
undefined
```

## Удаление каталогов

`delete()` предназначен только для JSON.

Если path занят каталогом, выбрасывается:

```text
MTDB_PATH_IS_DIRECTORY
```

API удаления каталогов в текущей версии отсутствует.

## Основные ошибки

```text
MTDB_INVALID_PATH
MTDB_PATH_TOO_LONG
MTDB_JSON_EXTENSION_REQUIRED
MTDB_PATH_IS_DIRECTORY
MTDB_CORRUPTED_INDEX
MTDB_CORRUPTED_RECORD
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
MTDB_WRITE_FAILED
```

---

# db.compact()

Пересобирает файл MTDB, удаляя ненужную историю.

## Сигнатура

```js
db.compact()
```

## Что удаляется

`compact()` удаляет:

* старые версии перезаписанных JSON;
* tombstone удалённых JSON;
* старые версии служебных directory records;
* прочую неактуальную историю bucket chains.

После compact остаётся только актуальное логическое состояние базы.

## Пример

```js
const result = db.compact();

console.log(result);
```

Пример результата:

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

## Возвращаемое значение

### beforeSize

Размер `.mtdb` до compact, в байтах.

### afterSize

Размер нового `.mtdb` после compact, в байтах.

### reclaimedBytes

Количество освобождённых байт:

```text
beforeSize - afterSize
```

### scannedRecords

Количество обычных records, просмотренных в исходных bucket chains.

### writtenRecords

Количество актуальных records, перенесённых в новый файл.

### files

Количество актуальных JSON.

### directories

Количество актуальных каталогов.

### deleted

Количество актуальных tombstone, которые не были перенесены.

### historical

Количество исторических версий, которые не были перенесены.

## Blocking behavior

`compact()` полностью синхронный.

Пока выполняется compact, экземпляр базы не обрабатывает другие операции.

## Проверка нового файла

Перед заменой основной базы новый compact-файл повторно проверяется через recovery/index rebuild logic.

Если проверка обнаруживает несогласованность:

```text
MTDB_COMPACT_VALIDATION_FAILED
```

основной файл не должен быть заменён повреждённым compact-файлом.

## Crash behavior

Compact-файл сначала создаётся отдельно.

Основной `.mtdb` заменяется только после завершения записи и проверки временного файла.

Process crash:

* во время подготовки temp;
* после подготовки temp до rename;
* сразу после rename

не должен приводить к потере логического состояния подтверждённых данных.

Гарантия физического power-loss поведения непосредственно во время filesystem rename зависит от ОС, файловой системы и оборудования.

## Recovery required

Если база уже находится в состоянии:

```text
MTDB_RECOVERY_REQUIRED
```

`compact()` не выполняет recovery текущего экземпляра.

Необходимо:

```js
db.close();

const db2 = mtdb.open('./data.mtdb');

db2.compact();
```

## Основные ошибки

```text
MTDB_COMPACT_VALIDATION_FAILED
MTDB_COMPACT_FAILED
MTDB_CORRUPTED_INDEX
MTDB_CORRUPTED_RECORD
MTDB_RECOVERY_REQUIRED
MTDB_CLOSED
MTDB_REENTRANT_OPERATION
MTDB_WRITE_FAILED
```

Также могут быть переданы ошибки файловой системы, включая ошибки создания, записи, `fsync`, `rename` и повторного открытия файла.

---

# db.close()

Закрывает MTDB и освобождает writer-lock.

## Сигнатура

```js
db.close()
```

## Пример

```js
const db = mtdb.open('./data.mtdb');

db.write('settings.json', {
  enabled: true
});

db.close();
```

## Возвращаемое значение

Первый успешный вызов:

```js
true
```

Повторный вызов:

```js
false
```

Пример:

```js
db.close(); // true
db.close(); // false
```

## CLEAN state

Если база изменялась и не находится в `recovery required`, `close()` переводит header в состояние `CLEAN` и выполняет `fsync` перед закрытием descriptor.

Если экземпляр находится в `recovery required`, `close()` не должен помечать базу `CLEAN`.

Это позволяет следующему `open()` выполнить recovery.

## После close

После успешного:

```js
db.close();
```

остальные операции запрещены.

Например:

```js
db.read('settings.json');
```

выбрасывает:

```text
MTDB_CLOSED
```

## Writer lock

При успешном закрытии освобождается writer-lock базы.

Если lock больше не принадлежит текущему экземпляру, может быть выброшена:

```text
MTDB_LOCK_OWNERSHIP_LOST
```

## Основные ошибки

```text
MTDB_LOCK_OWNERSHIP_LOST
MTDB_WRITE_FAILED
```

Также могут быть переданы системные ошибки `fsync`, `close` или удаления lock-файла.

---

# Типичный пример

```js
const mtdb = require('mtdb');

const db = mtdb.open('./data.mtdb');

db.mkdir('users');

db.write('users/1.json', {
  id: 1,
  name: 'Alice'
});

db.write('users/2.json', {
  id: 2,
  name: 'Bob'
});

console.log(
  db.list('users')
);

console.log(
  db.read('users/1.json')
);

db.delete('users/2.json');

db.compact();

db.close();
```

---

# Краткая таблица

| Method                  | Description                                | Return                   |
| ----------------------- | ------------------------------------------ | ------------------------ |
| `mtdb.open(filePath)`   | Открывает или создаёт MTDB                 | `Database`               |
| `db.mkdir(path)`        | Создаёт каталог/цепочку каталогов          | `boolean`                |
| `db.list(path)`         | Возвращает JSON непосредственно в каталоге | `string[]`               |
| `db.read(path)`         | Читает JSON                                | JSON value / `undefined` |
| `db.write(path, value)` | Создаёт или перезаписывает JSON            | `true`                   |
| `db.delete(path)`       | Удаляет JSON                               | `boolean`                |
| `db.compact()`          | Удаляет историю и пересобирает базу        | `object`                 |
| `db.close()`            | Закрывает базу                             | `boolean`                |

# Текущие ограничения

MTDB в текущей версии:

* имеет синхронный API;
* поддерживает только JSON;
* использует один writer на базу;
* не имеет read-only API;
* не имеет транзакций;
* не имеет SQL/query API;
* не имеет `find()`;
* не имеет `exists()`;
* не имеет watchers;
* не поддерживает удаление каталогов;
* не выполняет автоматический compact;
* ограничивает JSON размером 100 MiB;
* ограничивает путь размером 1024 байта UTF-8;
* использует формат файла версии 2.
