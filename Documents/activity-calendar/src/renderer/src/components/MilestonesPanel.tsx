import { useState } from 'react'
import { useMilestones } from '@/state/milestones'
import { useCoins } from '@/state/coins'
import { useToasts } from '@/state/toasts'
import { fmtCoins } from '@/lib/gamification'
import type { RewardMilestone } from '@shared/types'

/** Celebration overlay: confetti + coin burst when a milestone is claimed. */
export function Celebration({ m, onClose }: { m: RewardMilestone; onClose: () => void }) {
  const pieces = Array.from({ length: 42 }, (_, i) => ({
    left: (i * 137) % 100,
    delay: (i % 12) * 0.12,
    color: ['#FFD60A', '#0A84FF', '#34C759', '#FF375F', '#BF5AF2', '#FF9F0A'][i % 6],
    rotate: (i * 61) % 360
  }))
  return (
    <div className="overlay celeb" onClick={onClose}>
      <div className="confetti">
        {pieces.map((p, i) => (
          <span key={i} className="confetti-piece" style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, transform: `rotate(${p.rotate}deg)` }} />
        ))}
      </div>
      <div className="celeb-card">
        <div className="celeb-icon">🎉</div>
        <div className="celeb-title">Milestone claimed!</div>
        <div className="celeb-name">
          {m.icon} {m.name}
        </div>
        <div className="celeb-sub">Treat yourself — you earned it. 🪙</div>
        <button className="btn primary" onClick={onClose}>
          Enjoy!
        </button>
      </div>
    </div>
  )
}

/** Milestones panel for the Coins view: list, add, edit, claim. */
export default function MilestonesPanel() {
  const ms = useMilestones()
  const balance = useCoins((s) => s.balance)
  const refresh = useCoins((s) => s.refresh)
  const toasts = useToasts.getState()

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('🎯')
  const [cost, setCost] = useState('100')
  const [notes, setNotes] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState<RewardMilestone | null>(null)

  const submit = async () => {
    const c = parseFloat(cost)
    if (!name.trim() || isNaN(c) || c <= 0) return
    if (editingId) await ms.update(editingId, { name: name.trim(), icon, cost: c, notes })
    else await ms.create(name.trim(), icon, c, notes)
    setName('')
    setIcon('🎯')
    setCost('100')
    setNotes('')
    setEditingId(null)
    setAdding(false)
  }

  const claim = async (m: RewardMilestone) => {
    const res = await ms.claim(m.id)
    await refresh()
    if (res.ok) {
      setCelebrate(m)
      toasts.push({ message: `Claimed "${m.name}" — ${fmtCoins(m.cost)} 🪙 spent. Enjoy!`, kind: 'info', duration: 4000 })
    } else {
      toasts.push({ message: `Not enough coins yet (need ${fmtCoins(m.cost)})`, kind: 'danger', duration: 3500 })
    }
  }

  return (
    <div className="ins-panel wide">
      <div className="ins-panel-title">Milestones — treat yourself 🎁</div>
      {ms.list.length === 0 && !adding && (
        <div className="ins-empty">
          No milestones yet — set a reward goal like "Save 500 🪙 → movie night 🎬"
          <br />
          <button className="btn primary mile-add-btn" onClick={() => setAdding(true)}>
            ＋ New milestone
          </button>
        </div>
      )}

      {ms.list.map((m) => {
        const pct = Math.min(100, Math.round((balance / m.cost) * 100))
        const ready = balance >= m.cost
        return (
          <div key={m.id} className={`mile-row${ready ? ' ready' : ''}${m.achievedAt ? ' achieved' : ''}`}>
            <span className="mile-row-icon">{m.icon}</span>
            <div className="mile-row-main">
              <div className="mile-row-name">
                {m.name}
                {m.achievedAt && <span className="mini-badge done">✓ claimed</span>}
              </div>
              {m.notes && <div className="mile-row-notes">{m.notes}</div>}
              <div className="ins-progress-track">
                <div className="ins-progress-done" style={{ width: `${pct}%`, background: ready ? 'var(--amber)' : 'var(--accent)' }} />
              </div>
              <div className="mile-row-sub">
                {m.achievedAt
                  ? `Claimed ${new Date(m.achievedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : `${fmtCoins(balance)} / ${fmtCoins(m.cost)} 🪙 · ${pct}%`}
              </div>
            </div>
            <div className="mile-row-actions">
              {!m.achievedAt && ready && (
                <button className="btn primary" onClick={() => void claim(m)}>
                  Claim 🎉
                </button>
              )}
              {!m.achievedAt && (
                <button
                  className="btn"
                  onClick={() => {
                    setEditingId(m.id)
                    setName(m.name)
                    setIcon(m.icon)
                    setCost(String(m.cost))
                    setNotes(m.notes)
                    setAdding(true)
                  }}
                >
                  Edit
                </button>
              )}
              <button className="btn danger" onClick={() => void ms.remove(m.id)}>
                ✕
              </button>
            </div>
          </div>
        )
      })}

      {adding && (
        <div className="mile-form">
          <input placeholder="Name (e.g. Movie night)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Icon (emoji)" value={icon} onChange={(e) => setIcon(e.target.value)} className="mile-icon" />
          <input placeholder="Cost (🪙)" type="number" min={1} value={cost} onChange={(e) => setCost(e.target.value)} className="mile-cost" />
          <input placeholder="Treat notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} className="mile-notes" />
          <button className="btn primary" onClick={() => void submit()} disabled={!name.trim() || isNaN(parseFloat(cost)) || parseFloat(cost) <= 0}>
            {editingId ? 'Save' : 'Add'}
          </button>
          <button className="btn" onClick={() => { setAdding(false); setEditingId(null) }}>
            Cancel
          </button>
        </div>
      )}
      {ms.list.length > 0 && !adding && (
        <button className="btn mile-add-btn" onClick={() => setAdding(true)}>
          ＋ New milestone
        </button>
      )}

      {celebrate && <Celebration m={celebrate} onClose={() => setCelebrate(null)} />}
    </div>
  )
}
