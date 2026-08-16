/**
 * Gamification engine — pure, unit-tested.
 * Rhythm Coins: completing an activity earns coins based on HOW it was
 * completed (on time / late / off schedule) × a per-label coin rule.
 */
import type { ScoreType } from '@shared/types'

export const COINS_PER_HOUR_DEFAULT = 10

export const SCORE_MULT: Record<ScoreType, number> = {
  on_time: 1,
  late: 0.6,
  off_schedule: 0.3
}

export const SCORE_LABEL: Record<ScoreType, string> = {
  on_time: 'On time',
  late: 'Late (within period)',
  off_schedule: 'Off schedule'
}

/** base coins for `minutes` of activity under the default hourly rule */
export function baseCoins(minutes: number): number {
  return (minutes / 60) * COINS_PER_HOUR_DEFAULT
}

/** coins earned for a completion: base × score multiplier, rounded to 2 dp */
export function computeEarn(minutes: number, score: ScoreType): number {
  return roundCoins(baseCoins(minutes) * SCORE_MULT[score])
}

/** ledger-derived balance (never stored) */
export function balanceFromTxs(earns: number, spends: number): number {
  return roundCoins(earns - spends)
}

export function fmtCoins(n: number): string {
  const r = roundCoins(n)
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

/** v1.11.18 (audit): the streak-milestone COST/REWARD tables were hand-copied
 *  between the renderer and the main process — a drift risk. They now come
 *  from ONE source (gamifyCore) and are re-exported here so every existing
 *  importer keeps working. */
import { defaultStreakCosts, streakMilestoneReward, roundCoins } from '../../../main/gamifyCore'
const streakCosts = defaultStreakCosts // local alias (single source of truth)
export { streakCosts, streakMilestoneReward, roundCoins }

/** The 4-stone window: recently-hit stone is the 2nd (1st for the first milestone). */
export function streakWindow(streak: number): { stones: number[]; hitIndex: number; nextIndex: number } {
  const costs = streakCosts(80)
  let idx = -1
  for (let i = 0; i < costs.length; i++) {
    if (costs[i] <= streak) idx = i
    else break
  }
  if (idx < 0) return { stones: costs.slice(0, 4), hitIndex: -1, nextIndex: 0 }
  const start = idx === 0 ? 0 : idx - 1
  return { stones: costs.slice(start, start + 4), hitIndex: idx - start, nextIndex: idx - start + 1 }
}
