/**
 * Apple-style edge scrolling (user feature):
 *  - scrollable views (Day/Week): at the BOTTOM a hard scroll UP pulls the
 *    NEXT day/week; at the TOP a hard scroll DOWN pulls the PREVIOUS one.
 *  - fixed views (Month): a hard wheel gesture flips the month.
 * Pure decision helpers + a small React hook.
 */
import { useEffect, useRef } from 'react'

/** A "hard" gesture: strong deltaY (trackpad flick / fast wheel). */
export function isHardWheel(deltaY: number): boolean {
  return Math.abs(deltaY) >= 120
}

export type EdgeDecision = 'prev' | 'next' | null

/** Where is the scroller? Returns a nav decision if at an edge + hard wheel. */
export function edgeDecision(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  deltaY: number,
  mode: 'scroll' | 'fixed'
): EdgeDecision {
  if (!isHardWheel(deltaY)) return null
  if (mode === 'fixed') {
    return deltaY > 0 ? 'next' : 'prev'
  }
  const atBottom = scrollTop + clientHeight >= scrollHeight - 4
  const atTop = scrollTop <= 2
  if (atBottom && deltaY > 0) return 'next'
  if (atTop && deltaY < 0) return 'prev'
  return null
}

interface EdgeNavOptions {
  mode: 'scroll' | 'fixed'
  onPrev: () => void
  onNext: () => void
  /** ms between navigations (prevents chained flicks). */
  cooldownMs?: number
  /** return true to block navigation (e.g. a dialog is open). */
  blocked?: () => boolean
}

/** Attach to the scroll container (or any element for fixed mode). */
export function useEdgeNav<T extends HTMLElement>(ref: React.RefObject<T | null>, opts: EdgeNavOptions) {
  const lastNav = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (optsRef.current.blocked?.()) return
      const now = Date.now()
      if (now - lastNav.current < (optsRef.current.cooldownMs ?? 700)) return
      const dec = edgeDecision(
        el.scrollTop,
        el.clientHeight,
        el.scrollHeight,
        e.deltaY,
        optsRef.current.mode
      )
      if (!dec) return
      lastNav.current = now
      if (dec === 'next') optsRef.current.onNext()
      else optsRef.current.onPrev()
      // Apple-like: let the container glide to the matching edge after the
      // view swaps — the next frame the new content is in place.
      requestAnimationFrame(() => {
        if (dec === 'next') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        else el.scrollTo({ top: 0, behavior: 'smooth' })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref])
}
