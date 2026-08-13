import { ipcMain } from 'electron'
import type { Db } from '../db/connection'
import type { CalendarEvent, EventInput } from '@shared/types'

export function rowToEvent(r: any): CalendarEvent {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? '',
    startLocal: r.start_local,
    endLocal: r.end_local,
    allDay: !!r.all_day,
    labelId: r.label_id,
    colorOverride: r.color_override,
    status: r.status,
    rrule: r.rrule,
    exdates: JSON.parse(r.exdates || '[]'),
    parentId: r.parent_id,
    originDate: r.origin_date,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function registerEventHandlers(db: Db): void {
  ipcMain.handle('events:list', () => {
    return db.prepare('SELECT * FROM events ORDER BY start_local').all().map(rowToEvent)
  })

  ipcMain.handle('events:get', (_e, id: string) => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id)
    return row ? rowToEvent(row) : null
  })

  ipcMain.handle('events:create', (_e, input: EventInput) => {
    const now = new Date().toISOString()
    const id = input.id ?? crypto.randomUUID()
    db.prepare(`
      INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                          color_override, status, rrule, exdates, parent_id, origin_date,
                          completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.title, input.description ?? '', input.startLocal, input.endLocal,
      input.allDay ? 1 : 0, input.labelId ?? null, input.colorOverride ?? null,
      input.status ?? 'todo', input.rrule ?? null, JSON.stringify(input.exdates ?? []),
      input.parentId ?? null, input.originDate ?? null,
      input.status === 'done' ? now : null, now, now
    )
    return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id))
  })

  ipcMain.handle('events:update', (_e, id: string, patch: Partial<EventInput>) => {
    const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any
    if (!existing) throw new Error('Event not found: ' + id)
    const now = new Date().toISOString()
    const status = patch.status ?? existing.status
    const completedAt =
      status === 'done' && existing.status !== 'done' ? now : status !== 'done' ? null : existing.completed_at

    db.prepare(`
      UPDATE events SET
        title = @title, description = @desc, start_local = @start, end_local = @end,
        all_day = @allDay, label_id = @label, color_override = @color, status = @status,
        rrule = @rrule, exdates = @exdates, parent_id = @parent, origin_date = @origin,
        completed_at = @done, updated_at = @now
      WHERE id = @id
    `).run({
      id,
      title: patch.title ?? existing.title,
      desc: patch.description ?? existing.description,
      start: patch.startLocal ?? existing.start_local,
      end: patch.endLocal ?? existing.end_local,
      allDay: (patch.allDay ?? !!existing.all_day) ? 1 : 0,
      label: patch.labelId !== undefined ? patch.labelId : existing.label_id,
      color: patch.colorOverride !== undefined ? patch.colorOverride : existing.color_override,
      status,
      rrule: patch.rrule !== undefined ? patch.rrule : existing.rrule,
      exdates: JSON.stringify(patch.exdates ?? JSON.parse(existing.exdates || '[]')),
      parent: patch.parentId !== undefined ? patch.parentId : existing.parent_id,
      origin: patch.originDate !== undefined ? patch.originDate : existing.origin_date,
      done: completedAt,
      now
    })
    return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id))
  })

  ipcMain.handle('events:remove', (_e, id: string) => {
    db.prepare('DELETE FROM events WHERE id = ?').run(id)
  })
}
