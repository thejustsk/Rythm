import { ipcMain } from 'electron'
import type { Db } from '../db/connection'
import type { CoinTransaction, ScoreRow, ScoreType } from '@shared/types'
import {
  checkInState, allDoneCheck, weekKey, weekStartIso,
  addDaysIso, isoD, ALL_DONE_BONUS, PERFECT_WEEK_BONUS, PERFECT_MONTH_BONUS,
  perfectWeekCheck, perfectMonthCheck, streakMilestoneLevelsUpTo,
  defaultMilestoneCosts, streakMilestoneReward, roundCoins
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

/** Current streak: walk back from today; done days count, no-event days skip,
 *  event-without-done breaks. Builds a per-day map ONCE (fast even with years
 *  of history — the old per-day scan hung with >500 days). */
function computeStreak(db: Db): number {
  const today = todayIso()
  const gDay = new Map<string, { planned: number; done: number }>()
  let earliest: string | null = null
  const rows = db.prepare('SELECT * FROM events').all() as any[]
  for (const e of rows) {
    if (e.parent_id) continue
    const exdates = new Set(JSON.parse(e.exdates || '[]'))
    const ovs = db.prepare('SELECT origin_date, status FROM events WHERE parent_id = ?').all(e.id) as any[]
    const ovMap = new Map(ovs.map((o) => [o.origin_date, o.status]))
    const add = (iso: string, status: string) => {
      const g = gDay.get(iso) ?? { planned: 0, done: 0 }
      g.planned++
      if (status === 'done') g.done++
      gDay.set(iso, g)
    }
    if (e.rrule) {
      const rule = parseRRule(e.rrule)
      if (!rule) continue
      for (const day of iterateRule(rule, parseLocalDT(e.start_local))) {
        const iso = isoDate(day)
        if (iso > today) break
        if (exdates.has(iso)) continue
        add(iso, ovMap.get(iso) ?? e.status)
      }
    } else {
      const iso = e.start_local.slice(0, 10)
      if (iso > today) continue
      add(iso, ovMap.get(iso) ?? e.status)
    }
  }
  // earliest event day — computed from the map (visible to CFA, same result)
  earliest = null
  for (const iso of Array.from(gDay.keys())) {
    if (!earliest || iso < earliest) earliest = iso
  }
  let streak = 0
  for (let i = 0; i < 2000; i++) {
    const date = addDaysIso(today, -i)
    if (earliest && date < earliest) break // nothing older exists
    const g = gDay.get(date)
    if (g && g.done > 0) {
      streak++
      continue
    }
    // TODAY is a grace day: pending plans (not yet done) must NOT break the
    // streak — the day isn't over. Only a PAST day with plans and nothing
    // done breaks it. Days with no events are rest days (streak continues).
    if (g && g.planned > 0 && i > 0) break
  }
  return streak
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
    if (!coinsEnabled()) return { earned: false, amount: 0 }
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
    if (!coinsEnabled()) return { award: false, streak: 0, amount: 0, multiplier: 1 }
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
    if (!coinsEnabled()) return { award: false, amount: 0 }
    const occs = occurrencesOn(db, originDate)
    const planned = occs.length
    // v1.11.12: cancelled does NOT count as resolved — a day where you
    // cancelled everything is not "all done" (matches streak/perfect rules)
    const resolved = occs.filter((o) => o.status === 'done').length
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
   * Perfect week (+100) now fires when the current streak hits a multiple of 7
   * (7, 14, 21, …) — once per level. Streak rules: a done day counts; a day
   * with no events is skipped (streak continues, not counted); a day WITH
   * events but none done breaks the streak.
   */
  /** PERFECT WEEK (new logic): a completed Monday–Sunday week where every day
   *  with events is fully 'done' (rest days fine) and the week has ≥1 planned
   *  day. Each such week pays +100 once (key = the Monday). Weeks are scanned
   *  back from the most recent COMPLETED week (a week still in progress is
   *  never evaluated). */
  ipcMain.handle('coins:perfectWeek', () => {
    if (!coinsEnabled()) return { award: false, amount: 0, weekKey: null, streak: computeStreak(db) }
    // v1.11.6: the perfect-week bonus follows the user's FIRST DAY OF WEEK
    // setting — the rewarded week is EXACTLY the week shown in the Week view
    // (Sun–Sat when Sunday is set), so a week with a not-done first day can
    // never be rewarded. The streak calendar stays Monday-only (display).
    const startDow: 1 | 0 = (db.prepare("SELECT value FROM settings WHERE key = 'weekStart'").get() as any)?.value === 'sunday' ? 0 : 1
    const today = todayIso()
    const weekOfToday = weekStartIso(today, startDow)
    const awarded: string[] = []
    let amount = 0
    const hasKey = (k: string) => !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k)
    for (let w = 0; w < 16; w++) {
      const wkStart = addDaysIso(weekOfToday, -7 * w)
      const wkEnd = addDaysIso(wkStart, 6)
      if (wkEnd > today) continue // week not complete yet
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const iso = addDaysIso(wkStart, i)
        const occs = occurrencesOn(db, iso)
        return { planned: occs.length, done: occs.filter((o) => o.status === 'done').length }
      })
      // v1.11.7: the reward WAITS for the LAST day (Sunday / the week's end)
      // to have at least one DONE event — a week where Mon–Sat are done but
      // Sunday has nothing done (or only todos) is NOT yet perfect.
      if (!perfectWeekCheck(days)) continue
      if (days[6].done === 0) continue // last day must have >=1 done
      const key = 'streakAward.' + wkStart
      // double-pay guard: the two week orientations overlap by 6 days — never
      // pay twice for the same real days after switching the setting
      const neighbor = startDow === 1 ? addDaysIso(wkStart, -1) : addDaysIso(wkStart, 1)
      if (hasKey(key) || hasKey('streakAward.' + neighbor)) continue
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(key)
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Perfect week', NULL)`
        ).run(crypto.randomUUID(), new Date().toISOString(), wkStart, PERFECT_WEEK_BONUS)
      })()
      awarded.push(wkStart)
      amount += PERFECT_WEEK_BONUS
    }
    return { award: awarded.length > 0, amount, weekKey: awarded[0] ?? null, streak: computeStreak(db) }
  })

  /** PERFECT MONTH: every day of a completed month is a rest day or has at
   *  least one done event, AND no block of 7+ consecutive no-event days exists
   *  in the month. Pays +300 once (key = the 1st). */
  ipcMain.handle('coins:perfectMonth', () => {
    if (!coinsEnabled()) return { award: false, amount: 0, streak: computeStreak(db), level: null }
    const today = todayIso()
    const awarded: string[] = []
    let amount = 0
    for (let m = 0; m < 6; m++) {
      const first = new Date(today + 'T00:00:00')
      first.setDate(1)
      first.setMonth(first.getMonth() - m)
      const start = isoD(first)
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
      const end = isoD(last)
      if (end >= today) continue // month not complete yet
      const dayOf = (iso: string) => {
        const occs = occurrencesOn(db, iso)
        return { planned: occs.length, done: occs.filter((o) => o.status === 'done').length }
      }
      if (!perfectMonthCheck(start, end, dayOf)) continue
      const key = 'monthStreak.' + start
      if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) continue
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(key)
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Perfect month', NULL)`
        ).run(crypto.randomUUID(), new Date().toISOString(), start, PERFECT_MONTH_BONUS)
      })()
      awarded.push(start)
      amount += PERFECT_MONTH_BONUS
    }
    return { award: awarded.length > 0, amount, streak: computeStreak(db), level: awarded[0] ?? null }
  })

  /** Streak milestone: 5/10/20/… → value × 2 coins, once per level (catch-up:
   *  every unclaimed milestone ≤ streak pays out). */
  ipcMain.handle('coins:streakMilestone', () => {
    if (!coinsEnabled()) return { award: false, amount: 0, streak: 0, level: null }
    const streak = computeStreak(db)
    const levels = streakMilestoneLevelsUpTo(streak).filter((l) => !db.prepare('SELECT 1 FROM settings WHERE key = ?').get('streakMs.' + l))
    if (levels.length === 0) return { award: false, amount: 0, streak, level: null }
    db.transaction(() => {
      for (const l of levels) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run('streakMs.' + l)
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Streak milestone', NULL)`
        ).run(crypto.randomUUID(), new Date().toISOString(), todayIso(), streakMilestoneReward(l))
      }
    })()
    return { award: true, amount: levels.reduce((s, l) => s + streakMilestoneReward(l), 0), streak, level: levels[levels.length - 1] }
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
    const net = (date: string) => roundCoins(byLocalDate.get(date) ?? 0)
    const series = []
    for (let i = 6; i >= 0; i--) {
      const date = addDaysIso(today, -i)
      series.push({ date, amount: net(date) })
    }
    // v1.11.6: earned-by-label — 'earn' transactions group by their event's
    // label (NULL → "No label"); 'refund' reduces that label's bucket; ALL
    // bonus transactions (check-in, perfect week/month, streak milestone,
    // all-done) group into a dedicated "Rewards 🏆" row — never "No label".
    const perLabelMap = new Map<string | null, number>()
    let rewards = 0
    for (const t of txs) {
      if (t.type === 'bonus') { rewards += t.amount; continue }
      if (t.type === 'earn' || t.type === 'refund') {
        const delta = t.type === 'refund' ? -t.amount : t.amount
        perLabelMap.set(t.label_id ?? null, (perLabelMap.get(t.label_id ?? null) ?? 0) + delta)
      }
    }
    // v1.11.16: include parent info so the Coins view can group the rows
    // under their parent labels with expand/collapse toggles
    const labels = db.prepare('SELECT id, name, parent_id FROM labels').all() as Array<{ id: string; name: string; parent_id: string | null }>
    const perLabel: Array<{ labelId: string | null; labelName: string; parentId: string | null; parentName: string | null; amount: number }> = []
    for (const [id, amount] of perLabelMap.entries()) {
      if (amount === 0) continue
      const lb = id ? labels.find((l) => l.id === id) : undefined
      const parent = lb?.parent_id ? labels.find((l) => l.id === lb.parent_id) : undefined
      perLabel.push({
        labelId: id,
        labelName: id ? (lb?.name ?? '?') : 'No label',
        parentId: parent ? parent.id : null,
        parentName: parent ? parent.name : null,
        amount: roundCoins(amount)
      })
    }
    if (rewards !== 0) {
      perLabel.push({ labelId: '__rewards__', labelName: 'Rewards 🏆', parentId: null, parentName: null, amount: roundCoins(rewards) })
    }
    perLabel.sort((a, b) => b.amount - a.amount)
    return { today: net(today), series, perLabel }
  })

  // ---- cup 3: coin-system master switch ----
  const coinsEnabled = () => {
    const v = db.prepare("SELECT value FROM settings WHERE key = 'coinSystem'").get() as { value: string } | undefined
    return v ? v.value !== '0' : true
  }
  ipcMain.handle('coins:system', () => coinsEnabled())
  ipcMain.handle('coins:setSystem', (_e, on: boolean) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('coinSystem', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0')
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
  /** A milestone is "reached" once its cost was ever met (sticky setting) or it
   *  was first-claimed. EVERY path that returns a milestone (list/create/update)
   *  must include this flag — otherwise the renderer loses it on edit and the
   *  path wrongly collapses (the "first time after editing" bug). */
  const withReached = (r: any) => ({
    ...rowToMilestone(r),
    reached: !!r.achieved_at || !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get('stoneReached.' + r.cost)
  })

  /**
   * Canonicalize the milestone path — runs on EVERY list so no DB state can
   * break the design: the path is ALWAYS exactly "Level 1..8" with fixed costs
   * (100, 250, 500, …), Level 1 first. Legacy rows (old 'Level 100' names,
   * renamed levels, extra rows, missing rows) are repaired in place, and the
   * user's real progress (achieved_at, notes) is preserved per level slot.
   */
  const normalizeMilestonePath = () => {
    // INFINITE PATH: always at least 30 levels; extend (+10) whenever the
    // current net could reach the last level, so the +2000 ladder never ends
    const balRow = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    let count = 30
    while (defaultMilestoneCosts(count)[count - 1] <= balRow.b + 2000) count += 10
    const costs = defaultMilestoneCosts(count)
    db.transaction(() => {
      // 1) drop rows that can't belong to the ladder (extras, free-form costs)
      const canonical = new Set(costs)
      const all = db.prepare('SELECT id, cost FROM reward_milestones').all() as any[]
      const stmt = db.prepare('DELETE FROM reward_milestones WHERE id = ?')
      for (const r of all) if (!canonical.has(r.cost)) stmt.run(r.id)
      // 2) fill / repair the 8 slots in cost order (progress preserved per slot)
      const rows = db.prepare('SELECT * FROM reward_milestones ORDER BY cost').all() as any[]
      const now = new Date().toISOString()
      for (let i = 0; i < costs.length; i++) {
        const expectCost = costs[i]
        const expectName = 'Level ' + (i + 1)
        const row = rows[i]
        if (row) {
          if (row.cost !== expectCost || row.name !== expectName) {
            db.prepare('UPDATE reward_milestones SET cost = ?, name = ? WHERE id = ?').run(expectCost, expectName, row.id)
          }
        } else {
          db.prepare(
            `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
             VALUES (?, ?, '🎯', ?, 'Set your reward', NULL, ?)`
          ).run(crypto.randomUUID(), expectName, expectCost, now)
        }
      }
      // 3) drop any extras beyond the 8 slots
      const after = db.prepare('SELECT id FROM reward_milestones ORDER BY cost').all() as any[]
      for (let i = costs.length; i < after.length; i++) stmt.run(after[i].id)
      // mark migration done so future list calls skip the historical rebuild path
      db.prepare("INSERT INTO settings (key, value) VALUES ('milestonePathV2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    })()
  }

  ipcMain.handle('milestones:list', () => {
    const rows = db.prepare('SELECT * FROM reward_milestones ORDER BY cost').all() as any[]
    const v2 = db.prepare("SELECT 1 FROM settings WHERE key = 'milestonePathV2'").get()
    if (rows.length === 0 || !v2) {
      // ONE-TIME fresh start: canonical Level 1..8, nothing achieved yet —
      // guarantees "start from ONLY Level 1" regardless of any legacy data.
      // Also clears any sticky-reach keys left by an earlier path version.
      db.transaction(() => {
        db.prepare('DELETE FROM reward_milestones').run()
        db.prepare("DELETE FROM settings WHERE key LIKE 'stoneReached.%' OR key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%'").run()
        const now = new Date().toISOString()
        defaultMilestoneCosts(30).forEach((cost, i) => {
          db.prepare(
            `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
             VALUES (?, ?, '🎯', ?, 'Set your reward', NULL, ?)`
          ).run(crypto.randomUUID(), 'Level ' + (i + 1), cost, now)
        })
        db.prepare("INSERT INTO settings (key, value) VALUES ('milestonePathV2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
      })()
    } else {
      // Flag already set: repair names/costs/extras WITHOUT touching real
      // progress (achieved_at and notes are preserved per level slot).
      normalizeMilestonePath()
    }
    // STICKY REACH: any stone whose cost is currently met (or already claimed)
    // is remembered forever via `stoneReached.<cost>`. The renderer then never
    // removes a level box even after the net drops below the cost.
    const bal = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    const list = db.prepare('SELECT * FROM reward_milestones ORDER BY cost').all() as any[]
    const reachKey = (cost: number) => 'stoneReached.' + cost
    db.transaction(() => {
      const ins = db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      for (const m of list) {
        if (m.achieved_at || bal.b >= m.cost) ins.run(reachKey(m.cost))
      }
    })()
    return list.map((r) => withReached(r))
  })

  ipcMain.handle('milestones:create', (_e, name: string, icon: string, cost: number, notes: string) => {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(id, name, icon || '🎯', cost, notes, new Date().toISOString())
    return withReached(db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id))
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
    return withReached(db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id))
  })

  ipcMain.handle('milestones:remove', (_e, id: string) => {
    db.prepare('DELETE FROM reward_milestones WHERE id = ?').run(id)
  })

  /** Claim a milestone (redeemable MULTIPLE times): spends the cost; achieved_at
   *  only records the FIRST claim. */
  ipcMain.handle('milestones:claim', (_e, id: string) => {
    if (!coinsEnabled()) return { ok: false, balance: 0 }
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
      if (!m.achieved_at) {
        db.prepare('UPDATE reward_milestones SET achieved_at = ? WHERE id = ?').run(new Date().toISOString(), id)
      }
    })()
    const nb = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    return { ok: true, balance: nb }
  })

  /** Undo a milestone claim (item B.13): removes the latest un-refunded spend
   *  for that milestone and clears its achieved_at. Idempotent — no spend, no-op. */
  ipcMain.handle('milestones:unclaim', (_e, id: string) => {
    const m = db.prepare('SELECT * FROM reward_milestones WHERE id = ?').get(id) as any
    if (!m) return { ok: false, balance: 0 }
    const spend = db
      .prepare(
        `SELECT id FROM coin_transactions
         WHERE type = 'spend' AND reason = 'Milestone: ' || ? AND refunded_at IS NULL
         ORDER BY ts DESC LIMIT 1`
      )
      .get(m.name) as { id: string } | undefined
    if (!spend) return { ok: false, balance: 0 }
    db.transaction(() => {
      db.prepare('DELETE FROM coin_transactions WHERE id = ?').run(spend.id)
      db.prepare('UPDATE reward_milestones SET achieved_at = NULL WHERE id = ?').run(id)
    })()
    const nb = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    return { ok: true, balance: nb }
  })

  /** v1.11.15/16: score insights — on-time / late / off-schedule patterns,
   *  overall and BY LABEL (excludes refunded scores). v1.11.16: scoped to a
   *  PERIOD ([from, to) ISO dates by occurrence date) and/or a selection of
   *  PARENT labels (their children included) — the Insights top chips. */
  ipcMain.handle(
    'coins:scoreInsights',
    (_e, opts: { from?: string; to?: string; parentIds?: string[] } = {}) => {
      const { from, to, parentIds = [] } = opts ?? {}
      const where = ['s.refunded_at IS NULL']
      const params: string[] = []
      if (from) {
        where.push('s.origin_date >= ?')
        params.push(from)
      }
      if (to) {
        where.push('s.origin_date < ?')
        params.push(to)
      }
      if (parentIds.length > 0) {
        const ph = parentIds.map(() => '?').join(',')
        where.push(`((l.parent_id IN (${ph})) OR (l.id IN (${ph})))`)
        params.push(...parentIds, ...parentIds)
      }
      const rows = db.prepare(`
        SELECT s.score_type, s.origin_date, e.label_id, l.name AS label_name, l.parent_id, pl.name AS parent_name,
               l.color AS label_color, pl.color AS parent_color
        FROM event_scores s
        LEFT JOIN events e ON e.id = s.event_id
        LEFT JOIN labels l ON l.id = e.label_id
        LEFT JOIN labels pl ON pl.id = l.parent_id
        WHERE ${where.join(' AND ')}
      `).all(...params) as Array<{
        score_type: string
        label_id: string | null
        label_name: string | null
        parent_id: string | null
        parent_name: string | null
        label_color: string | null
        parent_color: string | null
      }>
      const total = { on_time: 0, late: 0, off_schedule: 0 }
      const byLabel = new Map<string, { labelId: string | null; name: string; parentId: string | null; parentName: string | null; color: string | null; on_time: number; late: number; off_schedule: number }>()
      for (const r of rows) {
        const k = r.score_type as keyof typeof total
        if (k in total) total[k]++
        const labelKey = r.label_id ?? 'none'
        let entry = byLabel.get(labelKey)
        if (!entry) {
          const name = r.label_name ?? r.parent_name ?? 'No label'
          entry = {
            labelId: r.label_id,
            name,
            parentId: r.parent_id,
            parentName: r.parent_name,
            color: r.label_color ?? r.parent_color ?? null,
            on_time: 0,
            late: 0,
            off_schedule: 0
          }
          byLabel.set(labelKey, entry)
        }
        if (k in entry) entry[k]++
      }
      const n = rows.length
      const labels = [...byLabel.values()]
        .map((l) => ({ ...l, total: l.on_time + l.late + l.off_schedule }))
        .filter((l) => l.total > 0)
        .sort((a, b) => b.total - a.total)
      return { total, labels, count: n }
    }
  )

  ipcMain.handle('coins:balance', () => {
    const r = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions")
      .get() as { b: number }
    return r.b
  })

  ipcMain.handle('coins:listTransactions', () => {
    // v1.10.6: NO cap — the ledger must show every entry (the UI scrolls).
    return db.prepare('SELECT * FROM coin_transactions ORDER BY ts DESC').all().map(rowToTx)
  })
}
