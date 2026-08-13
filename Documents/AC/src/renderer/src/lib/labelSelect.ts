import type { Label } from '@shared/types'

/**
 * Sidebar label selection (v3 — full independence).
 *
 * A group NEVER touches another group: selecting/removing a parent or its
 * child only changes THAT group's own ids in the hidden set. Other groups'
 * children keep their exact selected state (visibility AND phase memory).
 *
 * Parent group cycles:
 *   EMPTY → SAFFRON (parent's own events only — its children hidden)
 *         → GREEN  (parent + ALL children shown)
 *         → EMPTY
 *   BLUE (children selected while parent hidden) → parent click → GREEN directly
 *   LONE parent (no children): EMPTY → GREEN → EMPTY — and neither click
 *   touches any other group.
 *   A selected child is always GREEN.
 */

export type Phase = 'saffron' | 'green' | 'blue'

export interface LabelSelResult {
  hidden: Set<string>
  phases: Record<string, Phase>
}

function childrenOf(labels: Label[], parentId: string): Label[] {
  return labels.filter((l) => l.parentId === parentId)
}

/** Click a label row → next selection state. Pure & unit-tested. */
export function clickLabel(
  labels: Label[],
  hidden: Set<string>,
  phases: Record<string, Phase>,
  id: string
): LabelSelResult {
  const l = labels.find((x) => x.id === id)
  if (!l) return { hidden, phases }
  const nextH = new Set(hidden)
  const nextP: Record<string, Phase> = { ...phases }

  const kidsOf = (p: Label) => childrenOf(labels, p.id)
  const groupIds = (p: Label) => [p.id, ...kidsOf(p).map((k) => k.id)]

  if (l.parentId) {
    const parent = labels.find((p) => p.id === l.parentId)!
    const phase = nextP[parent.id]
    const kids = kidsOf(parent)

    if (!phase) {
      // EMPTY → solo-select this child WITHIN its group only: parent hidden
      // (BLUE) + siblings hidden; other groups untouched
      groupIds(parent).forEach((gid) => nextH.add(gid))
      nextH.delete(l.id)
      nextP[parent.id] = 'blue'
    } else if (phase === 'blue') {
      if (nextH.has(l.id)) nextH.delete(l.id)
      else nextH.add(l.id)
      if (kids.every((k) => nextH.has(k.id))) {
        groupIds(parent).forEach((gid) => nextH.delete(gid))
        delete nextP[parent.id]
      }
    } else if (phase === 'saffron') {
      if (nextH.has(l.id)) nextH.delete(l.id)
      else nextH.add(l.id)
      if (kids.every((k) => !nextH.has(k.id))) nextP[parent.id] = 'green'
    } else {
      nextH.add(l.id)
      nextP[parent.id] = 'saffron'
    }
  } else {
    const kids = kidsOf(l)
    const phase = nextP[l.id]

    if (!phase) {
      if (kids.length === 0) {
        // LONE parent: EMPTY → GREEN — touch NOTHING else
        nextH.delete(l.id)
        nextP[l.id] = 'green'
      } else {
        // EMPTY → SAFFRON: only this group's children hidden; parent shown;
        // other groups untouched
        kids.forEach((k) => nextH.add(k.id))
        nextH.delete(l.id)
        nextP[l.id] = 'saffron'
      }
    } else if (phase === 'saffron') {
      if (kids.length === 0) {
        nextH.delete(l.id)
        delete nextP[l.id]
      } else {
        kids.forEach((k) => nextH.delete(k.id))
        nextP[l.id] = 'green'
      }
    } else if (phase === 'green') {
      if (kids.length === 0) {
        nextH.delete(l.id)
        delete nextP[l.id]
      } else {
        groupIds(l).forEach((gid) => nextH.delete(gid))
        delete nextP[l.id]
      }
    } else {
      // BLUE → GREEN directly (skip SAFFRON)
      groupIds(l).forEach((gid) => nextH.delete(gid))
      nextP[l.id] = 'green'
    }
  }

  // safety: never hide every label — snap back to all-shown
  if (nextH.size >= labels.length) {
    nextH.clear()
    for (const k of Object.keys(nextP)) delete nextP[k]
  }
  return { hidden: nextH, phases: nextP }
}
