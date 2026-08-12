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
- [x] M5 — Recurrence editor UI: visual "Repeat" builder (None/Daily/Weekly/Monthly/Yearly, weekdays, every-N, ends never/on-date/after-N) with a live preview (year shown for yearly) + plain-English summary + a warning when the series would skip the activity's own start day; Repeat is also available in QuickAdd; "Apply changes to" bar sits at the top of the editor with **This occurrence** first; context-aware delete buttons — "Delete this occurrence" / "Delete upcoming" (this + all future, keeps the past) / "Delete series"; **toasts with Undo** for every delete and info messages for add/save/move; short blocks always show their title; day/week header is sticky inside the scroll area so it always aligns with the columns; overlapping blocks split side-by-side **only within their own overlap cluster** (standalone blocks keep full width); sidebar mini-calendar has a custom month/year selector (no dropdown); verified by a 53-check real-input smoke test
- [x] M6 — Label manager (sidebar): create labels & **sub-labels**, inline rename (pencil / double-click), colour palette popover on the colour dot (sub-labels can **inherit** the parent colour), duplicate-name guard, two-step delete (arm → confirm) with **full Undo** (restores label + sub-labels + re-attaches events), and **hover-reveal filter checks** — the tick is hidden until the cursor is over the row; filtered labels stay visibly marked; verified by smoke test (73 checks)
- [ ] M6 — Label manager (create/edit/colour, sub-labels)
- [x] M7 — Insights & analytics: **dice-rolling KPI cards** (5s cascade right→left; resets to Planned/Achieved on period change; streak skips empty days; best streak persisted; first completion); sticky period selector (+ Custom range defaulting today) & chips; digest 2-col with **highest-part breakdown ("mostly …")**; donut & completion drill-down incl. **own (no sub-label) part**, **auto-expanded when a single label is focused**; planned-vs-done, hour/weekday, 16-week heatmap; chrome animates away; end-after-start validation; series split + Undo; status changes never vanish blocks; **multi-day events fully fixed: drag/resize relative to the grabbed day (day-2 chunk drag keeps the whole span; BOTH chunks visible mid-drag), day-clamped overlap layout, per-day hour split, edit-panel trimming works**; repeat "None" is crash-proof (no dup summary); verified by smoke test (192 checks); premium ✦ Insights heading with shining blue border; Agenda rows show the event date, multi-day label + 2-decimal extra-day indicator, events appear in every day they touch, heading bleed fixed
- [ ] M8 — Polish, dark mode, backups, installer
- [ ] M9 — Google Calendar fetch (later)
- [x] M10.1 — Rhythm Coins core: score prompt ("How did it go?" On time/Late/Off schedule × multipliers), ledger (balance always derived), sidebar 🪙 chip, never-stuck prompt; **coin correctness: scores attach to the FINAL row (override id), re-save updates the override in place (no duplicates, no double earn), idempotent scoring IPC (same key earns once), status→not-done refunds but KEEPS the score (re-done restores coins silently — no prompt, no false toast), delete refunds only LIVE earns (marked refunded — no double refund), undo-delete restores event + real coin amounts**; full M10 design in master-plan §13
- [x] M10.2 — Streaks & bonuses + Coins view: daily check-in 🔥 (+10, ×2 on 7-day streaks, once/day, startup toast), "all planned done" (+25, once/day), **perfect week (+100, once/week — rest days OK, a day is only missed when you had plans and did nothing; auto-checked at startup and after every done-save so the credit is never missed)**; Coins view (🪙 tab: total balance, **local-date "earned today" (UTC-fix)**, 7-day chart that stretches to the box, earned-by-label, ledger) with animated chrome removal + golden heading; pure engine unit-tested
- [x] M10.3 — Milestones & celebration: milestone CRUD (name/icon/cost/notes), live progress ring in the sidebar (nearest milestone), Coins-view panel with progress bars + Claim, **confetti celebration overlay** on claim, spend logged to the ledger, achieved state persists; **M10 gamification complete** 🎉

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
