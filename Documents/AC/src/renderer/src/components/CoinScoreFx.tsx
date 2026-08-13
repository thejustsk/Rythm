import { useCoins } from '@/state/coins'
import Coin from './Coin'

/** "How did it go?" answered (NOT skip) → a small celebration in the CENTER of
 *  the page: the coin pops in with a slow flip, a golden ring pulses out, and
 *  a rich gold-dust + star-sparkle burst radiates around it. Transparent
 *  background, toaster-like ~1.9s, pointer-events: none — never blocks. */
export default function CoinScoreFx() {
  const fx = useCoins((s) => s.scoreFx)
  if (!fx) return null

  // 18 gold-dust motes + 5 four-point star sparkles, radiating outward
  const pieces = Array.from({ length: 23 }, (_, i) => {
    const a = (i / 23) * Math.PI * 2 + (i % 7) * 0.11
    const r = 62 + (i % 5) * 26
    return {
      dx: Math.cos(a) * r,
      dy: Math.sin(a) * r,
      spark: i % 5 === 2,
      delay: 0.12 + (i % 7) * 0.045
    }
  })

  return (
    <div className="coin-score-fx" aria-hidden>
      <div className="fx-coin">
        <Coin size={80} flip />
        <div className="fx-ring" />
        <div className="fx-dust">
          {pieces.map((d, i) => (
            <span
              key={i}
              className={d.spark ? 'spark' : ''}
              style={{
                ['--dx' as string]: `${d.dx}px`,
                ['--dy' as string]: `${d.dy}px`,
                animationDelay: `${d.delay}s`
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
