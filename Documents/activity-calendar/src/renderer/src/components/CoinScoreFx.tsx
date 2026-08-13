import { useCoins } from '@/state/coins'
import Coin from './Coin'

/** "How did it go?" answered (NOT skip) → a small celebration in the CENTER of
 *  the page: the coin pops in with a slow flip, wrapped in a gold-dust +
 *  sparkle burst. Transparent background, toaster-like ~1.9s, pointer-events:
 *  none — it never blocks anything. No flight, no count-up. */
export default function CoinScoreFx() {
  const fx = useCoins((s) => s.scoreFx)
  if (!fx) return null

  const dust = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const r = 70 + (i % 3) * 28
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, spark: i % 4 === 0, delay: 0.15 + (i % 5) * 0.04 }
  })

  return (
    <div className="coin-score-fx" aria-hidden>
      <div className="fx-coin">
        <Coin size={72} flip />
        <div className="fx-dust">
          {dust.map((d, i) => (
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
