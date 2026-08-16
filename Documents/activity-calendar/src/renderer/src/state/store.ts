import { create } from 'zustand'
import type { Phase } from '@/lib/labelSelect'
import type { CalendarEvent, EventInput, EventStatus, Label } from '@shared/types'
import { useToasts } from '@/state/toasts'

// ---------------- data store ----------------

/** v1.11.18 (audit #8): every IPC call in the store goes through this guard —
 *  a failure shows a SPECIFIC toast and rethrows with `toasted` set, so the
 *  global handler doesn't double-toast. State is only mutated AFTER the IPC
 *  succeeds, so a failed call never leaves the store out of sync. */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    useToasts.getState().push({
      message: `Couldn't ${what} — ${msg}`,
      kind: 'danger',
      duration: 5000
    })
    ;(err as { toasted?: boolean }).toasted = true
    throw err
  }
}

interface DataState {
  events: CalendarEvent[]
  labels: Label[]
  loaded: boolean
  load: () => Promise<void>
  createEvent: (input: EventInput) => Promise<CalendarEvent>
  updateEvent: (id: string, patch: Partial<EventInput>) => Promise<CalendarEvent>
  /** v1.11.14: unless toTrash === false, the event is snapshotted into the
   *  TRASH before deletion (internal cleanup passes false). */
  removeEvent: (id: string, opts?: { toTrash?: boolean }) => Promise<void>
  /** Re-create a previously deleted event with its original id (undo). */
  restoreEvent: (ev: CalendarEvent) => Promise<void>
  /** Create a one-off override copy of a recurring event + skip that day in the series — atomically.
   *  Re-saving the same origin UPDATES the existing override in place (stable id,
   *  no duplicates) and returns the final event row. */
  applyOverride: (override: EventInput, masterId: string, exdates: string[]) => Promise<CalendarEvent>
  createLabel: (name: string, color: string | null, parentId: string | null) => Promise<Label>
  updateLabel: (id: string, patch: { name?: string; color?: string | null; sortOrder?: number; archived?: boolean }) => Promise<void>
  removeLabel: (id: string) => Promise<void>
}

export const useData = create<DataState>((set, get) => ({
  events: [],
  labels: [],
  loaded: false,

  load: async () => {
    const [events, labels] = await guard('load your data', () =>
      Promise.all([window.api.events.list(), window.api.labels.list()])
    )
    set({ events, labels, loaded: true })
  },

  createEvent: async (input) => {
    const ev = await guard('save this activity', () => window.api.events.create(input))
    set({ events: [...get().events, ev] })
    return ev
  },

  updateEvent: async (id, patch) => {
    const ev = await guard('save this activity', () => window.api.events.update(id, patch))
    set({ events: get().events.map((e) => (e.id === id ? ev : e)) })
    return ev
  },

  removeEvent: async (id, opts?: { toTrash?: boolean }) => {
    // v1.11.14: snapshot the event (+ its children if it's a series master)
    // and keep it in the TRASH before deleting (unless internal cleanup)
    if (opts?.toTrash !== false) {
      const all = get().events
      const master = all.find((e) => e.id === id)
      if (master) {
        const children = all.filter((e) => e.parentId === id)
        try {
          await window.api.trash.add(id, { master, children })
        } catch {
          /* trash write failure must not block the delete */
        }
      }
    }
    await guard('delete this activity', () => window.api.events.remove(id))
    set({ events: get().events.filter((e) => e.id !== id && e.parentId !== id) })
  },

  restoreEvent: async (ev) => {
    // v1.11.14: an UNDO brings the event back — drop it from the trash
    try { await window.api.trash.remove(ev.id) } catch { /* non-fatal */ }
    const created = await guard('restore this activity', () =>
      window.api.events.create({
        id: ev.id,
        title: ev.title,
        description: ev.description,
        startLocal: ev.startLocal,
        endLocal: ev.endLocal,
        allDay: ev.allDay,
        labelId: ev.labelId,
        colorOverride: ev.colorOverride,
        status: ev.status,
        rrule: ev.rrule,
        exdates: ev.exdates,
        parentId: ev.parentId,
        originDate: ev.originDate
      })
    )
    set({ events: [...get().events, created] })
  },

  applyOverride: async (override, masterId, exdates) => {
    const existing = get().events.find(
      (e) => e.parentId === masterId && e.originDate === override.originDate
    )
    let created: CalendarEvent
    if (existing) {
      // update in place — keeps the id stable so scores stay attached
      created = await guard('save this activity', () =>
        window.api.events.update(existing.id, {
          title: override.title,
          description: override.description,
          startLocal: override.startLocal,
          endLocal: override.endLocal,
          allDay: override.allDay,
          labelId: override.labelId,
          colorOverride: override.colorOverride,
          status: override.status
        })
      )
    } else {
      created = await guard('save this activity', () => window.api.events.create(override))
    }
    const updated = await guard('save this activity', () => window.api.events.update(masterId, { exdates }))
    set((s) => ({
      events: [
        ...s.events.filter(
          (e) => e.id !== masterId && e.id !== created.id && !(e.parentId === masterId && e.originDate === override.originDate)
        ),
        updated,
        created
      ]
    }))
    return created
  },

  createLabel: async (name, color, parentId) => {
    const label = await guard('create this label', () => window.api.labels.create(name, color, parentId))
    set({ labels: [...get().labels, label] })
    return label
  },

  updateLabel: async (id, patch) => {
    const label = await guard('save this label', () => window.api.labels.update(id, patch))
    set({ labels: get().labels.map((l) => (l.id === id ? label : l)) })
  },

  removeLabel: async (id) => {
    await guard('delete this label', () => window.api.labels.remove(id))
    // drop the label and any children (DB cascades; mirror it locally)
    const ids = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const l of get().labels) {
        if (!ids.has(l.id) && l.parentId && ids.has(l.parentId)) {
          ids.add(l.id)
          grew = true
        }
      }
    }
    set({ labels: get().labels.filter((l) => !ids.has(l.id)) })
  }
}))

