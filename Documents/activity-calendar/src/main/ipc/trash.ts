/**
 * Trash (v1.11.14) — deleted events are kept here so they can be restored
 * (as a series or a single occurrence) or permanently deleted.
 * payload = JSON: { master: CalendarEvent, children?: CalendarEvent[] }
 */
import { ipcMain } from 'electron'
import type { Db } from '../db/connection'
import { rowToEvent } from './events'

export interface TrashEntry {
  id: string
  payload: { master: any; children?: any[] }
  deletedAt: string
}

export function registerTrashHandlers(db: Db): void {
  ipcMain.handle('trash:list', () => {
    const rows = db
      .prepare('SELECT id, payload, deleted_at FROM trash ORDER BY deleted_at ASC')
      .all() as Array<{ id: string; payload: string; deleted_at: string }>
    return rows.map((r) => ({ id: r.id, payload: JSON.parse(r.payload), deletedAt: r.deleted_at }))
  })

  ipcMain.handle('trash:add', (_e, id: string, payload: unknown) => {
    db.prepare('INSERT OR REPLACE INTO trash (id, payload, deleted_at) VALUES (?, ?, ?)').run(
      id,
      JSON.stringify(payload),
      new Date().toISOString()
    )
    return { ok: true }
  })

  /** Remove from trash (used when a delete is UNDONE — the event comes back). */
  ipcMain.handle('trash:remove', (_e, id: string) => {
    db.prepare('DELETE FROM trash WHERE id = ?').run(id)
    return { ok: true }
  })

  /** Restore: recreate the event(s) with their original ids, then drop the trash row. */
  ipcMain.handle('trash:restore', (_e, id: string, mode: 'series' | 'single') => {
    const row = db.prepare('SELECT payload FROM trash WHERE id = ?').get(id) as { payload: string } | undefined
    if (!row) return { ok: false, error: 'not found' }
    const { master, children = [] } = JSON.parse(row.payload)
    const ins = db.prepare(`
      INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                          color_override, status, rrule, exdates, parent_id, origin_date,
                          completed_at, created_at, updated_at)
      VALUES (@id, @title, @desc, @start, @end, @allDay, @label, @color, @status, @rrule,
              @exdates, @parent, @origin, @done, @created, @updated)
    `)
    db.transaction(() => {
      const insert = (e: any, parentId: string | null, rrule: string | null, exdates: string[]) => {
        ins.run({
          id: e.id,
          title: e.title,
          desc: e.description ?? '',
          start: e.startLocal,
          end: e.endLocal,
          allDay: e.allDay ? 1 : 0,
          label: e.labelId ?? null,
          color: e.colorOverride ?? null,
          status: e.status ?? 'todo',
          rrule,
          exdates: JSON.stringify(exdates),
          parent: parentId,
          origin: e.originDate ?? null,
          done: e.completedAt ?? null,
          created: e.createdAt ?? new Date().toISOString(),
          updated: new Date().toISOString()
        })
      }
      if (mode === 'single') {
        // restore as a one-off occurrence (rrule dropped, children dropped)
        insert(master, null, null, [])
      } else {
        insert(master, null, master.rrule ?? null, master.exdates ?? [])
        for (const c of children) insert(c, master.id, null, c.exdates ?? [])
      }
      db.prepare('DELETE FROM trash WHERE id = ?').run(id)
    })()
    return { ok: true }
  })

  /** Permanent delete — the event is gone forever. */
  ipcMain.handle('trash:purge', (_e, id: string) => {
    db.prepare('DELETE FROM trash WHERE id = ?').run(id)
    return { ok: true }
  })

  ipcMain.handle('trash:empty', () => {
    db.prepare('DELETE FROM trash').run()
    return { ok: true }
  })
}

export { rowToEvent }
