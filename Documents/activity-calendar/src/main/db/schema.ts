import type { Db } from './connection'

export function migrate(db: Db): void {
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
  `)
}
