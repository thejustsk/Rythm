import type { Label } from '@shared/types'

/**
 * Sidebar label selection — the full colour state machine (user spec).
 *
 * PARENT colours (per group; groups are independent = multi-select):
 *   (none)  – nothing in this group selected
 *   amber   – parent only (its children hidden)
 *   yellow  – parent + SOME (not all) children visible
 *   blue    – children visible WITHOUT the parent (few or all)
 *   green   – parent + ALL children visible
 *
 * PARENT click:
 *   none → amber → green → none          (yellow → green)
 *   blue → yellow (children kept + parent)   — green if ALL children visible
 *
 * CHILD click:
 *   none → blue (that child only)
 *   amber → yellow / green (child toggled on; green when all visible)
 *   yellow → toggling keeps yellow/green/amber (derived from the real set)
 *   blue → toggling keeps blue; last child off clears the group (→ none)
 *   green → toggling off → yellow (some remain) / amber (none remain)
 *
 * The STORED phase decides which transition runs; the colour is then
 * re-derived from the ACTUAL hidden set so it can never disagree with what
 * is really selected. Lone parents (no children): none → green → none.
 */

export type Phase = 'amber' | 'yellow' | 'blue' | 'green'

export interface LabelSelResult {
  hidden: Set<string>
  phases: Record<string, Phase>
}

function childrenOf(labels: Label[], parentId: string): Label[] {
  return labels.filter((l) => l.parentId === parentId)
}

/** The colour a parent group SHOULD show, derived from the real hidden set. */
export function deriveParentPhase(
  labels: Label[],
  hidden: Set<string>,
  parentId: string
): Phase | null {
  const kids = childrenOf(labels, parentId)
  if (kids.length === 0) {
    // lone parent: selected (not hidden) → green, else none
    return hidden.has(parentId) ? null : 'green'
  }
  const parentHidden = hidden.has(parentId)
  const visKids = kids.filter((k) => !hidden.has(k.id))
  if (parentHidden) return visKids.length > 0 ? 'blue' : null
  if (visKids.length === 0) return 'amber'
  return visKids.length === kids.length ? 'green' : 'yellow'
}

/** Remove a whole group from the selection (deselect). */
function clearGroup(
  nextH: Set<string>,
  nextP: Record<string, Phase>,
  groupIds: string[],
  parentId: string
): void {
  for (const id of groupIds) nextH.delete(id)
  delete nextP[parentId]
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

  if (l.parentId) {
    // ================= CHILD click =================
    const parent = labels.find((p) => p.id === l.parentId)!
    const kids = childrenOf(labels, parent.id)
    const cur = nextP[parent.id] // undefined = group off

    if (!cur) {
      // none → blue: parent + siblings hidden, this child visible
      kids.forEach((k) => nextH.add(k.id))
      nextH.add(parent.id)
      nextH.delete(l.id)
      nextP[parent.id] = 'blue'
    } else {
      // toggle this child
      if (nextH.has(l.id)) nextH.delete(l.id)
      else nextH.add(l.id)
      // blue + last child deselected → the whole group is off
      if (nextH.has(parent.id) && kids.every((k) => nextH.has(k.id))) {
        clearGroup(nextH, nextP, [parent.id, ...kids.map((k) => k.id)], parent.id)
        return { hidden: nextH, phases: nextP }
      }
      // re-derive the group colour from the real set
      const d = deriveParentPhase(labels, nextH, parent.id)
      if (d) nextP[parent.id] = d
      else delete nextP[parent.id]
    }
  } else {
    // ================= PARENT click =================
    const kids = childrenOf(labels, l.id)
    const cur = nextP[l.id]

    if (kids.length === 0) {
      // lone parent: none → green → none
      if (cur) {
        nextH.delete(l.id)
        delete nextP[l.id]
      } else {
        nextH.delete(l.id)
        nextP[l.id] = 'green'
      }
    } else if (!cur) {
      // none → amber: parent visible, all children hidden
      kids.forEach((k) => nextH.add(k.id))
      nextH.delete(l.id)
      nextP[l.id] = 'amber'
    } else if (cur === 'amber' || cur === 'yellow') {
      // amber/yellow → green: parent + all children
      kids.forEach((k) => nextH.delete(k.id))
      nextH.delete(l.id)
      nextP[l.id] = 'green'
    } else if (cur === 'blue') {
      // blue → yellow: keep the children selection, add the parent
      // (green when ALL children happen to be visible)
      nextH.delete(l.id)
      const visKids = kids.filter((k) => !nextH.has(k.id))
      nextP[l.id] = visKids.length === kids.length ? 'green' : 'yellow'
    } else {
      // green → none: deselect the whole group
      clearGroup(nextH, nextP, [l.id, ...kids.map((k) => k.id)], l.id)
    }
  }

  // safety: never hide every label — snap back to all-shown
  if (nextH.size >= labels.length) {
    nextH.clear()
    for (const k of Object.keys(nextP)) delete nextP[k]
  }
  return { hidden: nextH, phases: nextP }
}
