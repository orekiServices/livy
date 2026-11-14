# MetroDB

SQLite for Node, written in Rust — a drop-in alternative to
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) with the same
synchronous API and **no node-gyp**.

```js
const Database = require('metrodb')

const db = new Database('livy.db')
db.exec('CREATE TABLE plays (id INTEGER PRIMARY KEY, title TEXT)')

db.prepare('INSERT INTO plays (title) VALUES (?)').run('Get Lucky')
//  → { changes: 1, lastInsertRowid: 1 }
db.prepare('SELECT * FROM plays WHERE id = ?').get(1)   // row, or undefined
db.prepare('SELECT * FROM plays').all()                 // array of rows

const add = db.transaction((titles) => {
  for (const title of titles) db.prepare('INSERT INTO plays (title) VALUES (?)').run(title)
})
add(['One', 'Two'])          // commits, or rolls back if it throws

db.pragma('journal_mode = WAL')
db.close()
```

## Why

better-sqlite3 is excellent and it is a C++ addon that node-gyp compiles at
install time. On a Raspberry Pi, in an Alpine container, or on any machine
without a compiler, Python and headers, that compile is the single most
likely thing to fail — and it fails *after* somebody has decided to try
your project.

MetroDB is the same database with none of that. SQLite is compiled into the
binary, one binary per platform is prebuilt, and installing it is copying a
file.

| | better-sqlite3 | MetroDB |
| --- | --- | --- |
| install | node-gyp compiles C++ | copy a `.node` file |
| needs | compiler, Python, headers | nothing |
| SQLite | system or bundled | **bundled** (3.46) |
| API | `prepare/run/get/all/exec/transaction/pragma` | the same |
| ABI | rebuilt per Node major | N-API 8 — every Node ≥ 16 |

## API

Everything Livy's store uses, with better-sqlite3's names and
behaviour:

| | |
| --- | --- |
| `new Database(file, { readonly, create, timeout })` | opens (and creates) a database |
| `db.prepare(sql)` | → `Statement` |
| `db.exec(sql)` | run one or more statements for effect |
| `db.pragma(source, { simple })` | rows, or the single value |
| `db.transaction(fn)` | → a function; commits on return, rolls back on throw, **nests** via savepoints |
| `db.backup(path)` | an online, consistent copy |
| `db.close()` · `db.open` · `db.name` · `db.readonly` · `db.inTransaction` | |
| `statement.run(...params)` | → `{ changes, lastInsertRowid }` |
| `statement.get(...params)` | first row, or `undefined` |
| `statement.all(...params)` · `.iterate()` | every row |
| `statement.source` | the SQL it was prepared from |

Parameters may be passed variadically or as one array, and `undefined`
binds as `NULL` — SQLite has one kind of nothing and JavaScript has two.

Deliberately absent: async APIs, an ORM, migrations, query building. The
code above a database should own all of those.

## Building

```sh
cargo build --release && bun scripts/link-local.js   # this machine
./scripts/build-linux-universal.sh                    # every Linux arch
```

The universal script needs only a Rust toolchain: it fetches
[zig](https://ziglang.org) for the cross linkers and pins glibc builds to
2.17, so one binary runs on every distribution still in service.

```
metrodb.linux-x64-gnu.node        any x86-64 glibc distro
metrodb.linux-x64-musl.node       Alpine and slim containers
metrodb.linux-arm64-gnu.node      Pi 4/5 64-bit, Graviton, Ampere
metrodb.linux-arm64-musl.node     Alpine on arm64
metrodb.linux-arm-gnueabihf.node  Pi 2/3, 32-bit boards
```

Drop them next to `index.js`; the loader picks the one that fits and skips
any that will not load.

## Licence

MIT. SQLite itself is public domain.
