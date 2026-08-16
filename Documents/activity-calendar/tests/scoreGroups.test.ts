import { describe, expect, it } from 'vitest'
import { groupScores, type ScoreRow } from '../src/renderer/src/lib/scoreGroups'

const row = (labelId: string | null, name: string, parentId: string | null, parentName: string | null, on_time = 1, late = 0, off = 0): ScoreRow => ({
  labelId,
  name,
  parentId,
  parentName,
  on_time,
  late,
  off_schedule: off,
  total: on_time + late + off
})

describe('groupScores (v1.11.16 parent groups)', () => {
  it('groups child labels under their parent (totals summed)', () => {
    const groups = groupScores([
      row('gym', 'Gym', 'fit', 'Fitness', 3, 1, 0),
      row('walk', 'Walk', 'fit', 'Fitness', 1, 0, 1)
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    expect(g.key).toBe('fit')
    expect(g.name).toBe('Fitness')
    expect(g.children).toHaveLength(2)
    expect(g.total).toBe(6)
    expect(g.on_time).toBe(4)
    expect(g.late).toBe(1)
    expect(g.off_schedule).toBe(1)
    expect(g.own).toBeNull()
  })

  it('keeps the parent own part separate from children', () => {
    const groups = groupScores([
      row('fit', 'Fitness', null, null, 2, 0, 0),
      row('gym', 'Gym', 'fit', 'Fitness', 1, 0, 0)
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    expect(g.own?.total).toBe(2)
    expect(g.children).toHaveLength(1)
    expect(g.total).toBe(3)
  })

  it('keeps top-level labels and No label as their own groups', () => {
    const groups = groupScores([
      row('work', 'Work', null, null, 5, 0, 0),
      row(null, 'No label', null, null, 1, 1, 1)
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.name)).toEqual(['Work', 'No label'])
    expect(groups[0].total).toBe(5)
    expect(groups[1].total).toBe(3)
  })

  it('sorts groups and children by total descending', () => {
    const groups = groupScores([
      row('a', 'A', 'p', 'P', 1, 0, 0),
      row('b', 'B', 'p', 'P', 9, 0, 0),
      row('z', 'Z', null, null, 3, 0, 0)
    ])
    expect(groups[0].key).toBe('p') // 10
    expect(groups[1].key).toBe('z') // 3
    expect(groups[0].children.map((c) => c.name)).toEqual(['B', 'A'])
  })

  it('returns an empty list for no rows', () => {
    expect(groupScores([])).toEqual([])
  })

  it('v1.11.17: carries the label colour through to the group', () => {
    const groups = groupScores([
      row('fit', 'Fitness', null, null, 2, 0, 0),
      row('gym', 'Gym', 'fit', 'Fitness', 1, 0, 0)
    ])
    // colour from the parent's own row (or the first coloured child)
    const g = groups[0]
    expect(g.color).toBeNull() // helper rows carry no colour
    // a coloured row provides it
    const withColor = groupScores([
      { ...row('gym', 'Gym', 'fit', 'Fitness', 1, 0, 0), color: '#F97316' }
    ])
    expect(withColor[0].color).toBe('#F97316')
  })
})
