import { ipcMain } from 'electron'
import type { Db } from '../db/connection'
import type { CoinTransaction, ScoreRow, ScoreType } from '@shared/types'
import {
  checkInState, allDoneCheck, perfectWeekCheck, weekKey,
  addDaysIso, ALL_DONE_BONUS, PERFECT_WEEK_BONUS
} from '../gamifyCore'
import { parseRRule, iterateRule, isoDate } from '../../renderer/src/engine/recurrence'

const pad2 = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const todayIso = () => localDate(new Date())
const parseLocalDT = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(s)
}

/** Every occurrence of a date: masters (recurring or one-off) + overrides. */
function occurrencesOn(db: Db, dateIso: string): Array<{ eventId: string; status: string }> {
  const out: Array<{ eventId: string; status: string }> = []
  const rows = db.prepare('SELECT * FROM events').all() as any[]
  for (const e of rows) {
    if (e.parent_id) continue
    const exdates = new Set(JSON.parse(e.exdates || '[]'))
    const ov = db.prepare('SELECT * FROM events WHERE parent_id = ? AND origin_date = ?').get(e.id, dateIso) as any
    if (ov) {
      out.push({ eventId: ov.id, status: ov.status })
      continue
    }
    if (e.rrule) {
      const rule = parseRRule(e.rrule)
      if (!rule) continue
      for (const day of iterateRule(rule, parseLocalDT(e.start_local))) {
        const iso = isoDate(day)
        if (iso === dateIso) {
          if (!exdates.has(dateIso)) out.push({ eventId: e.id, status: e.status })
          break
        }
        if (iso > dateIso) break
      }
    } else if (e.start_local.slice(0, 10) === dateIso) {
      out.push({ eventId: e.id, status: e.status })
    }
  }
  return out
}

export function rowToScore(r: any): ScoreRow {
  return {
    eventId: r.event_id,
    originDate: r.origin_date,
    scoreType: r.score_type,
    scoredAt: r.scored_at,
    refundedAt: r.refunded_at ?? null
  }
}

/** LIVE (not-yet-refunded) earn transaction(s) tied to a score key. */
function liveEarns(db: Db, eventId: string, originDate: string): any[] {
  return db
    .prepare("SELECT * FROM coin_transactions WHERE event_id = ? AND origin_date = ? AND type = 'earn' AND refunded_at IS NULL")
    .all(eventId, originDate) as any[]
}

/** Mark earns as refunded so they can never be refunded twice. */
function markRefunded(db: Db, eventId: string, originDate: string, refundId: string): void {
  db.prepare("UPDATE coin_transactions SET refunded_at = ? WHERE event_id = ? AND origin_date = ? AND type = 'earn' AND refunded_at IS NULL")
    .run(refundId, eventId, originDate)
}

export function rowToTx(r: any): CoinTransaction {
  return {
    id: r.id,
    ts: r.ts,
    eventId: r.event_id,
    originDate: r.origin_date,
    labelId: r.label_id,
    type: r.type,
    amount: r.amount,
    reason: r.reason
  }
}

