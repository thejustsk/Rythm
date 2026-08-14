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

export type ScoreType = 'on_time' | 'late' | 'off_schedule'

export interface ScoreRow {
  eventId: string
  originDate: string
  scoreType: ScoreType
  scoredAt: string
  refundedAt: string | null
}

export interface RewardMilestone {
  id: string
  name: string
  icon: string
  cost: number
  notes: string
  achievedAt: string | null
  createdAt: string
  /** STICKY reach: true once the stone's cost was EVER met (persisted), so a
   *  level box never disappears when the net drops. */
  reached?: boolean
}

export interface CoinTransaction {
  id: string
  ts: string
  eventId: string | null
  originDate: string | null
  labelId: string | null
  type: 'earn' | 'bonus' | 'spend' | 'refund'
  amount: number
  reason: string
}

export interface BackupEntry {
  name: string
  size: number
  mtime: string
}
export interface BackupResult {
  ok: boolean
  path: string | null
  count: number
  lastBackup: string | null
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
  backups: {
    list(): Promise<BackupEntry[]>
    now(): Promise<BackupResult>
  }
  app: {
    info(): Promise<{ version: string; dataDir: string; backupsDir: string }>
    openDataFolder(): Promise<void>
    openBackupsFolder(): Promise<void>
    getLaunchAtStartup(): Promise<boolean>
    setLaunchAtStartup(on: boolean): Promise<boolean>
  }
  coins: {
    scoreEvent(eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null): Promise<{ earned: boolean; amount: number }>
    getScore(eventId: string, originDate: string): Promise<ScoreRow | null>
    clearScores(eventId: string, originDate?: string): Promise<{ scores: ScoreRow[]; earns: Array<{ eventId: string; originDate: string; amount: number; labelId: string | null }> }>
    restoreScores(rows: Array<{ eventId: string; originDate: string; scoreType: ScoreType; amount: number; labelId: string | null }>): Promise<void>
    revertScore(eventId: string, originDate: string): Promise<{ refunded: boolean; amount: number }>
    restoreScore(eventId: string, originDate: string, scoreType: ScoreType, amount: number, labelId: string | null): Promise<{ restored: boolean }>
    checkIn(): Promise<{ award: boolean; streak: number; amount: number }>
    allDoneCheck(originDate: string): Promise<{ award: boolean; amount: number }>
    perfectWeek(): Promise<{ award: boolean; amount: number; weekKey: string | null; blockingDay: string | null; streak: number }>
    perfectMonth(): Promise<{ award: boolean; amount: number; streak: number; level: number | null }>
    streakMilestone(): Promise<{ award: boolean; amount: number; streak: number; level: number | null }>
    system(): Promise<boolean>
    setSystem(on: boolean): Promise<void>
    stats(): Promise<{ today: number; series: Array<{ date: string; amount: number }>; perLabel: Array<{ labelId: string | null; labelName: string; amount: number }> }>
    balance(): Promise<number>
    listTransactions(): Promise<CoinTransaction[]>
  }
  milestones: {
    list(): Promise<RewardMilestone[]>
    create(name: string, icon: string, cost: number, notes: string): Promise<RewardMilestone>
    update(id: string, patch: { name?: string; icon?: string; cost?: number; notes?: string }): Promise<RewardMilestone>
    remove(id: string): Promise<void>
    claim(id: string): Promise<{ ok: boolean; balance: number }>
    unclaim(id: string): Promise<{ ok: boolean; balance: number }>
  }
  notify: {
    getConfig(): Promise<{ enabled: boolean; slots: string[]; leadMin: number }>
    setConfig(cfg: { enabled: boolean; slots: string[]; leadMin: number }): Promise<{ enabled: boolean; slots: string[]; leadMin: number }>
    test(): Promise<{ ok: boolean; reason: string }>
    resetDay(): Promise<{ ok: boolean }>
    onInApp(cb: (d: { title: string; body: string }) => void): () => void
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
}
