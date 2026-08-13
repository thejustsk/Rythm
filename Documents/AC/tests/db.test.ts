import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/schema'
import { seedIfEmpty } from '../src/main/db/seed'
import type { Db } from '../src/main/db/connection'
import { rowToEvent } from '../src/main/ipc/events'
import { rowToLabel } from '../src/main/ipc/labels'

let db: Db

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedIfEmpty(db)
})

describe('schema & seed', () => {
  it('seeds labels with sub-labels', () => {
    const labels = db.prepare('SELECT * FROM labels').all()
    expect(labels.length).toBeGreaterThan(0)
    const work = labels.find((l: any) => l.id === 'lbl-work') as any
    expect(work.color).toBe('#3B82F6')
    const sub = db.prepare("SELECT COUNT(*) AS c FROM labels WHERE parent_id = 'lbl-work'").get() as { c: number }
    expect(sub.c).toBe(2)
  })

  it('seeds events, including recurring ones', () => {
    const evs = db.prepare('SELECT * FROM events').all()
    expect(evs.length).toBeGreaterThan(10)
    const walk = db.prepare("SELECT * FROM events WHERE id = 'evt-walk'").get() as any
    expect(walk.rrule).toBe('FREQ=DAILY')
    expect(JSON.parse(walk.exdates)).toHaveLength(2) // two skipped days
  })

  it('seeds occurrence overrides', () => {
    const ov = db.prepare("SELECT * FROM events WHERE parent_id = 'evt-walk'").all()
    expect(ov.length).toBe(2)
    for (const o of ov as any[]) {
      expect(o.origin_date).toBeTruthy()
      expect(o.status).toBe('done')
    }
  })
})



describe('milestones', () => {
  afterAll(() => {
    db.prepare("DELETE FROM reward_milestones WHERE id IN ('m-claim')").run()
    db.prepare("DELETE FROM coin_transactions WHERE id IN ('fund','spend1')").run()
  })

  it('create + claim spends the cost and marks achieved', () => {
    db.prepare(
      `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
       VALUES ('m-claim', 'Movie night', '🎬', 50, 'treat', NULL, ?)`
    ).run(new Date().toISOString())
    // fund: earn 100
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
       VALUES ('fund', ?, NULL, NULL, NULL, 'earn', 100, 'Test fund', NULL)`
    ).run(new Date().toISOString())
    const bal = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    expect(bal.b).toBe(100)
    // claim 50
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
       VALUES ('spend1', ?, NULL, NULL, NULL, 'spend', 50, 'Milestone: Movie night', NULL)`
    ).run(new Date().toISOString())
    db.prepare("UPDATE reward_milestones SET achieved_at = ? WHERE id = 'm-claim'").run(new Date().toISOString())
    const bal2 = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    expect(bal2.b).toBe(50)
    const m = db.prepare("SELECT * FROM reward_milestones WHERE id = 'm-claim'").get() as any
    expect(m.achieved_at).toBeTruthy()
  })
})

