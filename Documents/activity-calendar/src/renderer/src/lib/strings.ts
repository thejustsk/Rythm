/**
 * Central user-facing strings (item B.15 — i18n-ready).
 *
 * All user-visible chrome text lives here so a future translation layer can
 * swap `T` for a per-locale object without touching components. Dynamic
 * messages (toasts etc.) stay inline — this file covers the static UI labels.
 */
export const T = {
  appName: 'Rhythm',
  coinsName: 'Rhythm Coins',
  views: {
    day: 'Day',
    week: 'Week',
    month: 'Month',
    agenda: 'Agenda',
    insights: 'Insights'
  },
  statuses: {
    all: 'All',
    todo: 'To Do',
    doing: 'In Progress',
    done: 'Done',
    cancelled: 'Cancelled'
  },
  agendaGroups: {
    overdue: 'Overdue',
    today: 'Today',
    tomorrow: 'Tomorrow',
    thisWeek: 'This week',
    later: 'Later'
  },
  miniBadges: {
    doing: 'In progress',
    done: 'Done',
    cancelled: 'Cancelled',
    multiday: 'Multi-day'
  },
  settings: {
    title: 'Settings',
    done: 'Done',
    appearance: 'Appearance',
    theme: 'Theme',
    themeHint: 'Dark mode protects your eyes in the evening. "System" follows Windows.',
    backups: 'Backups',
    autoBackup: 'Automatic daily backup',
    backUpNow: 'Back up now',
    backingUp: 'Backing up…',
    backupsFolder: 'Backups folder',
    dataFolder: 'Data folder',
    about: 'About',
    general: 'General',
    notifications: 'Notifications'
  },
  shortcutSheet: {
    title: 'Keyboard shortcuts',
    hint: 'Press ? anywhere to open this. Esc closes it.',
    groups: {
      views: 'Views',
      navigate: 'Navigate',
      actions: 'Actions'
    }
  },
  coinDialog: {
    turnOff: 'Turn Rhythm Coins OFF?',
    turnOn: 'Turn Rhythm Coins ON?',
    disable: 'Yes, disable',
    enable: 'Yes, enable',
    cancel: 'Cancel'
  }
} as const
