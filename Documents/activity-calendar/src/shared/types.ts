// Shared types used by main process, preload and renderer.

export type EventStatus = 'todo' | 'doing' | 'done' | 'cancelled'

export interface CalendarEvent {
  id: string
  title: string
  description: string
  /** Local wall-clock start, 'YYYY-MM-DDTHH:MM' */
  startLocal: string
  endLocal: string
  allDay: boolean
  labelId: string | null
  colorOverride: string | null
  status: EventStatus
  /** RFC-5545-ish rule, e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=2026-12-31' */
  rrule: string | null
  /** ISO dates of skipped occurrences, e.g. ['2026-08-12'] */
  exdates: string[]
  /** Set on occurrence-override copies */
  parentId: string | null
  originDate: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Label {
  id: string
  name: string
  /** hex colour; null = inherit parent (or default grey if top-level) */
  color: string | null
  parentId: string | null
  sortOrder: number
  archived: boolean
}

export interface EventInput {
  /** optional explicit id (used by undo-restore) */
  id?: string
  title: string
  description?: string
  startLocal: string
  endLocal: string
  allDay?: boolean
  labelId?: string | null
  colorOverride?: string | null
  status?: EventStatus
  rrule?: string | null
  exdates?: string[]
  parentId?: string | null
  originDate?: string | null
}

export interface Api {
  events: {
    list(): Promise<CalendarEvent[]>
    get(id: string): Promise<CalendarEvent | null>
    create(input: EventInput): Promise<CalendarEvent>
    update(id: string, patch: Partial<EventInput>): Promise<CalendarEvent>
    remove(id: string): Promise<void>
  }
  labels: {
    list(): Promise<Label[]>
    create(name: string, color: string | null, parentId: string | null): Promise<Label>
    update(id: string, patch: { name?: string; color?: string | null; sortOrder?: number; archived?: boolean }): Promise<Label>
    remove(id: string): Promise<void>
  }
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
}