// ---------------- ui store ----------------

export type View = 'day' | 'week' | 'month' | 'agenda' | 'insights' | 'coins' | 'trash'

export interface QuickAddState {
  open: boolean
  date: string // 'yyyy-MM-dd'
  time: string // 'HH:mm'
  end?: string // 'yyyy-MM-ddTHH:mm' (from the default-duration pref)
}

interface UiState {
  view: View
  cursor: Date
  /** v1.11.16: MULTI-SELECT status filter — a set of statuses to show;
   *  an EMPTY set means "All" (nothing filtered). */
  statusSel: ReadonlySet<EventStatus>
  hiddenLabels: Set<string>
  labelPhases: Record<string, Phase>
  search: string
  quickAdd: QuickAddState | null
  editorKey: string | null
  settingsOpen: boolean
  /** which Settings tab to show: general | notifications | about | shortcuts */
  settingsTab: 'general' | 'notifications' | 'about' | 'shortcuts'
  coinSystemConfirm: boolean
  /** user prefs (Settings → General): first day of week, start hour, clock, duration */
  weekStart: 'monday' | 'sunday'
  dayStartHour: number
  clock24: boolean
  defaultDuration: number
  /** Ctrl+P vertical grid zoom multiplier (day/week views). */
  gridZoom: number
  setPrefs: (p: { weekStart: 'monday' | 'sunday'; dayStartHour: number; clock24: boolean; defaultDuration: number }) => void
  setGridZoom: (z: number) => void
  setView: (v: View) => void
  setCursor: (d: Date) => void
  navigate: (days: number) => void
  goToday: () => void
  setStatusSel: (sel: ReadonlySet<EventStatus>) => void
  toggleLabelHidden: (id: string) => void
  setHiddenLabels: (ids: string[]) => void
  setLabelPhases: (phases: Record<string, Phase>) => void
  setSearch: (s: string) => void
  openQuickAdd: (date?: string, time?: string, durationMin?: number) => void
  closeQuickAdd: () => void
  openSettings: (tab?: 'general' | 'notifications' | 'about' | 'shortcuts') => void
  closeSettings: () => void
  openCoinSystemConfirm: () => void
  closeCoinSystemConfirm: () => void
  /** Open the editor for a specific event (not its render key). */
  openEditor: (eventId: string, originDate: string) => void
  closeEditor: () => void
}

const pad = (n: number) => String(n).padStart(2, '0')
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

const initialView = (): View => {
  // guard for non-browser (unit tests) environments
  if (typeof location === 'undefined') return 'month'
  const v = new URLSearchParams(location.search).get('view')
  return v === 'day' || v === 'week' || v === 'month' || v === 'agenda' || v === 'insights' || v === 'coins' || v === 'trash' ? v : 'month'
}

