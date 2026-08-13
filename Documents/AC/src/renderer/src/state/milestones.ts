import { create } from 'zustand'
import type { RewardMilestone } from '@shared/types'

interface MilestonesState {
  list: RewardMilestone[]
  loaded: boolean
  load: () => Promise<void>
  create: (name: string, icon: string, cost: number, notes: string) => Promise<void>
  update: (id: string, patch: { name?: string; icon?: string; cost?: number; notes?: string }) => Promise<void>
  remove: (id: string) => Promise<void>
  claim: (id: string) => Promise<{ ok: boolean; balance: number }>
  /** most relevant milestone: the nearest not-yet-achieved one */
  next: () => RewardMilestone | null
}

export const useMilestones = create<MilestonesState>((set, get) => ({
  list: [],
  loaded: false,

  load: async () => {
    const list = await window.api.milestones.list()
    set({ list, loaded: true })
  },

  create: async (name, icon, cost, notes) => {
    const m = await window.api.milestones.create(name, icon, cost, notes)
    set({ list: [...get().list, m] })
  },

  update: async (id, patch) => {
    const m = await window.api.milestones.update(id, patch)
    set({ list: get().list.map((x) => (x.id === id ? m : x)) })
  },

  remove: async (id) => {
    await window.api.milestones.remove(id)
    set({ list: get().list.filter((x) => x.id !== id) })
  },

  claim: async (id) => {
    const res = await window.api.milestones.claim(id)
    if (res.ok) await get().load()
    return res
  },

  next: () => {
    const pending = get().list.filter((m) => !m.achievedAt).sort((a, b) => a.cost - b.cost)
    return pending[0] ?? null
  }
}))