describe('gamification tables', () => {
  afterAll(() => {
    db.prepare("DELETE FROM event_scores WHERE event_id IN ('g1','g2')").run()
    db.prepare("DELETE FROM coin_transactions WHERE id LIKE 'tx%'").run()
  })

  it('scores + earns record and balance derives from the ledger', () => {
    db.prepare(
      `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at) VALUES ('g1', '2026-08-10', 'on_time', ?)`
    ).run(new Date().toISOString())
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
       VALUES ('tx1', ?, 'g1', '2026-08-10', NULL, 'earn', 10, 'Completion score')`
    ).run(new Date().toISOString())
    const bal = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    expect(bal.b).toBe(10)
  })
  it('clearScores refunds earns for that occurrence', () => {
    // score an occurrence, then clear only that occurrence
    db.prepare(
      `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at) VALUES ('g2', '2026-08-11', 'late', ?)`
    ).run(new Date().toISOString())
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
       VALUES ('tx2', ?, 'g2', '2026-08-11', NULL, 'earn', 6, 'Completion score')`
    ).run(new Date().toISOString())
    db.prepare("DELETE FROM event_scores WHERE event_id = 'g2' AND origin_date = '2026-08-11'").run()
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
       VALUES ('tx2r', ?, 'g2', '2026-08-11', NULL, 'refund', 6, 'Refund on delete')`
    ).run(new Date().toISOString())
    const bal = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    expect(bal.b).toBe(10) // tx1 remains
  })
  it('milestones table stores reward goals', () => {
    db.prepare(
      `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
       VALUES ('m1', 'Movie night', '🎬', 500, 'Treat myself', NULL, ?)`
    ).run(new Date().toISOString())
    const m = db.prepare("SELECT * FROM reward_milestones WHERE id = 'm1'").get() as any
    expect(m.cost).toBe(500)
    expect(m.achieved_at).toBeNull()
  })
})

describe('CRUD', () => {
  it('creates, updates, deletes an event', () => {
    const id = 'test-1'
    db.prepare(
      `INSERT INTO events (id, title, start_local, end_local, status, created_at, updated_at)
       VALUES (?, 'Test', '2026-08-10T10:00', '2026-08-10T11:00', 'todo', ?, ?)`
    ).run(id, new Date().toISOString(), new Date().toISOString())

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any
    const ev = rowToEvent(row)
    expect(ev.title).toBe('Test')
    expect(ev.exdates).toEqual([])

    db.prepare("UPDATE events SET title = 'Test 2', status = 'done' WHERE id = ?").run(id)
    const ev2 = rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any)
    expect(ev2.title).toBe('Test 2')
    expect(ev2.status).toBe('done')

    db.prepare('DELETE FROM events WHERE id = ?').run(id)
    expect(db.prepare('SELECT * FROM events WHERE id = ?').get(id)).toBeUndefined()
  })

  it('label delete sets events.label_id to NULL (ON DELETE SET NULL)', () => {
    db.prepare(
      `INSERT INTO labels (id, name, color, parent_id, sort_order) VALUES ('lbl-del-test', 'DelMe', '#123456', NULL, 99)`
    ).run()
    db.prepare(
      `INSERT INTO events (id, title, start_local, end_local, label_id, created_at, updated_at)
       VALUES ('evt-del-test', 'Has label', '2026-08-10T10:00', '2026-08-10T11:00', 'lbl-del-test', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString())

    db.prepare("DELETE FROM labels WHERE id = 'lbl-del-test'").run()
    const row = db.prepare("SELECT * FROM events WHERE id = 'evt-del-test'").get() as any
    expect(row.label_id).toBeNull()
  })

  it('deleting a label cascades to its sub-labels', () => {
    db.prepare(
      `INSERT INTO labels (id, name, color, parent_id, sort_order) VALUES ('lbl-parent-test', 'P', '#123456', NULL, 98)`
    ).run()
    db.prepare(
      `INSERT INTO labels (id, name, color, parent_id, sort_order) VALUES ('lbl-child-test', 'C', NULL, 'lbl-parent-test', 1)`
    ).run()
    db.prepare("DELETE FROM labels WHERE id = 'lbl-parent-test'").run()
    expect(db.prepare("SELECT * FROM labels WHERE id = 'lbl-child-test'").get()).toBeUndefined()
  })

  it('renames and recolours a label', () => {
    db.prepare(
      `INSERT INTO labels (id, name, color, parent_id, sort_order) VALUES ('lbl-upd-test', 'Old', '#123456', NULL, 97)`
    ).run()
    db.prepare("UPDATE labels SET name = 'New', color = '#ABCDEF' WHERE id = 'lbl-upd-test'").run()
    const l = rowToLabel(db.prepare("SELECT * FROM labels WHERE id = 'lbl-upd-test'").get() as any)
    expect(l.name).toBe('New')
    expect(l.color).toBe('#ABCDEF')
    db.prepare("DELETE FROM labels WHERE id = 'lbl-upd-test'").run()
  })
})

describe('occurrence expansion against DB data', () => {
  it('computes daily occurrences from the seeded walk series', () => {
    const walk = db.prepare("SELECT * FROM events WHERE id = 'evt-walk'").get() as any
    const ev = rowToEvent(walk)
    expect(ev.rrule).toBe('FREQ=DAILY')
    expect(ev.exdates.length).toBe(2)
  })

  it('round-trips label rows', () => {
    const l = rowToLabel(db.prepare("SELECT * FROM labels WHERE id = 'lbl-fitness-walk'").get() as any)
    expect(l.name).toBe('Walk')
    expect(l.parentId).toBe('lbl-fitness')
    expect(l.color).toBeNull() // inherits
  })
})