export const useUi = create<UiState>((set, get) => ({
  view: initialView(),
  cursor: new Date(),
  statusSel: new Set<EventStatus>(),
  hiddenLabels: new Set<string>(),
  labelPhases: {},
  search: '',
  quickAdd: null,
  editorKey: null,
  settingsOpen: false,
  settingsTab: 'general',
  coinSystemConfirm: false,
  weekStart: 'monday',
  dayStartHour: 0,
  clock24: true,
  defaultDuration: 60,
  gridZoom: 1,
  setPrefs: (p) => set({ weekStart: p.weekStart, dayStartHour: p.dayStartHour, clock24: p.clock24, defaultDuration: p.defaultDuration }),
  setGridZoom: (z) => set({ gridZoom: z }),
  setView: (v) => set({ view: v }),
  setCursor: (d) => set({ cursor: d }),
  navigate: (days) => {
    const d = new Date(get().cursor)
    d.setDate(d.getDate() + days)
    set({ cursor: d })
  },
  goToday: () => set({ cursor: new Date() }),
  setStatusSel: (sel) => set({ statusSel: sel }),
  toggleLabelHidden: (id) => {
    const next = new Set(get().hiddenLabels)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ hiddenLabels: next })
  },
  setHiddenLabels: (ids) => set({ hiddenLabels: new Set(ids), labelPhases: {} }),
  setLabelPhases: (phases) => set({ labelPhases: phases }),
  setSearch: (s) => set({ search: s }),
  openQuickAdd: (date, time, durationMin) => {
    const d = date ? new Date(date + 'T00:00:00') : new Date()
    const t = time ?? '09:00'
    const [hh, mm] = t.split(':').map(Number)
    const dur = Math.min(480, Math.max(5, durationMin ?? get().defaultDuration))
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm + dur)
    set({
      quickAdd: {
        open: true,
        date: date ?? iso(d),
        time: t,
        end: `${iso(end)}T${hm(end)}`
      }
    })
  },
  closeQuickAdd: () => set({ quickAdd: null }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? 'general' }),
  closeSettings: () => set({ settingsOpen: false }),
  openCoinSystemConfirm: () => set({ coinSystemConfirm: true }),
  closeCoinSystemConfirm: () => set({ coinSystemConfirm: false }),
  openEditor: (eventId, originDate) => set({ editorKey: `${eventId}|${originDate}` }),
  closeEditor: () => set({ editorKey: null })
}))

/** Labels that are hidden (filtered out) — hiding a parent hides its children too. */
// Test hook for the automated smoke suite — harmless in production.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __rhythmData: { load: () => Promise<void> } }).__rhythmData = {
    load: () => useData.getState().load()
  }
}

export function hiddenLabelIds(labels: Label[], hidden: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const l of labels) {
    if (hidden.has(l.id) || (l.parentId && hidden.has(l.parentId))) out.add(l.id)
  }
  return out
}

/** v1.11.7: VISIBLE (selected) label ids — the allowlist used by the views.
 *  An event is shown iff its own label is selected, OR its parent label is
 *  selected in "all sub-tags" mode. This makes the filter a true multi-select:
 *  selecting "Fitness" (only this) shows ONLY Fitness' own events; adding
 *  "Work" shows Work too; children show when their parent is in all-mode or
 *  the child itself is selected. */
export function visibleLabelIds(
  labels: Label[],
  hidden: Set<string>,
  phases: Record<string, Phase>
): Set<string> {
  const vis = new Set<string>()
  // true multi-select: if ANY selection exists, only selected groups show
  const anySelected = hidden.size > 0 || Object.keys(phases).length > 0
  const parents = labels.filter((l) => !l.parentId)
  for (const p of parents) {
    const phase = phases[p.id]
    const kids = labels.filter((c) => c.parentId === p.id)
    if (!phase) {
      // group not selected — visible only when nothing at all is selected
      if (!anySelected) {
        vis.add(p.id)
        for (const c of kids) vis.add(c.id)
      }
      continue
    }
    if (kids.length === 0) {
      vis.add(p.id) // lone parent selected
      continue
    }
    const parentHidden = hidden.has(p.id)
    if (parentHidden) {
      // blue: children only
      for (const c of kids) if (!hidden.has(c.id)) vis.add(c.id)
    } else {
      // amber / yellow / green: parent + the visible children
      vis.add(p.id)
      for (const c of kids) if (!hidden.has(c.id)) vis.add(c.id)
    }
  }
  return vis
}
