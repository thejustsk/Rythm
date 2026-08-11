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

  /** Coordinates of a block's grab point (top area, or bottom handle for resize). */
  const blockPos = async (findExpr: string, grab: 'top' | 'bottom' = 'top') => {
    const p = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes(${JSON.stringify(findExpr)}))
      if (!el) return null
      const r = el.getBoundingClientRect()
      const y = ${JSON.stringify(grab)} === 'bottom' ? r.bottom - 4 : r.top + Math.min(6, r.height / 2)
      return { x: Math.round(r.left + r.width / 2), y: Math.round(y) }
    })()`)
    return p
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

    // clicking a label row toggles the filter
    const hiddenBefore = await js(`(${labelRowJs('Sub Smoke')}).classList.contains('hidden')`)
    await js(`(${labelRowJs('Sub Smoke')}).click()`)
    await sleep(300)
    const hiddenAfter = await js(`(${labelRowJs('Sub Smoke')}).classList.contains('hidden')`)
    check('clicking label row toggles filter', !hiddenBefore && hiddenAfter)
    await js(`(${labelRowJs('Sub Smoke')}).click()`)
    await sleep(300)

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
