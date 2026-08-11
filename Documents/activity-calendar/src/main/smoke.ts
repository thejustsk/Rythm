import { BrowserWindow } from 'electron'
import fs from 'node:fs'
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



  /** A REAL click via the input pipeline (generates a genuine click event). */
  const realClick = async (pos: { x: number; y: number } | null) => {
    if (!pos) return false
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(50)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(250)
    return true
  }

  /** A REAL drag: press, incremental moves, release. */
  const realDrag = async (pos: { x: number; y: number } | null, dx: number, dy: number) => {
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
    const expectedRule = 'FREQ=WEEKLY;BYDAY=' + wantDays.join(',')
    const expectedSummary = 'Every week on ' + wantDays.map((k) => WD_NAMES[WD_KEYS.indexOf(k)]).join(', ')
    const warnShown = await js(`!!document.querySelector('.quickadd .re-warn') && document.querySelector('.quickadd .re-warn').textContent.includes(${JSON.stringify(startDowName)})`)
    check('quickadd repeat warns when start day not selected', warnShown)
    const summaryShown = await js(`(document.querySelector('.quickadd .re-summary')?.textContent ?? '').includes('${expectedSummary}')`)
    check('quickadd repeat shows plain-English summary', summaryShown, expectedSummary)
    const firstChip = await js(`document.querySelector('.quickadd .re-preview-date')?.textContent ?? ''`)
    check('preview shows shifted first occurrence', firstChip === expectedChip, firstChip + ' vs ' + expectedChip)
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
    await sleep(500)
    const rrQa = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke weekly qa'")
    check('quickadd saves the weekly rule', rrQa.rrule === expectedRule, String(rrQa.rrule) + ' vs ' + expectedRule)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    const qaCount = await countBlocks('Smoke weekly qa')
    check('weekly block appears in week view (shifted day)', qaCount >= 1, `count=${qaCount}`)
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
    await realClick(await blockPos('Smoke weekly qa'))
    await sleep(350)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
    const dangerLabels = await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())`)
    check(
      'series mode shows Delete upcoming + Delete series',
      dangerLabels.length === 2 && dangerLabels[0] === 'Delete upcoming' && dangerLabels[1] === 'Delete series',
      JSON.stringify(dangerLabels)
    )
    await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).find((b) => b.textContent.trim() === 'Delete series').click()`)
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
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await realClick(await blockPos('Morning walk'))
    await sleep(350)
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
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
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
    await realClick(await blockPos('Morning walk'))
    await sleep(350)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).find((b) => b.textContent.trim() === 'Delete upcoming').click()`)
    await sleep(600)
    const untilExpected = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const upR = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE id = 'evt-walk'")
    check('delete upcoming sets UNTIL to yesterday', upR.rrule === `FREQ=DAILY;UNTIL=${untilExpected}`, String(upR.rrule))
    const upVis = await countBlocks('Morning walk')
    check('no walk occurrence visible this week after delete upcoming', upVis === 0, `count=${upVis}`)
    const walkToast = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Morning walk') && !!t.querySelector('.toast-action'))?.querySelector('.toast-msg')?.textContent ?? ''`)
    check('toast with Undo appears after delete', walkToast.includes('Morning walk'), walkToast)
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Morning walk'))?.querySelector('.toast-action')?.click()`)
    await sleep(600)
    const upR2 = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE id = 'evt-walk'")
    check('undo restores the series rule', upR2.rrule === 'FREQ=DAILY', String(upR2.rrule))
    const upVis2 = await countBlocks('Morning walk')
    check('undo restores the visible occurrence', upVis2 > 0, `count=${upVis2}`)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2g. issue 5 — only overlapping events split; standalone keeps full width
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`)
    await sleep(400)
    const addQuick = async (title: string, startT: string, endT: string) => {
      await js(`document.querySelector('.new-btn').click()`)
      await sleep(250)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), '${title}')`)
      await js(`(${SET_VALUE})(document.querySelector('.quickadd input[type=datetime-local]'), '${TODAY}T${startT}')`)
      await sleep(100)
      await js(`(${SET_VALUE})(document.querySelectorAll('.quickadd input[type=datetime-local]')[1], '${TODAY}T${endT}')`)
      await sleep(100)
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`)
      await sleep(400)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(500)
    const soloGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke solo'))`)
    check('normal event deleted', soloGone)
    const soloToast = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke solo') && !!t.querySelector('.toast-action'))?.querySelector('.toast-msg')?.textContent ?? ''`)
    check('toast with Undo for normal delete', soloToast.includes('Smoke solo'), soloToast)
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke solo'))?.querySelector('.toast-action')?.click()`)
    await sleep(600)
    const soloBack = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke solo'")
    check('undo restores the event in DB', soloBack.c === 1, `rows=${soloBack.c}`)
    await realClick(await blockPos('Smoke solo'))
    await sleep(300)
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(400)
    // cleanup overlapping test events
    for (const t of ['Smoke ovl A', 'Smoke ovl B']) {
      await realClick(await blockPos(t))
      await sleep(300)
      const hasEditor = await js(`!!document.querySelector('.editor')`)
      if (hasEditor) await js(`document.querySelector('.editor .btn.danger').click()`)
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

    // FIRST click = solo-select: Gym green, everything else dimmed, parent blue +
    await js(`(${labelRowJs('Gym')}).click()`)
    await sleep(300)
    check('first click solo-selects the label (green tick)', (await glyphOf('Gym')) === 'tick')
    check('everything else dimmed/unselected', (await lbHidden('Fitness')) && (await lbHidden('Work')) && (await lbHidden('Personal')))
    check('parent of the solo label shows blue plus', (await glyphOf('Fitness')) === 'plus')
    check('All chip appears', await allChip())
    check('solo label events visible', await gymVisible())
    check('other labels events hidden', !(await walkVisible()))
    check('no red crosses anywhere', !(await anyCross()))

    // afterwards: multi-select — add another dimmed label, then toggle it off
    await js(`(${labelRowJs('Yoga')}).click()`)
    await sleep(300)
    check('multi-select: second label added (green)', (await glyphOf('Yoga')) === 'tick')
    check('first label stays green', (await glyphOf('Gym')) === 'tick')
    await js(`(${labelRowJs('Yoga')}).click()`)
    await sleep(300)
    check('clicking a green label removes it (dimmed)', (await glyphOf('Yoga')) === '' && (await lbHidden('Yoga')))
    check('other stays green', (await glyphOf('Gym')) === 'tick')

    // parent with unselected children (blue +): click selects the whole group
    await js(`(${labelRowJs('Fitness')}).click()`)
    await sleep(300)
    check(
      'parent click when not all children selected → selects all',
      (await glyphOf('Fitness')) === 'tick' &&
        (await glyphOf('Gym')) === 'tick' &&
        (await glyphOf('Yoga')) === 'tick' &&
        (await glyphOf('Walk')) === 'tick',
      `F=${await glyphOf('Fitness')} G=${await glyphOf('Gym')} Y=${await glyphOf('Yoga')} W=${await glyphOf('Walk')}`
    )
    check('no blue plus left', !(await js(`!!document.querySelector('.lb-check.plus')`)))
    check('group events visible', (await gymVisible()) && (await walkVisible()))

    // fully-selected parent click → deselects group; since everything else was
    // already hidden, the guard snaps back to all-selected (never all-hidden)
    await js(`(${labelRowJs('Fitness')}).click()`)
    await sleep(300)
    check('fully-selected parent click → guard returns to all-selected', !(await anyGlyph()) && !(await allChip()))
    check('guard: never all-hidden, no glyphs', !(await anyGlyph()))
    check('all events visible again', (await gymVisible()) && (await walkVisible()))
    check('All chip disappears', !(await allChip()))

    // first click on a parent from pristine = solo-select the whole group
    await js(`(${labelRowJs('Work')}).click()`)
    await sleep(300)
    check(
      'first click on parent solo-selects group',
      (await glyphOf('Work')) === 'tick' && (await glyphOf('Project A')) === 'tick' && (await glyphOf('Meetings')) === 'tick',
      `W=${await glyphOf('Work')} P=${await glyphOf('Project A')} M=${await glyphOf('Meetings')}`
    )
    check('others dimmed', (await lbHidden('Fitness')) && (await lbHidden('Personal')))
    check('group events visible, others hidden', (await deepVisible()) && !(await walkVisible()))

    // All chip resets everything → pristine
    await js(`document.querySelector('.all-chip').click()`)
    await sleep(300)
    check('All chip clears all hidden', !(await lbHidden('Work')) && !(await lbHidden('Fitness')))
    check('default restored: no glyphs', !(await anyGlyph()))
    check('all events visible again after reset', (await gymVisible()) && (await walkVisible()))
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
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
    await sleep(600)
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
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
        switcher: Array.from(document.querySelectorAll('.segmented .seg-btn')).some((b) => b.textContent.trim() === 'Insights')
      }
    })()`)
    check('insights collapses sidebar & pills, hides search/add/today/title', chrome.sidebarCollapsed && chrome.pillsGone && !chrome.search && !chrome.addBtn && !chrome.todayBtn && !chrome.title && chrome.switcher, JSON.stringify(chrome))
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
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(400)
    // revert the series title (in whole-series mode)
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke reading series')); if (el) el.scrollIntoView({ block: 'center' }); return !!el })()`)
    await sleep(250)
    await realClick(await blockPos('Smoke reading series'))
    await sleep(350)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
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
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
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
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(150)
    await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).find((b) => b.textContent.trim() === 'Delete series').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(400)

    // 2t. animated transitions: viewIn animation + sidebar collapses/expands
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
      await js(`document.querySelector('.editor .btn.danger').click()`)
      await sleep(400)
    }

    // 2v. status change must NEVER vanish the block (serious fix)
    await addQ('Smoke vanish', '15:00', '16:00')
    await realClick(await blockPos('Smoke vanish'))
    await sleep(300)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
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
      if (ok && open) await js(`document.querySelector('.editor .btn.danger').click()`)
      await sleep(500)
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2w. dice KPI cards: 4 cards, faces cascade right→left, flip animation
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
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
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
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
    if (n2Del) await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(500)

    // 2ad. insights bleed: sticky header must stay put and opaque while scrolling
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
    // (this is the disappear case the user reports)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(500)
    const wBefore = dbGet<{ start_local: string; end_local: string; rrule: string }>("SELECT start_local, end_local, rrule FROM events WHERE id = 'evt-walk'")
    // click a LATER day's walk (day+1) in week view
    const d1 = new Date(Date.now() + 1 * 86400000)
    const d1Iso = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')}`
    const walkLater = await js(`(() => { const col = document.querySelector('.day-col[data-day="${d1Iso}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Morning walk')); if (!el) return null; el.click(); return true })()`)
    await sleep(400)
    const wEd = await js(`({ editor: !!document.querySelector('.editor'), startVal: document.querySelectorAll('.editor input[type=datetime-local]')[0]?.value ?? '', applyTo: Array.from(document.querySelectorAll('.apply-to .seg-btn')).map((b) => b.textContent.trim()) })`)
    check('series edit opens on the later day', wEd.editor && wEd.startVal.startsWith(d1Iso), JSON.stringify(wEd))
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
    // change ONLY the time (keep dates as-is in the form)
    const tStart = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[0].value`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[0], '${'${tStart.slice(0, 10)}T07:00'}')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${'${tStart.slice(0, 10)}T07:45'}')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const wAfter = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE id = 'evt-walk'")
    check('series time edit keeps the SERIES start date (no vanish)', wAfter.start_local.slice(0, 10) === wBefore.start_local.slice(0, 10), `${wAfter.start_local} vs ${wBefore.start_local}`)
    const wDates = await js(`(() => { const cols = Array.from(document.querySelectorAll('.day-col')).map((c) => c.getAttribute('data-day')); return cols.filter((d, i) => i < 4 && Array.from(document.querySelectorAll('.day-col')[i].querySelectorAll('.eb')).some((e) => e.textContent.includes('Morning walk'))).length })()`)
    check('earlier days still show the walk', wDates >= 2, String(wDates))
    // revert the time
    await realClick(await blockPos('Morning walk'))
    await sleep(300)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[0], '${'${wBefore.start_local.slice(0, 10)}T06:30'}')`)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor input[type=datetime-local]')[1], '${'${wBefore.start_local.slice(0, 10)}T07:15'}')`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(700)
    const wRevert = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE id = 'evt-walk'")
    check('series time reverted', wRevert.start_local === wBefore.start_local, wRevert.start_local)

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
    if (visDel2) await js(`document.querySelector('.editor .btn.danger').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2ak. premium Insights heading (shining blue border)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Insights').click()`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(500)
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`)
    await sleep(150)

    // 2j. bug 2 — the editor must show the SELECTED occurrence's date,
    // not the series' start date; a "This occurrence" status edit lands on that day
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await realClick(await blockPos('Morning walk'))
    await sleep(350)
    const edStart = await js(`document.querySelector('.editor input[type=datetime-local]')?.value ?? ''`)
    const edEnd = await js(`document.querySelectorAll('.editor input[type=datetime-local]')[1]?.value ?? ''`)
    check('editor shows the selected occurrence date', edStart === `${TODAY}T06:30`, `${edStart} vs ${TODAY}T06:30`)
    check('editor end matches the selected occurrence', edEnd === `${TODAY}T07:15`, edEnd)
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'doing')`)
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(500)
    const stOv = dbGet<{ start_local: string }>("SELECT start_local FROM events WHERE parent_id = 'evt-walk' AND status = 'doing'")
    check('status override created on the occurrence day', !!stOv && stOv.start_local.startsWith(TODAY), JSON.stringify(stOv))
    await realClick(await blockPos('Morning walk'))
    await sleep(300)
    await js(`document.querySelector('.editor .btn.danger').click()`)
    await sleep(400)

    // 2i. bug 1 — move a recurring occurrence onto a day that already has the
    // same event (→ both show, no glitch), then move it back (→ no ghost)
    await sleep(300)
    const walkPos = await blockPos('Morning walk')
    const colRects = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width } })`)
    const fromIdx = colRects.findIndex((r: { left: number; width: number }) => walkPos.x >= r.left && walkPos.x < r.left + r.width)
    const toIdx = Math.min(fromIdx + 1, colRects.length - 1)
    const dx1 = colRects[toIdx].left + colRects[toIdx].width / 2 - walkPos.x
    const beforeTotal = await countBlocks('Morning walk')
    await realDrag(walkPos, dx1, 0)
    await sleep(700)
    const tgt1 = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      return {
        all: col.querySelectorAll('.eb').length,
        walks: Array.from(col.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Morning walk')).length
      }
    })()`)
    // the target day also has other seeded events — the key check is that BOTH
    // walk blocks render side by side (no duplicate-key glitch/ghost)
    check('moving onto a day that already has the event → both blocks render', tgt1.walks === 2, JSON.stringify(tgt1))
    const backPos = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Morning walk'))
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
        from: Array.from(fromCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Morning walk')).length,
        to: Array.from(toCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Morning walk')).length
      }
    })()`)
    const total2 = await countBlocks('Morning walk')
    check('moving back leaves exactly one block per day (no ghost)', tgt2.from === 1 && tgt2.to === 1 && total2 === beforeTotal, `from=${tgt2.from} to=${tgt2.to} total=${total2} before=${beforeTotal}`)
    const ovCount = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE parent_id = 'evt-walk'")
    check('no extra override rows from the round trip', ovCount.c === 3, `overrides=${ovCount.c}`)
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
    await js(`document.querySelector('.editor .btn.danger').click()`)
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
    const rr = dbGet<{ rrule: string }>("SELECT rrule FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL")
    check('repeat editor saves weekly rule', rr.rrule === 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3', String(rr.rrule))
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
    await realClick(await blockPos('Smoke edited occurrence'))
    await sleep(350)
    const dbg5d = await js(`({
      editorOpen: !!document.querySelector('.editor'),
      editorTitle: document.querySelector('.editor .ef-title')?.value ?? null,
      hasOneTimeBadge: !!document.querySelector('.editor .badge'),
      blocks: Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim()).slice(0, 15)
    })`)
    console.log('[smoke] 5d before delete:', JSON.stringify(dbg5d))
    await js(`document.querySelector('.editor .btn.danger').click()`)
    // allow the async delete + re-render to settle (retry a few times)
    let ovrGone = false
    for (let attempt = 0; attempt < 4 && !ovrGone; attempt++) {
      await sleep(500)
      ovrGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke edited occurrence'))`)
    }
    check('override deleted', ovrGone)
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`)
    await sleep(400)
    await realClick(await blockPos('Smoke test activity'))
    await sleep(350)
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'Whole series').click()`)
    await sleep(200)
    await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).find((b) => b.textContent.trim() === 'Delete series').click()`)
    await sleep(500)
    const seriesGone = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    )
    check('whole series deleted from database', seriesGone.c === 0, `rows=${seriesGone.c}`)

    // 6. M4 — dragging one occurrence of a recurring series: override + renders at new time
    await sleep(600)
    const walkCountBefore = await countBlocks('Morning walk')
    await realDrag(await blockPos('Morning walk'), 0, 33)
    await sleep(600)
    const ov = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE parent_id = 'evt-walk'")
    check('dragging a recurring occurrence creates an override', ov.c === 3, `overrides=${ov.c}`)
    const master = dbGet<{ exdates: string }>("SELECT exdates FROM events WHERE id = 'evt-walk'")
    // seed(2) + today's status-override (2j) + the moved-back day (2i) = 4 skipped dates
    check('recurring master keeps all skipped dates', JSON.parse(master.exdates).length === 4, master.exdates)
    const walkCountAfter = await countBlocks('Morning walk')
    const walkShowsNewTime = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('07:30–'))`)
    check(
      'recurring occurrence visible at new time (not vanished)',
      walkCountAfter === walkCountBefore && walkShowsNewTime,
      `before=${walkCountBefore} after=${walkCountAfter} shows07:30=${walkShowsNewTime}`
    )
    const walksAt730 = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('07:30–')).length`)
    check('no duplicate/ghost block after recurring drag', walksAt730 === 1, `n=${walksAt730}`)

    const row2 = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    )
    check('database has no leftover smoke rows', row2.c === 0, `rows=${row2.c}`)

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