export function registerGamifyHandlers(db: Db): void {
  /** Insert a score row + an earn transaction, atomically and IDEMPOTENTLY:
   *  an earn is only written when the score row is NEW (re-scoring the same
   *  key updates the score but never earns twice). */
  ipcMain.handle('coins:scoreEvent', (_e, eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null) => {
    const now = new Date().toISOString()
    return db.transaction(() => {
      const exists = db
        .prepare('SELECT 1 FROM event_scores WHERE event_id = ? AND origin_date = ?')
        .get(eventId, originDate)
      if (exists) {
        db.prepare('UPDATE event_scores SET score_type = ?, scored_at = ? WHERE event_id = ? AND origin_date = ?')
          .run(scoreType, now, eventId, originDate)
        return { earned: false, amount: 0 }
      }
      db.prepare(
        `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at)
         VALUES (?, ?, ?, ?)`
      ).run(eventId, originDate, scoreType, now)
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
         VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Completion score')`
      ).run(crypto.randomUUID(), now, eventId, originDate, labelId, amount)
      return { earned: true, amount }
    })()
  })

  ipcMain.handle('coins:getScore', (_e, eventId: string, originDate: string) => {
    const r = db.prepare('SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?').get(eventId, originDate)
    return r ? rowToScore(r) : null
  })

  /**
   * Remove scores (optionally for one occurrence) and refund any earns for them.
   * Returns the removed score rows + the earn info needed to restore them on Undo.
   * Rows already refunded (status-revert) are NOT refunded again.
   */
  ipcMain.handle('coins:clearScores', (_e, eventId: string, originDate?: string) => {
    const now = new Date().toISOString()
    return db.transaction(() => {
      const rows = (originDate
        ? db.prepare('SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?').all(eventId, originDate)
        : db.prepare('SELECT * FROM event_scores WHERE event_id = ?').all(eventId)) as any[]
      if (originDate) db.prepare('DELETE FROM event_scores WHERE event_id = ? AND origin_date = ?').run(eventId, originDate)
      else db.prepare('DELETE FROM event_scores WHERE event_id = ?').run(eventId)
      const earns: Array<{ eventId: string; originDate: string; amount: number; labelId: string | null }> = []
      for (const r of rows) {
        if (r.refunded_at) continue // already refunded by a status revert
        for (const e of liveEarns(db, eventId, r.origin_date)) {
          const rid = crypto.randomUUID()
          db.prepare(
            `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
             VALUES (?, ?, ?, ?, ?, 'refund', ?, 'Refund on delete', NULL)`
          ).run(rid, now, eventId, r.origin_date, e.label_id, e.amount)
          markRefunded(db, eventId, r.origin_date, rid)
          earns.push({ eventId, originDate: r.origin_date, amount: e.amount, labelId: e.label_id })
        }
      }
      return { scores: rows.map(rowToScore), earns }
    })()
  })

  /** Re-insert scores + earns (undo of a delete) — restores the real amounts. */
  ipcMain.handle('coins:restoreScores', (_e, rows: Array<{ eventId: string; originDate: string; scoreType: ScoreType; amount: number; labelId: string | null }>) => {
    const now = new Date().toISOString()
    db.transaction(() => {
      for (const r of rows) {
        db.prepare(
          `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at, refunded_at)
           VALUES (?, ?, ?, ?, NULL) ON CONFLICT(event_id, origin_date)
           DO UPDATE SET score_type = excluded.score_type, refunded_at = NULL`
        ).run(r.eventId, r.originDate, r.scoreType, now)
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
           VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Restored after undo')`
        ).run(crypto.randomUUID(), now, r.eventId, r.originDate, r.labelId, r.amount)
      }
    })()
  })

  /** Status-revert: refund the earn but KEEP the score row (marked refunded) so
   *  re-marking Done restores silently ("already gained") instead of re-prompting. */
  ipcMain.handle('coins:revertScore', (_e, eventId: string, originDate: string) => {
    const now = new Date().toISOString()
    db.transaction(() => {
      const row = db.prepare('SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?').get(eventId, originDate) as any
      if (!row || row.refunded_at) return { refunded: false, amount: 0 }
      const earns = liveEarns(db, eventId, originDate)
      let total = 0
      for (const e of earns) {
        const rid = crypto.randomUUID()
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, ?, ?, ?, 'refund', ?, 'Refund on status change', NULL)`
        ).run(rid, now, eventId, originDate, e.label_id, e.amount)
        markRefunded(db, eventId, originDate, rid)
        total += e.amount
      }
      db.prepare('UPDATE event_scores SET refunded_at = ? WHERE event_id = ? AND origin_date = ?').run(now, eventId, originDate)
      return { refunded: true, amount: total }
    })()
  })

  /** Re-marking Done after a revert: restore the earn silently, clear the refund flag. */
  ipcMain.handle('coins:restoreScore', (_e, eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null) => {
    const now = new Date().toISOString()
    db.transaction(() => {
      const row = db.prepare('SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?').get(eventId, originDate) as any
      if (!row || !row.refunded_at) return { restored: false }
      db.prepare('UPDATE event_scores SET refunded_at = NULL WHERE event_id = ? AND origin_date = ?').run(eventId, originDate)
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
         VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Restored after status change')`
      ).run(crypto.randomUUID(), now, eventId, originDate, labelId, amount)
      return { restored: true }
    })()
  })

  /** Balance = sum(earn + bonus + refund) − sum(spend), derived from the ledger. */
  /** Daily check-in: +10 once per day; streak continues from yesterday; ×2 every 7th day. */
  ipcMain.handle('coins:checkIn', () => {
    const today = todayIso()
    const last = db.prepare("SELECT value FROM settings WHERE key = 'lastCheckIn'").get() as { value: string } | undefined
    const streakRow = db.prepare("SELECT value FROM settings WHERE key = 'checkInStreak'").get() as { value: string } | undefined
    const res = checkInState(last?.value ?? null, parseInt(streakRow?.value ?? '0', 10) || 0, today)
    if (res.award) {
      const now = new Date().toISOString()
      db.transaction(() => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('lastCheckIn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today)
        db.prepare("INSERT INTO settings (key, value) VALUES ('checkInStreak', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(res.streak))
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Daily check-in', NULL)`
        ).run(crypto.randomUUID(), now, today, res.amount)
      })()
      return { award: true, streak: res.streak, amount: res.amount }
    }
    return { award: false, streak: res.streak, amount: 0 }
  })

  /** "All planned done" bonus for a day (+25), awarded once per day. */
  ipcMain.handle('coins:allDoneCheck', (_e, originDate: string) => {
    const occs = occurrencesOn(db, originDate)
    const planned = occs.length
    const resolved = occs.filter((o) => o.status === 'done' || o.status === 'cancelled').length
    if (!allDoneCheck(planned, resolved)) return { award: false, amount: 0 }
    const already = db
      .prepare("SELECT 1 FROM coin_transactions WHERE type = 'bonus' AND reason = 'All done' AND origin_date = ?")
      .get(originDate)
    if (already) return { award: false, amount: 0 }
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
       VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'All done', NULL)`
    ).run(crypto.randomUUID(), new Date().toISOString(), originDate, ALL_DONE_BONUS)
    return { award: true, amount: ALL_DONE_BONUS }
  })

  /**
   * Perfect week (+100, once per week): every day of the last 7 COMPLETED days
   * (yesterday back 7 — today's still-pending items NEVER block it) must be
   * active (≥1 done) or a rest day (no plans). A day only counts as missed if
   * it had plans and NOTHING was done.
   */
  ipcMain.handle('coins:perfectWeek', () => {
    const today = todayIso()
    const days: Array<{ date: string; hasDone: boolean; hasMissed: boolean; planned: number }> = []
    for (let i = 1; i <= 7; i++) {
      const date = addDaysIso(today, -i)
      const occs = occurrencesOn(db, date)
      days.push({
        date,
        planned: occs.length,
        hasDone: occs.some((o) => o.status === 'done'),
        hasMissed: occs.some((o) => o.status === 'todo' || o.status === 'doing')
      })
    }
    if (!perfectWeekCheck(days)) {
      const blocking = days.find((d) => d.planned > 0 && !d.hasDone)
      return { award: false, amount: 0, weekKey: null, blockingDay: blocking?.date ?? null }
    }
    const key = 'perfectWeek.' + weekKey(days[0].date)
    const done = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)
    if (done) return { award: false, amount: 0, weekKey: key }
    db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(key)
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
         VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Perfect week', NULL)`
      ).run(crypto.randomUUID(), new Date().toISOString(), days[0].date, PERFECT_WEEK_BONUS)
    })()
    return { award: true, amount: PERFECT_WEEK_BONUS, weekKey: key }
  })

  /** Stats for the Coins view: today net, 7-day series, per-label earnings.
   *  Transactions are stored in UTC — bucket them by LOCAL date so "today"
   *  matches what the user sees (fixes wrong "Earned today" in +UTC zones). */
  ipcMain.handle('coins:stats', () => {
    const today = todayIso()
    const txs = db.prepare('SELECT * FROM coin_transactions ORDER BY ts').all() as any[]
    const localDateOf = (iso: string) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }
    const byLocalDate = new Map<string, number>()
    for (const t of txs) {
      const key = localDateOf(t.ts)
      const delta = t.type === 'spend' || t.type === 'refund' ? -t.amount : t.amount
      byLocalDate.set(key, (byLocalDate.get(key) ?? 0) + delta)
    }
    const net = (date: string) => Math.round((byLocalDate.get(date) ?? 0) * 100) / 100
    const series = []
    for (let i = 6; i >= 0; i--) {
      const date = addDaysIso(today, -i)
      series.push({ date, amount: net(date) })
    }
    const perLabelMap = new Map<string | null, number>()
    for (const t of txs) {
      if (t.type !== 'earn' && t.type !== 'bonus') continue
      perLabelMap.set(t.label_id ?? null, (perLabelMap.get(t.label_id ?? null) ?? 0) + t.amount)
    }
    const labels = db.prepare('SELECT id, name FROM labels').all() as Array<{ id: string; name: string }>
    const perLabel = [...perLabelMap.entries()]
      .map(([id, amount]) => ({ labelId: id, labelName: id ? (labels.find((l) => l.id === id)?.name ?? '?') : 'No label', amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount)
    return { today: net(today), series, perLabel }
  })

  // ---- milestones ----
  const rowToMilestone = (r: any) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    cost: r.cost,
    notes: r.notes,
    achievedAt: r.achieved_at,
    createdAt: r.created_at
  })

  ipcMain.handle('milestones:list', () => {
    return db.prepare('SELECT * FROM reward_milestones ORDER BY cost').all().map(rowToMilestone)
  })

  ipcMain.handle('milestones:create', (_e, name: string, icon: string, cost: number, notes: string) => {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(id, name, icon || '🎯', cost, notes, new Date().toISOString())
    return rowToMilestone(db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id))
  })

  ipcMain.handle('milestones:update', (_e, id: string, patch: { name?: string; icon?: string; cost?: number; notes?: string }) => {
    const existing = db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id) as any
    if (!existing) throw new Error('Milestone not found')
    db.prepare('UPDATE reward_milestones SET name = ?, icon = ?, cost = ?, notes = ? WHERE id = ?').run(
      patch.name ?? existing.name,
      patch.icon ?? existing.icon,
      patch.cost ?? existing.cost,
      patch.notes ?? existing.notes,
      id
    )
    return rowToMilestone(db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id))
  })

  ipcMain.handle('milestones:remove', (_e, id: string) => {
    db.prepare('DELETE FROM reward_milestones WHERE id = ?').run(id)
  })

  /** Claim a milestone: spend the cost (derived from the ledger), mark achieved. */
  ipcMain.handle('milestones:claim', (_e, id: string) => {
    const m = db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id) as any
    if (!m) return { ok: false, balance: 0 }
    const bal = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    if (bal.b < m.cost) return { ok: false, balance: bal.b }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
         VALUES (?, ?, NULL, NULL, NULL, 'spend', ?, 'Milestone: ' || ?, NULL)`
      ).run(crypto.randomUUID(), new Date().toISOString(), m.cost, m.name)
      db.prepare('UPDATE reward_milestones SET achieved_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    })()
    const nb = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    return { ok: true, balance: nb }
  })

  ipcMain.handle('coins:balance', () => {
    const r = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    return r.b
  })

  ipcMain.handle('coins:listTransactions', () => {
    return db.prepare('SELECT * FROM coin_transactions ORDER BY ts DESC LIMIT 500').all().map(rowToTx)
  })
}
