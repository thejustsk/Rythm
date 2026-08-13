import { useEffect, useMemo, useRef, useState } from 'react'
import { useMilestones } from '@/state/milestones'
import { useCoins } from '@/state/coins'
import { fmtCoins } from '@/lib/gamification'
import type { RewardMilestone } from '@shared/types'

interface Celeb {
  ids: string[]
  names: string[]
  key: number
}

/** Sidebar widget: the ring always follows the CURRENT NET — the target is the
 *  next milestone whose cost the net hasn't reached yet. When the net moves
 *  THROUGH one or more milestones in a single jump, the widget celebrates:
 *  confetti + golden shining border + "Level X passed — Claim in Coins" for
 *  5 seconds, then it shows the next level. */
export default function MilestoneWidget() {
  const list = useMilestones((s) => s.list)
  const balance = useCoins((s) => s.balance)
  const [celeb, setCeleb] = useState<Celeb | null>(null)
  const prevRef = useRef<number | null>(null) // null = not tracked yet (initial load)
  const celebKey = useRef(0)

  // sorted by cost (the canonical path order)
  const sorted = useMemo(() => [...list].sort((a, b) => a.cost - b.cost), [list])

  // detect a net movement THROUGH milestone(s) — only for in-session increases
  useEffect(() => {
    if (prevRef.current === null) {
      prevRef.current = balance // initial load: record, don't celebrate
      return
    }
    const prev = prevRef.current
    if (balance > prev && sorted.length) {
      const crossed = sorted.filter((m) => m.cost > prev && m.cost <= balance)
      if (crossed.length) {
        celebKey.current += 1
        setCeleb({ ids: crossed.map((m) => m.id), names: crossed.map((m) => m.name), key: celebKey.current })
      }
    }
    prevRef.current = balance
  }, [balance, sorted])

  // clear the celebration after 5s
  useEffect(() => {
    if (!celeb) return
    const t = window.setTimeout(() => setCeleb((c) => (c && c.key === celeb.key ? null : c)), 5000)
    return () => window.clearTimeout(t)
  }, [celeb])

  // target = the next milestone the net hasn't reached; if everything is
  // reached, the ring fills on the last one
  const target = sorted.find((m) => m.cost > balance) ?? sorted[sorted.length - 1]
  if (!target) return null

  const pct = Math.min(100, Math.round((balance / target.cost) * 100))
  const R = 20
  const C = 2 * Math.PI * R
  const done = balance >= target.cost
  const celebText = celeb
    ? celeb.names.length === 1
      ? `${celeb.names[0]} passed`
      : `${celeb.names.join(' & ')} passed`
    : ''

  return (
    <div
      className={`mile-widget${done ? ' ready' : ''}${celeb ? ' celebrating' : ''}`}
      title={`Next: ${target.name} — ${fmtCoins(balance)} / ${fmtCoins(target.cost)} 🪙`}
    >
      {celeb && (
        <div className="mile-celeb" key={celeb.key}>
          {Array.from({ length: 14 }, (_, i) => (
            <span
              key={i}
              className="mile-celeb-dust"
              style={{
                ['--dx' as string]: `${(i * 61) % 70 - 35}px`,
                ['--dy' as string]: `${(i * 47) % 70 - 35}px`,
                animationDelay: `${(i % 6) * 0.05}s`
              }}
            />
          ))}
          <div className="mile-celeb-text">🎉 {celebText} — Claim in Coins 🪙</div>
        </div>
      )}
      {!celeb && (
        <>
          <svg className="mile-ring" viewBox="0 0 48 48" width="44" height="44">
            <circle cx="24" cy="24" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="5" />
            <circle
              cx="24"
              cy="24"
              r={R}
              fill="none"
              stroke={done ? 'var(--amber)' : 'var(--accent)'}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * C} ${C}`}
              transform="rotate(-90 24 24)"
            />
            <text x="24" y="28" textAnchor="middle" fontSize="11" fontWeight="700" fill={done ? 'var(--amber)' : 'var(--text)'}>
              {target.icon}
            </text>
          </svg>
          <div className="mile-info">
            <div className="mile-name">{target.name}</div>
            <div className="mile-progress">
              {fmtCoins(balance)} / {fmtCoins(target.cost)} 🪙 · {pct}%
            </div>
            {done && <div className="mile-cta">Claim in Coins 🎉</div>}
          </div>
        </>
      )}
    </div>
  )
}

export type { RewardMilestone }
