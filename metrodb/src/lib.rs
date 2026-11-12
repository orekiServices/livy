//! MetroDB — SQLite for Node, written in Rust.
//!
//! Nodecast stores everything in one SQLite file, which until now meant
//! `better-sqlite3`: an excellent library that is also a C++ addon built by
//! node-gyp at install time. On a Raspberry Pi, in a slim container, or on
//! any machine without a compiler and Python, that install is the single
//! most likely thing to fail — and it fails *after* somebody has decided to
//! try the project.
//!
//! This is the same database with none of that. SQLite is compiled into the
//! binary, the binary is prebuilt for every platform (the same universal
//! build as libmetro), and the API is deliberately **better-sqlite3's**:
//!
//! ```js
//! const db = new Database('nodecast.db')
//! db.exec('CREATE TABLE plays (id INTEGER PRIMARY KEY, title TEXT)')
//! db.prepare('INSERT INTO plays (title) VALUES (?)').run('Get Lucky')
//! db.prepare('SELECT * FROM plays WHERE id = ?').get(1)
//! db.prepare('SELECT * FROM plays').all()
//! db.transaction(() => { … })
//! ```
//!
//! Same names, same synchronous behaviour, same `{ changes, lastInsertRowid }`.
//! Swapping the driver is a one-line change in `server/src/store/index.js`,
//! and nothing above it knows which one answered.
//!
//! What is deliberately *not* here: async APIs, an ORM, migrations, query
//! building. The store above it has opinions about all of those already.

#![deny(clippy::all)]

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Number, Value as Json};

/// What `run()` gives back, exactly as better-sqlite3 does.
#[napi(object)]
pub struct RunResult {
  pub changes: i64,
  /// SQLite rowids are 64-bit; JavaScript numbers are safe to 2^53, which is
  /// more rows than this node will ever have.
  pub last_insert_rowid: i64,
}

/// One database file.
///
/// The connection is behind a mutex so a statement prepared from one handle
/// and used from another cannot interleave — the JavaScript side is single
/// threaded, but napi will happily let a callback run in between.
#[napi]
pub struct Database {
  inner: Arc<Mutex<Option<Connection>>>,
  path: String,
  readonly: bool,
}

fn to_napi(error: rusqlite::Error) -> Error {
  Error::new(Status::GenericFailure, error.to_string())
}

/// JSON in → SQLite parameter. Anything a JS caller can reasonably pass.
fn bind_value(value: &Json) -> Result<SqlValue> {
  Ok(match value {
    Json::Null => SqlValue::Null,
    Json::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
    Json::Number(number) => {
      if let Some(int) = number.as_i64() {
        SqlValue::Integer(int)
      } else {
        SqlValue::Real(number.as_f64().unwrap_or(0.0))
      }
    }
    Json::String(text) => SqlValue::Text(text.clone()),
    // Objects and arrays are stored the way the store already stores them:
    // as JSON text. It is what every caller in Nodecast does by hand today.
    other => SqlValue::Text(other.to_string()),
  })
}

/// SQLite column → JSON, for the row objects JavaScript sees.
fn read_value(value: ValueRef<'_>) -> Json {
  match value {
    ValueRef::Null => Json::Null,
    ValueRef::Integer(int) => Json::Number(Number::from(int)),
    ValueRef::Real(real) => Number::from_f64(real).map(Json::Number).unwrap_or(Json::Null),
    ValueRef::Text(bytes) => Json::String(String::from_utf8_lossy(bytes).into_owned()),
    // A blob comes back as an array of bytes rather than a Buffer: nothing
    // in Nodecast stores blobs, and silently lossy is worse than explicit.
    ValueRef::Blob(bytes) => Json::Array(bytes.iter().map(|byte| Json::Number(Number::from(*byte))).collect()),
  }
}

