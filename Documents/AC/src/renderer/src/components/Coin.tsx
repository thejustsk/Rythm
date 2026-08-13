import coinGold from '@assets/coin-gold.png'
import coinGoldBack from '@assets/coin-gold-back.png'

/**
 * The Rhythm coin — REAL 3D (item: "third dimension, thickness").
 *
 * Construction (pure CSS 3D):
 *   .rhythm-coin  → perspective container (size)
 *     .c3-spin    → the spinning element (money flip / gentle flip / intro spin)
 *       .c3-tilt  → rotateX(90°) lays the drum flat so faces point at the viewer
 *         .c3-face.front → 'tsk' script face
 *         .c3-face.back  → multi-star face (mirror-corrected)
 *         .c3-seg × N    → milled EDGE band: thin vertical strips wrapped
 *                          around the rim (rotateY(a) translateZ(r)) — this is
 *                          the visible THICKNESS during a rotateY flip.
 *
 * Props:
 *   flip     – gentle 3D rocking (KPI cards, sidebar chip, prompt)
 *   flipLoop – the realistic money flip: drop → spin on Y → hit ground →
 *              bounce → land flat → fade (heading pill + Coins tab)
 *   spinIn   – one-shot toss for the intro (drop + spin + land + glow)
 */
export default function Coin({
  size = 18,
  flip = false,
  flipLoop = false,
  spinIn = false,
  roll = false
}: {
  size?: number
  flip?: boolean
  flipLoop?: boolean
  spinIn?: boolean
  roll?: boolean
}) {
  const r = size / 2
  const th = Math.max(2.5, Math.round(size * 0.24 * 10) / 10) // coin thickness
  const segs = Math.max(24, Math.min(48, Math.round(size * 0.5)))
  const arc = (2 * Math.PI * r) / segs
  const cls = `rhythm-coin${flip ? ' flip' : ''}${flipLoop ? ' flip-loop' : ''}${spinIn ? ' spin-in' : ''}${roll ? ' roll' : ''}`

  return (
    <span
      className={cls}
      style={{ width: size, height: size, ['--size' as string]: `${size}px`, ['--th' as string]: `${th}px` }}
    >
      <span className="c3-spin">
        <span className="c3-tilt">
          <span
            className="c3-face front"
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, transform: `translateY(${th / 2}px) rotateX(-90deg)` }}
          >
            <img src={coinGold} alt="Rhythm coin" draggable={false} className="rc-img" />
          </span>
          <span
            className="c3-face back"
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, transform: `translateY(${-th / 2}px) rotateX(-90deg) rotateY(180deg)` }}
          >
            <img src={coinGoldBack} alt="" draggable={false} className="rc-img" />
          </span>
          {Array.from({ length: segs }, (_, i) => (
            <span
              key={i}
              className="c3-seg"
              style={{
                width: arc,
                height: th,
                marginLeft: -arc / 2,
                marginTop: -th / 2,
                transform: `rotateY(${(i * 360) / segs}deg) translateZ(${r}px)`,
                background: i % 2 === 0 ? '#e8b95c' : '#a86a1c'
              }}
            />
          ))}
        </span>
      </span>
    </span>
  )
}
