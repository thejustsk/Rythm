import type { Db } from './connection'

export function migrate(db: Db): void {
  // safe migration: add refunded_at to event_scores for older databases
  try {
    const cols = db.prepare('PRAGMA table_info(event_scores)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'refunded_at')) {
      db.exec('ALTER TABLE event_scores ADD COLUMN refunded_at TEXT')
    }
  } catch {
    // table may not exist yet on a brand-new DB — the CREATE below handles it
  }
  try {
    const tcols = db.prepare('PRAGMA table_info(coin_transactions)').all() as Array<{ name: string }>
    if (!tcols.some((c) => c.name === 'refunded_at')) {
      db.exec('ALTER TABLE coin_transactions ADD COLUMN refunded_at TEXT')
    }
  } catch {
    // brand-new DB — handled by CREATE
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT,
      parent_id  TEXT REFERENCES labels(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(parent_id);

    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      start_local   TEXT NOT NULL,
      end_local     TEXT NOT NULL,
      all_day       INTEGER NOT NULL DEFAULT 0,
      label_id      TEXT REFERENCES labels(id) ON DELETE SET NULL,
      color_override TEXT,
      status        TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo','doing','done','cancelled')),
      rrule         TEXT,
      exdates       TEXT NOT NULL DEFAULT '[]',
      parent_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
      origin_date   TEXT,
      completed_at  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_local);
    CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);
    CREATE INDEX IF NOT EXISTS idx_events_label ON events(label_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_scores (
      event_id    TEXT NOT NULL,
      origin_date TEXT NOT NULL,
      score_type  TEXT NOT NULL CHECK (score_type IN ('on_time','late','off_schedule')),
      scored_at   TEXT NOT NULL,
      refunded_at TEXT,
      PRIMARY KEY (event_id, origin_date)
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      event_id    TEXT,
      origin_date TEXT,
      label_id    TEXT,
      type        TEXT NOT NULL CHECK (type IN ('earn','bonus','spend','refund')),
      amount      REAL NOT NULL,
      reason      TEXT NOT NULL,
      refunded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coin_ts ON coin_transactions(ts);

    CREATE TABLE IF NOT EXISTS reward_milestones (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT,
      cost        REAL NOT NULL,
      notes       TEXT DEFAULT '',
      achieved_at TEXT,
      created_at  TEXT NOT NULL
    );
  `)
}
