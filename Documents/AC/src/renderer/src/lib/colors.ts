/** Colour helpers: label palette, resolution, contrast text. */
import type { CalendarEvent, Label } from '@shared/types'

export const LABEL_PALETTE = [
  '#FF6B6B',
  '#FF9F0A',
  '#FFD60A',
  '#34C759',
  '#30D158',
  '#0A84FF',
  '#5E5CE6',
  '#BF5AF2',
  '#FF375F',
  '#64D2FF',
  '#00C7BE',
  '#AC8E68'
]

export const DEFAULT_EVENT_COLOR = '#8E8E93'

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0.5
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** White or near-black text, whichever reads better on the given background. */
export function readableText(hex: string): string {
  return luminance(hex) > 0.5 ? '#1D1D1F' : '#FFFFFF'
}

export function resolveEventColor(event: CalendarEvent, labels: Label[]): string {
  if (event.colorOverride) return event.colorOverride
  if (event.labelId) {
    const label = labels.find((l) => l.id === event.labelId)
    if (label) {
      if (label.color) return label.color
      const parent = label.parentId ? labels.find((l) => l.id === label.parentId) : null
      if (parent?.color) return parent.color
    }
  }
  return DEFAULT_EVENT_COLOR
}

export function labelColor(label: Label, labels: Label[]): string {
  if (label.color) return label.color
  const parent = label.parentId ? labels.find((l) => l.id === label.parentId) : null
  return parent?.color ?? DEFAULT_EVENT_COLOR
}

/** Soft tinted background for sidebar dots and chips. */
export function tint(hex: string, alpha = 0.16): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(142,142,147,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
