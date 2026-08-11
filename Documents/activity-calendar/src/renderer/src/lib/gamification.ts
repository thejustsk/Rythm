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
  return Math.round(baseCoins(minutes) * SCORE_MULT[score] * 100) / 100
}

/** ledger-derived balance (never stored) */
export function balanceFromTxs(earns: number, spends: number): number {
  return Math.round((earns - spends) * 100) / 100
}

export function fmtCoins(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}
