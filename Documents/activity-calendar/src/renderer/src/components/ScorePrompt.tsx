import { useEffect } from 'react'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import { computeEarn, fmtCoins, SCORE_LABEL, SCORE_MULT } from '@/lib/gamification'
import { parseLocal } from '@/engine/occurrences'
import type { ScoreType } from '@shared/types'

/** "How did it go?" — shown right after a block is marked Done. */
export default function ScorePrompt() {
  const pending = useCoins((s) => s.pending)
  const setPending = useCoins((s) => s.setPending)
  const scoreEvent = useCoins((s) => s.scoreEvent)
  const toasts = useToasts.getState()

  // HOOKS MUST RUN BEFORE ANY EARLY RETURN (React #310 otherwise).
  // The prompt must never stay stuck: Escape closes it; a failed save still
  // closes it (the toast reports the error instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPending])

  if (!pending) return null
  const { event, originDate } = pending
  const minutes = (parseLocal(event.endLocal).getTime() - parseLocal(event.startLocal).getTime()) / 60000
  const amountFor = (t: ScoreType) => computeEarn(minutes, t)

  const pick = async (t: ScoreType) => {
    try {
      const amount = await scoreEvent(pending, t)
      toasts.push({ message: `${SCORE_LABEL[t]} — earned ${fmtCoins(amount)} 🪙`, kind: 'info', duration: 3500 })
    } catch (e) {
      toasts.push({ message: `Could not record score: ${String(e)}`, kind: 'danger', duration: 4000 })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setPending(null)}>
      <div className="dialog score-prompt">
        <div className="dialog-title">
          🪙 How did it go? <span className="badge">completed</span>
        </div>
        <div className="sp-event">
          <b>{event.title}</b>
          <span className="muted">
            {fmtCoins(amountFor('on_time'))}–{fmtCoins(amountFor('late'))} 🪙 potential
          </span>
        </div>
        <div className="sp-options">
          <button className="sp-opt ontime" onClick={() => void pick('on_time')}>
            <b>✓ On time</b>
            <span>×{SCORE_MULT.on_time}</span>
            <i>+{fmtCoins(amountFor('on_time'))} 🪙</i>
          </button>
          <button className="sp-opt late" onClick={() => void pick('late')}>
            <b>⏳ Late (within period)</b>
            <span>×{SCORE_MULT.late}</span>
            <i>+{fmtCoins(amountFor('late'))} 🪙</i>
          </button>
          <button className="sp-opt off" onClick={() => void pick('off_schedule')}>
            <b>📴 Off schedule</b>
            <span>×{SCORE_MULT.off_schedule}</span>
            <i>+{fmtCoins(amountFor('off_schedule'))} 🪙</i>
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
