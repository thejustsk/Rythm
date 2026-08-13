import { useEffect, useRef } from 'react'
import Coin from './Coin'
import { APP_VERSION, BUILD_TAG } from '@shared/version'

/**
 * Cinematic Coins-tab intro: dark-navy stage (like the user's reference art),
 * the gold coin drops in with a bounce + flip, gold dust bursts from it with
 * real particle physics (canvas), two gold ring shockwaves, then the
 * "Rhythm Coins" wordmark reveals. Click anywhere to skip.
 * Auto-dismisses after ~2.9s; parent flips the KPI cards in as it fades.
 */
export default function CoinIntro({ onDone }: { onDone: (skipped: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  // ---- gold dust particle engine ----
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const DPR = Math.min(2, window.devicePixelRatio || 1)
    const SIZE = 480
    cv.width = SIZE * DPR
    cv.height = SIZE * DPR
    ctx.scale(DPR, DPR)

    interface P {
      x: number; y: number; vx: number; vy: number; life: number; decay: number
      r: number; kind: 'dust' | 'glint'; hue: number; spin: number
    }
    const particles: P[] = []
    const mk = (kind: 'dust' | 'glint', angle: number, speed: number): P => ({
      x: SIZE / 2, y: SIZE / 2,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.6,
      life: 1, decay: 0.012 + Math.random() * 0.02,
      r: kind === 'dust' ? 2 + Math.random() * 4.5 : 1.5 + Math.random() * 2,
      kind, hue: 38 + Math.random() * 18, spin: Math.random() * Math.PI * 2
    })
    const burst = (n: number, speed0: number, delay = 0) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const s = speed0 + Math.random() * (speed0 * 1.6)
        const p = mk(Math.random() < 0.78 ? 'dust' : 'glint', a, s)
        p.decay = delay === 0 ? p.decay : p.decay * 1.6
        particles.push(p)
      }
    }
    burst(64, 3.2, 0)
    window.setTimeout(() => burst(26, 2.2), 620)
    window.setTimeout(() => burst(14, 1.6), 1150)

    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.life -= p.decay * 0.9
        if (p.life <= 0) { particles.splice(i, 1); continue }
        p.vy += 0.055 // gravity
        p.vx *= 0.992
        p.x += p.vx
        p.y += p.vy
        p.spin += 0.02
        const a = Math.min(1, p.life * 2.2) * (1 - Math.min(1, t / 2.4))
        if (p.kind === 'dust') {
          ctx.fillStyle = `hsla(${p.hue}, 96%, ${58 + p.life * 16}%, ${a})`
          ctx.shadowColor = 'rgba(255, 190, 60, 0.9)'
          ctx.shadowBlur = 10
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r * (0.6 + p.life * 0.5), 0, Math.PI * 2)
          ctx.fill()
        } else {
          // four-point sparkle glint
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.spin)
          ctx.fillStyle = `hsla(46, 100%, ${82 + p.life * 12}%, ${a})`
          ctx.shadowColor = 'rgba(255, 230, 150, 1)'
          ctx.shadowBlur = 8
          const r2 = p.r * (1 + p.life * 1.4)
          ctx.beginPath()
          ctx.moveTo(0, -r2 * 2.4)
          ctx.quadraticCurveTo(0, 0, r2 * 2.4, 0)
          ctx.quadraticCurveTo(0, 0, 0, r2 * 2.4)
          ctx.quadraticCurveTo(0, 0, -r2 * 2.4, 0)
          ctx.quadraticCurveTo(0, 0, 0, -r2 * 2.4)
          ctx.fill()
          ctx.restore()
        }
      }
      ctx.shadowBlur = 0
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- auto-dismiss (long enough to read the wordmark + subtitle) ----
  useEffect(() => {
    const t = window.setTimeout(() => doneRef.current(false), 5300)
    return () => window.clearTimeout(t)
  }, [])

  return (
    <div className="coin-drop" onClick={() => onDone(true)} title="Skip intro">
      <div className="intro-stage">
        <div className="intro-center">
          <div className="intro-ring r1" />
          <div className="intro-ring r2" />
          <div className="intro-glow" />
          <div className="intro-coin">
            <Coin size={150} spinIn />
          </div>
          <canvas ref={canvasRef} className="dust-canvas" width={480} height={480} />
        </div>
        <div className="intro-word">
          <div className="intro-word-main">Rhythm <span>Coins</span></div>
          <div className="intro-word-sub">Every task done · every coin earned</div>
          <div className="intro-word-ver">v{APP_VERSION} · {BUILD_TAG}</div>
        </div>
      </div>
    </div>
  )
}
