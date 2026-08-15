import { describe, it, expect } from 'vitest'
import { visibleLabelIds } from '../src/renderer/src/state/store'
import type { Label, Phase } from '../src/shared/types'

const labels: Label[] = [
  { id: 'fit', name: 'Fitness', color: '#10B981', parentId: null, sortOrder: 0, archived: 0 },
  { id: 'fit-gym', name: 'Gym', color: '#F97316', parentId: 'fit', sortOrder: 0, archived: 0 },
  { id: 'fit-yoga', name: 'Yoga', color: '#A78BFA', parentId: 'fit', sortOrder: 0, archived: 0 },
  { id: 'fit-walk', name: 'Walk', color: '#8E8E93', parentId: 'fit', sortOrder: 0, archived: 0 },
  { id: 'work', name: 'Work', color: '#0A84FF', parentId: null, sortOrder: 0, archived: 0 },
  { id: 'work-proj', name: 'Project A', color: '#5E5CE6', parentId: 'work', sortOrder: 0, archived: 0 }
]

const h = (...ids: string[]) => new Set(ids)
const p = (o: Record<string, Phase>) => o

describe('visibleLabelIds (true multi-select)', () => {
  it('nothing selected → everything visible', () => {
    expect(visibleLabelIds(labels, h(), p({})).size).toBe(6)
  })
  it('AMBER (parent only): parent visible, children + other groups hidden', () => {
    const vis = visibleLabelIds(labels, h('fit-gym', 'fit-yoga', 'fit-walk'), p({ fit: 'amber' }))
    expect(vis.has('fit')).toBe(true)
    expect(vis.has('fit-gym')).toBe(false)
    expect(vis.has('work')).toBe(false)
  })
  it('YELLOW (parent + some children): parent + visible children', () => {
    const vis = visibleLabelIds(labels, h('fit-yoga', 'fit-walk'), p({ fit: 'yellow' }))
    expect(vis.has('fit')).toBe(true)
    expect(vis.has('fit-gym')).toBe(true)
    expect(vis.has('fit-yoga')).toBe(false)
    expect(vis.has('work')).toBe(false)
  })
  it('BLUE (children only): parent hidden, children shown', () => {
    const vis = visibleLabelIds(labels, h('fit', 'fit-yoga', 'fit-walk'), p({ fit: 'blue' }))
    expect(vis.has('fit')).toBe(false)
    expect(vis.has('fit-gym')).toBe(true)
    expect(vis.has('fit-yoga')).toBe(false)
    expect(vis.has('work')).toBe(false)
  })
  it('GREEN (parent + all children)', () => {
    const vis = visibleLabelIds(labels, h(), p({ fit: 'green' }))
    expect(vis.has('fit')).toBe(true)
    expect(vis.has('fit-gym')).toBe(true)
    expect(vis.has('fit-yoga')).toBe(true)
    expect(vis.has('fit-walk')).toBe(true)
    expect(vis.has('work')).toBe(false)
  })
  it('two groups selected (multi-select AND): both show, others hidden', () => {
    const vis = visibleLabelIds(labels, h('fit-gym', 'fit-yoga', 'fit-walk'), p({ fit: 'amber', work: 'green' }))
    expect(vis.has('fit')).toBe(true)
    expect(vis.has('work')).toBe(true)
    expect(vis.has('work-proj')).toBe(true)
    expect(vis.has('fit-gym')).toBe(false)
  })
})
