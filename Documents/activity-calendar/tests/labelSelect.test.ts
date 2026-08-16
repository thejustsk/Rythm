import { describe, expect, it } from 'vitest'
import { clickLabel, deriveParentPhase, shouldShowAllChip, type Phase } from '../src/renderer/src/lib/labelSelect'
import type { Label } from '../src/shared/types'

const mk = (id: string, name: string, parentId: string | null = null): Label => ({
  id, name, color: null, parentId, sortOrder: 0, archived: 0
})
const labels: Label[] = [mk('P', 'Parent'), mk('A', 'A', 'P'), mk('B', 'B', 'P'), mk('C', 'C', 'P'), mk('X', 'Lone')]
const empty = new Set<string>()
const noPhases: Record<string, Phase> = {}

describe('PARENT click transitions (user spec)', () => {
  it('none → amber → green → none', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBe('amber') // parent only
    expect(h.has('P')).toBe(false)
    expect(h.has('A') && h.has('B') && h.has('C')).toBe(true) // children hidden
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBe('green') // parent + all children
    expect(h.has('A') || h.has('B') || h.has('C')).toBe(false)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBeUndefined() // none
    expect(h.size).toBe(0)
  })
  it('yellow → green (parent click)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // amber
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // amber + A → yellow
    expect(p.P).toBe('yellow')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // yellow → green
    expect(p.P).toBe('green')
    expect(h.has('A') || h.has('B') || h.has('C')).toBe(false)
  })
  it('blue → yellow (children retained + parent); green when ALL children visible', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // blue (A only)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // blue → yellow
    expect(p.P).toBe('yellow')
    expect(h.has('P')).toBe(false) // parent now visible
    expect(h.has('A')).toBe(false) // A retained
    expect(h.has('B') && h.has('C')).toBe(true) // other children still hidden
    // now select ALL children (B, C) from yellow → green
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'C'))
    expect(p.P).toBe('green')
    // and blue → parent with all children visible → green directly
    let h2 = new Set(empty)
    let p2 = { ...noPhases }
    ;({ hidden: h2, phases: p2 } = clickLabel(labels, h2, p2, 'A'))
    ;({ hidden: h2, phases: p2 } = clickLabel(labels, h2, p2, 'B'))
    ;({ hidden: h2, phases: p2 } = clickLabel(labels, h2, p2, 'C')) // all children in blue
    expect(p2.P).toBe('blue')
    ;({ hidden: h2, phases: p2 } = clickLabel(labels, h2, p2, 'P')) // blue → green (all visible)
    expect(p2.P).toBe('green')
  })
  it('lone parent: none → green → none', () => {
    const lone: Label[] = [mk('Solo')]
    let h = new Set<string>()
    let p: Record<string, Phase> = {}
    ;({ hidden: h, phases: p } = clickLabel(lone, h, p, 'Solo'))
    expect(p.Solo).toBe('green')
    expect(h.has('Solo')).toBe(false)
    ;({ hidden: h, phases: p } = clickLabel(lone, h, p, 'Solo'))
    expect(p.Solo).toBeUndefined()
    expect(h.size).toBe(0)
  })
})

describe('CHILD click transitions (user spec)', () => {
  it('none → blue (that child only, parent + siblings hidden)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    expect(p.P).toBe('blue')
    expect(h.has('P')).toBe(true)
    expect(h.has('A') && h.has('C')).toBe(true)
    expect(h.has('B')).toBe(false)
  })
  it('amber → yellow (one child on); amber → green (all children on)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // amber
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // amber + A → yellow
    expect(p.P).toBe('yellow')
    expect(h.has('A')).toBe(false)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // + B → still yellow (C hidden)
    expect(p.P).toBe('yellow')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'C')) // + C → green (all)
    expect(p.P).toBe('green')
  })
  it('yellow → green when all children selected', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // amber
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // yellow
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'C')) // all → green
    expect(p.P).toBe('green')
  })
  it('green → yellow (some children deselected); green → amber (all deselected)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // amber
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // green
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // deselect A → yellow
    expect(p.P).toBe('yellow')
    expect(h.has('A')).toBe(true)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // deselect B → yellow (C left)
    expect(p.P).toBe('yellow')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'C')) // deselect C → amber (parent only)
    expect(p.P).toBe('amber')
    expect(h.has('A') && h.has('B') && h.has('C')).toBe(true)
  })
  it('blue → toggle: still blue; last child off → none (group cleared)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // blue
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // + B → still blue
    expect(p.P).toBe('blue')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A')) // - A → blue (B left)
    expect(p.P).toBe('blue')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // - B → none
    expect(p.P).toBeUndefined()
    expect(h.has('P')).toBe(false) // group fully cleared (parent restored)
    expect(h.has('A') && h.has('B')).toBe(false)
  })
})

describe('deriveParentPhase — robust from the real hidden set', () => {
  it('reflects the actual selection, not a stale phase', () => {
    // force a stale phase: phase says green, but A is hidden in reality
    const h = new Set(['A'])
    expect(deriveParentPhase(labels, h, 'P')).toBe('yellow')
    const h2 = new Set(['A', 'B', 'C'])
    expect(deriveParentPhase(labels, h2, 'P')).toBe('amber')
    const h3 = new Set(['P', 'A'])
    expect(deriveParentPhase(labels, h3, 'P')).toBe('blue')
    const h4 = new Set<string>()
    expect(deriveParentPhase(labels, h4, 'P')).toBe('green')
  })
})

describe('FULL INDEPENDENCE between groups (multi-select)', () => {
  it('selecting one group never touches another', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // P blue
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'X')) // lone X green
    expect(p.P).toBe('blue')
    expect(p.X).toBe('green')
    expect(h.has('B')).toBe(false)
    expect(h.has('P')).toBe(true)
    // deselect X — P untouched
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'X'))
    expect(p.X).toBeUndefined()
    expect(p.P).toBe('blue')
    expect(h.has('B')).toBe(false)
  })
})

describe('shouldShowAllChip (v1.11.14)', () => {
  it('hidden when nothing is selected', () => {
    expect(shouldShowAllChip(labels, new Set(), {})).toBe(false)
  })
  it('shown for a partial selection (amber)', () => {
    expect(shouldShowAllChip(labels, new Set(['A', 'B', 'C']), { P: 'amber' })).toBe(true)
  })
  it('hidden when everything is fully green', () => {
    expect(shouldShowAllChip(labels, new Set(), { P: 'green', X: 'green' })).toBe(false)
  })
  it('shown when one group is green but another is not selected', () => {
    expect(shouldShowAllChip(labels, new Set(), { P: 'green' })).toBe(true)
  })
})
