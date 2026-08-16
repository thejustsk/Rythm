import { describe, expect, it } from 'vitest'
import { toggleStatusSel, ALL_STATUSES, statusLabelOf } from '../src/renderer/src/lib/statusSel'

describe('statusSel (v1.11.16 multi-select status filter)', () => {
  it('starts empty (All) and toggles a status on', () => {
    const sel = toggleStatusSel(new Set(), 'todo')
    expect([...sel]).toEqual(['todo'])
  })

  it('toggles a status off again', () => {
    const sel = toggleStatusSel(new Set(['todo', 'doing']), 'todo')
    expect([...sel]).toEqual(['doing'])
  })

  it('keeps multiple statuses selected at once', () => {
    let sel = toggleStatusSel(new Set(), 'todo')
    sel = toggleStatusSel(sel, 'doing')
    sel = toggleStatusSel(sel, 'done')
    expect([...sel].sort()).toEqual(['doing', 'done', 'todo'])
  })

  it('normalizes "all four selected" back to All (empty set)', () => {
    let sel = new Set(ALL_STATUSES)
    expect(sel.size).toBe(4)
    sel = toggleStatusSel(sel, 'todo') // removing one → 3
    expect(sel.size).toBe(3)
    sel = toggleStatusSel(sel, 'todo') // adding it back → 4 → All
    expect(sel.size).toBe(0)
  })

  it('labels statuses for toasts', () => {
    expect(statusLabelOf('todo')).toBe('To Do')
    expect(statusLabelOf('doing')).toBe('In Progress')
    expect(statusLabelOf('done')).toBe('Done')
    expect(statusLabelOf('cancelled')).toBe('Cancelled')
  })
})
