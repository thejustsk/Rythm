import { useEffect } from 'react'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import { fmtCoins, SCORE_LABEL } from '@/lib/gamification'
import { parseLocal } from '@/engine/occurrences'
import type { CalendarEvent } from '@shared/types'
import type { ScoreType } from '@shared/types'
import Coin from './Coin'

/** "How did it go?" — closes IMMEDIATELY on selection (no animation after). */
export default function ScorePrompt() {
  const pending = useCoins((s) => s.pending)
  const setPending = useCoins((s) => s.setPending)
  const scoreEvent = useCoins((s) => s.scoreEvent)
  const systemOn = useCoins((s) => s.systemOn)
  const fireScoreFx = useCoins((s) => s.fireScoreFx)
  const toasts = useToasts.getState()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPending])

  const pick = async (t: ScoreType) => {
    if (!pending) return
    const ev: CalendarEvent = pending.event
    const originDate = pending.originDate
    setPending(null) // close immediately
    fireScoreFx() // cup 3: brief centered coin (only on an ANSWER, never on skip)
    try {
      const amount = await scoreEvent({ event: ev, originDate }, t)
      if (amount > 0) {
        toasts.push({ message: `${SCORE_LABEL[t]} — earned ${fmtCoins(amount)} 🪙`, kind: 'info', duration: 3500 })
      }
    } catch (e) {
      toasts.push({ message: `Could not record score: ${String(e)}`, kind: 'danger', duration: 4000 })
    }
  }

  if (!pending) return null
  if (!systemOn) return null // cup 3: prompt hidden while the coin system is OFF

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPending(null)}>
      <div className="dialog score-prompt">
        <div className="dialog-title">
          <Coin size={20} /> How did it go? <span className="badge">completed</span>
        </div>
        <div className="sp-event">
          <b>{pending.event.title}</b>
        </div>
        <div className="sp-options">
          <button className="sp-opt ontime" onClick={() => void pick('on_time')}>
            <b>✓ On time</b>
          </button>
          <button className="sp-opt late" onClick={() => void pick('late')}>
            <b>⏳ Late (within period)</b>
          </button>
          <button className="sp-opt off" onClick={() => void pick('off_schedule')}>
            <b>📴 Off schedule</b>
          </button>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setPending(null)}>
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
