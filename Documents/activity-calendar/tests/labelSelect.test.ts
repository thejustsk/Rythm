import { describe, expect, it } from 'vitest'
import { clickLabel, type Phase } from '../src/renderer/src/lib/labelSelect'
import type { Label } from '../src/shared/types'

const mk = (id: string, name: string, parentId: string | null = null): Label => ({
  id, name, icon: '', color: null, parentId, sortOrder: 0, archived: false
})
const labels: Label[] = [mk('P', 'Parent'), mk('A', 'A', 'P'), mk('B', 'B', 'P'), mk('C', 'C', 'P'), mk('X', 'Lone')]
const empty = new Set<string>()
const noPhases: Record<string, Phase> = {}

describe('label selection — FULL INDEPENDENCE between groups', () => {
  it('selecting a childless parent does NOT deselect other groups children', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    // first select child B of P (group blue)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    expect(p.P).toBe('blue')
    expect(h.has('B')).toBe(false)
    // now click the LONE parent X — must NOT touch P's state or B's visibility
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'X'))
    expect(p.X).toBe('green')
    expect(h.has('X')).toBe(false)
    expect(p.P).toBe('blue') // P phase untouched
    expect(h.has('B')).toBe(false) // B still selected/visible
    expect(h.has('P')).toBe(true) // P still hidden (blue)
  })
  it('deselecting a childless parent does NOT select other groups children', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B')) // P blue
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'X')) // X green
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'X')) // X → EMPTY
    expect(p.X).toBeUndefined()
    expect(p.P).toBe('blue') // P untouched
    expect(h.has('B')).toBe(false) // B NOT auto-selected/shown by X's deselect
    expect(h.has('P')).toBe(true)
  })
  it('parent saffron does not dim other groups', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P')) // P saffron
    expect(p.P).toBe('saffron')
    expect(h.has('A') && h.has('B') && h.has('C')).toBe(true) // P's children hidden
    expect(h.has('X')).toBe(false) // lone X untouched
    expect(p.X).toBeUndefined()
  })
})

describe('label selection — parent cycles', () => {
  it('parent with children: EMPTY → SAFFRON → GREEN → EMPTY', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBe('saffron')
    expect(h.has('P')).toBe(false)
    expect(h.has('A') && h.has('B') && h.has('C')).toBe(true)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBe('green')
    expect(h.has('A') || h.has('B') || h.has('C')).toBe(false)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBeUndefined()
    expect(h.size).toBe(0)
  })
  it('BLUE (children only) → parent → GREEN directly (no SAFFRON)', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    expect(p.P).toBe('blue')
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    expect(p.P).toBe('green')
    expect(h.has('P')).toBe(false)
    expect(h.has('A') || h.has('B') || h.has('C')).toBe(false)
  })
  it('lone parent: EMPTY → GREEN → EMPTY (no saffron, no side effects)', () => {
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

describe('label selection — child interactions within a phase', () => {
  it('SAFFRON + child click → child green, stays SAFFRON; select all → GREEN', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A'))
    expect(p.P).toBe('saffron')
    expect(h.has('A')).toBe(false)
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'C'))
    expect(p.P).toBe('green')
  })
  it('GREEN → deselect one child → SAFFRON', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'P'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'A'))
    expect(p.P).toBe('saffron')
    expect(h.has('A')).toBe(true)
    expect(h.has('B') || h.has('C')).toBe(false)
  })
  it('BLUE → deselect last child → EMPTY', () => {
    let h = new Set(empty)
    let p = { ...noPhases }
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    ;({ hidden: h, phases: p } = clickLabel(labels, h, p, 'B'))
    expect(p.P).toBeUndefined()
    expect(h.has('B')).toBe(false)
    expect(h.has('P')).toBe(false)
  })
})
