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
  const js = (code: string) => win.webContents.executeJavaScript(code)

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
    // cleanup: delete the series via the two explicit delete buttons (issue 4)
    await realClick(await blockPos('Smoke weekly qa'))
    await sleep(350)
    const dangerCount = await js(`document.querySelectorAll('.editor .btn.danger').length`)
    check('recurring shows two explicit delete buttons', dangerCount === 2, `n=${dangerCount}`)
    const dbgDel = await js(`(() => {
      const btns = Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())
      const title = document.querySelector('.editor .ef-title')?.value
      return { btns, title, errors: window.__errors || [] }
    })()`)
    console.log('[smoke] delete probe:', JSON.stringify(dbgDel))
    await js(`document.querySelectorAll('.editor .btn.danger')[1].click()`)
    await sleep(600)
    const dbgAfter = await js(`({ editorStillOpen: !!document.querySelector('.editor'), errors: window.__errors || [] })`)
    console.log('[smoke] after delete:', JSON.stringify(dbgAfter))
    const qaGone = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke weekly qa'")
    check('series deleted via explicit button', qaGone.c === 0, `rows=${qaGone.c}`)
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
    await js(`document.querySelectorAll('.editor .btn.danger')[1].click()`) // "Delete series"
    await sleep(500)
    const seriesGone = dbGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    )
    check('whole series deleted from database', seriesGone.c === 0, `rows=${seriesGone.c}`)

    // 6. M4 — dragging one occurrence of a recurring series: override + renders at new time
    await sleep(600)
    await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Morning walk'))
      if (el) el.dataset.marker = 'walkkept'
      return !!el
    })()`)
    const walkCountBefore = await countBlocks('Morning walk')
    await realDrag(await blockPos('Morning walk'), 0, 33)
    await sleep(600)
    const ov = dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE parent_id = 'evt-walk'")
    check('dragging a recurring occurrence creates an override', ov.c === 3, `overrides=${ov.c}`)
    const master = dbGet<{ exdates: string }>("SELECT exdates FROM events WHERE id = 'evt-walk'")
    check('recurring master gets the skipped date', JSON.parse(master.exdates).length === 3, master.exdates)
    const walkCountAfter = await countBlocks('Morning walk')
    const walkShowsNewTime = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('07:30–'))`)
    check(
      'recurring occurrence visible at new time (not vanished)',
      walkCountAfter === walkCountBefore && walkShowsNewTime,
      `before=${walkCountBefore} after=${walkCountAfter} shows07:30=${walkShowsNewTime}`
    )
    const walkSameNode = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('07:30–'))
      return el ? el.dataset.marker === 'walkkept' : false
    })()`)
    check('recurring drag kept the same DOM node (no remount → no blink)', walkSameNode)

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
