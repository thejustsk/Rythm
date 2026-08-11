# Rhythm — your personal activity calendar

A Google-Calendar-style desktop app for planning & tracking activities.
Local-first (everything stays on your PC), colourful, minimal, macOS-flavoured.

## Run it (Windows)

1. Install **Node.js** (LTS — 22 or 24) from nodejs.org — needed only once. No other tools
   (no Visual Studio, no C++ toolchain) are required: the database library ships
   ready-made Windows binaries for current Node versions.
2. Open this folder in **VS Code** (File → Open Folder).
3. Open the terminal: **Terminal → New Terminal**, then:

```bash
npm install
npm run dev
```

The app window opens with demo data. Close the window (or Ctrl+C) to stop.

> Your data lives in `Documents\ActivityCalendar\activity-calendar.db` — outside this
> folder, so reinstalling/updating the app never touches it.

## Test

```bash
npm test
```

Runs unit tests for the recurrence engine, time-grid math and the database layer.

## Project map

```
src/
  main/        Electron main process (window, SQLite, IPC handlers)
  preload/     Safe bridge between the app and the UI
  shared/      Types shared by both sides
  renderer/    The UI (React)
    engine/    Recurrence engine + occurrence expansion (pure, tested)
    views/     Day / Week / Month / Agenda
    components/ Title bar, sidebar, event blocks, dialogs
    state/     Zustand stores
    lib/       Time-grid math, colour helpers
    styles/    Design tokens + styles (minimal & colourful)
tests/         Unit tests (Vitest)
```

## Roadmap status

- [x] M0 — Scaffolding: app shell, traffic-light title bar, sidebar, design tokens
- [x] M1 — Data layer: SQLite, migrations, seed data, IPC CRUD
- [x] M2 — Calendar grid: Month, Week, Day, Agenda views with label colours
- [x] M3 — CRUD from every view: QuickAdd on empty slots / ＋New, full editor (title, times, label, status, notes), delete (incl. "this occurrence vs whole series" for repeats); verified by automated UI smoke test
- [x] M4 — Drag & resize: grab a block to move it (15-min snap, cross-day in Week view), drag the bottom edge to resize (min 15 min); dragging one occurrence of a repeating activity creates a one-time override that renders at the new time; click-to-edit works; Esc cancels; **no blink on drop** (the block moves in place, same DOM node); verified by a real-input UI smoke test
- [x] M5 — Recurrence editor UI: visual "Repeat" builder (None/Daily/Weekly/Monthly/Yearly, weekdays, every-N, ends never/on-date/after-N) with a live preview + plain-English summary + a warning when the series would skip the activity's own start day; Repeat is also available in QuickAdd; "Apply changes to: Whole series / This occurrence"; two explicit delete buttons ("this occurrence" / "series"); short blocks always show their title; day/week header is sticky inside the scroll area so it always aligns with the columns; verified by a 35-check real-input smoke test
- [ ] M6 — Label manager (create/edit/colour, sub-labels)
- [ ] M7 — Insights & analytics
- [ ] M8 — Polish, dark mode, backups, installer
- [ ] M9 — Google Calendar fetch (later)
- [ ] M10 — Rhythm Coins & Rewards (gamification) — planned in master-plan.md

## What already works today

- **4 views** — Day, Week, Month, Agenda — switch freely, each with its own feel
- **Recurring activities** — daily/weekly/monthly/yearly rules run in the engine (e.g. "every Mon/Wed/Fri"), skipped days + one-off edits work
- **Labels with sub-labels** — colour-coded blocks, checkbox filtering in the sidebar
- **Statuses** — To Do / In Progress / Done / Cancelled, with visual states and filter pills
- **Search** — filters blocks by title/notes
- **Demo data** — seeded relative to today, so the calendar always looks alive on first run
- **40 unit tests + automated UI smoke test** — `npm test`

## Smoke test (advanced)

```bash
AC_DATA_DIR=/tmp/smoke AC_SMOKE=/tmp/smoke-result.txt npm run dev
# or, after build: npx electron . --no-sandbox
```
The app drives itself: opens QuickAdd, adds an activity, edits its status, deletes it,
and reports PASS/FAIL per step to the given file.
