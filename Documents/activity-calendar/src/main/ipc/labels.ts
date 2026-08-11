import { ipcMain } from 'electron'
import type { Db } from '../db/connection'
import type { Label } from '@shared/types'

export function rowToLabel(r: any): Label {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    parentId: r.parent_id,
    sortOrder: r.sort_order,
    archived: !!r.archived
  }
}

export function registerLabelHandlers(db: Db): void {
  ipcMain.handle('labels:list', () => {
    return db.prepare('SELECT * FROM labels ORDER BY sort_order, name').all().map(rowToLabel)
  })

  ipcMain.handle('labels:create', (_e, name: string, color: string | null, parentId: string | null) => {
    const dup = db
      .prepare('SELECT 1 FROM labels WHERE name = ? AND parent_id IS ?')
      .get(name, parentId ?? null)
    if (dup) throw new Error('A label with that name already exists here')
    const id = crypto.randomUUID()
    const max = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM labels WHERE parent_id IS ?')
      .get(parentId) as { m: number }
    db.prepare('INSERT INTO labels (id, name, color, parent_id, sort_order, archived) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, name, color, parentId, max.m + 1)
    return rowToLabel(db.prepare('SELECT * FROM labels WHERE id = ?').get(id))
  })

  ipcMain.handle('labels:update', (_e, id: string, patch: { name?: string; color?: string | null; sortOrder?: number; archived?: boolean }) => {
    const existing = db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as any
    if (!existing) throw new Error('Label not found: ' + id)
    if (patch.name !== undefined && patch.name !== existing.name) {
      const dup = db
        .prepare('SELECT 1 FROM labels WHERE name = ? AND parent_id IS ? AND id != ?')
        .get(patch.name, existing.parent_id, id)
      if (dup) throw new Error('A label with that name already exists here')
    }
    db.prepare('UPDATE labels SET name = @name, color = @color, sort_order = @sort, archived = @archived WHERE id = @id').run({
      id,
      name: patch.name ?? existing.name,
      color: patch.color !== undefined ? patch.color : existing.color,
      sort: patch.sortOrder ?? existing.sort_order,
      archived: patch.archived ?? existing.archived
    })
    return rowToLabel(db.prepare('SELECT * FROM labels WHERE id = ?').get(id))
  })

  ipcMain.handle('labels:remove', (_e, id: string) => {
    db.prepare('DELETE FROM labels WHERE id = ?').run(id)
  })
}
