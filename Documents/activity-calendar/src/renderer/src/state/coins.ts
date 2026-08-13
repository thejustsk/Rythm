import { create } from 'zustand'
import type { CalendarEvent, CoinTransaction, ScoreRow, ScoreType } from '@shared/types'
import { computeEarn } from '@/lib/gamification'
import { parseLocal } from '@/engine/occurrences'

interface PendingScore {
  event: CalendarEvent
  originDate: string
}

export interface CoinStats {
  today: number
  series: Array<{ date: string; amount: number }>
  perLabel: Array<{ labelId: string | null; labelName: string; amount: number }>
}

interface CoinsState {
  balance: number
  txs: CoinTransaction[]
  scores: Map<string, ScoreRow>
  pending: PendingScore | null
  stats: CoinStats | null
  bestStreak: number
  loaded: boolean
  /** cup 3: coin-system master switch (persisted in settings 'coinSystem'). */
  systemOn: boolean
  /** cup 3: "How did it go?" answered → brief non-blocking coin animation. */
  scoreFx: boolean
  load: () => Promise<void>
  refreshStats: () => Promise<void>
  setSystem: (on: boolean) => Promise<void>
  fireScoreFx: () => void
  /** Persist the all-time best streak whenever the current one exceeds it. */
  updateBestStreak: (streak: number) => Promise<void>
  setPending: (p: PendingScore | null) => void
  scoreEvent: (p: PendingScore, scoreType: ScoreType) => Promise<number>
  clearScores: (eventId: string, originDate?: string) => Promise<{ scores: ScoreRow[]; earns: Array<{ eventId: string; originDate: string; amount: number; labelId: string | null }> }>
  restoreScores: (scores: ScoreRow[], earns: Array<{ eventId: string; originDate: string; amount: number; labelId: string | null }>) => Promise<void>
  revertScore: (eventId: string, originDate: string) => Promise<{ refunded: boolean; amount: number }>
  restoreScore: (eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null) => Promise<{ restored: boolean }>
  refresh: () => Promise<void>
}

const key = (id: string, date: string) => `${id}|${date}`

export const useCoins = create<CoinsState>((set, get) => ({
  balance: 0,
  txs: [],
  scores: new Map(),
  pending: null,
  stats: null,
  bestStreak: 0,
  loaded: false,
  systemOn: true,
  scoreFx: false,

  load: async () => {
    const [balance, txs, stats, best, systemOn] = await Promise.all([
      window.api.coins.balance(),
      window.api.coins.listTransactions(),
      window.api.coins.stats(),
      window.api.settings.get('bestStreak'),
      window.api.coins.system()
    ])
    set({ balance, txs, stats, bestStreak: parseInt(best ?? '0', 10) || 0, systemOn, loaded: true })
  },

  setSystem: async (on) => {
    await window.api.coins.setSystem(on)
    set({ systemOn: on })
  },

  fireScoreFx: () => {
    set({ scoreFx: true })
    window.setTimeout(() => set({ scoreFx: false }), 1900)
  },

  refreshStats: async () => {
    const stats = await window.api.coins.stats()
    set({ stats })
  },

  updateBestStreak: async (streak) => {
    const cur = get().bestStreak
    if (streak > cur) {
      set({ bestStreak: streak })
      await window.api.settings.set('bestStreak', String(streak))
    }
  },

  setPending: (p) => set({ pending: p }),

  scoreEvent: async (p, scoreType) => {
    const minutes = (parseLocal(p.event.endLocal).getTime() - parseLocal(p.event.startLocal).getTime()) / 60000
    const amount = computeEarn(minutes, scoreType)
    const res = await window.api.coins.scoreEvent(p.event.id, p.originDate, scoreType, amount, p.event.labelId)
    await get().refresh()
    return res.earned ? amount : 0
  },

  clearScores: async (eventId, originDate) => {
    const res = await window.api.coins.clearScores(eventId, originDate)
    await get().refresh()
    return res
  },

  restoreScores: async (scores, earns) => {
    const amountByKey = new Map(earns.map((e) => [key(e.eventId, e.originDate), e.amount]))
    const labelByKey = new Map(earns.map((e) => [key(e.eventId, e.originDate), e.labelId]))
    await window.api.coins.restoreScores(
      scores.map((r) => ({
        eventId: r.eventId,
        originDate: r.originDate,
        scoreType: r.scoreType,
        amount: amountByKey.get(key(r.eventId, r.originDate)) ?? 0,
        labelId: labelByKey.get(key(r.eventId, r.originDate)) ?? null
      }))
    )
    await get().refresh()
  },

  revertScore: async (eventId, originDate) => {
    const res = await window.api.coins.revertScore(eventId, originDate)
    await get().refresh()
    return res
  },

  restoreScore: async (eventId, originDate, scoreType, amount, labelId) => {
    const res = await window.api.coins.restoreScore(eventId, originDate, scoreType, amount, labelId)
    await get().refresh()
    return res
  },

  refresh: async () => {
    const [balance, txs, stats] = await Promise.all([
      window.api.coins.balance(),
      window.api.coins.listTransactions(),
      window.api.coins.stats()
    ])
    set({ balance, txs, stats })
  }
}))

// Test hook for the automated smoke suite — harmless in production.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __rhythmCoins: { refresh: () => Promise<void> } }).__rhythmCoins = {
    refresh: () => useCoins.getState().refresh()
  }

  // Test hook (smoke + fx screenshot harness) — harmless in production.
  ;(window as unknown as { __rhythmCoins2: { fireScoreFx: () => void } }).__rhythmCoins2 = {
    fireScoreFx: () => useCoins.getState().fireScoreFx()
  }
}
