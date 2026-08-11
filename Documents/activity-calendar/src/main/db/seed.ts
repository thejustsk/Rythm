import type { Db } from './connection'

/**
 * Demo data so the app looks alive on first launch.
 * All dates are relative to "today" so the calendar is always populated.
 */

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function daysFromNow(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

const nowIso = () => new Date().toISOString()

export function seedIfEmpty(db: Db): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
  if (count > 0) return

  const t = (offsetDays: number, hhmm: string) => `${fmt(daysFromNow(offsetDays))}T${hhmm}`
  const d = (offsetDays: number) => fmt(daysFromNow(offsetDays))

  const insLabel = db.prepare(
    'INSERT INTO labels (id, name, color, parent_id, sort_order, archived) VALUES (?, ?, ?, ?, ?, 0)'
  )
  const labels: Array<[string, string, string | null, string | null]> = [
    ['lbl-work', 'Work', '#3B82F6', null],
    ['lbl-work-project', 'Project A', '#0EA5E9', 'lbl-work'],
    ['lbl-work-meetings', 'Meetings', '#8B5CF6', 'lbl-work'],
    ['lbl-fitness', 'Fitness', '#10B981', null],
    ['lbl-fitness-gym', 'Gym', '#F97316', 'lbl-fitness'],
    ['lbl-fitness-yoga', 'Yoga', '#A78BFA', 'lbl-fitness'],
    ['lbl-fitness-walk', 'Walk', null, 'lbl-fitness'],
    ['lbl-learning', 'Learning', '#F43F5E', null],
    ['lbl-personal', 'Personal', '#EC4899', null],
    ['lbl-personal-errands', 'Errands', '#F59E0B', 'lbl-personal'],
    ['lbl-personal-family', 'Family', '#14B8A6', 'lbl-personal']
  ]
  labels.forEach(([id, name, color, parent]) => insLabel.run(id, name, color, parent, 0))

  const ins = db.prepare(`
    INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                        color_override, status, rrule, exdates, parent_id, origin_date,
                        completed_at, created_at, updated_at)
    VALUES (@id, @title, @desc, @start, @end, 0, @label, NULL, @status, @rrule, @exdates, @parent, @origin, @done, @now, @now)
  `)

  const E = (
    id: string,
    title: string,
    start: string,
    end: string,
    label: string | null,
    status: string,
    rrule: string | null = null,
    exdates: string[] = [],
    parent: string | null = null,
    origin: string | null = null,
    desc = '',
    done: string | null = null
  ) =>
    ins.run({
      id,
      title,
      desc,
      start,
      end,
      label,
      status,
      rrule,
      exdates: JSON.stringify(exdates),
      parent,
      origin,
      done,
      now: nowIso()
    })

  // --- Recurring series -------------------------------------------------
  E('evt-walk', 'Morning walk', t(-20, '06:30'), t(-20, '07:15'), 'lbl-fitness-walk', 'todo',
    'FREQ=DAILY', [d(-1), d(-3)])
  E('evt-walk-done-1', 'Morning walk', t(-2, '06:30'), t(-2, '07:20'), 'lbl-fitness-walk', 'done',
    null, [], 'evt-walk', d(-2), '', `${fmt(daysFromNow(-2))}T07:20:00.000Z`)
  E('evt-walk-done-2', 'Morning walk', t(-4, '06:30'), t(-4, '07:10'), 'lbl-fitness-walk', 'done',
    null, [], 'evt-walk', d(-4), '', `${fmt(daysFromNow(-4))}T07:10:00.000Z`)

  E('evt-deepwork', 'Deep work — Project A', t(-20, '09:30'), t(-20, '11:30'), 'lbl-work-project', 'doing',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  E('evt-sync', 'Team sync', t(-20, '11:30'), t(-20, '12:00'), 'lbl-work-meetings', 'todo',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR')
  E('evt-lunch', 'Lunch break', t(-20, '12:30'), t(-20, '13:15'), 'lbl-personal', 'todo', 'FREQ=DAILY')
  E('evt-gym', 'Gym session', t(-20, '18:00'), t(-20, '19:00'), 'lbl-fitness-gym', 'todo',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR')
  E('evt-yoga', 'Yoga flow', t(-20, '18:00'), t(-20, '18:45'), 'lbl-fitness-yoga', 'todo',
    'FREQ=WEEKLY;BYDAY=TU,TH')
  E('evt-reading', 'Evening reading', t(-20, '21:00'), t(-20, '21:45'), 'lbl-learning', 'todo', 'FREQ=DAILY')
  E('evt-errands', 'Weekend errands', t(-20, '10:00'), t(-20, '11:30'), 'lbl-personal-errands', 'todo',
    'FREQ=WEEKLY;BYDAY=SA')
  E('evt-review', 'Weekly review', t(-20, '16:00'), t(-20, '17:00'), 'lbl-work-meetings', 'todo',
    'FREQ=WEEKLY;BYDAY=FR')

  // --- One-off events ----------------------------------------------------
  E('evt-plan', 'Project A — milestone planning', t(2, '14:00'), t(2, '15:30'), 'lbl-work-project', 'todo')
  E('evt-dentist', 'Dentist appointment', t(1, '09:00'), t(1, '09:45'), 'lbl-personal-errands', 'todo')
  E('evt-dinner', 'Dinner with family', t(3, '19:30'), t(3, '21:00'), 'lbl-personal-family', 'todo')
  E('evt-movie', 'Movie night', t(-3, '20:00'), t(-3, '22:30'), 'lbl-personal-family', 'done',
    null, [], null, null, '', `${fmt(daysFromNow(-3))}T22:30:00.000Z`)
  E('evt-bookclub', 'Book club meetup', t(-6, '19:00'), t(-6, '20:30'), 'lbl-learning', 'done',
    null, [], null, null, '', `${fmt(daysFromNow(-6))}T20:30:00.000Z`)
  E('evt-run-cancelled', 'Morning run', t(-2, '06:30'), t(-2, '07:15'), 'lbl-fitness-walk', 'cancelled')
}