#[napi]
impl Database {
  /// `new Database(file, { readonly, create, timeoutMs })`
  #[napi(constructor)]
  pub fn new(path: String, options: Option<OpenOptions>) -> Result<Self> {
    let options = options.unwrap_or_default();
    let readonly = options.readonly.unwrap_or(false);

    let mut flags = if readonly {
      OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
      OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    if !readonly && options.create.unwrap_or(true) {
      flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    flags |= OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;

    let connection = Connection::open_with_flags(&path, flags).map_err(to_napi)?;
    // A radio node writes from one thread but reads while it writes; a busy
    // timeout is the difference between "wait 4 ms" and SQLITE_BUSY.
    connection
      .busy_timeout(std::time::Duration::from_millis(options.timeout_ms.unwrap_or(5000) as u64))
      .map_err(to_napi)?;

    Ok(Database {
      inner: Arc::new(Mutex::new(Some(connection))),
      path,
      readonly,
    })
  }

  fn with<T>(&self, run: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let guard = self.inner.lock().unwrap();
    match guard.as_ref() {
      Some(connection) => run(connection),
      None => Err(Error::new(Status::GenericFailure, "database is closed")),
    }
  }

  /// Run one or more statements for their effect. No parameters, like
  /// better-sqlite3's `exec`.
  #[napi]
  pub fn exec(&self, sql: String) -> Result<()> {
    self.with(|connection| connection.execute_batch(&sql).map_err(to_napi))
  }

  /// `db.prepare(sql)` → a statement you can run, get or all.
  #[napi]
  pub fn prepare(&self, sql: String) -> Result<Statement> {
    // Prepared once here to surface syntax errors immediately, exactly as
    // better-sqlite3 does; the statement re-prepares per call, which SQLite
    // serves from its own statement cache.
    self.with(|connection| connection.prepare(&sql).map(|_| ()).map_err(to_napi))?;
    Ok(Statement {
      db: Arc::clone(&self.inner),
      sql,
    })
  }

  /// Convenience for the common one-liners.
  #[napi]
  pub fn run(&self, sql: String, params: Option<Vec<Json>>) -> Result<RunResult> {
    self.prepare(sql)?.run(params)
  }

  #[napi]
  pub fn get(&self, sql: String, params: Option<Vec<Json>>) -> Result<Option<Json>> {
    self.prepare(sql)?.get(params)
  }

  #[napi]
  pub fn all(&self, sql: String, params: Option<Vec<Json>>) -> Result<Vec<Json>> {
    self.prepare(sql)?.all(params)
  }

  /// `db.pragma('journal_mode = WAL')` — returns whatever the pragma does.
  #[napi]
  pub fn pragma(&self, source: String) -> Result<Vec<Json>> {
    self.all(format!("PRAGMA {source}"), None)
  }

  /* --------------------------- transactions --------------------------- */
  //
  // better-sqlite3 wraps a function; a napi callback cannot safely re-enter
  // this object, so the three verbs are exposed instead and `index.js`
  // rebuilds the familiar `transaction(fn)` on top. Nested calls use
  // savepoints, so a transaction inside a transaction behaves.

  #[napi]
  pub fn begin(&self) -> Result<()> {
    self.with(|connection| connection.execute_batch("BEGIN IMMEDIATE").map_err(to_napi))
  }

  #[napi]
  pub fn commit(&self) -> Result<()> {
    self.with(|connection| connection.execute_batch("COMMIT").map_err(to_napi))
  }

  #[napi]
  pub fn rollback(&self) -> Result<()> {
    self.with(|connection| connection.execute_batch("ROLLBACK").map_err(to_napi))
  }

  #[napi]
  pub fn savepoint(&self, name: String) -> Result<()> {
    self.with(|connection| connection.execute_batch(&format!("SAVEPOINT {name}")).map_err(to_napi))
  }

  #[napi]
  pub fn release(&self, name: String) -> Result<()> {
    self.with(|connection| connection.execute_batch(&format!("RELEASE {name}")).map_err(to_napi))
  }

  #[napi]
  pub fn rollback_to(&self, name: String) -> Result<()> {
    self.with(|connection| connection.execute_batch(&format!("ROLLBACK TO {name}")).map_err(to_napi))
  }

  /// True while a transaction is open — the same property better-sqlite3 has.
  #[napi(getter)]
  pub fn in_transaction(&self) -> Result<bool> {
    self.with(|connection| Ok(!connection.is_autocommit()))
  }

  /// Back the whole database up to another file, online and safely.
  #[napi]
  pub fn backup(&self, destination: String) -> Result<()> {
    self.with(|connection| {
      connection
        .backup(rusqlite::DatabaseName::Main, std::path::Path::new(&destination), None)
        .map_err(to_napi)
    })
  }

  #[napi(getter)]
  pub fn open(&self) -> bool {
    self.inner.lock().unwrap().is_some()
  }

  #[napi(getter)]
  pub fn name(&self) -> String {
    self.path.clone()
  }

  #[napi(getter)]
  pub fn readonly(&self) -> bool {
    self.readonly
  }

  #[napi]
  pub fn close(&self) -> Result<()> {
    let mut guard = self.inner.lock().unwrap();
    if let Some(connection) = guard.take() {
      connection.close().map_err(|(_, error)| to_napi(error))?;
    }
    Ok(())
  }
}

#[napi(object)]
#[derive(Default)]
pub struct OpenOptions {
  pub readonly: Option<bool>,
  pub create: Option<bool>,
  pub timeout_ms: Option<u32>,
}

/// A prepared statement: `.run()`, `.get()`, `.all()`.
#[napi]
pub struct Statement {
  db: Arc<Mutex<Option<Connection>>>,
  sql: String,
}

#[napi]
impl Statement {
  fn with<T>(&self, run: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let guard = self.db.lock().unwrap();
    match guard.as_ref() {
      Some(connection) => run(connection),
      None => Err(Error::new(Status::GenericFailure, "database is closed")),
    }
  }

  /// Execute for effect. Returns rows changed and the last rowid.
  #[napi]
  pub fn run(&self, params: Option<Vec<Json>>) -> Result<RunResult> {
    let values = bind_all(params)?;
    self.with(|connection| {
      let mut statement = connection.prepare_cached(&self.sql).map_err(to_napi)?;
      let changes = statement
        .execute(rusqlite::params_from_iter(values.iter()))
        .map_err(to_napi)?;
      Ok(RunResult {
        changes: changes as i64,
        last_insert_rowid: connection.last_insert_rowid(),
      })
    })
  }

  /// The first row, or `null`.
  #[napi]
  pub fn get(&self, params: Option<Vec<Json>>) -> Result<Option<Json>> {
    let values = bind_all(params)?;
    self.with(|connection| {
      let mut statement = connection.prepare_cached(&self.sql).map_err(to_napi)?;
      let names: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
      let mut rows = statement
        .query(rusqlite::params_from_iter(values.iter()))
        .map_err(to_napi)?;

      match rows.next().map_err(to_napi)? {
        Some(row) => Ok(Some(row_to_json(row, &names)?)),
        None => Ok(None),
      }
    })
  }

  /// Every row, as an array of objects.
  #[napi]
  pub fn all(&self, params: Option<Vec<Json>>) -> Result<Vec<Json>> {
    let values = bind_all(params)?;
    self.with(|connection| {
      let mut statement = connection.prepare_cached(&self.sql).map_err(to_napi)?;
      let names: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
      let mut rows = statement
        .query(rusqlite::params_from_iter(values.iter()))
        .map_err(to_napi)?;

      let mut out = Vec::new();
      while let Some(row) = rows.next().map_err(to_napi)? {
        out.push(row_to_json(row, &names)?);
      }
      Ok(out)
    })
  }

  /// The SQL this statement was prepared from.
  #[napi(getter)]
  pub fn source(&self) -> String {
    self.sql.clone()
  }
}

fn bind_all(params: Option<Vec<Json>>) -> Result<Vec<SqlValue>> {
  params.unwrap_or_default().iter().map(bind_value).collect()
}

fn row_to_json(row: &rusqlite::Row<'_>, names: &[String]) -> Result<Json> {
  let mut object = Map::with_capacity(names.len());
  for (index, name) in names.iter().enumerate() {
    let value = row.get_ref(index).map_err(to_napi)?;
    object.insert(name.clone(), read_value(value));
  }
  Ok(Json::Object(object))
}

/* ------------------------------ identity ------------------------------ */

#[napi]
pub fn version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

/// The SQLite this binary carries — no system library is involved.
#[napi]
pub fn sqlite_version() -> String {
  rusqlite::version().to_string()
}

#[napi]
pub fn describe() -> String {
  format!(
    "MetroDB {} · SQLite {} · {} · {}",
    env!("CARGO_PKG_VERSION"),
    rusqlite::version(),
    std::env::consts::OS,
    std::env::consts::ARCH
  )
}
