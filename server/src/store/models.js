/**
 * Model registry tables, mixed into `Store.prototype`.
 *
 * Training history is the one thing a model file cannot carry: how a candidate
 * scored, which run produced it, and whether a copy exists on Hugging Face.
 */
const json = (value, fallback) => {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export const modelRepo = {
  saveSeam(record) {
    const stationId = record?.stationId ?? record?.station ?? null
    return this.db.run('INSERT INTO dj_seams (station_id, effect, outcome, record, created_at) VALUES (?, ?, ?, ?, ?)', [
      stationId,
      record?.effect ?? null,
      record?.outcome ?? null,
      JSON.stringify(record ?? {}),
      Number(record?.at) || Date.now()
    ]).changes
  },

  recentSeams(limit = 20_000) {
    const rows = this.db.all('SELECT record FROM dj_seams ORDER BY id DESC LIMIT ?', [Math.max(1, Number(limit) || 1)])
    const records = []
    for (const row of rows.reverse()) {
      try {
        records.push(JSON.parse(row.record))
      } catch {
        // A row written by a different schema: ignore it.
      }
    }
    return records
  },

  countSeams() {
    return this.db.get('SELECT COUNT(*) AS n FROM dj_seams')?.n ?? 0
  },

  saveModelRecord(record = {}) {
    const now = Date.now()
    this.db.run(
      `INSERT INTO dj_models
        (name, digest, file, shape, parameters, accuracy, loss, backend, station_id, active, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         digest = excluded.digest, file = excluded.file, shape = excluded.shape,
         parameters = excluded.parameters, accuracy = excluded.accuracy, loss = excluded.loss,
         backend = excluded.backend, station_id = excluded.station_id,
         active = excluded.active, meta = excluded.meta, updated_at = excluded.updated_at`,
      [
        record.name,
        record.digest ?? null,
        record.file ? String(record.file).split('/').pop() : null,
        JSON.stringify(record.shape ?? null),
        record.parameters ?? null,
        record.accuracy ?? null,
        record.loss ?? null,
        record.backend ?? null,
        record.station ?? record.stationId ?? null,
        record.active ? 1 : 0,
        JSON.stringify(record.meta ?? {}),
        record.createdAt ?? now,
        now
      ]
    )
    return this.modelRecord(record.name)
  },

  modelRecord(name) {
    const row = this.db.get('SELECT * FROM dj_models WHERE name = ?', [name])
    if (!row) return null
    return {
      ...row,
      active: row.active === 1,
      shape: json(row.shape, null),
      meta: json(row.meta, {}),
      remote: json(row.remote, null)
    }
  },

  listModelRecords() {
    return this.db.all('SELECT * FROM dj_models ORDER BY created_at DESC').map((row) => ({
      ...row,
      active: row.active === 1,
      shape: json(row.shape, null),
      meta: json(row.meta, {}),
      remote: json(row.remote, null)
    }))
  },

  activateModelRecord(name) {
    this.db.run('UPDATE dj_models SET active = 0, updated_at = ? WHERE active = 1', [Date.now()])
    this.db.run('UPDATE dj_models SET active = 1, updated_at = ? WHERE name = ?', [Date.now(), name])
    return this.modelRecord(name)
  },

  deleteModelRecord(name) {
    return this.db.run('DELETE FROM dj_models WHERE name = ?', [name]).changes > 0
  },

  setModelRemote(name, { repo = null, path = null, revision = 'main' } = {}) {
    this.db.run('UPDATE dj_models SET remote = ?, updated_at = ? WHERE name = ?', [
      JSON.stringify(repo ? { repo, path, revision } : null),
      Date.now(),
      name
    ])
    return this.modelRecord(name)
  },

  saveTrainingRun({ stationId = null, mode = null, count = 0, backend = null, trained = false, accuracy = null, best = null, report = {} } = {}) {
    const result = this.db.run(
      'INSERT INTO dj_training_runs (station_id, mode, count, backend, trained, accuracy, best, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [stationId, mode, count, backend, trained ? 1 : 0, accuracy, best, JSON.stringify(report ?? {}), Date.now()]
    )
    return Number(result.lastInsertRowid ?? this.db.get('SELECT last_insert_rowid() AS id')?.id ?? 0)
  },

  recentTrainingRuns(limit = 20) {
    return this.db.all('SELECT * FROM dj_training_runs ORDER BY id DESC LIMIT ?', [Math.max(1, Number(limit) || 1)]).map((row) => ({
      ...row,
      trained: row.trained === 1,
      report: json(row.report, {})
    }))
  }
}

export default modelRepo
