import { create } from 'zustand'
import type { CalendarEvent } from '@shared/types'

export interface TrashItem {
  id: string
  master: CalendarEvent
  children: CalendarEvent[]
  deletedAt: string
}

interface TrashState {
  items: TrashItem[]
  loaded: boolean
  load: () => Promise<void>
  restore: (id: string, mode: 'series' | 'single') => Promise<boolean>
  purge: (id: string) => Promise<void>
  empty: () => Promise<void>
}

export const useTrash = create<TrashState>((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    try {
      const rows = await window.api.trash.list()
      set({
        items: rows.map((r) => ({
          id: r.id,
          master: r.payload.master as CalendarEvent,
          children: (r.payload.children ?? []) as CalendarEvent[],
          deletedAt: r.deletedAt
        })),
        loaded: true
      })
    } catch {
      set({ loaded: true })
    }
  },

  restore: async (id, mode) => {
    const res = await window.api.trash.restore(id, mode)
    if (res.ok) {
      set({ items: get().items.filter((i) => i.id !== id) })
      return true
    }
    return false
  },

  purge: async (id) => {
    await window.api.trash.purge(id)
    set({ items: get().items.filter((i) => i.id !== id) })
  },

  empty: async () => {
    await window.api.trash.empty()
    set({ items: [] })
  }
}))
