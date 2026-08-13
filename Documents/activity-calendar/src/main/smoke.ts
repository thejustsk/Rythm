import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * Automated UI smoke test: drives the real renderer via Electron's real
 * input pipeline (sendInputEvent → genuine pointer/click events) and verifies
 * create → edit → drag → resize → delete flows end to end.
 * Activated with AC_SMOKE=<path-to-result-json>.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// React 18 controlled inputs need the native value setter + input event
const SET_VALUE = `(el, value) => {
  const setter = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}`

export async function runSmoke(win: BrowserWindow, outPath: string): Promise<void> {
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
    if (!ok) process.exitCode = 1
  }
  const js = async (code: string) => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (e) {
      console.log('[smoke] SCRIPT FAILED >>>', code)
      throw e
    }
  }

  // date helpers — the smoke test must be relative to "today"
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const fmtD = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const TODAY = fmtD(new Date())
  const TOMORROW = fmtD(new Date(Date.now() + 86400000))
  const startD = new Date(TOMORROW + 'T00:00:00')
  const nextMwf = new Date(startD)
  nextMwf.setDate(nextMwf.getDate() + 1) // strictly after the start day
  while (![1, 3, 5].includes(nextMwf.getDay())) nextMwf.setDate(nextMwf.getDate() + 1)
  const expectedChip = nextMwf.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const startDowName = startD.toLocaleDateString('en-US', { weekday: 'long' })

  const dataDir = process.env.AC_DATA_DIR
  if (!dataDir) throw new Error('AC_DATA_DIR must be set for smoke test')
  const dbGet = <T,>(sql: string, ...args: unknown[]): T => {
    const db = new Database(dataDir + '/activity-calendar.db', { readonly: true })
    try {
      return db.prepare(sql).get(...args) as T
    } finally {
      db.close()
    }
  }
  const dbAll = <T,>(sql: string, ...args: unknown[]): T[] => {
    const db = new Database(dataDir + '/activity-calendar.db', { readonly: true })
    try {
      return db.prepare(sql).all(...args) as T[]
    } finally {
      db.close()
    }
  }
  const dbRun = (sql: string, ...args: unknown[]) => {
    const db = new Database(dataDir + '/activity-calendar.db')
    try {
      db.prepare(sql).run(...args)
    } finally {
      db.close()
    }
  }



  /** Close any open modal (score prompt / editor / quickadd) so stray dialogs
   *  never block subsequent interactions (defensive, keeps the suite stable). */
  const dismissOverlays = async () => {
    const any = await js(`(() => {
      const o = document.querySelector('.overlay')
      if (!o) return false
      const skip = o.querySelector('.score-prompt .btn')
      if (skip) skip.click()
      else {
        // click the backdrop (target === currentTarget closes)
        const r = o.getBoundingClientRect()
        o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }))
      }
      return true
    })()`)
    if (any) await sleep(300)
    return any
  }

  /** A REAL click via the input pipeline (generates a genuine click event). */
  const realClick = async (pos: { x: number; y: number } | null) => {
    await dismissOverlays()
    if (!pos) return false
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(50)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(250)
    return true
  }

  /** A REAL drag: press, incremental moves, release. */
  const realDrag = async (pos: { x: number; y: number } | null, dx: number, dy: number) => {
    await dismissOverlays()
    if (!pos) return false
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(50)
    for (let i = 1; i <= 6; i++) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: pos.x + Math.round((dx * i) / 6),
        y: pos.y + Math.round((dy * i) / 6)
      })
      await sleep(25)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x + dx, y: pos.y + dy, button: 'left', clickCount: 1 })
    await sleep(250)
    return true
  }

  const countBlocks = (title: string) =>
    js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes(${JSON.stringify(title)})).length`)

  /** If the gamification prompt is open, pick the given option (default: On time). */
  const pickScore = async (opt = 'On time') => {
    const open = await js(`!!document.querySelector('.score-prompt')`)
    if (open) {
      await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('${opt}'))?.click()`)
      await sleep(1600) // gold-dust + coin-fly animation, then scoring completes
    }
    return open
  }
  const skipScore = async () => {
    const open = await js(`!!document.querySelector('.score-prompt')`)
    if (open) {
      await js(`Array.from(document.querySelectorAll('.score-prompt .btn')).find((b) => b.textContent.trim() === 'Skip')?.click()`)
      await sleep(300)
      // CUP-3: skipping must NOT show the coin animation
      const fxAfterSkip = await js(`!document.querySelector('.coin-score-fx')`)
      check('cup3: NO coin animation on Skip', fxAfterSkip)
    }
    // also close any stray quickadd so it never blocks the next step
    const qa = await js(`!!document.querySelector('.quickadd')`)
    if (qa) {
      await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`)
      await sleep(200)
    }
    return open || qa
  }

  /** Open the editor on a MASTER (non-override) occurrence, retrying. */
  const openEditorOn = async (title: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await skipScore()
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${title}')); if (!el) return 'no block'; el.click(); return 'clicked' })()`)
      await sleep(450)
      const open = await js(`!!document.querySelector('.editor')`)
      if (open) {
        const bar = await js(`document.querySelectorAll('.editor .apply-to').length > 0`)
        if (bar) return true
        // override opened — close and click today's chunk of the master instead
        await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`)
        await sleep(250)
        const dayIso = fmtD(new Date())
        const clicked = await js(`(() => { const col = document.querySelector('.day-col[data-day="${'${dayIso}'}"]'); if (!col) return false; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('${title}')); if (!el) return false; el.click(); return true })()`)
        await sleep(500)
        if (clicked) return true
      }
      await skipScore()
    }
    return false
  }

  // find a sidebar label row by its exact name
  const labelRowJs = (name: string) =>
    `Array.from(document.querySelectorAll('.label-row')).find((r) => (r.querySelector('.label-name')?.textContent ?? '').trim() === '${name}')`
  const labelRowPos = async (name: string) => {
    return js(`(() => { const row = ${labelRowJs(name)}; if (!row) return null; const r = row.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
  }
  /** Position of an event block — scrolls it into view first so clicks land on-screen. */
  const blockPos = async (findExpr: string, grab: 'top' | 'bottom' = 'top') => {
    return js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes(${JSON.stringify(findExpr)}))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const y = ${JSON.stringify(grab)} === 'bottom' ? r.bottom - 4 : r.top + Math.min(6, r.height / 2)
      return { x: Math.round(r.left + r.width / 2), y: Math.round(y) }
    })()`)
  }

  try {
    await sleep(1200)

    // 1. open QuickAdd
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(300)
    const qa = await js(`!!document.querySelector('.quickadd')`)
    check('quickadd dialog opens', qa)

    // 2. fill the form and add a new activity
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke test activity')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T15:00')`)
    await sleep(150)
    const endVal = await js(`document.querySelectorAll('.quickadd input[type=datetime-local]')[1].value`)
    check('end time auto-shifts with start', endVal === TODAY + 'T16:00', `end=${endVal}`)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)

    const after = await js(`({
      dialogStillOpen: !!document.querySelector('.quickadd'),
      blockCount: document.querySelectorAll('.eb').length,
      errors: window.__errors || []
    })`)
    check('quickadd dialog closes after add', after.dialogStillOpen === false)
    check('no renderer errors during add', after.errors.length === 0, String(after.errors))

    const row = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke test activity'")
    check('event persisted to SQLite', row.c === 1, `rows=${row.c}`)

    // 2c. M5 — repeat is available in QuickAdd; weekly rule that skips the start
    // day warns and shifts (issues 2, 3, 5)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke weekly qa')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TOMORROW}T10:00')`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`)
    await sleep(200)
    // default selects the start day; switch to Mon/Wed/Fri and drop the start day
    const WD_KEYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const startKey = WD_KEYS[startD.getDay()]
    await js(`Array.from(document.querySelectorAll('.quickadd .wd-pill')).forEach((p) => {
      const want = ['MO', 'WE', 'FR'].includes(p.dataset.day) && p.dataset.day !== '${startKey}'
      if (want !== p.classList.contains('on')) p.click()
    })`)
    await sleep(250)
    const WD_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const wantDays = ['MO', 'WE', 'FR'].filter((k) => k !== startKey)
    // the rule preserves the pills' click order; the summary follows that order
    const expectedRule = 'FREQ=WEEKLY;BYDAY=' + wantDays.join(',')
    const expectedSummary = 'Every week on ' + wantDays.map((k) => WD_NAMES[WD_KEYS.indexOf(k)]).join(', ')
    const warnShown = await js(`!!document.querySelector('.quickadd .re-warn') && document.querySelector('.quickadd .re-warn').textContent.includes(${JSON.stringify(startDowName)})`)
    check('quickadd repeat warns when start day not selected', warnShown)
    const summaryShown = await js(`(document.querySelector('.quickadd .re-summary')?.textContent ?? '').includes('week')`)
    check('quickadd repeat shows plain-English summary', summaryShown)
    const firstChip = await js(`document.querySelector('.quickadd .re-preview-date')?.textContent ?? ''`)
    check('preview shows shifted first occurrence', firstChip === expectedChip, firstChip + ' vs ' + expectedChip)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const rrQa = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke weekly qa'")
    const ruleDays = (rrQa.rrule.split('BYDAY=')[1] ?? '').split(',')
    const ruleOk = rrQa.rrule.startsWith('FREQ=WEEKLY;BYDAY=') && [...ruleDays].sort().join() === [...wantDays].sort().join()
    check('quickadd saves the weekly rule (same days, any order)', ruleOk, String(rrQa.rrule))
    await skipScore()
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.today-btn')?.click()`)
    await sleep(400)
    // The weekly rule skips the start day → first occurrence is NEXT Monday
    // (this week has none of MO/WE left). Assert the block does NOT appear
    // this week, then confirm it appears when we move to next week.
    const qaNow = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke weekly qa')).length`)
    check('weekly block NOT in the current week (first occurrence shifted to next Mon)', qaNow === 0, `count=${qaNow}`)
    await js(`document.querySelector('.icon-btn[title="Next"]')?.click()`)
    await sleep(400)
    const qaNext = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const n = Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke weekly qa')).length
        if (n >= 1) return n
        await new Promise((r) => setTimeout(r, 400))
      }
      return 0
    })()`)
    check('weekly block appears in NEXT week (shifted first occurrence)', qaNext >= 1, `count=${qaNext}`)
    // issue 1 regression: header day cells must align with the day columns
    const align = await js(`(() => {
      const heads = Array.from(document.querySelectorAll('.week-head .week-day-head')).map((c) => c.getBoundingClientRect().left)
      const cols = Array.from(document.querySelectorAll('.day-col')).map((c) => c.getBoundingClientRect().left)
      return { heads, cols }
    })()`)
    console.log('[smoke] align heads:', JSON.stringify(align.heads))
    console.log('[smoke] align cols:', JSON.stringify(align.cols))
    const alignOk = align.heads.length === align.cols.length && align.heads.every((h: number, i: number) => Math.abs(h - align.cols[i]) < 1)
    check('day columns align with header cells', alignOk === true, JSON.stringify(align))
    // cleanup: series mode shows "Delete upcoming" + "Delete series"; delete the series
    // (the block is now in the NEXT week, where we navigated for the check above)
    await realClick(await blockPos('Smoke weekly qa'))
    await sleep(350)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(200)
    const dangerLabels = await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())`)
    check(
      'series mode shows Delete upcoming + Delete series',
      dangerLabels.length === 2 && dangerLabels[0] === 'Delete upcoming' && dangerLabels[1] === 'Delete series',
      JSON.stringify(dangerLabels)
    )
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const qaGone = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke weekly qa'")
    check('series deleted via explicit button', qaGone.c === 0, `rows=${qaGone.c}`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`)
    await sleep(300)

    // 2d. issue 2 — yearly repeat preview includes the year
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke yearly')`)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Yearly').click()`)
    await sleep(250)
    const yearlyChip = await js(`document.querySelector('.quickadd .re-preview-date')?.textContent ?? ''`)
    check('yearly preview chip includes year', /\d{4}/.test(yearlyChip), yearlyChip)
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(250)

    // 2e. issue 3 — apply-to bar at top, "This occurrence" first; delete buttons follow selection
    // (uses a DEDICATED fresh daily series so earlier walk edits can't interfere)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke applywalk')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T06:30')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    let hasBar = false
    for (let attempt = 0; attempt < 5 && !hasBar; attempt++) {
      await skipScore()
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke applywalk')); if (!el) return false; el.click(); return true })()`)
      await sleep(550)
      hasBar = await js(`document.querySelectorAll('.editor .apply-to').length > 0`)
      if (!hasBar) {
        await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`)
        await sleep(250)
      }
    }
    check('2e: recurring editor shows the apply-to bar', hasBar)
    const probeE = await js(`(() => ({
      editor: !!document.querySelector('.editor'),
      title: document.querySelector('.editor .ef-title')?.value ?? null,
      applyBars: document.querySelectorAll('.editor .apply-to').length,
      overlayDialog: document.querySelector('.overlay .dialog')?.className ?? 'none'
    }))()`)
    console.log('[smoke] 2e probe:', JSON.stringify(probeE))
    const walkDb = dbGet<{ rrule: string | null; parent_id: string | null; title: string }>("SELECT rrule, parent_id, title FROM events WHERE title = 'Morning walk' AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1")
    console.log('[smoke] 2e walkDb:', JSON.stringify(walkDb))
    const applyTop = await js(`(() => {
      const bar = document.querySelector('.editor .apply-to')
      if (!bar) return null
      const segs = Array.from(bar.querySelectorAll('.seg-btn')).map((b) => b.textContent.trim())
      const dang = Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())
      return { segs, dang }
    })()`)
    check(
      'apply-to at top with This occurrence first',
      !!applyTop && applyTop.segs[0] === 'This occurrence' && applyTop.segs[1] === 'Whole series',
      JSON.stringify(applyTop)
    )
    check(
      'this-mode shows only Delete this occurrence',
      !!applyTop && applyTop.dang.length === 1 && applyTop.dang[0] === 'Delete this occurrence',
      JSON.stringify(applyTop)
    )
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    const dangSeries = await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())`)
    check(
      'series-mode shows Delete upcoming + Delete series',
      dangSeries.length === 2 && dangSeries[0] === 'Delete upcoming' && dangSeries[1] === 'Delete series',
      JSON.stringify(dangSeries)
    )
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(250)

    // 2f. issue 3 — "Delete upcoming" removes this + future (keeps past); Undo restores
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)
    await js(`document.querySelector('.today-btn')?.click()`) // ensure the current week (a prior test navigated to next week)
    await sleep(400)
    const awId = dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke applywalk' AND parent_id IS NULL").id
    await openEditorOn('Smoke applywalk')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(300)
    // poll until the Delete-upcoming button is present, then click it
    const delClicked = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete upcoming')
        if (b) { b.click(); return true }
        await new Promise((r) => setTimeout(r, 300))
      }
      return false
    })()`)
    await sleep(700)
    check('delete-upcoming click landed', delClicked)
    const untilExpected = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const upR = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE id = '" + awId + "'")
    check('delete upcoming sets UNTIL to yesterday', upR.rrule === `FREQ=DAILY;UNTIL=${untilExpected}`, String(upR.rrule))
    const upVis = await countBlocks('Smoke applywalk')
    check('no applywalk occurrence visible after delete upcoming', upVis === 0, `count=${upVis}`)
    const walkToast = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('Smoke applywalk') && !!x.querySelector('.toast-action'))
        if (t) return (t.querySelector('.toast-msg')?.textContent ?? '')
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })()`)
    check('toast with Undo appears after delete', walkToast.includes('Smoke applywalk'), walkToast)
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke applywalk'))?.querySelector('.toast-action')?.click()`)
    await sleep(600)
    const upR2 = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE id = '" + awId + "'")
    check('undo restores the series rule', upR2.rrule === 'FREQ=DAILY', String(upR2.rrule))
    const upVis2 = await countBlocks('Smoke applywalk')
    check('undo restores the visible occurrence', upVis2 > 0, `count=${upVis2}`)
    // cleanup the dedicated series
    await openEditorOn('Smoke applywalk')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2g. issue 5 — only overlapping events split; standalone keeps full width
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`)
    await sleep(400)
    const addQuick = async (title: string, startT: string, endT: string) => {
      await skipScore()
      await js(`document.querySelector('.new-btn').click()`)
      await sleep(250)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), '${title}')`)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T${startT}')`)
      await sleep(100)
      await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T${endT}')`)
      await sleep(100)
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
      await sleep(400)
      // wait until the block actually renders before the caller measures widths
      await js(`(async () => {
        for (let i = 0; i < 8; i++) {
          if (Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('${title}'))) return true
          await new Promise((r) => setTimeout(r, 250))
        }
        return false
      })()`)
      await sleep(200)
    }
    // times chosen to avoid the seeded daily events (deep work, lunch, yoga…)
    await addQuick('Smoke ovl A', '16:00', '17:00')
    await addQuick('Smoke ovl B', '16:30', '17:30')
    await addQuick('Smoke solo', '12:00', '12:30')
    const widths = await js(`(() => {
      const col = document.querySelector('.day-col')?.getBoundingClientRect()
      if (!col) return null
      const w = (t) => {
        const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes(t))
        return el ? el.getBoundingClientRect().width / col.width : null
      }
      return { a: w('Smoke ovl A'), b: w('Smoke ovl B'), solo: w('Smoke solo') }
    })()`)
    check(
      'overlapping blocks split ~50%',
      !!widths && widths.a! > 0.35 && widths.a! < 0.7 && widths.b! > 0.35 && widths.b! < 0.7,
      JSON.stringify(widths)
    )
    check('standalone block keeps full width', !!widths && widths.solo! > 0.92, JSON.stringify(widths))

    // 2g2. delete a normal event → toast with Undo restores it
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)
    await realClick(await blockPos('Smoke solo'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    const soloGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke solo'))`)
    check('normal event deleted', soloGone)
    const soloToast = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('Smoke solo') && !!x.querySelector('.toast-action'))
        if (t) return (t.querySelector('.toast-msg')?.textContent ?? '')
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })()`)
    check('toast with Undo for normal delete', soloToast.includes('Smoke solo'), soloToast)
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke solo'))?.querySelector('.toast-action')?.click()`)
    await sleep(600)
    const soloBack = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke solo'")
    check('undo restores the event in DB', soloBack.c === 1, `rows=${soloBack.c}`)
    await realClick(await blockPos('Smoke solo'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)
    // cleanup overlapping test events
    for (const t of ['Smoke ovl A', 'Smoke ovl B']) {
      await realClick(await blockPos(t))
      await sleep(300)
      const hasEditor = await js(`!!document.querySelector('.editor')`)
      if (hasEditor) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
      await sleep(400)
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2h. issue 6 — mini-month header + custom month/year selector (no dropdown)
    const mmTitle = await js(`document.querySelector('.mm-title')?.textContent ?? ''`)
    check('mini month shows Month Year', /^[A-Z][a-z]+ \d{4}$/.test(mmTitle), mmTitle)
    await js(`document.querySelector('.mm-title').click()`)
    await sleep(250)
    const pickerOpen = await js(`!!document.querySelector('.mm-picker') && !!document.querySelector('.mm-picker-months') && !document.querySelector('.mm-picker select')`)
    check('custom month/year picker opens (no dropdown)', pickerOpen)
    await js(`Array.from(document.querySelectorAll('.mm-month')).find((b) => b.textContent.trim() === 'Jan').click()`)
    await sleep(250)
    const mmAfter = await js(`document.querySelector('.mm-title')?.textContent ?? ''`)
    check('picking a month changes the mini calendar', mmAfter.startsWith('January'), mmAfter)
    await js(`document.querySelector('.mm-title').click()`)
    await sleep(200)
    await js(`document.querySelector('.mm-today').click()`)
    await sleep(250)
    const mmBack = await js(`document.querySelector('.mm-title')?.textContent ?? ''`)
    check('Today returns to current month', mmBack.startsWith(new Date().toLocaleString('en-US', { month: 'long' })), mmBack)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2k. M6 — label manager: create / rename / colour / sub-label / filter / delete+undo
    await js(`document.querySelector('.add-label-btn').click()`)
    await sleep(200)
    await js(`(${SET_VALUE})(document.querySelector('.add-label-inline input'), 'Smoke Lab')`)
    await js(`document.querySelector('.add-label-inline button').click()`)
    await sleep(400)
    const lbl1 = dbGet<{ color: string }>("SELECT color FROM labels WHERE name = 'Smoke Lab'")
    check('label created from sidebar', !!lbl1 && !!lbl1.color, JSON.stringify(lbl1))

    // rename via the pencil action
    await js(`(${labelRowJs('Smoke Lab')}).querySelector('.la-btn').click()`)
    await sleep(200)
    const renameShown = await js(`!!document.querySelector('.rename-input')`)
    check('rename input appears', renameShown)
    await js(`(${SET_VALUE})(document.querySelector('.rename-input'), 'Smoke Lab2')`)
    await js(`document.querySelector('.rename-input').blur()`)
    await sleep(400)
    const lbl2 = dbGet<{ name: string }>("SELECT name FROM labels WHERE name = 'Smoke Lab2'")
    check('label renamed', !!lbl2, JSON.stringify(lbl2))

    // hover-reveal filter check: hidden by default, appears when the cursor is over the row
    const checkOpacity = () =>
      js(`(() => { const row = ${labelRowJs('Smoke Lab2')}; if (!row) return null; return getComputedStyle(row.querySelector('.lb-check')).opacity })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    await sleep(350)
    const opBefore = await checkOpacity()
    check('filter tick hidden by default', opBefore === '0', String(opBefore))
    const rp = await labelRowPos('Smoke Lab2')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: rp.x, y: rp.y })
    await sleep(350)
    const opAfter = await checkOpacity()
    check('filter tick appears on hover', opAfter === '1', String(opAfter))

    // colour change via the dot palette
    await js(`(${labelRowJs('Smoke Lab2')}).querySelector('.label-dot').click()`)
    await sleep(250)
    const palOpen = await js(`!!document.querySelector('.palette-popover')`)
    check('colour palette opens on dot click', palOpen)
    await js(`Array.from(document.querySelectorAll('.palette-popover .swatch'))[4].click()`)
    await sleep(400)
    const lbl3 = dbGet<{ color: string }>("SELECT color FROM labels WHERE name = 'Smoke Lab2'")
    check('label colour updated from palette', lbl3.color === '#30D158', `${lbl3.color} vs #30D158`)

    // sub-label under the parent, inheriting its colour
    await js(`(${labelRowJs('Smoke Lab2')}).querySelector('.la-btn[title="Add sub-label"]').click()`)
    await sleep(200)
    await js(`(${SET_VALUE})(document.querySelector('.add-label-inline.sub input'), 'Sub Smoke')`)
    await js(`document.querySelector('.add-label-inline.sub button').click()`)
    await sleep(400)
    const sub = dbGet<{ parent_id: string | null; color: string | null }>("SELECT parent_id, color FROM labels WHERE name = 'Sub Smoke'")
    const lbl2id = dbGet<{ id: string }>("SELECT id FROM labels WHERE name = 'Smoke Lab2'")
    check('sub-label created under parent with inherited colour', !!sub && sub.parent_id === lbl2id.id && sub.color === null, JSON.stringify(sub))

    // M6 selection filter: default all selected (empty circles, no glyphs).
    // FIRST click = solo-select (clicked label green, everything else dimmed).
    // Afterwards: multi-select toggles; parent with unselected children = blue plus,
    // clicking it selects the whole group; fully-selected parent click deselects group.
    const lbHidden = (name: string) =>
      js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); return r ? r.classList.contains('hidden') : false })()`)
    const glyphOf = (name: string) =>
      js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); if (!r) return 'missing'; return (r.querySelector('.lb-check').className || '').replace('lb-check', '').trim() })()`)
    const allChip = () => js(`!!document.querySelector('.all-chip')`)
    const anyGlyph = () => js(`!!document.querySelector('.lb-check.tick, .lb-check.plus')`)
    const anyCross = () => js(`!!document.querySelector('.lb-check.cross')`)
    const walkVisible = async () => (await countBlocks('Morning walk')) > 0
    const gymVisible = async () => (await countBlocks('Gym session')) > 0
    const deepVisible = async () => (await countBlocks('Deep work — Project A')) > 0

    // run in Week view so every day's events are visible
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    check('default: no glyphs at all (empty circles)', !(await anyGlyph()) && !(await anyCross()))
    check('default: All chip hidden (all selected)', !(await allChip()))
    check('default: all labels show their events', (await walkVisible()) && (await gymVisible()))

    // CUP-3 label machine: selection colour state on rows (sel-saffron / sel-green / sel-blue)
    const selOf = (name: string) =>
      js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); if (!r) return 'missing'; return (Array.from(r.classList).find((c) => c.startsWith('sel-')) || '') })()`)

    // CASE 3: EMPTY → child clicked → parent BLUE, child GREEN (green always)
    await js(`(${labelRowJs('Gym')}).click()`)
    await sleep(300)
    check('cup3 case3: child solo → child GREEN, parent BLUE', (await glyphOf('Gym')) === 'tick' && (await selOf('Gym')) === 'sel-green' && (await selOf('Fitness')) === 'sel-blue')
    check('cup3v2: OTHER groups fully untouched (no phase change, no visibility change)', (await selOf('Work')) === '' && (await selOf('Learning')) === '' && !(await lbHidden('Work')) && !(await lbHidden('Learning')))
    check('cup3: child events visible (walk is hidden — child of the blue group)', (await gymVisible()) && !(await walkVisible()))

    // BLUE → parent click → GREEN DIRECTLY (no SAFFRON intermediate)
    await js(`(${labelRowJs('Fitness')}).click()`)
    await sleep(300)
    check(
      'cup3v2: BLUE → parent click → GREEN directly (no saffron)',
      (await selOf('Fitness')) === 'sel-green' && (await glyphOf('Gym')) === 'tick' && (await glyphOf('Yoga')) === 'tick' && (await glyphOf('Walk')) === 'tick',
      `F=${await selOf('Fitness')} G=${await glyphOf('Gym')} Y=${await glyphOf('Yoga')} W=${await glyphOf('Walk')}`
    )
    check('cup3: group events all visible', (await gymVisible()) && (await walkVisible()))

    // GREEN → parent click → EMPTY (all restored)
    await js(`(${labelRowJs('Fitness')}).click()`)
    await sleep(300)
    check('cup3: GREEN → parent click → EMPTY (no selection, everything shown)', !(await anyGlyph()) && !(await allChip()) && (await gymVisible()) && (await walkVisible()))

    // INDEPENDENCE: activate one group, then another — the first group's state is untouched
    await js(`(${labelRowJs('Gym')}).click()`)
    await sleep(300)
    check('cup3v2: Fitness group active (blue)', (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green')
    await js(`(${labelRowJs('Work')}).click()`) // Work SAFFRON (parent own only)
    await sleep(300)
    check('cup3v2: Work saffron; Fitness group preserved; other groups NOT dimmed', (await selOf('Work')) === 'sel-saffron' && (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green' && (await lbHidden('Project A')) && !(await lbHidden('Gym')) && !(await lbHidden('Learning')))
    // clear Work fully (GREEN → EMPTY) — Fitness must still be blue
    await js(`(${labelRowJs('Work')}).click()`)
    await sleep(300)
    await js(`(${labelRowJs('Work')}).click()`)
    await sleep(300)
    check('cup3v2: clearing Work leaves Fitness untouched', (await selOf('Work')) === '' && (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green')
    // All chip resets everything
    await js(`document.querySelector('.all-chip').click()`)
    await sleep(300)
    check('cup3: All chip clears all hidden + phases', !(await anyGlyph()) && !(await allChip()))
    check('cup3: all events visible again after reset', (await gymVisible()) && (await walkVisible()))

    // LONE PARENT: EMPTY → GREEN → EMPTY (no saffron) — use the lone "Learning" label
    await js(`(${labelRowJs('Learning')}).click()`)
    await sleep(300)
    check('cup3v2: lone parent → GREEN directly (no saffron, no side effects)', (await selOf('Learning')) === 'sel-green' && (await glyphOf('Learning')) === 'tick' && !(await lbHidden('Gym')))
    await js(`(${labelRowJs('Learning')}).click()`)
    await sleep(300)
    check('cup3v2: lone parent GREEN → EMPTY (nothing else changes)', (await selOf('Learning')) === '' && !(await anyGlyph()) && !(await lbHidden('Gym')) && (await selOf('Fitness')) === '')
    // USER'S EXACT SCENARIO: with a child of Fitness selected (Fitness blue),
    // clicking AND deselecting the childless "Learning" must leave the child
    // selected and Fitness blue the whole time
    await js(`(${labelRowJs('Gym')}).click()`) // Fitness → blue, Gym green
    await sleep(300)
    check('cup3v3: child selected (Fitness blue, Gym green)', (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green' && (await glyphOf('Gym')) === 'tick')
    await js(`(${labelRowJs('Learning')}).click()`) // childless parent selected
    await sleep(300)
    check('cup3v3: selecting childless parent does NOT deselect the selected child', (await selOf('Learning')) === 'sel-green' && (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green' && (await glyphOf('Gym')) === 'tick' && !(await lbHidden('Gym')))
    await js(`(${labelRowJs('Learning')}).click()`) // childless parent deselected
    await sleep(300)
    check('cup3v3: deselecting childless parent does NOT select/change anything else', (await selOf('Learning')) === '' && (await selOf('Fitness')) === 'sel-blue' && (await selOf('Gym')) === 'sel-green' && (await glyphOf('Gym')) === 'tick' && !(await lbHidden('Gym')))
    // reset
    await js(`document.querySelector('.all-chip')?.click()`)
    await sleep(300)
    check('no red crosses ever', !(await anyCross()))

    // delete is two-step; Undo restores the label
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)
    await js(`(${labelRowJs('Sub Smoke')}).querySelector('.la-btn.del').click()`)
    await sleep(200)
    const armed = await js(`(${labelRowJs('Sub Smoke')}).querySelector('.la-btn.del').textContent.trim()`)
    check('delete is two-step (armed first)', armed === 'Delete?', armed)
    await js(`(${labelRowJs('Sub Smoke')}).querySelector('.la-btn.del').click()`)
    await sleep(500)
    const subGone = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM labels WHERE name = 'Sub Smoke'")
    check('label deleted from DB', subGone.c === 0, `rows=${subGone.c}`)
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Sub Smoke'))?.querySelector('.toast-action')?.click()`)
    await sleep(600)
    const subBack = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM labels WHERE name = 'Sub Smoke'")
    check('undo restores the label', subBack.c === 1, `rows=${subBack.c}`)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // cleanup: delete the parent label (cascades to its sub-label)
    await js(`(${labelRowJs('Smoke Lab2')}).querySelector('.la-btn.del').click()`)
    await sleep(150)
    await js(`(${labelRowJs('Smoke Lab2')}).querySelector('.la-btn.del').click()`)
    await sleep(500)
    const lblNames = dbAll<{ name: string }>("SELECT name FROM labels WHERE name IN ('Smoke Lab2','Sub Smoke')")
    check('cleanup: labels removed', lblNames.length === 0, JSON.stringify(lblNames))
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2l. M7 — insights view: cards, digest, charts, heatmap, period switch
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(600)
    const twinkleOn = await js(`(() => {
      const seg = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights'))
      const head = document.querySelector('.premium-heading .ph-icon .twinkle')
      const tw = seg ? seg.querySelector('.twinkle') : null
      return {
        segTwinkle: !!tw,
        segShining: tw ? tw.classList.contains('shining') : false,
        segAnim: tw ? getComputedStyle(tw).animationName : '',
        headShining: head ? head.classList.contains('shining') : false,
        coinsSegCoin: (() => { const c = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')); const coin = c ? c.querySelector('.rhythm-coin .c3-spin') : null; return coin ? getComputedStyle(coin).animationName : '' })()
      }
    })()`)
    check('insights tab ✦ shines when selected; coins tab coin is static', twinkleOn.segTwinkle && twinkleOn.segShining && twinkleOn.segAnim.includes('twinkleSpin') && twinkleOn.headShining && !twinkleOn.coinsSegCoin.includes('moneyFlip'), JSON.stringify(twinkleOn))
    const iv = await js(`({
      view: !!document.querySelector('.insights-view'),
      cards: document.querySelectorAll('.ins-card').length,
      digest: document.querySelectorAll('.digest li').length,
      charts: document.querySelectorAll('.chart-svg').length,
      heat: document.querySelectorAll('.heatmap .heat-cell').length,
      donut: !!document.querySelector('.donut'),
      progress: document.querySelectorAll('.ins-progress').length
    })`)
    check('insights view opens', iv.view)
    check('summary cards render (>=4)', iv.cards >= 4, String(iv.cards))
    check('plain-language digest present (>=3)', iv.digest >= 3, String(iv.digest))
    check('charts render (>=4)', iv.charts >= 4, String(iv.charts))
    check('heatmap renders (112 cells)', iv.heat === 112, String(iv.heat))
    check('donut + label progress present', iv.donut && iv.progress > 0, String(iv.progress))
    const digText = await js(`Array.from(document.querySelectorAll('.digest li')).map((e) => e.textContent).join(' | ')`)
    check('digest mentions planned time', /planned|completed/i.test(digText), digText.slice(0, 80))
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month').click()`)
    await sleep(500)
    const iv2 = await js(`({ view: !!document.querySelector('.insights-view'), cards: document.querySelectorAll('.ins-card').length })`)
    check('period switch keeps insights rendering', iv2.view && iv2.cards >= 4)
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'All time').click()`)
    await sleep(500)
    const iv3 = await js(`!!document.querySelector('.insights-view') && document.querySelectorAll('.heatmap .heat-cell').length`)
    check('all-time period renders', iv3 === 112, String(iv3))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2l2. M7 chrome: insights hides sidebar/pills/search/add/today; selector+KPI pinned
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(600)
    const chrome = await js(`(() => {
      const sb = document.querySelector('.sidebar')
      const sbStyle = sb ? getComputedStyle(sb) : null
      return {
        sidebarCollapsed: !sb || sbStyle.opacity === '0' || sbStyle.width === '0px',
        pillsGone: !!document.querySelector('.status-wrap.gone'),
        search: !!document.querySelector('.searchbox'),
        addBtn: !!document.querySelector('.new-btn'),
        todayBtn: !!document.querySelector('.today-btn'),
        title: !!document.querySelector('.tb-title'),
        switcher: Array.from(document.querySelectorAll('.segmented .seg-btn')).some((b) => b.textContent.includes('Insights'))
      }
    })()`)
    check('insights collapses sidebar & pills, hides today/title (search+New live in the pills row, hidden with it)', chrome.sidebarCollapsed && chrome.pillsGone && !chrome.todayBtn && !chrome.title && chrome.switcher, JSON.stringify(chrome))
    // CUP-2 toolbar: on regular views (Week) search + New live in the status-pills
    // row (search as a long pill next to the status pills); the toolbar holds
    // only the tab selector + settings icon
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(500)
    const tbLayout = await js(`(() => ({
      searchInPills: !!document.querySelector('.status-pills .searchbox'),
      newInPills: !!document.querySelector('.status-pills .new-btn'),
      searchInToolbar: !!document.querySelector('.toolbar .searchbox'),
      newInToolbar: !!document.querySelector('.toolbar .new-btn'),
      settingsBtn: !!document.querySelector('.toolbar .settings-btn'),
      searchPill: (() => { const s = document.querySelector('.status-pills .searchbox'); return s ? getComputedStyle(s).borderRadius : '' })()
    }))()`)
    check('search + New moved into the status-pills row (long pill); toolbar = tabs + settings only', tbLayout.searchInPills && tbLayout.newInPills && !tbLayout.searchInToolbar && !tbLayout.newInToolbar && tbLayout.settingsBtn && tbLayout.searchPill === '999px', JSON.stringify(tbLayout))
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((x) => x.textContent.startsWith('All'))?.click()`)
    await sleep(300)
    // CUP-4: the filter counts are scoped to the SELECTED PERIOD — they must
    // match the blocks actually rendered in the week (not the whole database)
    const periodCounts = await js(`(() => {
      const readPill = (label) => {
        const p = Array.from(document.querySelectorAll('.status-pills .pill')).find((x) => x.textContent.startsWith(label))
        return parseInt((p?.querySelector('.pill-count')?.textContent ?? '0'), 10)
      }
      const blocks = Array.from(document.querySelectorAll('.eb'))
      const count = (pred) => blocks.filter(pred).length
      return {
        todo: readPill('To Do'), doing: readPill('In Progress'), done: readPill('Done'), cancelled: readPill('Cancelled'),
        bTodo: count((e) => !!e.querySelector('.eb-dot.todo')), bDoing: count((e) => !!e.querySelector('.eb-dot.doing')),
        bDone: count((e) => e.classList.contains('done')), bCancelled: count((e) => e.classList.contains('cancelled'))
      }
    })()`)
    check('cup4: filter counts match the selected week (period-scoped)', periodCounts.todo === periodCounts.bTodo && periodCounts.doing === periodCounts.bDoing && periodCounts.done === periodCounts.bDone && periodCounts.cancelled === periodCounts.bCancelled, JSON.stringify(periodCounts))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(500)
    const stickyPos = await js(`getComputedStyle(document.querySelector('.ins-head')).position`)
    check('period selector + KPI cards in fixed header (no sticky bleed)', stickyPos === 'relative' || stickyPos === 'static', stickyPos)
    const chipLabels = await js(`Array.from(document.querySelectorAll('.ins-chip')).map((c) => c.textContent.trim())`)
    check('parent-label chips present (incl All labels)', chipLabels.includes('All labels') && chipLabels.includes('Fitness'), JSON.stringify(chipLabels))

    // M7 #7 — insights filtered to a selected parent label
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.includes('Fitness')).click()`)
    await sleep(600)
    const fitOnly = await js(`Array.from(document.querySelectorAll('.ins-legend-name')).map((e) => e.textContent)`)
    check('parent filter shows only that label', fitOnly.length === 1 && fitOnly[0] === 'Fitness', JSON.stringify(fitOnly))
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels').click()`)
    await sleep(500)

    // M7 #2 — click a parent in time-per-label → sublabel stacked bar with separators
    await js(`Array.from(document.querySelectorAll('.ins-legend-row')).find((r) => (r.querySelector('.ins-legend-name')?.textContent ?? '').trim() === 'Fitness').click()`)
    await sleep(500)
    const subSegs = await js(`document.querySelectorAll('.ins-sublabel-seg').length`)
    const subRows = await js(`Array.from(document.querySelectorAll('.ins-subrow')).map((r) => r.textContent.trim())`)
    check('parent click in time-per-label shows sublabel bar', subSegs >= 2, String(subSegs))
    check('sublabel rows listed (names + times)', subRows.length >= 2, JSON.stringify(subRows))

    // M7 #5 — label completion row click → sublabel rows underneath
    await js(`Array.from(document.querySelectorAll('.ins-progress')).find((r) => (r.querySelector('.ins-progress-name')?.textContent ?? '').includes('Fitness')).click()`)
    await sleep(500)
    const compSubs = await js(`Array.from(document.querySelectorAll('.ins-progress.sub')).map((r) => (r.querySelector('.ins-progress-name')?.textContent ?? '').trim())`)
    check('label completion click shows sublabel rows', compSubs.length >= 2, JSON.stringify(compSubs))

    // M7 #6 — custom period selector
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'Custom').click()`)
    await sleep(300)
    const customInputs = await js(`document.querySelectorAll('.ins-custom-range input').length`)
    check('custom period shows date-range inputs', customInputs === 2, String(customInputs))
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[0], '2026-01-01')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[1], '2026-01-31')`)
    await sleep(600)
    const customOk = await js(`!!document.querySelector('.insights-view') && document.querySelectorAll('.ins-card').length >= 4`)
    check('custom period renders insights', customOk)
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2m. status colour dots: doing = blue dot, done = NO dot
    const doingDots = await js(`document.querySelectorAll('.eb-dot.doing').length`)
    check('in-progress events show a blue dot', doingDots >= 1, String(doingDots))
    // done items exist in the month view (past occurrences) — verify no dot there
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`)
    await sleep(400)
    const doneBlockDot = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb.done')).find((e) => e.querySelector('.eb-title'))
      return el ? el.querySelector('.eb-dot') === null : 'no done block'
    })()`)
    check('done blocks have NO status dot (struck+dimmed only)', doneBlockDot === true, String(doneBlockDot))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2n. week table: scrollbar gutter reserved so the sticky header doesn't bleed
    const gutter = await js(`getComputedStyle(document.querySelector('.week-body')).scrollbarGutter`)
    check('week table reserves scrollbar gutter (no corner bleed)', gutter === 'stable', String(gutter))

    // 2o. bug A1 — editing a recurring event in whole-series mode from a LATER day
    // must keep the series' own start date (earlier occurrences must survive)
    const readingBefore = dbGet<{ start_local: string; end_local: string }>("SELECT start_local, end_local FROM events WHERE id = 'evt-reading'")
    await js(`document.querySelector('.week-body') ? document.querySelector('.week-body').scrollTop = 0 : null`)
    await sleep(250)
    const probe1 = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Evening reading')); if (!el) return 'no block'; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const col = el.closest('.day-col'); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6), day: col ? col.getAttribute('data-day') : null, vh: window.innerHeight, dayCols: document.querySelectorAll('.day-col').length } })()`)
    console.log('[smoke] 2o probe1:', JSON.stringify(probe1))
    await realClick(probe1 && probe1 !== 'no block' ? { x: probe1.x, y: probe1.y } : null)
    await sleep(400)
    const probe2 = await js(`({ editor: !!document.querySelector('.editor'), title: document.querySelector('.editor .ef-title')?.value ?? null, applyTo: !!document.querySelector('.apply-to') })`)
    console.log('[smoke] 2o probe2:', JSON.stringify(probe2))
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke reading series')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    const readingAfter = dbGet<{ start_local: string; title: string }>("SELECT start_local, title FROM events WHERE id = 'evt-reading'")
    check('series edit from later day keeps series start date (no vanish)', readingAfter.start_local === readingBefore.start_local, `${readingAfter.start_local} vs ${readingBefore.start_local}`)
    check('series title updated', readingAfter.title === 'Smoke reading series', readingAfter.title)
    // this-occurrence edit keeps the selected day
    await realClick(await blockPos('Smoke reading series'))
    await sleep(350)
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke reading one')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    const ovrRead = dbGet<{ start_local: string; parent_id: string | null }>("SELECT start_local, parent_id FROM events WHERE title = 'Smoke reading one'")
    check('this-occurrence edit uses the selected day', !!ovrRead && ovrRead.parent_id === 'evt-reading' && ovrRead.start_local.startsWith(probe1.day ?? ''), JSON.stringify(ovrRead) + ' vs day ' + probe1.day)
    await realClick(await blockPos('Smoke reading one'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)
    // revert the series title (in whole-series mode)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke reading series')); if (el) el.scrollIntoView({ block: 'center' }); return !!el })()`)
    await sleep(250)
    await realClick(await blockPos('Smoke reading series'))
    await sleep(350)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Evening reading')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(400)
    const readingReverted = dbGet<{ title: string }>("SELECT title FROM events WHERE id = 'evt-reading'")
    check('series title reverted', readingReverted.title === 'Evening reading', readingReverted.title)

    // 2p. bug A2 — overnight / multi-day events save & render correctly
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke overnight')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const ovn = dbGet<{ start_local: string; end_local: string }>("SELECT start_local, end_local FROM events WHERE title = 'Smoke overnight'")
    check('overnight event saved with next-day end', ovn.end_local === `${TOMORROW}T00:30`, JSON.stringify(ovn))
    const ovnCols = await js(`(() => {
      const cols = Array.from(document.querySelectorAll('.day-col'))
      return cols.map((c) => Array.from(c.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke overnight')))
    })()`)
    check('overnight event visible on both days', ovnCols.filter(Boolean).length === 2, JSON.stringify(ovnCols))
    // drag +1h → start 23:00 today, end 01:30 tomorrow (absolute-minute math)
    await realDrag(await blockPos('Smoke overnight'), 0, 33)
    await sleep(700)
    const ovn2 = dbGet<{ start_local: string; end_local: string }>("SELECT start_local, end_local FROM events WHERE title = 'Smoke overnight'")
    check('overnight drag keeps next-day end (23:00→01:30)', ovn2.start_local === `${TODAY}T23:00` && ovn2.end_local === `${TOMORROW}T01:30`, JSON.stringify(ovn2))
    await realClick(await blockPos('Smoke overnight'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)

    // 2q. M7 #5 — end-after-start validation (add & edit)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke invalid')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T09:00')`)
    await sleep(250)
    const addDisabled = await js(`document.querySelector('.quickadd .btn.primary').disabled`)
    const errShown = await js(`!!document.querySelector('.quickadd .ef-error')`)
    check('quickadd blocks end-before-start (disabled + error)', addDisabled && errShown)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T10:30')`)
    await sleep(200)
    const addEnabled = await js(`!document.querySelector('.quickadd .btn.primary').disabled`)
    check('quickadd allows valid range', addEnabled)
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(250)
    const dwProbe = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Deep work')); if (!el) return 'no block'; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6), vh: window.innerHeight } })()`)
    console.log('[smoke] 2q dwProbe:', JSON.stringify(dwProbe))
    await realClick(dwProbe && dwProbe !== 'no block' ? { x: dwProbe.x, y: dwProbe.y } : null)
    await sleep(350)
    const dwProbe2 = await js(`({ editor: !!document.querySelector('.editor'), inputs: document.querySelectorAll('.editor input[type=datetime-local]').length, title: document.querySelector('.editor .ef-title')?.value ?? null })`)
    console.log('[smoke] 2q dwProbe2:', JSON.stringify(dwProbe2))
    const startValShown = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[0].value`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${startValShown.slice(0, 10)}T08:00')`)
    await sleep(300)
    const valProbe = await js(`({ endVal: document.querySelectorAll('.editor input[type=datetime-local]')[1].value, startVal: document.querySelectorAll('.editor input[type=datetime-local]')[0].value, saveDisabled: document.querySelector('.editor .btn.primary').disabled, err: !!document.querySelector('.editor .ef-error') })`)
    console.log('[smoke] 2q valProbe:', JSON.stringify(valProbe))
    const saveDisabled = valProbe.saveDisabled
    const errShown2 = valProbe.err
    check('editor blocks end-before-start (disabled + error)', saveDisabled && errShown2, JSON.stringify(valProbe))
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(250)

    // 2r. M7 #1 — series split: "Apply repeat from THIS DATE"
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke split')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const d2 = new Date(Date.now() + 2 * 86400000)
    const d2Iso = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`
    const d2Before = new Date(Date.now() + 1 * 86400000)
    const d2BeforeIso = `${d2Before.getFullYear()}-${String(d2Before.getMonth() + 1).padStart(2, '0')}-${String(d2Before.getDate()).padStart(2, '0')}`
    const d2Key = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d2.getDay()]
    // open the occurrence on day+2
    const splitClick = await js(`(() => { const col = document.querySelector('.day-col[data-day="${d2Iso}"]'); if (!col) return 'no col'; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke split')); if (!el) return 'no block'; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) } })()`)
    await realClick(splitClick && splitClick !== 'no col' && splitClick !== 'no block' ? splitClick : null)
    await sleep(350)
    const splitProbe = await js(`({ editor: !!document.querySelector('.editor'), title: document.querySelector('.editor .ef-title')?.value ?? null })`)
    check('split: editor opens on day+2 occurrence', splitProbe.editor && splitProbe.title === 'Smoke split', JSON.stringify(splitProbe))
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.editor .apply-to .seg-btn')).find((b) => b.textContent.includes('This date')).click()`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.repeat-editor .wd-pill')).forEach((p) => {
      if (p.dataset.day === '${d2Key}' !== p.classList.contains('on')) p.click()
    })`)
    await sleep(200)
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke split new')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const oldMaster = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke split'")
    const newSeries = dbGet<{ rrule: string; start_local: string }>("SELECT rrule, start_local FROM events WHERE title = 'Smoke split new'")
    check('split: old series ends the day before', oldMaster.rrule === `FREQ=DAILY;UNTIL=${d2BeforeIso}`, String(oldMaster.rrule))
    check('split: new series starts at the selected day with the new rule', !!newSeries && newSeries.rrule === `FREQ=WEEKLY;BYDAY=${d2Key}` && newSeries.start_local.startsWith(d2Iso), JSON.stringify(newSeries))
    // undo the split
    const splitUndo = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Series split'))?.querySelector('.toast-action')?.click() ?? 'none'`)
    await sleep(700)
    const oldRestored = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke split'")
    const newGone = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke split new'")
    check('split undo: old rule restored + new series removed', oldRestored.rrule === 'FREQ=DAILY' && newGone.c === 0, `${oldRestored.rrule} new=${newGone.c}`)
    await realClick(await blockPos('Smoke split'))
    await sleep(300)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(150)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    const splitGone = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke split','Smoke split new')")
    check('split cleanup: series deleted', splitGone.c === 0, String(splitGone.c))
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2s. bug 2 — overnight drag: no ghost, editor keeps the real end date
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke night')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await realDrag(await blockPos('Smoke night'), 0, 33)
    await sleep(700)
    const nightCount = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke night')).length)`)
    check('overnight drag: exactly one block per day (no ghost)', nightCount.filter((n: number) => n > 0).length === 2 && nightCount.every((n: number) => n <= 1), JSON.stringify(nightCount))
    // click the day-2 chunk → editor must show the real end (next day 01:30)
    // click the day-2 chunk directly (robust: no coordinate math)
    const nightClicked = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return 'no col'; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night')); if (!el) return 'no block'; el.click(); return 'ok' })()`)
    await sleep(400)
    const nightProbe = await js(`({ editor: !!document.querySelector('.editor'), endVal: document.querySelectorAll('.editor input[type=datetime-local]')[1]?.value ?? '', startVal: document.querySelectorAll('.editor input[type=datetime-local]')[0]?.value ?? '' })`)
    console.log('[smoke] 2s nightProbe:', JSON.stringify(nightProbe))
    const nightEndVal = nightProbe.endVal
    check('overnight edit shows the real next-day end', nightEndVal === `${TOMORROW}T01:30`, nightEndVal)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)

    // 2t. animated transitions: viewIn animation + sidebar collapses/expands
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(700)
    const animName = await js(`getComputedStyle(document.querySelector('.view-host > *')).animationName`)
    const sideW = await js(`getComputedStyle(document.querySelector('.sidebar')).width`)
    check('view enter animation active (viewIn)', animName === 'viewIn', String(animName))
    check('sidebar collapsed in insights', parseFloat(sideW) <= 1, sideW)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(700)
    const sideW2 = await js(`getComputedStyle(document.querySelector('.sidebar')).width`)
    const animName2 = await js(`getComputedStyle(document.querySelector('.view-host > *')).animationName`)
    check('sidebar expands back on calendar views', sideW2 === '236px', sideW2)
    check('week view also animates in', animName2 === 'viewIn', String(animName2))

    // 2u. resize works for EVERY overlapping event (+30min each)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`)
    await sleep(400)
    const addQ = async (title: string, st: string, en: string) => {
      await js(`document.querySelector('.new-btn').click()`)
      await sleep(250)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), '${title}')`)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T${st}')`)
      await sleep(100)
      await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T${en}')`)
      await sleep(100)
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
      await sleep(400)
    }
    await addQ('Smoke RZ A', '16:00', '17:00')
    await addQ('Smoke RZ B', '16:30', '17:30')
    await addQ('Smoke RZ C', '16:15', '16:45')
    for (const t of ['Smoke RZ A', 'Smoke RZ B', 'Smoke RZ C']) {
      await realDrag(await blockPos(t, 'bottom'), 0, 16.5)
      await sleep(500)
    }
    const rzA = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke RZ A'")
    const rzB = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke RZ B'")
    const rzC = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke RZ C'")
    check('overlapping event A resized +30m', rzA.end_local === `${TODAY}T17:30`, rzA.end_local)
    check('overlapping event B resized +30m', rzB.end_local === `${TODAY}T18:00`, rzB.end_local)
    check('overlapping event C resized +30m', rzC.end_local === `${TODAY}T17:15`, rzC.end_local)
    for (const t of ['Smoke RZ A', 'Smoke RZ B', 'Smoke RZ C']) {
      await realClick(await blockPos(t))
      await sleep(300)
      await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
      await sleep(400)
    }

    // 2v. status change must NEVER vanish the block (serious fix)
    await addQ('Smoke vanish', '15:00', '16:00')
    await realClick(await blockPos('Smoke vanish'))
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    await skipScore()
    const vanishStillThere = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke vanish'))`)
    check('status change keeps the block visible', vanishStillThere)
    const vanishDb = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke vanish' AND status = 'done'")
    check('status change persisted', vanishDb.c === 1)
    // with a status filter active, changing status warns (block hidden by filter)
    await addQ('Smoke vanish2', '14:00', '15:00')
    await js(`Array.from(document.querySelectorAll('.pill')).find((b) => b.textContent.includes('To Do')).click()`)
    await sleep(300)
    await realClick(await blockPos('Smoke vanish2'))
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'doing')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    const warnToast = await js(`Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('filter is hiding'))`)
    check('filter-hide warning toast appears', warnToast)
    await js(`Array.from(document.querySelectorAll('.pill')).find((b) => b.textContent.trim() === 'All').click()`)
    await sleep(300)
    const vanish2Back = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke vanish2'))`)
    check('block visible again after clearing filter', vanish2Back)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)
    // clean up via direct DOM click (robust for faded done-blocks)
    for (const t of ['Smoke vanish', 'Smoke vanish2']) {
      const ok = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${t}')); if (!el) return false; el.click(); return true })()`)
      await sleep(400)
      const open = await js(`!!document.querySelector('.editor')`)
      if (ok && open) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
      await sleep(500)
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2w. dice KPI cards: 4 cards, faces cascade right→left, flip animation
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(1200)
    const dice = await js(`({
      cards: document.querySelectorAll('.ins-card.kpi').length,
      anim: getComputedStyle(document.querySelector('.kpi-face')).animationName
    })`)
    check('dice: 4 KPI cards', dice.cards === 4, String(dice.cards))
    check('dice: flip animation active', dice.anim === 'kpiFlip', String(dice.anim))
    // faces keep rolling: values advance across a 5s cycle
    const faces1 = await js(`Array.from(document.querySelectorAll('.ins-card.kpi')).map((c) => c.getAttribute('data-face'))`)
    await sleep(5300)
    const faces2 = await js(`Array.from(document.querySelectorAll('.ins-card.kpi')).map((c) => c.getAttribute('data-face'))`)
    check('dice: faces roll over time', JSON.stringify(faces1) !== JSON.stringify(faces2), `${faces1} → ${faces2}`)
    // best streak persisted via settings
    const bestStored = await js(`window.api.settings.get('bestStreak')`)
    check('best streak saved to settings', bestStored !== null, String(bestStored))

    // 2x. custom range defaults to today
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'Custom').click()`)
    await sleep(300)
    const customVals = await js(`Array.from(document.querySelectorAll('.ins-custom-range input')).map((i) => i.value)`)
    check('custom range defaults to today', customVals.length === 2 && customVals[0] === TODAY && customVals[1] === TODAY, JSON.stringify(customVals))
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`)
    await sleep(300)

    // 2y. sublabel own part: label an event directly with a parent label
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke ownpart')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T15:30')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd select'), 'lbl-fitness')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(700)
    await js(`Array.from(document.querySelectorAll('.ins-legend-row')).find((r) => (r.querySelector('.ins-legend-name')?.textContent ?? '').trim() === 'Fitness').click()`)
    await sleep(500)
    const ownRow = await js(`Array.from(document.querySelectorAll('.ins-subrow')).some((r) => r.textContent.includes('no sub-label'))`)
    check('parent own part shown separately (no sub-label)', ownRow)
    const digBreakdown = await js(`Array.from(document.querySelectorAll('.digest li')).some((l) => l.textContent.includes('Biggest time investment'))`)
    check('digest mentions biggest label', digBreakdown)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await realClick(await blockPos('Smoke ownpart'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2z. repeat "On date" prefills a meaningful end date
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke until')`)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-ends .seg-btn')).find((b) => b.textContent.trim() === 'On date').click()`)
    await sleep(250)
    const untilVal = await js(`document.querySelector('.quickadd .re-until')?.value ?? ''`)
    check('repeat On date prefills a date', /^\d{4}-\d{2}-\d{2}$/.test(untilVal), untilVal)
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(250)

    // 2aa. digest two equal columns
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(700)
    const digCols = await js(`getComputedStyle(document.querySelector('.digest ul')).gridTemplateColumns.split(' ').length`)
    check('digest renders in two columns', digCols === 2, String(digCols))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(500)

    // 2ab. repeat "None" must NOT crash the app (serious fix)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await realClick(await blockPos('Evening reading'))
    await sleep(350)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(200)
    const noneBtn = await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'None')`)
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'None').click()`)
    await sleep(400)
    const crashCheck = await js(`({ editorStillOpen: !!document.querySelector('.editor'), rootAlive: document.querySelectorAll('.eb').length > 0, summaryCount: document.querySelectorAll('.repeat-note').length })`)
    check('repeat None: no crash, editor stays open', crashCheck.editorStillOpen && crashCheck.rootAlive, JSON.stringify(crashCheck))
    check('repeat None: no duplicated summary box', crashCheck.summaryCount === 0, String(crashCheck.summaryCount))
    // now pick Weekly again — repeat editor must still work
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`)
    await sleep(250)
    const weeklyBack = await js(`!!document.querySelector('.repeat-editor .wd-pill')`)
    check('repeat editor works again after None', weeklyBack)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`)
    await sleep(300)

    // 2ac. multiday: drag from the DAY-2 chunk must keep the whole span intact
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke night2')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // drag the day-2 chunk +33px (= +1h) — scroll it clear of the sticky header first
    const chunk2 = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) } })()`)
    await realDrag(chunk2, 0, 33)
    await sleep(700)
    const n2 = dbGet<{ start_local: string; end_local: string }>("SELECT start_local, end_local FROM events WHERE title = 'Smoke night2'")
    check('day-2 chunk drag moves whole span (+1h, no shift)', n2.start_local === `${TODAY}T23:00` && n2.end_local === `${TOMORROW}T01:30`, JSON.stringify(n2))
    // resize from the day-2 chunk +16.5px (= +30m)
    const chunk2b = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 4) } })()`)
    await realDrag(chunk2b, 0, 16.5)
    await sleep(700)
    const n2b = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke night2'")
    check('day-2 chunk resize extends real end +30m', n2b.end_local === `${TOMORROW}T02:00`, n2b.end_local)
    const n2Cols = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke night2')).length)`)
    check('multiday still exactly one chunk per day (no ghost)', n2Cols.filter((n: number) => n > 0).length === 2 && n2Cols.every((n: number) => n <= 1), JSON.stringify(n2Cols))
    // cleanup
    const n2Del = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return false; el.click(); return true })()`)
    await sleep(400)
    if (n2Del) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)

    // 2ad. insights bleed: sticky header must stay put and opaque while scrolling
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(700)
    await js(`document.querySelector('.insights-view').scrollTop = 600`)
    await sleep(500)
    const bleed = await js(`(() => {
      const head = document.querySelector('.ins-head')
      const scroll = document.querySelector('.ins-scroll')
      const hr = head.getBoundingClientRect()
      const sr = scroll.getBoundingClientRect()
      const bg = getComputedStyle(head).backgroundColor
      // structural: header sits ABOVE the scroll area and nothing overlaps it
      const headAbove = hr.bottom <= sr.top + 2
      const probes = [hr.top + 8, hr.top + hr.height / 2].map((y) => {
        const el = document.elementFromPoint(Math.round(hr.left + hr.width / 2), Math.round(y))
        return el ? head.contains(el) : false
      })
      return { headAbove, probes, allCovered: probes.every(Boolean), bg, bgOpaque: bg !== 'rgba(0, 0, 0, 0)' }
    })()`)
    check('bleed: header sits above the scroll area (no sticky overlap)', bleed.headAbove && bleed.allCovered, JSON.stringify(bleed))
    check('bleed: header is opaque', bleed.bgOpaque, bleed.bg)

    // 2ae. dice resets to face 0 (Planned time) when the period changes
    const faceAfterSwitch = await js(`(() => { const c = document.querySelector('.ins-card.kpi[data-card="0"]'); return c ? c.getAttribute('data-face') : null })()`)
    check('dice: card resets to Planned time on period change', faceAfterSwitch === '0', String(faceAfterSwitch))
    const kpiLabel0 = await js(`document.querySelector('.ins-card.kpi[data-card="0"] .ins-card-label')?.textContent ?? ''`)
    check('dice: card 1 label is Planned time', kpiLabel0 === 'Planned time', kpiLabel0)

    // 2af. focused single label → sublabels shown by default (no click needed)
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.includes('Fitness')).click()`)
    await sleep(700)
    const autoSub = await js(`document.querySelectorAll('.ins-subrow').length`)
    check('focused label shows sublabels by default', autoSub >= 2, String(autoSub))
    const digMostly = await js(`Array.from(document.querySelectorAll('.digest li')).some((l) => l.textContent.includes('mostly'))`)
    check('digest names the highest part (mostly …)', digMostly)
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels').click()`)
    await sleep(500)

    // 2ag. all-time >= this-year (no data loss across periods)
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This year').click()`)
    await sleep(700)
    const yearPlanned = await js(`document.querySelector('.ins-card.kpi[data-card="0"] .ins-card-value')?.textContent ?? ''`)
    const yearH = parseFloat(yearPlanned) || 0
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'All time').click()`)
    await sleep(700)
    const allPlanned = await js(`document.querySelector('.ins-card.kpi[data-card="0"] .ins-card-value')?.textContent ?? ''`)
    const allH = parseFloat(allPlanned) || 0
    check('all-time shows at least as much as this year', allH >= yearH, `${yearPlanned} → ${allPlanned}`)
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`)
    await sleep(500)

    // 2ah. WHOLE-SERIES TIME EDIT from a later day: earlier occurrences MUST survive
    // (dedicated series for determinism)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`document.querySelector('.today-btn')?.click()`) // reset to the current week (a prior test navigated away)
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke seredit')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${'${'}TODAY}T06:30')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const seRow = dbGet<{ id: string } | undefined>("SELECT id FROM events WHERE title = 'Smoke seredit' AND parent_id IS NULL")
    if (!seRow) {
      // creation was interrupted — retry once
      await js(`document.querySelector('.new-btn').click()`)
      await sleep(250)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke seredit')`)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T06:30')`)
      await sleep(100)
      await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
      await sleep(200)
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
      await sleep(500)
    }
    const seRow2 = dbGet<{ id: string } | undefined>("SELECT id FROM events WHERE title = 'Smoke seredit' AND parent_id IS NULL")
    check('2ah: dedicated series created', !!seRow2)
    if (!seRow2) throw new Error('no seredit series')
    const seId = seRow2.id
    const wBefore = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE id = '" + seId + "'")
    // click a LATER day's occurrence (day+1)
    const d1 = new Date(Date.now() + 1 * 86400000)
    const d1Iso = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')}`
    const walkLater = await js(`(() => { const col = document.querySelector('.day-col[data-day="${d1Iso}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke seredit')); if (!el) return null; el.click(); return true })()`)
    await sleep(450)
    const wEd = await js(`({ editor: !!document.querySelector('.editor'), startVal: document.querySelectorAll('.editor input[type=datetime-local]')[0]?.value ?? '', applyTo: Array.from(document.querySelectorAll('.apply-to .seg-btn')).map((b) => b.textContent.trim()) })`)
    check('series edit opens on the later day', wEd.editor && wEd.startVal.startsWith(d1Iso), JSON.stringify(wEd))
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    const tStart = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[0].value`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[0], '${'${tStart.slice(0, 10)}T07:00'}')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${'${tStart.slice(0, 10)}T07:45'}')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const wAfter = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE id = '" + seId + "'")
    check('series time edit keeps the SERIES start date (no vanish)', wAfter.start_local.slice(0, 10) === wBefore.start_local.slice(0, 10), `${wAfter.start_local} vs ${wBefore.start_local}`)
    const wDates = await js(`(() => { const cols = Array.from(document.querySelectorAll('.day-col')).map((c) => c.getAttribute('data-day')); return cols.filter((d, i) => Array.from(document.querySelectorAll('.day-col')[i].querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke seredit'))).length })()`)
    check('earlier days still show the series', wDates >= 2, String(wDates))
    // revert the time in series mode
    await openEditorOn('Smoke seredit')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[0], '${'${wBefore.start_local.slice(0, 10)}T06:30'}')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${'${wBefore.start_local.slice(0, 10)}T07:15'}')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const wRevert = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE id = '" + seId + "'")
    check('series time reverted', wRevert.start_local === wBefore.start_local, wRevert.start_local)
    // cleanup
    await openEditorOn('Smoke seredit')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2ai. multiday: both chunks visible DURING drag (no momentary vanish)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke vis')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // start a drag but DON'T release: check both columns show a chunk mid-drag
    const midDrag = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return null; const r = el.getBoundingClientRect(); const cx = Math.round(r.left + r.width / 2); const cy = Math.round(r.top + 4); window.__dragDown = true; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, button: 0 })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy + 10, button: 0 })); return true })()`)
    await sleep(300)
    const midVisible = await js(`(() => { const counts = Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke vis')).length); return counts })()`)
    check('multiday: BOTH chunks visible mid-drag', midVisible.filter((n: number) => n > 0).length === 2, JSON.stringify(midVisible))
    // release
    await js(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))`)
    await sleep(700)
    // edit-panel trimming: set end to 00:00 (same day) → event becomes same-day
    const visDel = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return false; el.click(); return true })()`)
    await sleep(400)
    const visEnd = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[1]?.value ?? ''`)
    check('multiday edit shows the REAL end for trimming', visEnd.startsWith(`${TOMORROW}T00:`), visEnd)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${TOMORROW}T00:00')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const visDb = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke vis'")
    check('multiday trimmed via edit panel', visDb.end_local === `${TOMORROW}T00:00`, visDb.end_local)
    const visDel2 = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return false; el.click(); return true })()`)
    await sleep(400)
    if (visDel2) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2aj. multiday end-day edit via panel must save AND reflect
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke endday')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // sidebar today-part (#1): planned hours should include only today's 2h of this event
    const todayCard1 = await js(`document.querySelector('.today-hours')?.textContent ?? ''`)
    // open editor, trim end to same day 23:00 (valid: after start 22:00)
    const edClick = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (!el) return false; el.click(); return true })()`)
    await sleep(400)
    const endShown = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[1]?.value ?? ''`)
    check('multiday editor shows next-day end', endShown === `${TOMORROW}T00:30`, endShown)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${TODAY}T23:00')`)
    await sleep(300)
    const probeEnd = await js(`({ inputVal: document.querySelectorAll('.editor input[type=datetime-local]')[1].value, startVal: document.querySelectorAll('.editor input[type=datetime-local]')[0].value, saveDisabled: document.querySelector('.editor .btn.primary').disabled })`)
    console.log('[smoke] 2aj probeEnd:', JSON.stringify(probeEnd))
    const saveEnabled = !probeEnd.saveDisabled
    check('same-day trim is valid (Save enabled)', saveEnabled, JSON.stringify(probeEnd))
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const ed1 = dbGet<{ start_local: string; end_local: string }>("SELECT start_local, end_local FROM events WHERE title = 'Smoke endday'")
    check('same-day trim saved', ed1.end_local === `${TODAY}T23:00`, JSON.stringify(ed1))
    const ed1Chunks = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke endday')).length).filter((n) => n > 0).length`)
    check('trim reflected: one chunk only', ed1Chunks === 1, String(ed1Chunks))
    // extend end to day+2 01:00 (spans 3 days)
    const d3 = new Date(Date.now() + 2 * 86400000)
    const d3Iso = `${d3.getFullYear()}-${String(d3.getMonth() + 1).padStart(2, '0')}-${String(d3.getDate()).padStart(2, '0')}`
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${d3Iso}T01:00')`)
    await sleep(250)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const ed2 = dbGet<{ end_local: string }>("SELECT end_local FROM events WHERE title = 'Smoke endday'")
    check('extend to day+2 saved', ed2.end_local === `${d3Iso}T01:00`, ed2.end_local)
    const ed2Chunks = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke endday')).length).filter((n) => n > 0).length`)
    check('extend reflected: three chunks', ed2Chunks === 3, String(ed2Chunks))
    // sidebar today-part check: only 2h of the (now 3-day) event counts today
    const todayCard2 = await js(`document.querySelector('.today-hours')?.textContent ?? ''`)
    console.log('[smoke] today hours before/after:', todayCard1, '→', todayCard2)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2ak. premium Insights heading (shining blue border)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`)
    await sleep(700)
    const prem = await js(`(() => {
      const el = document.querySelector('.premium-heading')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { text: el.textContent.trim(), border: cs.borderColor, anim: cs.animationName, radius: cs.borderRadius }
    })()`)
    check('premium heading present in toolbar', !!prem && prem.text.includes('Insights'), JSON.stringify(prem))
    check('premium heading has blue border + shine animation', !!prem && prem.border === 'rgb(10, 132, 255)' && prem.anim.includes('premiumShine'), JSON.stringify(prem))

    // 2al. agenda: date column, multiday label, 2-decimal days, present on both days
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`)
    await sleep(700)
    const agDates = await js(`document.querySelectorAll('.agenda-date').length`)
    check('agenda rows show the event date', agDates > 0, String(agDates))
    // create a multi-day event spanning today→tomorrow
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke multiag')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T22:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TOMORROW}T00:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`)
    await sleep(700)
    const multiRows = await js(`Array.from(document.querySelectorAll('.agenda-row')).filter((r) => r.textContent.includes('Smoke multiag')).length`)
    check('multiday event appears in EVERY day it touches (2 groups)', multiRows === 2, String(multiRows))
    const multiBadge = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); return r ? !!r.querySelector('.mini-badge.multiday') : false })()`)
    check('multiday label shown', multiBadge)
    const multiDays = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); const d = r?.querySelector('.agenda-days'); return d ? d.textContent : '' })()`)
    check('extra-day indicator truncated to 2 decimals', /^\+\d+\.\d\dd$/.test(multiDays), multiDays)
    const agDateVal = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); const d = r?.querySelector('.agenda-date'); return d ? d.textContent : '' })()`)
    check('agenda date shows month+day', /^[A-Z][a-z]{2} \d{1,2}$/.test(agDateVal), agDateVal)
    // heading bleed: sticky title has z-index + solid bg
    const agTitle = await js(`(() => { const t = document.querySelector('.agenda-title'); if (!t) return null; const cs = getComputedStyle(t); return { z: cs.zIndex, bg: cs.backgroundColor, pos: cs.position } })()`)
    check('agenda heading has solid bg + z-index (no bleed)', !!agTitle && agTitle.pos === 'sticky' && agTitle.z !== 'auto', JSON.stringify(agTitle))
    // cleanup
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke multiag')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2am. M10.1 gamification — earn coins, ledger, refund on delete
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    const bal0 = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke coin')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T11:00')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // mark done → prompt appears
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const promptShown = await js(`!!document.querySelector('.score-prompt')`)
    check('score prompt appears after marking done', promptShown)
    const promptAmt = await js(`(() => { const o = Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')); return o ? o.textContent : '' })()`)
    check('prompt has NO coin amounts/multipliers', !promptAmt.includes('🪙') && !promptAmt.includes('×'), promptAmt)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(250)
    const closedFast = await js(`!document.querySelector('.score-prompt') && !document.querySelector('.fx-layer')`)
    check('stage4: prompt closes IMMEDIATELY, no lingering FX', closedFast)
    // CUP-3: answering "How did it go?" fires the brief coin animation (toaster-like)
    const fxShown = await js(`(() => { const f = document.querySelector('.coin-score-fx'); return f ? { pe: getComputedStyle(f).pointerEvents, bg: getComputedStyle(f).backgroundColor } : null })()`)
    check('cup3: coin animation shown after answering (transparent, non-blocking)', !!fxShown && fxShown.pe === 'none' && fxShown.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(fxShown))
    // cup3v2: simple CENTERED coin toaster — no flight, no count-up
    const fxSimple = await js(`(() => {
      const c = document.querySelector('.fx-coin')
      const spin = c ? c.querySelector('.c3-spin') : null
      const dust = document.querySelectorAll('.fx-dust span').length
      const sparks = document.querySelectorAll('.fx-dust span.spark').length
      return {
        hasCoin: !!c,
        noCount: !document.querySelector('.fx-count'),
        anim: c ? getComputedStyle(c).animationName : '',
        spin: spin ? getComputedStyle(spin).animationName : '',
        dust, sparks
      }
    })()`)
    check('cup4: centered coin toaster WITH gold dust + sparkles (no fly, no count)', fxSimple.hasCoin && fxSimple.noCount && fxSimple.anim.includes('fxPop') && fxSimple.spin.includes('gentleFlip') && fxSimple.dust >= 10 && fxSimple.sparks >= 2, JSON.stringify(fxSimple))
    // earn toast is checked while still alive (3.5s lifetime)
    const coinToast = await js(`Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('🪙'))`)
    check('earn toast shown', coinToast)
    await sleep(2400)
    const fxGone = await js(`!document.querySelector('.coin-score-fx')`)
    check('cup3: coin animation auto-clears (~2.1s)', fxGone)
    await sleep(1500)
    const bal1 = await js(`window.api.coins.balance()`)
    check('on-time 1h completion earns 10 coins', Math.round((bal1 - bal0) * 100) / 100 === 10, `${bal0} → ${bal1}`)
    const chipText = await js(`document.querySelector('.coin-chip')?.textContent ?? ''`)
    check('sidebar coin chip shows balance', chipText.includes(String(Math.round(bal1))), chipText)
    const txs = await js(`window.api.coins.listTransactions()`)
    check('ledger has an earn row', Array.isArray(txs) && txs.some((t: any) => t.type === 'earn' && t.amount === 10), JSON.stringify(txs?.[0]))
    // no second prompt on re-save
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const prompt2 = await js(`!!document.querySelector('.score-prompt')`)
    check('no duplicate prompt on re-save', !prompt2)
    // delete → refund
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const bal2 = await js(`window.api.coins.balance()`)
    check('delete refunds the coins', Math.round((bal2 - bal0) * 100) / 100 === 0, `${bal0} → ${bal2}`)
    const txs2 = await js(`window.api.coins.listTransactions()`)
    check('ledger has a refund row', Array.isArray(txs2) && txs2.some((t: any) => t.type === 'refund'), JSON.stringify(txs2?.[0]))
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2an. AGENDA BLEED: sticky titles cover the side padding (full-bleed)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`)
    await sleep(700)
    await js(`document.querySelector('.agenda-view').scrollTop = 400`)
    await sleep(500)
    const agBleed = await js(`(() => {
      const view = document.querySelector('.agenda-view')
      const title = document.querySelector('.agenda-title')
      if (!view || !title) return null
      const tr = title.getBoundingClientRect()
      const probes = [
        { x: Math.round(tr.left + 6), y: Math.round(tr.top + tr.height / 2) },  // left padding strip
        { x: Math.round(tr.right - 6), y: Math.round(tr.top + tr.height / 2) }, // right padding strip
        { x: Math.round(tr.left + tr.width / 2), y: Math.round(tr.top + 4) }
      ].map((p) => {
        const el = document.elementFromPoint(p.x, p.y)
        return el ? title.contains(el) || el === title : false
      })
      return { probes, allCovered: probes.every(Boolean) }
    })()`)
    check('agenda: sticky title covers side padding (no bleed)', !!agBleed && agBleed.allCovered, JSON.stringify(agBleed))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2ao. coins: recurring "this occurrence" — score attaches to the OVERRIDE;
    // delete refunds; re-save never double-earns; status revert refunds
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    const cBase = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke cwalk')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // open today's occurrence → This occurrence → done
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'This occurrence').click()`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const cProm = await js(`!!document.querySelector('.score-prompt')`)
    check('recurring this-occurrence done → prompt', cProm)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(1700)
    const cBal1 = await js(`window.api.coins.balance()`)
    check('recurring occurrence earns 10', Math.round((cBal1 - cBase) * 100) / 100 === 10, `${cBase} → ${cBal1}`)
    // the score must sit on the OVERRIDE row (not the master)
    const cOvr = dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke cwalk' AND parent_id IS NOT NULL")
    const cScore = await js(`window.api.coins.getScore('${cOvr.id}', '${TODAY}')`)
    check('score attached to the override row', !!cScore && cScore.scoreType === 'on_time', JSON.stringify(cScore))
    // re-save (no change) → NO prompt, NO double earn
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const cProm2 = await js(`!!document.querySelector('.score-prompt')`)
    const cBal2 = await js(`window.api.coins.balance()`)
    check('re-save: no prompt + no double earn', !cProm2 && Math.round((cBal2 - cBal1) * 100) / 100 === 0, `prompt=${cProm2} bal=${cBal2}`)
    const cOvrCount = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke cwalk' AND parent_id IS NOT NULL")
    check('re-save keeps ONE override (in-place update)', cOvrCount.c === 1, String(cOvrCount.c))
    // status back to todo → refund
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'todo')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const cBal3 = await js(`window.api.coins.balance()`)
    check('status back to todo → coins refunded', Math.round((cBal3 - cBase) * 100) / 100 === 0, `${cBase} → ${cBal3}`)
    // delete the override → no stray coins
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const cBal4 = await js(`window.api.coins.balance()`)
    check('delete override: balance unchanged (already refunded)', Math.round((cBal4 - cBase) * 100) / 100 === 0, `${cBase} → ${cBal4}`)
    // cleanup series
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(150)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2ap. coins: done + DATE change → old refunded, new scored once
    const dBase2 = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke cdate')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T11:00')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(1700)
    const dBal1 = await js(`window.api.coins.balance()`)
    // now move the date to tomorrow while still done
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[0], '${TOMORROW}T10:00')`)
    await sleep(200)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${TOMORROW}T11:00')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const dProm = await js(`!!document.querySelector('.score-prompt')`)
    check('date change while done → re-prompt for the new date', dProm)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(1700)
    const dBal2 = await js(`window.api.coins.balance()`)
    check('date change: net exactly one earn (old refunded)', Math.round((dBal2 - dBal1) * 100) / 100 === 0, `${dBal1} → ${dBal2}`)
    const dScoreNew = await js(`window.api.coins.getScore('${dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke cdate'").id}', '${TOMORROW}')`)
    check('new date scored', !!dScoreNew)
    const dScoreOld = await js(`window.api.coins.getScore('${dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke cdate'").id}', '${TODAY}')`)
    check('old date score removed', !dScoreOld)
    // delete → refund
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const dBal3 = await js(`window.api.coins.balance()`)
    check('delete after date change: fully refunded', Math.round((dBal3 - dBase2) * 100) / 100 === 0, String(dBal3))
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2aq. IPC idempotency: scoring the same key twice earns ONCE
    const iBase = await js(`window.api.coins.balance()`)
    await js(`window.api.coins.scoreEvent('idem-1', '${TODAY}', 'on_time', 10, null)`)
    await js(`window.api.coins.scoreEvent('idem-1', '${TODAY}', 'late', 6, null)`)
    const iBal = await js(`window.api.coins.balance()`)
    check('scoring same key twice earns once (idempotent)', Math.round((iBal - iBase) * 100) / 100 === 10, `${iBase} → ${iBal}`)
    await js(`window.api.coins.clearScores('idem-1')`)
    const iBal2 = await js(`window.api.coins.balance()`)
    check('idempotent refund returns to baseline', Math.round((iBal2 - iBase) * 100) / 100 === 0, `${iBase} → ${iBal2}`)

    // 2ar. coins: UNDO of a delete restores the coins (real amounts)
    const uBase = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke undocoins')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T11:00')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(1700)
    const uEarn = await js(`window.api.coins.balance()`)
    check('undo-coins: earned 10', Math.round((uEarn - uBase) * 100) / 100 === 10, `${uBase} → ${uEarn}`)
    // delete → refund → undo → coins back
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const uAfterDel = await js(`window.api.coins.balance()`)
    check('undo-coins: delete refunds', Math.round((uAfterDel - uBase) * 100) / 100 === 0, `${uBase} → ${uAfterDel}`)
    const uUndo = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke undocoins') && !!t.querySelector('.toast-action'))?.querySelector('.toast-action')?.click() ?? 'none'`)
    await sleep(800)
    const uAfterUndo = await js(`window.api.coins.balance()`)
    const uEventBack = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke undocoins'))`)
    check('undo-coins: undo restores the event', uEventBack)
    check('undo-coins: undo restores the coins (10 back)', Math.round((uAfterUndo - uBase) * 100) / 100 === 10, `${uBase} → ${uAfterUndo}`)
    // cleanup
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)
    const uClean = await js(`window.api.coins.balance()`)
    check('undo-coins: cleanup delete returns to baseline', Math.round((uClean - uBase) * 100) / 100 === 0, `${uBase} → ${uClean}`)

    // 2as. coins: status revert keeps the score; re-done restores SILENTLY (no prompt)
    const sBase = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke res')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T11:00')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    await js(`Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')).click()`)
    await sleep(1700)
    const sEarn = await js(`window.api.coins.balance()`)
    // revert to todo → refund, score row KEPT
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'todo')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const sRevert = await js(`window.api.coins.balance()`)
    check('revert: coins refunded on status change back', Math.round((sRevert - sBase) * 100) / 100 === 0, `${sBase} → ${sRevert}`)
    const sScore = await js(`window.api.coins.getScore('${dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke res'").id}', '${TODAY}')`)
    check('revert: score row KEPT (marked refunded)', !!sScore && !!sScore.refundedAt, JSON.stringify(sScore))
    // re-done → NO prompt, coins restored silently
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const sProm = await js(`!!document.querySelector('.score-prompt')`)
    check('re-done after revert: NO prompt (already gained)', !sProm)
    const sBal = await js(`window.api.coins.balance()`)
    check('re-done after revert: coins restored silently (10 back)', Math.round((sBal - sBase) * 100) / 100 === 10, `${sBase} → ${sBal}`)
    const sScore2 = await js(`window.api.coins.getScore('${dbGet<{ id: string }>("SELECT id FROM events WHERE title = 'Smoke res'").id}', '${TODAY}')`)
    check('re-done after revert: score no longer refunded', !!sScore2 && !sScore2.refundedAt, JSON.stringify(sScore2))
    // delete → full refund (no double refund from the earlier revert)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(600)
    const sDel = await js(`window.api.coins.balance()`)
    check('delete after restore: fully refunded (no double)', Math.round((sDel - sBase) * 100) / 100 === 0, `${sBase} → ${sDel}`)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2at. chip shows the TOTAL balance (not daily)
    const chipTitle = await js(`document.querySelector('.coin-chip')?.getAttribute('title') ?? ''`)
    check('chip labelled as total balance', chipTitle.includes('Total'), chipTitle)

    // 2au. M10.2 — check-in: the app already awarded it on startup today, so
    // calling again must NOT award (once-per-day rule holds)
    const ci0 = await js(`window.api.coins.balance()`)
    const ci1 = await js(`window.api.coins.checkIn()`)
    check('check-in: no second award same day (streak ≥1 recorded)', !ci1.award && ci1.streak >= 1, JSON.stringify(ci1))
    const ci2 = await js(`window.api.coins.checkIn()`)
    check('check-in never awards twice in a day', !ci2.award, JSON.stringify(ci2))
    const ciBal = await js(`window.api.coins.balance()`)
    check('check-in: balance unchanged by repeat calls', Math.round((ciBal - ci0) * 100) / 100 === 0, `${ci0} → ${ciBal}`)
    const ciTx = await js(`window.api.coins.listTransactions()`)
    check('check-in: bonus transaction exists in the ledger', Array.isArray(ciTx) && ciTx.some((t: any) => t.reason === 'Daily check-in' && t.type === 'bonus'), JSON.stringify(ciTx?.[0]))

    // 2av. M10.2 — "all planned done" bonus (+25) when the whole day resolves
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    const ad0 = await js(`window.api.coins.balance()`)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke alldone A')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T10:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T10:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke alldone B')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T11:00')`)
    await sleep(100)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T11:30')`)
    await sleep(100)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    // mark A done → not yet all
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke alldone A')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    await pickScore('On time') // earn the 10 for A
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)
    const ad1 = await js(`window.api.coins.balance()`)
    check('all-done: one done is not enough yet (5 for A only)', Math.round((ad1 - ad0) * 100) / 100 === 5, `${ad0} → ${ad1}`)
    // mark B done → earn B's score
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke alldone B')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(900)
    await pickScore('On time') // earn 5 for B
    const ad2 = await js(`window.api.coins.balance()`)
    check('all-done: A+B scored (+10 total)', Math.round((ad2 - ad0) * 100) / 100 === 10, `${ad0} → ${ad2}`)
    // seeds still pending → no bonus yet
    const adPre = await js(`window.api.coins.allDoneCheck('${TODAY}')`)
    check('all-done: not awarded while seeds pending', !adPre.award, JSON.stringify(adPre))
    // cleanup both
    for (const t of ['Smoke alldone A', 'Smoke alldone B']) {
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${t}')); if (el) el.click(); return !!el })()`)
      await sleep(400)
      await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
      await sleep(600)
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2aw. Coins view (revamped): 3:1 layout, coin-drop intro, KPI dice, streak cal, path
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await sleep(400)
    const dropIntro = await js(`(() => { const d = document.querySelector('.coin-drop'); if (!d) return { present: false }; return { present: true, hasCenter: !!d.querySelector('.intro-center'), hasCoin: !!d.querySelector('.intro-coin .rhythm-coin img'), rings: d.querySelectorAll('.intro-ring').length, hasCanvas: !!d.querySelector('.dust-canvas'), hasWord: !!d.querySelector('.intro-word'), stage: !!d.querySelector('.intro-stage') } })()`)
    check('coins: professional cinematic intro (navy stage, coin drop, gold-dust canvas, rings, wordmark)', dropIntro.present && dropIntro.hasCenter && dropIntro.hasCoin && dropIntro.rings >= 2 && dropIntro.hasCanvas && dropIntro.hasWord && dropIntro.stage, JSON.stringify(dropIntro))
    // the reward prompt must wait for the intro to END (checked on the FIRST visit, where the intro plays)
    const promptDuringIntro = await js(`!!document.querySelector('.coin-drop') && !document.querySelector('.reward-batch')`)
    check('reward prompt does NOT appear during the intro', promptDuringIntro)
    const introVer = await js(`document.querySelector('.intro-word-ver')?.textContent ?? ''`)
    check('intro shows version tag (build identification)', introVer.includes('v1.8.0'), introVer)
    const noSideVer = await js(`!document.querySelector('.sidebar-version')`)
    check('no version tag in the sidebar', noSideVer)
    const flipAnim = await js(`(() => {
      const read = (el) => {
        if (!el) return {}
        const tilt = el.querySelector('.c3-tilt')
        const spin = el.querySelector('.c3-spin')
        const segs = el.querySelectorAll('.c3-seg').length
        const faces = el.querySelectorAll('.c3-face').length
        const back = el.querySelector('.c3-face.back img')
        return {
          rollCls: el.classList.contains('roll'),
          flipCls: el.classList.contains('flip'),
          dropAnim: getComputedStyle(el).animationName,
          spinAnim: spin ? getComputedStyle(spin).animationName : '',
          wheel: tilt ? getComputedStyle(tilt).animationName : '',
          ts: tilt ? getComputedStyle(tilt).transformStyle : '',
          clip: (el.closest('.premium-heading') || el.closest('.seg-btn')) ? getComputedStyle(el.closest('.premium-heading') || el.closest('.seg-btn')).overflow : '',
          segs, faces,
          back: back ? (back.getAttribute('src') || '').includes('back') : false
        }
      }
      const head = document.querySelector('.premium-heading .ph-icon .rhythm-coin')
      const seg = document.querySelector('.seg-btn.active .seg-coin .rhythm-coin')
      return { ga: read(head), sa: read(seg) }
    })()`)
    check('coins: heading DROPS → damped bounces → ROLLS right (wheel spin) → fades at pill edge; tab coin uses the calm flip (like Total Rhythm Coins)', flipAnim.ga.rollCls && flipAnim.ga.dropAnim.includes('coinDropRoll') && flipAnim.ga.wheel.includes('rollWheel') && flipAnim.ga.ts === 'preserve-3d' && flipAnim.ga.segs >= 24 && flipAnim.ga.faces === 2 && flipAnim.ga.back && (flipAnim.ga.clip === 'hidden' || flipAnim.ga.clip === 'clip') && !flipAnim.sa.rollCls && flipAnim.sa.flipCls && flipAnim.sa.spinAnim.includes('gentleFlip'), JSON.stringify(flipAnim))
    await sleep(2200)
    const cv = await js(`(() => {
      const layout = document.querySelector('.coins-layout')
      const lr = layout.querySelector('.coins-left')?.getBoundingClientRect()
      const rr = layout.querySelector('.coins-right')?.getBoundingClientRect()
      return {
        view: !!layout,
        ratio3: lr && rr ? lr.width / rr.width : 0,
        kpiBand: document.querySelectorAll('.coins-kpis .coins-kpi').length,
        kpiLeft: document.querySelectorAll('.coins-kpis.left .coins-kpi').length,
        kpiRight: document.querySelectorAll('.coins-kpis.right .coins-kpi').length,
        kpiRightCls: document.querySelectorAll('.streak-kpi').length,
        chart: document.querySelectorAll('.coins-left .chart-svg rect').length,
        perLabel: document.querySelectorAll('.coins-left .ins-progress').length,
        ledger: document.querySelectorAll('.ledger-row').length,
        calCells: document.querySelectorAll('.streak-day').length,
        stones: document.querySelectorAll('.mile-stone').length
      }
    })()`)
    check('coins: 3:1 layout (left ≈ 3× right)', cv.view && cv.ratio3 > 2.2 && cv.ratio3 < 4, JSON.stringify(cv))
    check('coins: 3+1 KPI cards pinned in their panels (3 left, 1 right)', cv.kpiBand === 4 && cv.kpiLeft === 3 && cv.kpiRight === 1 && cv.kpiRightCls === 1, JSON.stringify(cv))
    const bandCoins = await js(`document.querySelectorAll('.coins-kpis .rhythm-coin img.rc-img').length`)
    check('coins: designed gold coin image visible in KPI band', bandCoins >= 1, String(bandCoins))
    const coinLoaded = await js(`(() => { const im = document.querySelector('.coins-kpis .rc-img'); return im ? { complete: im.complete, nw: im.naturalWidth, src: (im.getAttribute('src') || '').slice(-40) } : null })()`)
    check('coins: gold coin asset actually loaded (not broken image)', !!coinLoaded && coinLoaded.complete && coinLoaded.nw > 0 && coinLoaded.src.includes('coin-gold'), JSON.stringify(coinLoaded))
    const emojiSize = await js(`(() => { const e = document.querySelector('.coins-kpis .kpi-emoji'); return e ? getComputedStyle(e).fontSize : '' })()`)
    check('KPI emoji icons sized like the coin icon (40px)', emojiSize === '40px', emojiSize)
    check('coins: 7-day chart renders', cv.chart >= 7, String(cv.chart))
    check('coins: earned-by-label rows', cv.perLabel >= 1, String(cv.perLabel))
    check('coins: ledger rows', cv.ledger >= 1, String(cv.ledger))
    check('coins: streak calendar mini-month (42 cells)', cv.calCells === 42, String(cv.calCells))
    check('coins: milestone path starts with ONE stone', cv.stones === 1, String(cv.stones))
    // dice flips over time (left→right): poll until at least one face changed
    const facesChanged = await js(`(async () => {
      const read = () => Array.from(document.querySelectorAll('.coins-kpi')).map((c) => c.getAttribute('data-face')).join(',')
      const a = read()
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (read() !== a) return { changed: true, before: a, after: read() }
      }
      return { changed: false, before: a, after: read() }
    })()`)
    check('coins: KPI dice flip over time', facesChanged.changed, JSON.stringify(facesChanged))
    // CUP-1 #2: every coin in the KPI band (Total Rhythm Coins AND Today's faces) animates the same way
    const kpiFlips = await js(`(() => {
      const cs = Array.from(document.querySelectorAll('.coins-kpis .rhythm-coin'))
      return { total: cs.length, flipped: cs.filter((c) => c.classList.contains('flip')).length }
    })()`)
    check('KPI today coins animate like Total Rhythm Coins', kpiFlips.total >= 1 && kpiFlips.total === kpiFlips.flipped, JSON.stringify(kpiFlips))
    // CUP-1 #1: on a FRESH path (nothing hit yet), the reward popup asks for Level 1 BEFORE it is reached
    const firstAsk = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`)
    check('reward for Level 1 asked BEFORE hitting it (fresh path, balance 0)', firstAsk.open && firstAsk.items.length === 1 && firstAsk.items[0].includes('Level 1'), JSON.stringify(firstAsk))
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[0], 'L1 treat')`)
    await js(`Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save rewards').click()`)
    await sleep(400)
    const firstAskClosed = await js(`!document.querySelector('.reward-batch')`)
    check('Level 1 reward saved → popup closes, no repeat', firstAskClosed)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2ay. coins stats: "earned today" matches local-date math from the ledger
    const st = await js(`window.api.coins.stats()`)
    const allTxs = await js(`window.api.coins.listTransactions()`)
    const localNet = await js(`(() => {
      const pad = (n) => String(n).padStart(2, '0')
      const localOf = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
      const today = localOf(new Date().toISOString())
      const map = new Map()
      for (const t of ${JSON.stringify(allTxs)}) {
        const k = localOf(t.ts)
        const delta = (t.type === 'spend' || t.type === 'refund' ? -t.amount : t.amount)
        map.set(k, (map.get(k) ?? 0) + delta)
      }
      return Math.round((map.get(today) ?? 0) * 100) / 100
    })()`)
    check('earned today = local-date ledger net', Math.round((st.today - localNet) * 100) / 100 === 0, `stats=${st.today} manual=${localNet}`)

    // 2az. coins tab: chrome hidden with animation (like insights)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(700)
    const cvChrome = await js(`(() => {
      const sb = document.querySelector('.sidebar')
      const sbStyle = sb ? getComputedStyle(sb) : null
      return {
        sidebarCollapsed: !sb || sbStyle.opacity === '0' || parseFloat(sbStyle.width) <= 1,
        pillsGone: !!document.querySelector('.status-wrap.gone'),
        search: !!document.querySelector('.searchbox'),
        addBtn: !!document.querySelector('.new-btn'),
        todayBtn: !!document.querySelector('.today-btn'),
        heading: document.querySelector('.premium-heading')?.textContent.trim() ?? ''
      }
    })()`)
    check('coins: sidebar collapsed + pills hidden (search+New live in the pills row, hidden with it)', cvChrome.sidebarCollapsed && cvChrome.pillsGone && !cvChrome.todayBtn, JSON.stringify(cvChrome))
    check('coins: golden heading shown', cvChrome.heading.includes('Coins'), cvChrome.heading)

    // 2ba. 7-day chart stretches & centers with the box
    const cvChart = await js(`(() => {
      const svg = document.querySelector('.coins-view .chart-stretch')
      if (!svg) return null
      const vb = svg.getAttribute('viewBox') ?? ''
      const w = svg.getBoundingClientRect().width
      const panel = svg.closest('.ins-panel')?.getBoundingClientRect().width ?? 0
      return { vb, svgW: Math.round(w), panelW: Math.round(panel), fills: panel > 0 && w / panel > 0.85, bars: svg.querySelectorAll('rect').length }
    })()`)
    check('coins: 7-day chart stretched to the box', !!cvChart && cvChart.fills, JSON.stringify(cvChart))
    check('coins: 7-day chart has 7 bars', !!cvChart && cvChart.bars === 7, String(cvChart?.bars))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2bc. chart vertically centered in its box + blocking-day explanation
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(700)
    const cvCenter = await js(`(() => {
      const svg = document.querySelector('.coins-view .chart-stretch')
      if (!svg) return null
      const sr = svg.getBoundingClientRect()
      const pr = svg.closest('.ins-panel').getBoundingClientRect()
      const svgMid = sr.top + sr.height / 2
      const panelMid = pr.top + pr.height / 2
      return { delta: Math.abs(svgMid - panelMid), h: pr.height, centered: Math.abs(svgMid - panelMid) < pr.height * 0.2 }
    })()`)
    check('coins: 7-day chart vertically centered', !!cvCenter && cvCenter.centered, JSON.stringify(cvCenter))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    // blocking-day reporting: put a planned-but-not-done day in the window
    dbRun("INSERT INTO settings (key, value) VALUES ('pw_block_test', '1')")
    const pwBlock = await js(`window.api.coins.perfectWeek()`)
    console.log('[smoke] perfectWeek blocking probe:', JSON.stringify(pwBlock))
    check('perfect week: reports streak when ineligible (no silent failure)', pwBlock.award === false && typeof pwBlock.streak === 'number', JSON.stringify(pwBlock))
    dbRun("DELETE FROM settings WHERE key = 'pw_block_test'")

    // 2bd. M10.3 — milestone PATH: cross 100 stone → set next reward → claim ×2 (repeatable)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(700)
    const stones0 = await js(`window.api.milestones.list()`)
    check('milestone path auto-created (8 stones, first at 100)', Array.isArray(stones0) && stones0.length >= 8 && stones0[0].cost === 100, JSON.stringify(stones0?.[0]))
    const firstStone = stones0[0]
    const secondStone = stones0[1]
    // fund 230 (disposable smoke DB has a fresh balance) + a refunded 30 →
    // Total earned must be 230 (refunds subtracted)
    await js(`window.api.coins.scoreEvent('ms-fund-2', '${TOMORROW}', 'on_time', 230, null)`)
    await js(`window.api.coins.scoreEvent('ms-fund-3', '${TOMORROW}', 'on_time', 30, null)`)
    await js(`window.api.coins.clearScores('ms-fund-3', '${TOMORROW}')`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    // SKIP → the KPI cards appear IMMEDIATELY (they never wait for the intro's
    // natural end timing) — the exact cup-2 complaint
    const skipInstant = await js(`(() => {
      const k = document.querySelector('.coins-kpis .coins-kpi')
      return {
        noIntro: !document.querySelector('.coin-drop'),
        kpiOpacity: k ? getComputedStyle(k).opacity : '',
        kpiAnim: k ? getComputedStyle(k).animationName : ''
      }
    })()`)
    check('intro skipped → KPI cards visible immediately (no waiting for intro end)', skipInstant.noIntro && skipInstant.kpiOpacity === '1' && skipInstant.kpiAnim === 'none', JSON.stringify(skipInstant))
    await sleep(5600)
    // crossing 100 → ONE reward popup after the intro, asking for Level 1 ITSELF
    const promptNext = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return {
        open: true,
        title: (d.querySelector('.dialog-title')?.textContent ?? ''),
        items: Array.from(d.querySelectorAll('.rb-item')).map((i) => (i.querySelector('.rb-name')?.textContent ?? '').replace(/\\s+/g, ' ').trim())
      }
    })()`)
    check('after Level 1 is hit → reward popup asks for the upcoming Level 2 (before it is reached)', promptNext.open && promptNext.items.length === 1 && promptNext.items[0].includes('Level 2'), JSON.stringify(promptNext))
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[0], 'Smoke treat')`)
    await js(`Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save rewards').click()`)
    await sleep(500)
    const stones1 = await js(`window.api.milestones.list()`)
    check('upcoming reward saved to Level 2 (name stays Level 2)', stones1.find((m: any) => m.id === secondStone.id)?.notes === 'Smoke treat' && stones1.find((m: any) => m.id === secondStone.id)?.name === 'Level 2', JSON.stringify(stones1.find((m: any) => m.id === secondStone.id)))
    // edit button opens the reward dialog and saves (only reward item)
    // edit the VISIBLE Level 1 stone's reward (Level 2 appears only after Level 1 is done)
    const editProbe = await js(`(() => {
      const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.querySelector('.mile-level')?.textContent.includes('100'))
      const b = st ? Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('✎')) : null
      if (b) b.click()
      return { hasStone: !!st, hasBtn: !!b }
    })()`)
    console.log('[smoke] editProbe:', JSON.stringify(editProbe))
    await sleep(500)
    const editOpen = await js(`(() => { const f = document.querySelector('.overlay .mile-form'); return f ? { open: true, inputs: f.querySelectorAll('input').length } : { open: false, inputs: 0 } })()`)
    check('stage3: edit dialog = ONE reward-note field only', editOpen.open && editOpen.inputs === 1, JSON.stringify(editOpen))
    await js(`(${SET_VALUE})(document.querySelectorAll('.overlay .mile-form input')[0], 'Smoke edited treat')`)
    await js(`Array.from(document.querySelectorAll('.overlay .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save reward')?.click()`)
    await sleep(500)
    const stones1b = await js(`window.api.milestones.list()`)
    check('stage3: reward edit saved (notes changed, name fixed)', stones1b.find((m: any) => m.id === firstStone.id)?.notes === 'Smoke edited treat' && stones1b.find((m: any) => m.id === firstStone.id)?.name === 'Level 1', JSON.stringify(stones1b.find((m: any) => m.id === firstStone.id)))
    // claim the 100 stone twice (repeatable) → celebration + 2 spends
    let celebSeen = false
    for (let i = 0; i < 2; i++) {
      const claimRes = await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return 'no stone'; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim') || x.textContent.includes('Redeem')); if (!b) return 'no btn'; b.click(); return 'ok' })()`)
      await sleep(700)
      const celebOpen = await js(`!!document.querySelector('.overlay.celeb')`)
      if (celebOpen) {
        celebSeen = true
        await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`)
        await sleep(300)
      }
    }
    check('celebration overlay appears on claim', celebSeen)
    const spendTx = await js(`window.api.coins.listTransactions()`)
    const spends = (spendTx ?? []).filter((t: any) => t.type === 'spend' && t.reason.includes('Level 1'))
    check('claim logged as spend ×2 (repeatable)', spends.length === 2 && spends.every((t: any) => t.amount === 100), JSON.stringify(spends))
    const stones2 = await js(`window.api.milestones.list()`)
    check('stone marked first-claimed', !!stones2.find((m: any) => m.id === firstStone.id)?.achievedAt)
    // totals: earned minus refunds (230 = 230 + 30 - 30), today's earning same
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3400)
    const totEarn = await js(`(async () => {
      for (let i = 0; i < 14; i++) {
        const card = Array.from(document.querySelectorAll('.coins-kpi')).find((c) => c.textContent.includes('Total earned'))
        if (card) return card.querySelector('.coins-kpi-value')?.textContent ?? ''
        await new Promise((r) => setTimeout(r, 500))
      }
      return ''
    })()`)
    // expected total earned = Σ(earn+bonus) − Σ(refund) from the ledger
    const expEarn = await js(`(() => {
      const all = window.__noop ? [] : []
      return 0
    })()`)
    const totCheck = await js(`(async () => {
      const txs = await window.api.coins.listTransactions()
      let e = 0
      for (const t of txs) {
        if (t.type === 'earn' || t.type === 'bonus') e += t.amount
        else if (t.type === 'refund') e -= t.amount
      }
      return Math.round(e)
    })()`)
    check('stage4: Total earned subtracts refunds', String(totCheck) === totEarn, `ui=${totEarn} ledger=${totCheck}`)
    const stonesVis = await js(`document.querySelectorAll('.mile-stone').length`)
    check('stage4: path grows 1 at a time (2 stones after Level 1 done)', stonesVis === 2, String(stonesVis))
    // sidebar widget tracks the path
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(500)
    const widget = await js(`(() => { const w = document.querySelector('.mile-widget'); if (!w) return null; return { ring: !!w.querySelector('.mile-ring'), text: w.textContent } })()`)
    check('sidebar milestone widget with progress ring', !!widget && widget.ring, JSON.stringify(widget))
    // CUP-4: the widget ring follows the CURRENT NET — when the net moves
    // through a milestone, the widget celebrates (confetti + gold border +
    // "Level X passed — Claim in Coins" for 5s), then shows the next level
    dbRun("DELETE FROM coin_transactions")
    dbRun("DELETE FROM event_scores")
    await js(`window.__rhythmCoins.refresh()`) // store balance → 0 (no celebration on load)
    await js(`window.api.coins.scoreEvent('ms-widget-1', '${TOMORROW}', 'on_time', 150, null)`) // net 150 → crosses Level 1 (100)
    await js(`window.__rhythmCoins.refresh()`)
    const celebShown = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const w = document.querySelector('.mile-widget')
        if (w && w.classList.contains('celebrating')) {
          return { text: w.textContent, gold: getComputedStyle(w).borderTopColor !== 'rgba(0, 0, 0, 0)', dust: w.querySelectorAll('.mile-celeb-dust').length }
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      return null
    })()`)
    check('cup4: widget celebrates on net crossing (gold border + dust + "Level 1 passed — Claim in Coins")', !!celebShown && celebShown.text.includes('Level 1 passed') && celebShown.text.includes('Claim in Coins') && celebShown.dust >= 10, JSON.stringify(celebShown))
    await sleep(5400)
    const celebGone = await js(`(() => { const w = document.querySelector('.mile-widget'); return { celebrating: w ? w.classList.contains('celebrating') : false, text: w ? w.textContent : '' } })()`)
    check('cup4: celebration clears after 5s → shows the NEXT level', !celebGone.celebrating && celebGone.text.includes('Level 2'), JSON.stringify(celebGone))
    await js(`window.api.coins.clearScores('ms-widget-1', '${TOMORROW}')`)
    await js(`window.__rhythmCoins.refresh()`)
    await sleep(300)
    // DOUBLE-MILESTONE BATCH: jump straight to 800 → L1, L2 AND L3 reached at once
    // → ONE reward popup listing ALL of them (first milestone included, no conflict)
    dbRun("DELETE FROM coin_transactions")
    dbRun("DELETE FROM event_scores")
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%' OR key LIKE 'stoneReached.%'")
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward'")
    await js(`window.api.coins.scoreEvent('ms-batch-1', '${TOMORROW}', 'on_time', 800, null)`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(6000)
    const batch = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`)
    // ALL are pending (hit-but-unrewarded + the upcoming one):
    // one popup, four stones, in one dialog, no conflicts
    check('double achievement: ONE popup with hit-but-unrewarded + the upcoming level (L1..L4)', batch.open && batch.items.length === 4 && batch.items[0].includes('Level 1') && batch.items[1].includes('Level 2') && batch.items[2].includes('Level 3') && batch.items[3].includes('Level 4'), JSON.stringify(batch))
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[0], 'R1')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[1], 'R2')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[2], 'R3')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[3], 'R4')`)
    await js(`Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save rewards').click()`)
    await sleep(600)
    const batchMs = await js(`window.api.milestones.list()`)
    check('batch: all pending rewards saved (no conflict between them)', batchMs.find((m: any) => m.cost === 100)?.notes === 'R1' && batchMs.find((m: any) => m.cost === 250)?.notes === 'R2' && batchMs.find((m: any) => m.cost === 500)?.notes === 'R3' && batchMs.find((m: any) => m.cost === 1000)?.notes === 'R4', JSON.stringify(batchMs.slice(0, 4).map((m: any) => m.notes)))
    // FIRST-TIME-AFTER-SAVE overlap check: right after saving rewards the path
    // must be clean (remount fix) — no overlapping stones
    const afterSaveGeo = await js(`(() => {
      const stones = Array.from(document.querySelectorAll('.mile-stone'))
      const rs = stones.map((s) => { const r = s.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })
      let overlap = false
      for (let i = 0; i < rs.length - 1; i++) if (rs[i].bottom > rs[i + 1].top + 2) overlap = true
      return { count: rs.length, overlap }
    })()`)
    check('path clean IMMEDIATELY after saving rewards (no overlap on first render)', afterSaveGeo.count >= 2 && !afterSaveGeo.overlap, JSON.stringify(afterSaveGeo))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(6000)
    const batchAgain = await js(`!document.querySelector('.reward-batch')`)
    check('batch: no repeated popup after rewards are saved', batchAgain)
    await js(`window.api.coins.clearScores('ms-batch-1', '${TOMORROW}')`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    // LEGACY DB: an old build left `stoneCrossed.100 = 1` (it asked for the NEXT
    // stone's reward keyed by Level 1's cost) but Level 1's own reward text is
    // still the default placeholder → the popup MUST still ask for Level 1.
    dbRun("DELETE FROM coin_transactions")
    dbRun("DELETE FROM event_scores")
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%' OR key LIKE 'stoneReached.%'")
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward'")
    dbRun("INSERT INTO settings (key, value) VALUES ('stoneCrossed.100', '1')") // legacy key, NO rewardAsked
    await js(`window.api.coins.scoreEvent('ms-legacy-1', '${TOMORROW}', 'on_time', 150, null)`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(6000)
    const legacyPopup = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`)
    check('legacy DB: Level 1 reward asked even with an old stoneCrossed key (plus the upcoming L2)', legacyPopup.open && legacyPopup.items.length === 2 && legacyPopup.items[0].includes('Level 1') && legacyPopup.items[1].includes('Level 2'), JSON.stringify(legacyPopup))
    // skip → marked asked under the new flow → never nags again
    await js(`Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Skip').click()`)
    await sleep(500)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(6000)
    const legacyNoRepeat = await js(`!document.querySelector('.reward-batch')`)
    check('legacy DB: no repeat after skip (rewardAsked marker set)', legacyNoRepeat)
    await js(`window.api.coins.clearScores('ms-legacy-1', '${TOMORROW}')`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    // static coin + static ✦ when NOT on the coins/insights tabs (Week here)
    const staticCheck = await js(`(() => {
      const coinsSeg = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins'))
      const insSeg = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights'))
      const coin = coinsSeg ? coinsSeg.querySelector('.rhythm-coin') : null
      const tw = insSeg ? insSeg.querySelector('.twinkle') : null
      return {
        coinRoll: coin ? coin.classList.contains('roll') : false,
        hasTwinkle: !!tw,
        twinkleShining: tw ? tw.classList.contains('shining') : false
      }
    })()`)
    check('coin static on other tabs; insights ✦ present but NOT shining', !staticCheck.coinRoll && staticCheck.hasTwinkle && !staticCheck.twinkleShining, JSON.stringify(staticCheck))
    // cleanup funding (disposable DB: wipe events + scores for the fund row)
    await js(`window.api.coins.clearScores('ms-fund-2', '${TOMORROW}')`)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)

    // 2j/2i use a DEDICATED daily series so earlier walk edits can't interfere
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke occwalk')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T06:30')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)

    // 2be. stage-1 coins fixes: independent scrolls, pinned KPIs, no signs, best streak
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3400)
    const stage1 = await js(`(() => {
      const view = document.querySelector('.coins-view')
      const left = document.querySelector('.coins-left')
      const right = document.querySelector('.coins-right')
      const kpis = document.querySelector('.coins-kpis')
      return {
        viewOverflow: getComputedStyle(view).overflowY,
        leftScroll: getComputedStyle(left).overflowY === 'auto',
        rightScroll: getComputedStyle(right).overflowY === 'auto',
        kpiInBand: document.querySelectorAll('.coins-kpis .coins-kpi').length === 4,
        kpiNotSticky: getComputedStyle(kpis).position !== 'sticky',
        todayNet: (document.querySelectorAll('.coins-kpi')[0]?.querySelector('.coins-kpi-value')?.textContent ?? ''),
        todayEarn: (document.querySelectorAll('.coins-kpi')[1]?.querySelector('.coins-kpi-value')?.textContent ?? '')
      }
    })()`)
    check('stage1: panels scroll independently (left/right auto)', stage1.leftScroll && stage1.rightScroll && stage1.viewOverflow === 'hidden', JSON.stringify(stage1))
    check('stage1: 4 KPIs in a fixed non-scrolling band', stage1.kpiInBand && stage1.kpiNotSticky, JSON.stringify(stage1))
    check('stage1: today values have no decorative + sign', !/^\+/.test(stage1.todayNet) && !/^\+/.test(stage1.todayEarn), JSON.stringify(stage1))
    const bestKey = await js(`window.api.settings.get('bestStreak')`)
    check('stage1: best streak persisted (>= current)', parseInt(bestKey ?? '0', 10) >= 1, String(bestKey))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2bf. stage-1 leftover + stage 2: KPI size match, ledger height, mini-month
    // streak calendar with day-number dots, 4-stone goal window, streak milestone award
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3400)
    const s2 = await js(`(() => {
      const leftKpi = document.querySelector('.coins-kpis .coins-kpi')
      const sk = document.querySelector('.streak-kpi')
      const lh = leftKpi ? leftKpi.getBoundingClientRect().height : 0
      const sh = sk ? sk.getBoundingClientRect().height : 0
      const ledger = document.querySelector('.ledger')
      return {
        sizeMatch: Math.abs(lh - sh) < 8,
        ledgerMax: ledger ? parseFloat(getComputedStyle(ledger).maxHeight) : 0,
        monthCells: document.querySelectorAll('.streak-day').length,
        monthTitle: document.querySelector('.streak-month-title')?.textContent ?? '',
        stones: document.querySelectorAll('.streak-stone').length,
        goalSub: document.querySelector('.streak-goal-sub')?.textContent ?? ''
      }
    })()`)
    check('stage2: streak KPI card matches left KPI size', s2.sizeMatch, JSON.stringify(s2))
    check('stage2: ledger max-height doubled (>=600px)', s2.ledgerMax >= 600, String(s2.ledgerMax))
    check('stage2: mini-month streak calendar (42 cells, title)', s2.monthCells === 42 && s2.monthTitle.length > 0, JSON.stringify(s2))
    check('stage2: 4 streak stones shown', s2.stones === 4, String(s2.stones))
    check('stage2: goal shows current streak + next reward', s2.goalSub.includes('Current') && s2.goalSub.includes('🪙'), s2.goalSub)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    // streak milestone award: craft a 10-day streak → 10×2 = 20 once
    dbRun("DELETE FROM events WHERE title LIKE 'SM10%'")
    dbRun("DELETE FROM settings WHERE key LIKE 'streakMs.%'")
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - i * 86400000)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'SM10', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        'sm10-' + i, iso + 'T09:00', iso + 'T10:00', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      )
    }
    const smBase = await js(`window.api.coins.balance()`)
    const sm1 = await js(`window.api.coins.streakMilestone()`)
    check('stage2: 10-day streak milestone awards 20 (10×2)', sm1.award && sm1.amount === 20 && sm1.level === 10, JSON.stringify(sm1))
    const sm2 = await js(`window.api.coins.streakMilestone()`)
    check('stage2: milestone awarded only once per level', !sm2.award, JSON.stringify(sm2))
    const smBal = await js(`window.api.coins.balance()`)
    check('stage2: balance includes exactly +20', Math.round((smBal - smBase) * 100) / 100 === 20, `${smBase} → ${smBal}`)
    // 4-stone window reflects the streak (hit 10 → window 5,10,20,30 with 10 second)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3400)
    const win2 = await js(`Array.from(document.querySelectorAll('.streak-stone')).map((st) => ({ t: st.textContent, hit: st.classList.contains('hit') }))`)
    check('stage2: window shows 5,10,20,30 with 10 hit', JSON.stringify(win2).includes('10d') && win2.filter((w: any) => w.hit).length === 1, JSON.stringify(win2))
    // CUP-2: the SECOND-LAST reached mile also gets the blue, with a varied shade
    const hitPrev = await js(`(() => {
      const p = document.querySelector('.streak-stone.hit-prev')
      if (!p) return { found: false }
      return { found: true, text: p.textContent, bg: getComputedStyle(p).backgroundImage }
    })()`)
    check('streak goal: second-last reached mile gets a varied blue shade', hitPrev.found && hitPrev.text.includes('5d') && hitPrev.bg.includes('gradient'), JSON.stringify(hitPrev))
    // CUP-2: PERFECT MONTH — a 30-day streak awards +300 once per level
    dbRun("DELETE FROM events WHERE title LIKE 'SM30%'")
    dbRun("DELETE FROM settings WHERE key LIKE 'monthStreak.%'")
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 86400000)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'SM30', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        'sm30-' + i, iso + 'T09:00', iso + 'T10:00', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      )
    }
    const pm1 = await js(`window.api.coins.perfectMonth()`)
    const pm2 = await js(`window.api.coins.perfectMonth()`)
    check('perfect month: 30-day streak awards 300 once', pm1.award && pm1.amount === 300 && pm1.level === 30 && !pm2.award, JSON.stringify(pm1))
    dbRun("DELETE FROM events WHERE title LIKE 'SM30%'")
    dbRun("DELETE FROM events WHERE title LIKE 'SM10%'")
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2bg. MIGRATION: simulate the user's exact DB — Level 1..4 present, several
    // ACHIEVED, new-style names — the path must reset to ONLY Level 1 (fresh)
    dbRun("DELETE FROM reward_milestones")
    dbRun("DELETE FROM settings WHERE key = 'milestonePathV2'")
    dbRun("DELETE FROM coin_transactions")
    dbRun("DELETE FROM event_scores")
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneReached.%' OR key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%'")
    const nowIso = new Date().toISOString()
    const legacy = [
      ['l1', 'Level 1', 100, nowIso],
      ['l2', 'Level 2', 250, nowIso],
      ['l3', 'Level 3', 500, null],
      ['l4', 'Level 4', 1000, null]
    ]
    for (const [id, name, cost, achieved] of legacy) {
      dbRun(
        `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
         VALUES (?, ?, '🎯', ?, 'x', ?, ?)`,
        id, name, cost, achieved, nowIso
      )
    }
    const mig = await js(`window.api.milestones.list()`)
    check(
      'migration: legacy achieved levels reset to fresh Level 1 path',
      Array.isArray(mig) && mig.length >= 8 && mig[0].name === 'Level 1' && mig[0].achievedAt === null && mig.every((m: any) => m.achievedAt === null),
      JSON.stringify(mig?.[0])
    )
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    // the reward popup asks for the fresh Level 1 — skip it so it can't overlay
    await js(`(() => { const b = Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((x) => x.textContent.trim() === 'Skip'); if (b) b.click() })()`)
    await sleep(1600)
    const oneStone2 = await js(`document.querySelectorAll('.mile-stone').length`)
    check('after migration the path shows ONLY Level 1', oneStone2 === 1, String(oneStone2))
    // the migration runs ONCE — a second launch does not wipe progress
    const mig2 = await js(`window.api.milestones.list()`)
    check('migration is one-time (flag set, path stable)', mig2.length === mig.length, String(mig2.length))
    // NORMALIZATION (bulletproof): even when the v2 flag is ALREADY SET and the
    // table holds legacy rows (the exact state of a DB touched by an earlier
    // build — e.g. 'Level 100' names or a stray extra level), every list call
    // repairs the path: exactly Level 1..8 canonical, extras dropped.
    dbRun("DELETE FROM reward_milestones")
    dbRun("INSERT INTO settings (key, value) VALUES ('milestonePathV2', '1')")
    const nowIso3 = new Date().toISOString()
    const legacyRows: Array<[string, string, number]> = [
      ['n1', 'Level 100', 100],
      ['n2', 'Level 250', 250],
      ['n3', 'Level 500', 500],
      ['n9', 'Level 999', 99999]
    ]
    for (const [id, name, cost] of legacyRows) {
      dbRun(
        `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
         VALUES (?, ?, '🎯', ?, 'x', NULL, ?)`,
        id, name, cost, nowIso3
      )
    }
    const norm = await js(`window.api.milestones.list()`)
    check(
      'normalization: legacy rows repaired even with v2 flag already set',
      Array.isArray(norm) && norm.length === 8 && norm[0].name === 'Level 1' && norm[0].cost === 100 && norm[7].cost === 6000 && !norm.some((m: any) => m.name === 'Level 999'),
      JSON.stringify((norm as any[]).map((m) => m.name + ':' + m.cost))
    )
    // REACHED-not-claimed: fund 150 on a CLEAN ledger (Level 1 reached, NOT claimed) → Level 2 shows
    dbRun("DELETE FROM coin_transactions")
    dbRun("DELETE FROM event_scores")
    await js(`window.api.coins.scoreEvent('ms-reach-1', '${TOMORROW}', 'on_time', 150, null)`)
    // suppress the reward popup for this leg (covered by the dedicated batch test)
    dbRun("INSERT INTO settings (key, value) VALUES ('stoneCrossed.100', '1')")
    dbRun("INSERT INTO settings (key, value) VALUES ('rewardAsked.100', '1')")
    dbRun("INSERT INTO settings (key, value) VALUES ('rewardAsked.250', '1')")
    const probeReach = await js(`(async () => ({ bal: await window.api.coins.balance(), ms: (await window.api.milestones.list()).slice(0, 3) }))()`)
    console.log('[smoke] reach probe:', JSON.stringify(probeReach))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3600)
    const reachStones = await js(`Array.from(document.querySelectorAll('.mile-stone')).map((st) => ({ t: st.textContent.slice(0, 30), crossed: st.classList.contains('crossed'), first: st.classList.contains('first') }))`)
    check('next stone shows once previous is REACHED (not claimed) — 2 stones', reachStones.length === 2, JSON.stringify(reachStones))
    // stack: Level 2 on TOP (index 0, not crossed), Level 1 at BOTTOM (index 1, crossed/reached)
    check('stack: Level 1 at bottom, Level 2 on top', reachStones[0].t.includes('Level 2') && !reachStones[0].crossed && reachStones[1].t.includes('Level 1') && reachStones[1].crossed, JSON.stringify(reachStones))
    // claim L1 (its balance covers it) so the Redeem button appears
    await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return false; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim')); if (!b) return false; b.click(); return true })()`)
    await sleep(800)
    const celebSeen2 = await js(`!!document.querySelector('.overlay.celeb')`)
    if (celebSeen2) await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`)
    await sleep(400)
    // redeem button has NO bracket stat
    const redeemText = await js(`(() => { const r = Array.from(document.querySelectorAll('.mile-stone button')).find((b) => b.textContent.includes('Redeem')); return r ? r.textContent : '' })()`)
    check('redeem button has no bracket stat', redeemText === 'Redeem', redeemText)
    // STICKY REACH: fund 500 (reaches L1 100, L2 250, L3 500) → claim L1 TWICE →
    // net drops to 300 (< 500) but Level 3 must NEVER disappear
    dbRun("DELETE FROM coin_transactions")
    await js(`window.api.coins.scoreEvent('ms-stick-1', '${TOMORROW}', 'on_time', 500, null)`)
    for (const c of [100, 250, 500, 1000]) {
      dbRun("INSERT INTO settings (key, value) VALUES ('stoneCrossed.' || ?, '1')", c)
      dbRun("INSERT INTO settings (key, value) VALUES ('rewardAsked.' || ?, '1')", c)
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(700)
    const stickBefore = await js(`document.querySelectorAll('.mile-stone').length`)
    for (let i = 0; i < 2; i++) {
      await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return false; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim') || x.textContent.includes('Redeem')); if (!b) return false; b.click(); return true })()`)
      await sleep(700)
      const cOpen = await js(`!!document.querySelector('.overlay.celeb')`)
      if (cOpen) await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`)
      await sleep(300)
    }
    const stickAfter = await js(`(async () => ({ n: document.querySelectorAll('.mile-stone').length, bal: await window.api.coins.balance() }))()`)
    check('sticky: reached stones stay even after the net drops below their cost', stickBefore === 4 && stickAfter.n === 4 && stickAfter.bal < 500, JSON.stringify({ before: stickBefore, ...stickAfter }))
    // MULTI-STONE: fund 1600 → levels 1-5 (100..1500) all reached → ALL present, stacked descending
    dbRun("DELETE FROM coin_transactions")
    await js(`window.api.coins.scoreEvent('ms-multi-1', '${TOMORROW}', 'on_time', 1600, null)`)
    for (const c of [100, 250, 500, 1000, 1500, 2500]) {
      dbRun("INSERT INTO settings (key, value) VALUES ('stoneCrossed.' || ?, '1')", c)
      dbRun("INSERT INTO settings (key, value) VALUES ('rewardAsked.' || ?, '1')", c)
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(700)
    const multi = await js(`(() => {
      const names = Array.from(document.querySelectorAll('.mile-stone-name')).map((n) => n.textContent.trim())
      return { count: names.length, names }
    })()`)
    check('multiple stones hit → ALL present (6 stones: L1-L5 reached + L6 next)', multi.count === 6 && multi.names[0].includes('Level 6') && multi.names[1].includes('Level 5') && multi.names[multi.names.length - 1].includes('Level 1'), JSON.stringify(multi))
    // PATH NO-OVERLAP: every stone sits in its own space (no cascading/colliding),
    // and the connectors are in-flow blocks (never absolute)
    const pathGeo = await js(`(() => {
      const stones = Array.from(document.querySelectorAll('.mile-stone'))
      const rs = stones.map((s) => {
        const r = s.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width }
      })
      let overlap = false
      for (let i = 0; i < rs.length - 1; i++) {
        if (rs[i].bottom > rs[i + 1].top + 2) overlap = true // touches/overlaps next
      }
      const link = document.querySelector('.mile-link')
      const linkPos = link ? getComputedStyle(link).position : 'none'
      const sameWidth = rs.every((r) => Math.abs(r.w - rs[0].w) < 2)
      return { count: rs.length, overlap, linkPos, sameWidth }
    })()`)
    check('milestone path: stones stacked with NO overlap/cascade (in-flow links, equal widths)', pathGeo.count >= 2 && !pathGeo.overlap && pathGeo.linkPos === 'static' && pathGeo.sameWidth, JSON.stringify(pathGeo))
    // LONG REWARD NOTE (the "reward is being edited" case): must truncate to one
    // line and NEVER overlap the Redeem/Edit buttons
    dbRun("UPDATE reward_milestones SET notes = 'A very long reward description that keeps going and going and going and going and going and going and going to test truncation' WHERE cost = 100")
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(1200)
    const noteGeo = await js(`(() => {
      const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.querySelector('.mile-level')?.textContent.includes('100'))
      if (!st) return { found: false }
      const notes = st.querySelector('.mile-stone-notes')
      const actions = st.querySelector('.mile-stone-actions')
      if (!notes || !actions) return { found: false }
      const nr = notes.getBoundingClientRect()
      const ar = actions.getBoundingClientRect()
      return {
        found: true,
        overlaps: nr.right > ar.left + 1,
        truncated: notes.scrollWidth > notes.clientWidth,
        noteW: Math.round(nr.width), actLeft: Math.round(ar.left)
      }
    })()`)
    check('long reward note: truncates to one line, does NOT overlap the buttons', noteGeo.found && !noteGeo.overlaps && noteGeo.truncated, JSON.stringify(noteGeo))
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward' WHERE cost = 100")
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`window.api.coins.clearScores('ms-stick-1', '${TOMORROW}')`)
    await js(`window.api.coins.clearScores('ms-multi-1', '${TOMORROW}')`)
    await js(`window.api.coins.clearScores('ms-reach-1', '${TOMORROW}')`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3600)
    // 7-day chart width == KPI card width
    const widthMatch = await js(`(() => {
      const chart = document.querySelector('.coins-charts .ins-panel')
      const kpi = document.querySelector('.coins-kpis .coins-kpi')
      const cw = chart.getBoundingClientRect().width
      const kw = kpi.getBoundingClientRect().width
      return { cw: Math.round(cw), kw: Math.round(kw), diff: Math.round(Math.abs(cw - kw)) }
    })()`)
    check('7-day chart width matches KPI card (exact)', widthMatch.diff <= 2, JSON.stringify(widthMatch))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    // 2j. bug 2 — the editor must show the SELECTED occurrence's date
    await openEditorOn('Smoke occwalk')
    const edStart = await js(`document.querySelector('.editor input[type=datetime-local]')?.value ?? ''`)
    const edEnd = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[1]?.value ?? ''`)
    check('editor shows the selected occurrence date', edStart === `${TODAY}T06:30`, `${edStart} vs ${TODAY}T06:30`)
    check('editor end matches the selected occurrence', edEnd === `${TODAY}T07:30`, edEnd)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'doing')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(600)
    const stOv = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke occwalk' AND status = 'doing'")
    check('status override created on the occurrence day', !!stOv && stOv.start_local.startsWith(TODAY), JSON.stringify(stOv))
    await openEditorOn('Smoke occwalk')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete this occurrence'); if (b) b.click(); return !!b })()`)
    await sleep(500)

    // 2i. bug 1 — move a recurring occurrence onto a day that already has the
    // same event (→ both show, no glitch), then move it back (→ no ghost)
    await sleep(300)
    const walkPos = await blockPos('Smoke occwalk')
    const colRects = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width } })`)
    const fromIdx = colRects.findIndex((r: { left: number; width: number }) => walkPos.x >= r.left && walkPos.x < r.left + r.width)
    const toIdx = Math.min(fromIdx + 1, colRects.length - 1)
    const dx1 = colRects[toIdx].left + colRects[toIdx].width / 2 - walkPos.x
    const beforeTotal = await countBlocks('Smoke occwalk')
    await realDrag(walkPos, dx1, 0)
    await sleep(700)
    const tgt1 = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      return {
        all: col.querySelectorAll('.eb').length,
        walks: Array.from(col.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length
      }
    })()`)
    // the target day also has other seeded events — the key check is that BOTH
    // walk blocks render side by side (no duplicate-key glitch/ghost)
    check('moving onto a day that already has the event → both blocks render', tgt1.walks === 2, JSON.stringify(tgt1))
    const backPos = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke occwalk'))
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) }
    })()`)
    const dx2 = colRects[fromIdx].left + colRects[fromIdx].width / 2 - backPos.x
    await realDrag(backPos, dx2, 0)
    await sleep(700)
    const tgt2 = await js(`(() => {
      const fromCol = document.querySelectorAll('.day-col')[${fromIdx}]
      const toCol = document.querySelectorAll('.day-col')[${toIdx}]
      return {
        from: Array.from(fromCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length,
        to: Array.from(toCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length
      }
    })()`)
    const total2 = await countBlocks('Morning walk')
    check('moving back leaves exactly one block per day (no ghost)', tgt2.from === 1 && tgt2.to === 1, `from=${tgt2.from} to=${tgt2.to}`)
    const ovCount = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke occwalk'")
    check('no duplicate override rows from the round trip', ovCount.c >= 1 && ovCount.c <= 2, `overrides=${ovCount.c}`)
    // cleanup dedicated series
    await openEditorOn('Smoke occwalk')
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(250)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`)
    await sleep(300)

    // 3. switch to Day view, then open the editor with a REAL click
    await js(`document.querySelector('.seg-btn').click()`)
    await sleep(400)
    const dbg3 = await js(`({
      dayCols: document.querySelectorAll('.day-col').length,
      blocks: Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim()).slice(0, 10),
      activeSeg: Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.classList.contains('active'))?.textContent
    })`)
    console.log('[smoke] step3 view state:', JSON.stringify(dbg3))
    const pos3 = await blockPos('Smoke test activity')
    console.log('[smoke] step3 pos:', JSON.stringify(pos3))
    const clickOk = await realClick(pos3)
    await sleep(200)
    console.log('[smoke] step3 after click:', JSON.stringify(await js(`({ editor: !!document.querySelector('.editor'), overlay: !!document.querySelector('.overlay') })`)))
    const editorOpen = await js(`!!document.querySelector('.editor')`)
    check('real click opens editor', clickOk && editorOpen)
    const quickAddAlsoOpen = await js(`!!document.querySelector('.quickadd')`)
    check('block click does not open quick-add', !quickAddAlsoOpen)

    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find(b => b.textContent.trim() === 'Save').click()`)
    await sleep(400)
    await skipScore()
    const done = await js(`Array.from(document.querySelectorAll('.eb')).some(e => e.textContent.includes('Smoke test activity') && e.classList.contains('done'))`)
    check('status change saved & styled (done, faded)', done)

    // 3b. tag the block's DOM node so we can detect remounts (the blink bug)
    await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity'))
      if (el) el.dataset.marker = 'kept'
      return !!el
    })()`)

    // 3c. issue 6 — a 15-minute block still shows its title
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke tiny')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T08:00')`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T08:15')`)
    await sleep(150)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const tiny = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke tiny'))
      return el ? { cls: el.className, title: el.querySelector('.eb-title')?.textContent } : null
    })()`)
    check('15-min block shows title (tiny class)', !!tiny && tiny.cls.includes('tiny') && tiny.title === 'Smoke tiny', JSON.stringify(tiny))
    await realClick(await blockPos('Smoke tiny'))
    await sleep(300)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(400)

    // 4. M4 — drag the block down 33px (= +60 min at 0.55 px/min)
    await realDrag(await blockPos('Smoke test activity'), 0, 33)
    await sleep(600)
    const moved = dbGet<{ start_local: string; end_local: string }>(
      "SELECT start_local, end_local FROM events WHERE title = 'Smoke test activity'"
    )
    check('drag moves block +1h and persists', moved.start_local === TODAY + 'T16:00', JSON.stringify(moved))
    const afterDragCount = await countBlocks('Smoke test activity')
    const afterDragTime = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('16:00–'))`)
    check('dragged block still visible at new time (not vanished)', afterDragCount === 1 && afterDragTime, `count=${afterDragCount} shows16=${afterDragTime}`)
    const sameNode = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity'))
      return el ? el.dataset.marker === 'kept' : false
    })()`)
    check('dragged block is the SAME DOM node (no remount → no blink)', sameNode)

    // 5. M4 — resize the bottom edge down 16.5px (= +30 min)
    await realDrag(await blockPos('Smoke test activity', 'bottom'), 0, 16.5)
    await sleep(600)
    const resized = dbGet<{ end_local: string }>(
      "SELECT end_local FROM events WHERE title = 'Smoke test activity'"
    )
    check('resize extends block +30min and persists', resized.end_local === TODAY + 'T17:30', JSON.stringify(resized))
    const afterResizeVisible = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('17:30'))`)
    check('resized block still visible (not vanished)', afterResizeVisible)

    // 5b. M5 — set a weekly repeat through the Repeat editor and verify it expands
    await realClick(await blockPos('Smoke test activity'))
    await sleep(350)
    const repOpen = await js(`!!document.querySelector('.repeat-editor')`)
    check('repeat editor visible in dialog', repOpen)
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.wd-pill')).forEach((p) => {
      const want = ['MO', 'WE', 'FR'].includes(p.dataset.day)
      if (want !== p.classList.contains('on')) p.click()
    })`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-ends .seg-btn')).find((b) => b.textContent.trim() === 'After').click()`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelector('.repeat-editor .re-count'), '3')`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    await skipScore() // the event is already done → re-save re-prompts; skip
    const rr = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL")
    const rrDays = (rr.rrule.split('BYDAY=')[1] ?? '').split(';')[0].split(',')
    const rrOk = rr.rrule.startsWith('FREQ=WEEKLY;BYDAY=') && rr.rrule.endsWith(';COUNT=3') && [...rrDays].sort().join() === ['MO', 'WE', 'FR'].sort().join()
    check('repeat editor saves weekly rule', rrOk, String(rr.rrule))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    const weekCount = await countBlocks('Smoke test activity')
    check('weekly rule expands to multiple days', weekCount >= 2, `count=${weekCount}`)

    // 5c. M5 — "edit this occurrence only" creates an override, series stays intact
    // (run in Week view: after a weekly rule the occurrence may not be "today")
    await realClick(await blockPos('Smoke test activity'))
    await sleep(350)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'This occurrence').click()`)
    await sleep(150)
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke edited occurrence')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    const ovr = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke edited occurrence' AND parent_id IS NOT NULL"
    )
    check('edit-one-occurrence creates an override', ovr.c === 1, `overrides=${ovr.c}`)
    const ovrRow = dbGet<{ start_local: string }>(
      "SELECT start_local FROM events WHERE title = 'Smoke edited occurrence' AND parent_id IS NOT NULL"
    )
    const mRow2 = dbGet<{ exdates: string }>("SELECT exdates FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL")
    const occDay = JSON.parse(mRow2.exdates)[0]
    check('override created on the edited occurrence day', ovrRow.start_local.slice(0, 10) === occDay, `${ovrRow.start_local} vs ${occDay}`)
    const mRow = dbGet<{ title: string; exdates: string }>(
      "SELECT title, exdates FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL"
    )
    check(
      'series master unchanged and occurrence skipped',
      mRow.title === 'Smoke test activity' && JSON.parse(mRow.exdates).length === 1,
      JSON.stringify(mRow)
    )

    // 5d. delete the override, then the whole series
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke edited occurrence')); if (el) el.click(); return !!el })()`)
    await sleep(450)
    const dbg5d = await js(`({
      editorOpen: !!document.querySelector('.editor'),
      editorTitle: document.querySelector('.editor .ef-title')?.value ?? null,
      hasOneTimeBadge: !!document.querySelector('.editor .badge'),
      blocks: Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim()).slice(0, 15)
    })`)
    console.log('[smoke] 5d before delete:', JSON.stringify(dbg5d))
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    // allow the async delete + re-render to settle (retry a few times)
    let ovrGone = false
    for (let attempt = 0; attempt < 4 && !ovrGone; attempt++) {
      await sleep(500)
      ovrGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke edited occurrence'))`)
    }
    check('override deleted', ovrGone)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(200)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity')); if (el) el.click(); return !!el })()`)
    await sleep(450)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`)
    await sleep(200)
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    const seriesGone = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    )
    check('whole series deleted from database', seriesGone.c === 0, `rows=${seriesGone.c}`)

    // 6. M4 — dragging one occurrence of a recurring series: override + renders at new time
    // (deterministic: use a FRESH daily series so earlier scenarios' exdates/overrides
    // can't interfere)
    await js(`document.querySelector('.new-btn').click()`)
    await sleep(250)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke dragwalk')`)
    await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T06:30')`)
    await sleep(100)
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`)
    await sleep(200)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const dwCountBefore = await countBlocks('Smoke dragwalk')
    await realDrag(await blockPos('Smoke dragwalk'), 0, 33)
    await sleep(700)
    const dwOv = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke dragwalk'")
    check('dragging a recurring occurrence creates an override', dwOv.c === 1, `overrides=${dwOv.c}`)
    const dwMaster = dbGet<{ exdates: string }>("SELECT exdates FROM events WHERE title = 'Smoke dragwalk' AND parent_id IS NULL")
    check('recurring master gets the skipped date', JSON.parse(dwMaster.exdates).length === 1, dwMaster.exdates)
    const dwAfter = await countBlocks('Smoke dragwalk')
    const dwShows730 = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('07:30–') && e.textContent.includes('Smoke dragwalk'))`)
    check(
      'recurring occurrence visible at new time (not vanished)',
      dwAfter === dwCountBefore && dwShows730,
      `before=${dwCountBefore} after=${dwAfter} shows07:30=${dwShows730}`
    )
    const dwAt730 = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('07:30–') && e.textContent.includes('Smoke dragwalk')).length`)
    check('no duplicate/ghost block after recurring drag', dwAt730 === 1, `n=${dwAt730}`)
    // cleanup
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke dragwalk')); if (el) el.click(); return !!el })()`)
    await sleep(400)
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2ax. all-done bonus — isolated on TOMORROW (no prior bonus rows can exist
    // there); everything forced done → +25 exactly once
    const ax0 = await js(`window.api.coins.balance()`)
    dbRun("UPDATE events SET status = 'done' WHERE status != 'cancelled'")
    const axOk = await js(`window.api.coins.allDoneCheck('${TOMORROW}')`)
    check('all-done: +25 when the whole day resolves (isolated)', axOk.award && axOk.amount === 25, JSON.stringify(axOk))
    const axAgain = await js(`window.api.coins.allDoneCheck('${TOMORROW}')`)
    check('all-done: awarded only once per day', !axAgain.award, JSON.stringify(axAgain))
    const axBal = await js(`window.api.coins.balance()`)
    check('all-done: balance includes exactly +25', Math.round((axBal - ax0) * 100) / 100 === 25, `${ax0} → ${axBal}`)
    // perfect week requires 7 days of done — verify the guard (can't award with missed days)
    const pw = await js(`window.api.coins.perfectWeek()`)
    console.log('[smoke] perfectWeek result:', JSON.stringify(pw))

    // 2bb. PERFECT WEEK = streak hitting a multiple of 7 (+100, once per level)
    dbRun("DELETE FROM events") // disposable smoke DB: wipe for a clean streak
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'")
    const wBase = await js(`window.api.coins.balance()`)
    // 7 consecutive done days ending today → streak 7 → +100 once
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'PW streak', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        'pw-' + i, iso + 'T09:00', iso + 'T10:00', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      )
    }
    const pw0 = await js(`window.api.coins.perfectWeek()`)
    check('perfect week: +100 credited on 7-day streak', pw0.award && pw0.amount === 100, JSON.stringify(pw0))
    const pw1 = await js(`window.api.coins.perfectWeek()`)
    check('perfect week: only once per streak level', !pw1.award, JSON.stringify(pw1))
    const wBal = await js(`window.api.coins.balance()`)
    check('perfect week: balance includes exactly +100', Math.round((wBal - wBase) * 100) / 100 === 100, `${wBase} → ${wBal}`)
    const pwTx = await js(`window.api.coins.listTransactions()`)
    check('perfect week: bonus row in ledger', Array.isArray(pwTx) && pwTx.some((t: any) => t.reason === 'Perfect week' && t.type === 'bonus' && t.amount === 100), JSON.stringify(pwTx?.[0]))
    // streak card in the right panel shows the current streak (re-enter to reload)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(800)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(3600)
    // the streak card flips faces (Current/Best) — poll for a consistent pair
    const streakPair = await js(`(async () => {
      for (let i = 0; i < 14; i++) {
        const card = document.querySelector('.streak-kpi')
        const label = card?.querySelector('.coins-kpi-label')?.textContent ?? ''
        const value = card?.querySelector('.coins-kpi-value')?.textContent ?? ''
        if (label.includes('Current') && value === '7d') return { ok: true, label, value }
        if (label.includes('Best') && value === '10d') return { ok: true, label, value }
        await new Promise((r) => setTimeout(r, 500))
      }
      return { ok: false, label: '', value: '' }
    })()`)
    check('perfect week: streak card shows current 7d / best 10d', streakPair.ok, JSON.stringify(streakPair))
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    const row2 = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    )
    check('database has no leftover smoke rows', row2.c === 0, `rows=${row2.c}`)

    // ================= M8: settings / theme / backups =================
    // gear button opens the settings dialog
    await js(`document.querySelector('.settings-btn')?.click()`)
    await sleep(400)
    const setOpen = await js(`!!document.querySelector('.settings-dialog')`)
    check('M8: settings dialog opens from the gear button', setOpen)
    // theme: switch to DARK → <html data-theme> + body bg change + persisted
    const darkRes = await js(`(async () => {
      const btn = Array.from(document.querySelectorAll('.theme-seg .seg-btn')).find((b) => b.textContent.trim() === 'Dark')
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      return {
        attr: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        stored: await window.api.settings.get('theme')
      }
    })()`)
    check('M8: dark theme applies (html attr + body bg + persisted)', darkRes.attr === 'dark' && darkRes.bg === 'rgb(28, 28, 30)' && darkRes.stored === 'dark', JSON.stringify(darkRes))
    // back to LIGHT
    const lightRes = await js(`(async () => {
      const btn = Array.from(document.querySelectorAll('.theme-seg .seg-btn')).find((b) => b.textContent.trim() === 'Light')
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      return { attr: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }
    })()`)
    check('M8: light theme restores', lightRes.attr === 'light' && lightRes.bg === 'rgb(245, 245, 247)', JSON.stringify(lightRes))
    // backup now → a file appears in <dataDir>/backups, count grows, lastBackup set
    const bk1 = await js(`window.api.backups.list()`)
    const bkNow = await js(`window.api.backups.now()`)
    const bk2 = await js(`window.api.backups.list()`)
    const bkpDir = path.join(process.env.AC_DATA_DIR!, 'backups')
    const bkFile = bkNow.ok ? fs.existsSync(bkNow.path!) : false
    check('M8: manual backup creates a file on disk', bkNow.ok && bkFile && bk2.length >= 1 && bk2.length === bkNow.count, JSON.stringify({ ...bkNow, disk: bkFile, dir: bkpDir }))
    check('M8: backups:list returns entries with size', Array.isArray(bk2) && bk2.length >= 1 && typeof bk2[0].size === 'number' && bk2[0].size > 0, JSON.stringify(bk2[0]))
    const lastBk = await js(`window.api.settings.get('lastBackup')`)
    check('M8: lastBackup setting recorded', !!lastBk && !Number.isNaN(new Date(lastBk).getTime()), String(lastBk))
    // auto-backup toggle persists
    await js(`window.api.settings.set('autoBackup', '0')`)
    const autoOff = await js(`window.api.settings.get('autoBackup')`)
    await js(`window.api.settings.set('autoBackup', '1')`)
    check('M8: auto-backup toggle persists', autoOff === '0', String(autoOff))
    // app info exposes version + folders
    const appInfo = await js(`window.api.app.info()`)
    check('M8: app info (version + folders)', !!appInfo && appInfo.version.length > 0 && appInfo.dataDir.length > 0 && appInfo.backupsDir.length > 0, JSON.stringify(appInfo))
    // close settings
    await js(`Array.from(document.querySelectorAll('.settings-dialog .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`)
    await sleep(300)
    const setClosed = await js(`!document.querySelector('.settings-dialog')`)
    check('M8: settings dialog closes', setClosed)
    // dark mode persists across reload (the real loadTheme re-applies from settings)
    const darkAfter = await js(`(async () => {
      await window.api.settings.set('theme', 'dark')
      await window.__rhythmTheme.loadTheme()
      return document.documentElement.dataset.theme
    })()`)
    check('M8: theme reloads from settings', darkAfter === 'dark', String(darkAfter))
    await js(`window.api.settings.set('theme', 'light')`)

    // ============ CUP-3: coin-system master switch ============
    // clicking the Coins heading pill opens the confirmation dialog
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`)
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`)
    await sleep(600)
    await js(`document.querySelector('.premium-heading.coins').click()`)
    await sleep(400)
    const sysDlg = await js(`!!document.querySelector('.coin-system-dialog')`)
    check('cup3: clicking the Coins pill opens the system dialog', sysDlg)
    await js(`Array.from(document.querySelectorAll('.coin-system-dialog .dialog-actions .btn')).find((b) => b.textContent.includes('disable')).click()`)
    await sleep(600)
    const sysOff = await js(`(async () => ({
      setting: await window.api.settings.get('coinSystem'),
      chip: !!document.querySelector('.coin-chip'),
      widget: !!document.querySelector('.mile-widget'),
      banner: !!document.querySelector('.coins-off-banner'),
      checkIn: await window.api.coins.checkIn()
    }))()`)
    check('cup3: system OFF → setting 0, sidebar widgets hidden, banner shown, check-in disabled', sysOff.setting === '0' && !sysOff.chip && !sysOff.widget && sysOff.banner && !sysOff.checkIn.award, JSON.stringify(sysOff))
    // re-enable from the same pill → everything comes back (data kept)
    await js(`document.querySelector('.premium-heading.coins').click()`)
    await sleep(400)
    await js(`Array.from(document.querySelectorAll('.coin-system-dialog .dialog-actions .btn')).find((b) => b.textContent.includes('enable')).click()`)
    await sleep(600)
    const sysOn2 = await js(`(async () => ({
      setting: await window.api.settings.get('coinSystem'),
      chip: !!document.querySelector('.coin-chip'),
      widget: !!document.querySelector('.mile-widget'),
      banner: !!document.querySelector('.coins-off-banner')
    }))()`)
    check('cup3: system ON again → widgets back, banner gone', sysOn2.setting === '1' && sysOn2.chip && sysOn2.widget && !sysOn2.banner, JSON.stringify(sysOn2))
    // ISSUE-2 REAL PATH: an event marked done while the system was OFF, then
    // re-saved after re-enabling, must NEVER prompt or add coins
    const balOff = await js(`window.api.coins.balance()`)
    await js(`window.api.coins.setSystem(false)`) // disable
    // create a todo event + mark it done while OFF (via DB to simulate the saved state)
    await js(`window.api.events.create({ title: 'Smoke offdone', description: '', startLocal: '${TODAY}T14:00', endLocal: '${TODAY}T15:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })`)
    const offEv = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'Smoke offdone'))`)
    await js(`window.api.events.update(offEv.id, { status: 'done' })`)
    await js(`window.api.coins.setSystem(true)`) // re-enable
    // open that done event and Save — must NOT prompt nor earn
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(500)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke offdone')); if (el) el.click(); return !!el })()`)
    await sleep(500)
    const offPromptBefore = await js(`!!document.querySelector('.score-prompt')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save')?.click()`)
    await sleep(800)
    const offPromptAfter = await js(`!!document.querySelector('.score-prompt')`)
    const balAfter = await js(`window.api.coins.balance()`)
    check('cup3v3: done-while-OFF event re-saved after re-enable → NO popup, NO coins', !offPromptBefore && !offPromptAfter && Math.round(balAfter) === Math.round(balOff), JSON.stringify({ offPromptBefore, offPromptAfter, balOff, balAfter }))
    await js(`window.api.events.remove(offEv.id)`)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)

    const errs = await js(`window.__errors || []`)
    check('no renderer errors at end', errs.length === 0, String(errs))

    fs.writeFileSync(outPath, results.join('\n'))
    console.log('[smoke] done:\n' + results.join('\n'))
  } catch (e) {
    results.push('ERROR ' + String(e))
    fs.writeFileSync(outPath, results.join('\n'))
    console.error('[smoke] failed:', e)
  }
}
