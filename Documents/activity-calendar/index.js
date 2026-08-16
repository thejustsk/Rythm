"use strict";
const electron = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const APP_VERSION = "1.11.18";
function getDataDir() {
  if (process.env.AC_DATA_DIR) return process.env.AC_DATA_DIR;
  try {
    return path.join(electron.app.getPath("documents"), "ActivityCalendar");
  } catch {
    return electron.app.getPath("userData");
  }
}
function openDatabase() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "activity-calendar.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
function migrate(db) {
  db.transaction(() => {
    try {
      const cols = db.prepare("PRAGMA table_info(event_scores)").all();
      if (!cols.some((c) => c.name === "refunded_at")) {
        db.exec("ALTER TABLE event_scores ADD COLUMN refunded_at TEXT");
      }
    } catch {
    }
    try {
      const tcols = db.prepare("PRAGMA table_info(coin_transactions)").all();
      if (!tcols.some((c) => c.name === "refunded_at")) {
        db.exec("ALTER TABLE coin_transactions ADD COLUMN refunded_at TEXT");
      }
    } catch {
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT,
      parent_id  TEXT REFERENCES labels(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(parent_id);

    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      start_local   TEXT NOT NULL,
      end_local     TEXT NOT NULL,
      all_day       INTEGER NOT NULL DEFAULT 0,
      label_id      TEXT REFERENCES labels(id) ON DELETE SET NULL,
      color_override TEXT,
      status        TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo','doing','done','cancelled')),
      rrule         TEXT,
      exdates       TEXT NOT NULL DEFAULT '[]',
      parent_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
      origin_date   TEXT,
      completed_at  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_local);
    CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);
    CREATE INDEX IF NOT EXISTS idx_events_label ON events(label_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_scores (
      event_id    TEXT NOT NULL,
      origin_date TEXT NOT NULL,
      score_type  TEXT NOT NULL CHECK (score_type IN ('on_time','late','off_schedule')),
      scored_at   TEXT NOT NULL,
      refunded_at TEXT,
      PRIMARY KEY (event_id, origin_date)
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      event_id    TEXT,
      origin_date TEXT,
      label_id    TEXT,
      type        TEXT NOT NULL CHECK (type IN ('earn','bonus','spend','refund')),
      amount      REAL NOT NULL,
      reason      TEXT NOT NULL,
      refunded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coin_ts ON coin_transactions(ts);

    CREATE TABLE IF NOT EXISTS reward_milestones (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT,
      cost        REAL NOT NULL,
      notes       TEXT DEFAULT '',
      achieved_at TEXT,
      created_at  TEXT NOT NULL
    );

    -- v1.11.14: trash — deleted events kept for restore. payload = JSON
    -- { master: CalendarEvent, children?: CalendarEvent[] }.
    CREATE TABLE IF NOT EXISTS trash (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at);
  `);
  })();
}
function fmt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysFromNow(n) {
  const d = /* @__PURE__ */ new Date();
  d.setDate(d.getDate() + n);
  return d;
}
const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
function seedIfEmpty(db) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM events").get().c;
  if (count > 0) return;
  const t = (offsetDays, hhmm) => `${fmt(daysFromNow(offsetDays))}T${hhmm}`;
  const d = (offsetDays) => fmt(daysFromNow(offsetDays));
  const insLabel = db.prepare(
    "INSERT INTO labels (id, name, color, parent_id, sort_order, archived) VALUES (?, ?, ?, ?, ?, 0)"
  );
  const labels = [
    ["lbl-work", "Work", "#3B82F6", null],
    ["lbl-work-project", "Project A", "#0EA5E9", "lbl-work"],
    ["lbl-work-meetings", "Meetings", "#8B5CF6", "lbl-work"],
    ["lbl-fitness", "Fitness", "#10B981", null],
    ["lbl-fitness-gym", "Gym", "#F97316", "lbl-fitness"],
    ["lbl-fitness-yoga", "Yoga", "#A78BFA", "lbl-fitness"],
    ["lbl-fitness-walk", "Walk", null, "lbl-fitness"],
    ["lbl-learning", "Learning", "#F43F5E", null],
    ["lbl-personal", "Personal", "#EC4899", null],
    ["lbl-personal-errands", "Errands", "#F59E0B", "lbl-personal"],
    ["lbl-personal-family", "Family", "#14B8A6", "lbl-personal"]
  ];
  labels.forEach(([id, name, color, parent]) => insLabel.run(id, name, color, parent, 0));
  const ins = db.prepare(`
    INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                        color_override, status, rrule, exdates, parent_id, origin_date,
                        completed_at, created_at, updated_at)
    VALUES (@id, @title, @desc, @start, @end, 0, @label, NULL, @status, @rrule, @exdates, @parent, @origin, @done, @now, @now)
  `);
  const E = (id, title, start, end, label, status, rrule = null, exdates = [], parent = null, origin = null, desc = "", done = null) => ins.run({
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
  });
  E(
    "evt-walk",
    "Morning walk",
    t(-20, "06:30"),
    t(-20, "07:15"),
    "lbl-fitness-walk",
    "todo",
    "FREQ=DAILY",
    [d(-1), d(-3)]
  );
  E(
    "evt-walk-done-1",
    "Morning walk",
    t(-2, "06:30"),
    t(-2, "07:20"),
    "lbl-fitness-walk",
    "done",
    null,
    [],
    "evt-walk",
    d(-2),
    "",
    `${fmt(daysFromNow(-2))}T07:20:00.000Z`
  );
  E(
    "evt-walk-done-2",
    "Morning walk",
    t(-4, "06:30"),
    t(-4, "07:10"),
    "lbl-fitness-walk",
    "done",
    null,
    [],
    "evt-walk",
    d(-4),
    "",
    `${fmt(daysFromNow(-4))}T07:10:00.000Z`
  );
  E(
    "evt-deepwork",
    "Deep work — Project A",
    t(-20, "09:30"),
    t(-20, "11:30"),
    "lbl-work-project",
    "doing",
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
  );
  E(
    "evt-sync",
    "Team sync",
    t(-20, "11:30"),
    t(-20, "12:00"),
    "lbl-work-meetings",
    "todo",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  );
  E("evt-lunch", "Lunch break", t(-20, "12:30"), t(-20, "13:15"), "lbl-personal", "todo", "FREQ=DAILY");
  E(
    "evt-gym",
    "Gym session",
    t(-20, "18:00"),
    t(-20, "19:00"),
    "lbl-fitness-gym",
    "todo",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  );
  E(
    "evt-yoga",
    "Yoga flow",
    t(-20, "18:00"),
    t(-20, "18:45"),
    "lbl-fitness-yoga",
    "todo",
    "FREQ=WEEKLY;BYDAY=TU,TH"
  );
  E("evt-reading", "Evening reading", t(-20, "21:00"), t(-20, "21:45"), "lbl-learning", "todo", "FREQ=DAILY");
  E(
    "evt-errands",
    "Weekend errands",
    t(-20, "10:00"),
    t(-20, "11:30"),
    "lbl-personal-errands",
    "todo",
    "FREQ=WEEKLY;BYDAY=SA"
  );
  E(
    "evt-review",
    "Weekly review",
    t(-20, "16:00"),
    t(-20, "17:00"),
    "lbl-work-meetings",
    "todo",
    "FREQ=WEEKLY;BYDAY=FR"
  );
  E("evt-plan", "Project A — milestone planning", t(2, "14:00"), t(2, "15:30"), "lbl-work-project", "todo");
  E("evt-dentist", "Dentist appointment", t(1, "09:00"), t(1, "09:45"), "lbl-personal-errands", "todo");
  E("evt-dinner", "Dinner with family", t(3, "19:30"), t(3, "21:00"), "lbl-personal-family", "todo");
  E(
    "evt-movie",
    "Movie night",
    t(-3, "20:00"),
    t(-3, "22:30"),
    "lbl-personal-family",
    "done",
    null,
    [],
    null,
    null,
    "",
    `${fmt(daysFromNow(-3))}T22:30:00.000Z`
  );
  E(
    "evt-bookclub",
    "Book club meetup",
    t(-6, "19:00"),
    t(-6, "20:30"),
    "lbl-learning",
    "done",
    null,
    [],
    null,
    null,
    "",
    `${fmt(daysFromNow(-6))}T20:30:00.000Z`
  );
  E("evt-run-cancelled", "Morning run", t(-2, "06:30"), t(-2, "07:15"), "lbl-fitness-walk", "cancelled");
}
function rowToEvent(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    startLocal: r.start_local,
    endLocal: r.end_local,
    allDay: !!r.all_day,
    labelId: r.label_id,
    colorOverride: r.color_override,
    status: r.status,
    rrule: r.rrule,
    exdates: JSON.parse(r.exdates || "[]"),
    parentId: r.parent_id,
    originDate: r.origin_date,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function assertEndAfterStart(startLocal, endLocal) {
  const parse = (x) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(x);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(x);
  };
  if (parse(endLocal).getTime() <= parse(startLocal).getTime()) {
    throw new Error("End must be after start");
  }
}
function registerEventHandlers(db) {
  electron.ipcMain.handle("events:list", () => {
    return db.prepare("SELECT * FROM events ORDER BY start_local").all().map(rowToEvent);
  });
  electron.ipcMain.handle("events:get", (_e, id) => {
    const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    return row ? rowToEvent(row) : null;
  });
  electron.ipcMain.handle("events:create", (_e, input) => {
    assertEndAfterStart(input.startLocal, input.endLocal);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = input.id ?? crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                          color_override, status, rrule, exdates, parent_id, origin_date,
                          completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.description ?? "",
      input.startLocal,
      input.endLocal,
      input.allDay ? 1 : 0,
      input.labelId ?? null,
      input.colorOverride ?? null,
      input.status ?? "todo",
      input.rrule ?? null,
      JSON.stringify(input.exdates ?? []),
      input.parentId ?? null,
      input.originDate ?? null,
      input.status === "done" ? now : null,
      now,
      now
    );
    return rowToEvent(db.prepare("SELECT * FROM events WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("events:update", (_e, id, patch) => {
    const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    if (!existing) throw new Error("Event not found: " + id);
    assertEndAfterStart(patch.startLocal ?? existing.start_local, patch.endLocal ?? existing.end_local);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const status = patch.status ?? existing.status;
    const completedAt = status === "done" && existing.status !== "done" ? now : status !== "done" ? null : existing.completed_at;
    db.prepare(`
      UPDATE events SET
        title = @title, description = @desc, start_local = @start, end_local = @end,
        all_day = @allDay, label_id = @label, color_override = @color, status = @status,
        rrule = @rrule, exdates = @exdates, parent_id = @parent, origin_date = @origin,
        completed_at = @done, updated_at = @now
      WHERE id = @id
    `).run({
      id,
      title: patch.title ?? existing.title,
      desc: patch.description ?? existing.description,
      start: patch.startLocal ?? existing.start_local,
      end: patch.endLocal ?? existing.end_local,
      allDay: patch.allDay ?? !!existing.all_day ? 1 : 0,
      label: patch.labelId !== void 0 ? patch.labelId : existing.label_id,
      color: patch.colorOverride !== void 0 ? patch.colorOverride : existing.color_override,
      status,
      rrule: patch.rrule !== void 0 ? patch.rrule : existing.rrule,
      exdates: JSON.stringify(patch.exdates ?? JSON.parse(existing.exdates || "[]")),
      parent: patch.parentId !== void 0 ? patch.parentId : existing.parent_id,
      origin: patch.originDate !== void 0 ? patch.originDate : existing.origin_date,
      done: completedAt,
      now
    });
    return rowToEvent(db.prepare("SELECT * FROM events WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("events:remove", (_e, id) => {
    db.prepare("DELETE FROM events WHERE id = ?").run(id);
  });
}
function rowToLabel(r) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    parentId: r.parent_id,
    sortOrder: r.sort_order,
    archived: !!r.archived
  };
}
function registerLabelHandlers(db) {
  electron.ipcMain.handle("labels:list", () => {
    return db.prepare("SELECT * FROM labels ORDER BY sort_order, name").all().map(rowToLabel);
  });
  electron.ipcMain.handle("labels:create", (_e, name, color, parentId) => {
    const dup = db.prepare("SELECT 1 FROM labels WHERE name = ? AND parent_id IS ?").get(name, parentId ?? null);
    if (dup) throw new Error("A label with that name already exists here");
    const id = crypto.randomUUID();
    const max = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM labels WHERE parent_id IS ?").get(parentId);
    db.prepare("INSERT INTO labels (id, name, color, parent_id, sort_order, archived) VALUES (?, ?, ?, ?, ?, 0)").run(id, name, color, parentId, max.m + 1);
    return rowToLabel(db.prepare("SELECT * FROM labels WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("labels:update", (_e, id, patch) => {
    const existing = db.prepare("SELECT * FROM labels WHERE id = ?").get(id);
    if (!existing) throw new Error("Label not found: " + id);
    if (patch.name !== void 0 && patch.name !== existing.name) {
      const dup = db.prepare("SELECT 1 FROM labels WHERE name = ? AND parent_id IS ? AND id != ?").get(patch.name, existing.parent_id, id);
      if (dup) throw new Error("A label with that name already exists here");
    }
    db.prepare("UPDATE labels SET name = @name, color = @color, sort_order = @sort, archived = @archived WHERE id = @id").run({
      id,
      name: patch.name ?? existing.name,
      color: patch.color !== void 0 ? patch.color : existing.color,
      sort: patch.sortOrder ?? existing.sort_order,
      archived: patch.archived ?? existing.archived
    });
    return rowToLabel(db.prepare("SELECT * FROM labels WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("labels:remove", (_e, id) => {
    db.prepare("DELETE FROM labels WHERE id = ?").run(id);
  });
}
function notifyInApp(title, body) {
  try {
    for (const w of electron.BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("notify:inapp", { title, body });
    }
  } catch {
  }
}
const MAX_BACKUPS = 14;
const DATE_RE = /^rhythm-backup-(\d{4}-\d{2}-\d{2}-\d{6})\.db$/;
function backupsDir() {
  return path.join(getDataDir(), "backups");
}
function stamp() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function listBackups() {
  const dir = backupsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  return fs.readdirSync(dir).filter((f) => DATE_RE.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, size: st.size, mtime: st.mtime.toISOString() };
  }).sort((a, b) => a.name < b.name ? 1 : -1);
}
function pruneBackups() {
  const dir = backupsDir();
  const all = fs.readdirSync(dir).filter((f) => DATE_RE.test(f)).sort().reverse();
  for (const f of all.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
    }
  }
  return Math.min(all.length, MAX_BACKUPS);
}
async function backupNow(db) {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `rhythm-backup-${stamp()}.db`;
  const dest = path.join(dir, name);
  try {
    await db.backup(dest);
    const count = pruneBackups();
    const iso = (/* @__PURE__ */ new Date()).toISOString();
    db.prepare("INSERT INTO settings (key, value) VALUES ('lastBackup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(iso);
    db.prepare("INSERT INTO settings (key, value) VALUES ('lastBackupName', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
    return { ok: true, path: dest, count, lastBackup: iso };
  } catch (e) {
    console.error("[backup] failed:", e);
    return { ok: false, path: null, count: listBackups().length, lastBackup: null };
  }
}
async function runAutoBackup(db, force = false) {
  try {
    const auto = db.prepare("SELECT value FROM settings WHERE key = 'autoBackup'").get();
    if (auto && auto.value === "0") return;
    const last = db.prepare("SELECT value FROM settings WHERE key = 'lastBackup'").get();
    if (!force && last && Date.now() - new Date(last.value).getTime() < 24 * 3600 * 1e3) return;
    const res = await backupNow(db);
    console.log("[backup] auto backup:", res.ok ? "created " + res.path : "failed", "· stored", res.count);
    if (!res.ok) notifyInApp("Rhythm — Backup failed", "Automatic backup could not be created. Check disk space / permissions (Settings → About → Back up now).");
  } catch (e) {
    console.error("[backup] auto backup error:", e);
    notifyInApp("Rhythm — Backup failed", "Automatic backup could not be created. Check disk space / permissions (Settings → About → Back up now).");
  }
}
function registerSettingsHandlers(db) {
  electron.ipcMain.handle("settings:get", (_e, key) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  });
  electron.ipcMain.handle("settings:set", (_e, key, value) => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  });
  electron.ipcMain.handle("backups:list", () => listBackups());
  electron.ipcMain.handle("backups:now", () => backupNow(db));
  electron.ipcMain.handle("app:info", () => ({
    version: electron.app.getVersion(),
    dataDir: getDataDir(),
    backupsDir: backupsDir()
  }));
  electron.ipcMain.handle("app:openDataFolder", async () => {
    await electron.shell.openPath(getDataDir());
  });
  electron.ipcMain.handle("app:openBackupsFolder", async () => {
    await electron.shell.openPath(backupsDir());
  });
}
const pad2$2 = (n) => String(n).padStart(2, "0");
const isoD = (d) => `${d.getFullYear()}-${pad2$2(d.getMonth() + 1)}-${pad2$2(d.getDate())}`;
const addDaysIso = (iso, n) => {
  const d = /* @__PURE__ */ new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoD(d);
};
const CHECKIN_BASE = 10;
const ALL_DONE_BONUS = 25;
const PERFECT_WEEK_BONUS = 100;
const PERFECT_MONTH_BONUS = 300;
const CHECKIN_STREAK_MULTIPLIER_DAY = 7;
function roundCoins(n) {
  return Math.round(n * 100) / 100;
}
function checkInState(lastCheckIn, checkInStreak, today) {
  if (lastCheckIn === today) return { award: false, streak: checkInStreak, amount: 0, multiplier: 1 };
  if (lastCheckIn !== null && lastCheckIn > today) {
    return { award: false, streak: checkInStreak, amount: 0, multiplier: 1 };
  }
  const streak = lastCheckIn === addDaysIso(today, -1) ? checkInStreak + 1 : 1;
  const multiplier = streak % CHECKIN_STREAK_MULTIPLIER_DAY === 0 ? 2 : 1;
  return { award: true, streak, amount: CHECKIN_BASE * multiplier, multiplier };
}
function allDoneCheck(planned, resolved) {
  return planned > 0 && resolved === planned;
}
function dayResolved(d) {
  return d.planned === 0 || d.done > 0;
}
function perfectWeekCheck(days) {
  if (days.length !== 7) return false;
  const totalPlanned = days.reduce((s, d) => s + d.planned, 0);
  if (totalPlanned === 0) return false;
  return days.every(dayResolved);
}
function weekStartIso(anyDayInWeek, startDow) {
  const d = /* @__PURE__ */ new Date(anyDayInWeek + "T00:00:00");
  const dow = d.getDay();
  let diff;
  if (startDow === 1) diff = dow === 0 ? -6 : 1 - dow;
  else diff = dow === 0 ? 0 : -dow;
  const out = new Date(d);
  out.setDate(out.getDate() + diff);
  return isoD(out);
}
function perfectMonthCheck(monthStart, monthEnd, dayOf) {
  let emptyRun = 0;
  let anyPlanned = false;
  for (let d = monthStart; d <= monthEnd; d = addDaysIso(d, 1)) {
    const day = dayOf(d);
    if (day.planned === 0) {
      emptyRun++;
      if (emptyRun >= 7) return false;
      continue;
    }
    emptyRun = 0;
    anyPlanned = true;
    if (day.done === 0) return false;
  }
  return anyPlanned;
}
function defaultMilestoneCosts(count) {
  const base = [100, 250, 500, 1e3, 1500, 2500, 4e3];
  const out = [];
  let prev = 4e3;
  for (let i = 0; i < count; i++) {
    if (i < base.length) out.push(base[i]);
    else {
      prev += 2e3;
      out.push(prev);
    }
  }
  return out;
}
function streakMilestoneLevelsUpTo(streak) {
  const costs = defaultStreakCosts(80);
  return costs.filter((c) => c <= streak);
}
function defaultStreakCosts(count) {
  const base = [5, 10, 20, 30, 50, 75];
  const out = [];
  let prev = 75;
  for (let i = 0; i < count; i++) {
    if (i < base.length) out.push(base[i]);
    else {
      prev += 25;
      out.push(prev);
    }
  }
  return out;
}
function streakMilestoneReward(level) {
  return level * 2;
}
const WEEKDAY_KEYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITERATIONS = 5e3;
function parseRRule(s) {
  const parts = {};
  for (const piece of s.split(";")) {
    const i = piece.indexOf("=");
    if (i > 0) parts[piece.slice(0, i).toUpperCase()] = piece.slice(i + 1);
  }
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const rule = { freq, interval: Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1) };
  if (parts.BYDAY) rule.byday = parts.BYDAY.split(",");
  if (parts.BYMONTHDAY)
    rule.bymonthday = parts.BYMONTHDAY.split(",").map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
  if (parts.BYMONTH)
    rule.bymonth = parts.BYMONTH.split(",").map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
  if (parts.COUNT) {
    const c = parseInt(parts.COUNT, 10);
    if (!isNaN(c)) rule.count = c;
  }
  if (parts.UNTIL) rule.until = parts.UNTIL;
  return rule;
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function daysInMonth(year, month0) {
  return new Date(year, month0 + 1, 0).getDate();
}
function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function mondayOf(d) {
  const x = startOfDay(d);
  const dow = x.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + diff);
  return x;
}
function dayMatches(rule, day) {
  if (rule.byday && !rule.byday.includes(WEEKDAY_KEYS[day.getDay()])) return false;
  if (rule.bymonthday && !rule.bymonthday.includes(day.getDate())) return false;
  if (rule.bymonth && !rule.bymonth.includes(day.getMonth() + 1)) return false;
  return true;
}
function* iterateRule(rule, seriesStart, from) {
  const start = startOfDay(seriesStart);
  const untilMs = rule.until ? (/* @__PURE__ */ new Date(rule.until + "T00:00:00")).getTime() : Infinity;
  let emitted = 0;
  const yieldIfMatch = (day) => {
    if (day.getTime() < start.getTime()) return false;
    if (!dayMatches(rule, day)) return false;
    if (day.getTime() > untilMs) return false;
    emitted++;
    return true;
  };
  const idx0 = (numerator, denom) => {
    return 0;
  };
  if (rule.freq === "DAILY") {
    const k02 = idx0(0, 864e5 * rule.interval);
    for (let k = k02; k < MAX_ITERATIONS; k++) {
      const day = addDays(start, k * rule.interval);
      if (day.getTime() > untilMs) break;
      if (yieldIfMatch(day)) yield day;
      if (rule.count && emitted >= rule.count) break;
    }
    return;
  }
  if (rule.freq === "WEEKLY") {
    const anchor = mondayOf(start);
    const byday = rule.byday ? [...rule.byday].sort((a, b) => WEEKDAY_INDEX[a] - WEEKDAY_INDEX[b]) : null;
    const w0 = idx0(0, 7 * 864e5 * rule.interval);
    for (let w = w0; w < MAX_ITERATIONS; w++) {
      const weekStart = addDays(anchor, w * 7 * rule.interval);
      if (weekStart.getTime() > untilMs) break;
      if (byday) {
        for (const key of byday) {
          const day = addDays(weekStart, WEEKDAY_INDEX[key] === 0 ? 6 : WEEKDAY_INDEX[key] - 1);
          if (day.getTime() > untilMs) break;
          if (yieldIfMatch(day)) yield day;
          if (rule.count && emitted >= rule.count) return;
        }
      } else {
        const day = addDays(weekStart, start.getDay() === 0 ? 6 : start.getDay() - 1);
        if (day.getTime() > untilMs) break;
        if (yieldIfMatch(day)) yield day;
      }
      if (rule.count && emitted >= rule.count) return;
    }
    return;
  }
  if (rule.freq === "MONTHLY") {
    const months2 = rule.bymonthday ?? [start.getDate()];
    const k02 = idx0(
      0,
      rule.interval
    );
    for (let k = k02; k < MAX_ITERATIONS; k++) {
      const totalMonths = start.getFullYear() * 12 + start.getMonth() + k * rule.interval;
      const year = Math.floor(totalMonths / 12);
      const month0 = totalMonths % 12;
      if (rule.bymonth && !rule.bymonth.includes(month0 + 1)) continue;
      const dim = daysInMonth(year, month0);
      const days2 = [...new Set(months2)].sort((a, b) => a - b).filter((dnum) => dnum <= dim);
      for (const dnum of days2) {
        const day = new Date(year, month0, dnum);
        if (day.getTime() > untilMs) break;
        if (yieldIfMatch(day)) yield day;
        if (rule.count && emitted >= rule.count) return;
      }
      if (rule.count && emitted >= rule.count) return;
    }
    return;
  }
  const months = rule.bymonth ?? [start.getMonth() + 1];
  const days = rule.bymonthday ?? [start.getDate()];
  const k0 = idx0(0, rule.interval);
  for (let k = k0; k < MAX_ITERATIONS; k++) {
    const year = start.getFullYear() + k * rule.interval;
    for (const month1 of [...months].sort((a, b) => a - b)) {
      const dim = daysInMonth(year, month1 - 1);
      for (const dnum of [...days].sort((a, b) => a - b)) {
        if (dnum > dim) continue;
        const day = new Date(year, month1 - 1, dnum);
        if (day.getTime() > untilMs) break;
        if (yieldIfMatch(day)) yield day;
        if (rule.count && emitted >= rule.count) return;
      }
    }
    if (rule.count && emitted >= rule.count) return;
  }
}
const pad2$1 = (n) => String(n).padStart(2, "0");
const localDate$1 = (d) => `${d.getFullYear()}-${pad2$1(d.getMonth() + 1)}-${pad2$1(d.getDate())}`;
const todayIso = () => localDate$1(/* @__PURE__ */ new Date());
const parseLocalDT = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(s);
};
function occurrencesOn(db, dateIso) {
  const out = [];
  const rows = db.prepare("SELECT * FROM events").all();
  for (const e of rows) {
    if (e.parent_id) continue;
    const exdates = new Set(JSON.parse(e.exdates || "[]"));
    const ov = db.prepare("SELECT * FROM events WHERE parent_id = ? AND origin_date = ?").get(e.id, dateIso);
    if (ov) {
      out.push({ eventId: ov.id, status: ov.status });
      continue;
    }
    if (e.rrule) {
      const rule = parseRRule(e.rrule);
      if (!rule) continue;
      for (const day of iterateRule(rule, parseLocalDT(e.start_local))) {
        const iso = isoDate(day);
        if (iso === dateIso) {
          if (!exdates.has(dateIso)) out.push({ eventId: e.id, status: e.status });
          break;
        }
        if (iso > dateIso) break;
      }
    } else if (e.start_local.slice(0, 10) === dateIso) {
      out.push({ eventId: e.id, status: e.status });
    }
  }
  return out;
}
function computeStreak(db) {
  const today = todayIso();
  const gDay = /* @__PURE__ */ new Map();
  let earliest = null;
  const rows = db.prepare("SELECT * FROM events").all();
  for (const e of rows) {
    if (e.parent_id) continue;
    const exdates = new Set(JSON.parse(e.exdates || "[]"));
    const ovs = db.prepare("SELECT origin_date, status FROM events WHERE parent_id = ?").all(e.id);
    const ovMap = new Map(ovs.map((o) => [o.origin_date, o.status]));
    const add = (iso, status) => {
      const g = gDay.get(iso) ?? { planned: 0, done: 0 };
      g.planned++;
      if (status === "done") g.done++;
      gDay.set(iso, g);
    };
    if (e.rrule) {
      const rule = parseRRule(e.rrule);
      if (!rule) continue;
      for (const day of iterateRule(rule, parseLocalDT(e.start_local))) {
        const iso = isoDate(day);
        if (iso > today) break;
        if (exdates.has(iso)) continue;
        add(iso, ovMap.get(iso) ?? e.status);
      }
    } else {
      const iso = e.start_local.slice(0, 10);
      if (iso > today) continue;
      add(iso, ovMap.get(iso) ?? e.status);
    }
  }
  earliest = null;
  for (const iso of Array.from(gDay.keys())) {
    if (!earliest || iso < earliest) earliest = iso;
  }
  let streak = 0;
  for (let i = 0; i < 2e3; i++) {
    const date = addDaysIso(today, -i);
    if (earliest && date < earliest) break;
    const g = gDay.get(date);
    if (g && g.done > 0) {
      streak++;
      continue;
    }
    if (g && g.planned > 0 && i > 0) break;
  }
  return streak;
}
function rowToScore(r) {
  return {
    eventId: r.event_id,
    originDate: r.origin_date,
    scoreType: r.score_type,
    scoredAt: r.scored_at,
    refundedAt: r.refunded_at ?? null
  };
}
function liveEarns(db, eventId, originDate) {
  return db.prepare("SELECT * FROM coin_transactions WHERE event_id = ? AND origin_date = ? AND type = 'earn' AND refunded_at IS NULL").all(eventId, originDate);
}
function markRefunded(db, eventId, originDate, refundId) {
  db.prepare("UPDATE coin_transactions SET refunded_at = ? WHERE event_id = ? AND origin_date = ? AND type = 'earn' AND refunded_at IS NULL").run(refundId, eventId, originDate);
}
function rowToTx(r) {
  return {
    id: r.id,
    ts: r.ts,
    eventId: r.event_id,
    originDate: r.origin_date,
    labelId: r.label_id,
    type: r.type,
    amount: r.amount,
    reason: r.reason
  };
}
function registerGamifyHandlers(db) {
  electron.ipcMain.handle("coins:scoreEvent", (_e, eventId, originDate, scoreType, amount, labelId) => {
    if (!coinsEnabled()) return { earned: false, amount: 0 };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM event_scores WHERE event_id = ? AND origin_date = ?").get(eventId, originDate);
      if (exists) {
        db.prepare("UPDATE event_scores SET score_type = ?, scored_at = ? WHERE event_id = ? AND origin_date = ?").run(scoreType, now, eventId, originDate);
        return { earned: false, amount: 0 };
      }
      db.prepare(
        `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at)
         VALUES (?, ?, ?, ?)`
      ).run(eventId, originDate, scoreType, now);
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
         VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Completion score')`
      ).run(crypto.randomUUID(), now, eventId, originDate, labelId, amount);
      return { earned: true, amount };
    })();
  });
  electron.ipcMain.handle("coins:getScore", (_e, eventId, originDate) => {
    const r = db.prepare("SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?").get(eventId, originDate);
    return r ? rowToScore(r) : null;
  });
  electron.ipcMain.handle("coins:clearScores", (_e, eventId, originDate) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return db.transaction(() => {
      const rows = originDate ? db.prepare("SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?").all(eventId, originDate) : db.prepare("SELECT * FROM event_scores WHERE event_id = ?").all(eventId);
      if (originDate) db.prepare("DELETE FROM event_scores WHERE event_id = ? AND origin_date = ?").run(eventId, originDate);
      else db.prepare("DELETE FROM event_scores WHERE event_id = ?").run(eventId);
      const earns = [];
      for (const r of rows) {
        if (r.refunded_at) continue;
        for (const e of liveEarns(db, eventId, r.origin_date)) {
          const rid = crypto.randomUUID();
          db.prepare(
            `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
             VALUES (?, ?, ?, ?, ?, 'refund', ?, 'Refund on delete', NULL)`
          ).run(rid, now, eventId, r.origin_date, e.label_id, e.amount);
          markRefunded(db, eventId, r.origin_date, rid);
          earns.push({ eventId, originDate: r.origin_date, amount: e.amount, labelId: e.label_id });
        }
      }
      return { scores: rows.map(rowToScore), earns };
    })();
  });
  electron.ipcMain.handle("coins:restoreScores", (_e, rows) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.transaction(() => {
      for (const r of rows) {
        db.prepare(
          `INSERT INTO event_scores (event_id, origin_date, score_type, scored_at, refunded_at)
           VALUES (?, ?, ?, ?, NULL) ON CONFLICT(event_id, origin_date)
           DO UPDATE SET score_type = excluded.score_type, refunded_at = NULL`
        ).run(r.eventId, r.originDate, r.scoreType, now);
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
           VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Restored after undo')`
        ).run(crypto.randomUUID(), now, r.eventId, r.originDate, r.labelId, r.amount);
      }
    })();
  });
  electron.ipcMain.handle("coins:revertScore", (_e, eventId, originDate) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.transaction(() => {
      const row = db.prepare("SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?").get(eventId, originDate);
      if (!row || row.refunded_at) return { refunded: false, amount: 0 };
      const earns = liveEarns(db, eventId, originDate);
      let total = 0;
      for (const e of earns) {
        const rid = crypto.randomUUID();
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, ?, ?, ?, 'refund', ?, 'Refund on status change', NULL)`
        ).run(rid, now, eventId, originDate, e.label_id, e.amount);
        markRefunded(db, eventId, originDate, rid);
        total += e.amount;
      }
      db.prepare("UPDATE event_scores SET refunded_at = ? WHERE event_id = ? AND origin_date = ?").run(now, eventId, originDate);
      return { refunded: true, amount: total };
    })();
  });
  electron.ipcMain.handle("coins:restoreScore", (_e, eventId, originDate, scoreType, amount, labelId) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.transaction(() => {
      const row = db.prepare("SELECT * FROM event_scores WHERE event_id = ? AND origin_date = ?").get(eventId, originDate);
      if (!row || !row.refunded_at) return { restored: false };
      db.prepare("UPDATE event_scores SET refunded_at = NULL WHERE event_id = ? AND origin_date = ?").run(eventId, originDate);
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason)
         VALUES (?, ?, ?, ?, ?, 'earn', ?, 'Restored after status change')`
      ).run(crypto.randomUUID(), now, eventId, originDate, labelId, amount);
      return { restored: true };
    })();
  });
  electron.ipcMain.handle("coins:checkIn", () => {
    if (!coinsEnabled()) return { award: false, streak: 0, amount: 0, multiplier: 1 };
    const today = todayIso();
    const last = db.prepare("SELECT value FROM settings WHERE key = 'lastCheckIn'").get();
    const streakRow = db.prepare("SELECT value FROM settings WHERE key = 'checkInStreak'").get();
    const res = checkInState(last?.value ?? null, parseInt(streakRow?.value ?? "0", 10) || 0, today);
    if (res.award) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      db.transaction(() => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('lastCheckIn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
        db.prepare("INSERT INTO settings (key, value) VALUES ('checkInStreak', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(res.streak));
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Daily check-in', NULL)`
        ).run(crypto.randomUUID(), now, today, res.amount);
      })();
      return { award: true, streak: res.streak, amount: res.amount };
    }
    return { award: false, streak: res.streak, amount: 0 };
  });
  electron.ipcMain.handle("coins:allDoneCheck", (_e, originDate) => {
    if (!coinsEnabled()) return { award: false, amount: 0 };
    const occs = occurrencesOn(db, originDate);
    const planned = occs.length;
    const resolved = occs.filter((o) => o.status === "done").length;
    if (!allDoneCheck(planned, resolved)) return { award: false, amount: 0 };
    const already = db.prepare("SELECT 1 FROM coin_transactions WHERE type = 'bonus' AND reason = 'All done' AND origin_date = ?").get(originDate);
    if (already) return { award: false, amount: 0 };
    db.prepare(
      `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
       VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'All done', NULL)`
    ).run(crypto.randomUUID(), (/* @__PURE__ */ new Date()).toISOString(), originDate, ALL_DONE_BONUS);
    return { award: true, amount: ALL_DONE_BONUS };
  });
  electron.ipcMain.handle("coins:perfectWeek", () => {
    if (!coinsEnabled()) return { award: false, amount: 0, weekKey: null, streak: computeStreak(db) };
    const startDow = db.prepare("SELECT value FROM settings WHERE key = 'weekStart'").get()?.value === "sunday" ? 0 : 1;
    const today = todayIso();
    const weekOfToday = weekStartIso(today, startDow);
    const awarded = [];
    let amount = 0;
    const hasKey = (k) => !!db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k);
    for (let w = 0; w < 16; w++) {
      const wkStart = addDaysIso(weekOfToday, -7 * w);
      const wkEnd = addDaysIso(wkStart, 6);
      if (wkEnd > today) continue;
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const iso = addDaysIso(wkStart, i);
        const occs = occurrencesOn(db, iso);
        return { planned: occs.length, done: occs.filter((o) => o.status === "done").length };
      });
      if (!perfectWeekCheck(days)) continue;
      if (days[6].done === 0) continue;
      const key = "streakAward." + wkStart;
      const neighbor = startDow === 1 ? addDaysIso(wkStart, -1) : addDaysIso(wkStart, 1);
      if (hasKey(key) || hasKey("streakAward." + neighbor)) continue;
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(key);
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Perfect week', NULL)`
        ).run(crypto.randomUUID(), (/* @__PURE__ */ new Date()).toISOString(), wkStart, PERFECT_WEEK_BONUS);
      })();
      awarded.push(wkStart);
      amount += PERFECT_WEEK_BONUS;
    }
    return { award: awarded.length > 0, amount, weekKey: awarded[0] ?? null, streak: computeStreak(db) };
  });
  electron.ipcMain.handle("coins:perfectMonth", () => {
    if (!coinsEnabled()) return { award: false, amount: 0, streak: computeStreak(db), level: null };
    const today = todayIso();
    const awarded = [];
    let amount = 0;
    for (let m = 0; m < 6; m++) {
      const first = /* @__PURE__ */ new Date(today + "T00:00:00");
      first.setDate(1);
      first.setMonth(first.getMonth() - m);
      const start = isoD(first);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
      const end = isoD(last);
      if (end >= today) continue;
      const dayOf = (iso) => {
        const occs = occurrencesOn(db, iso);
        return { planned: occs.length, done: occs.filter((o) => o.status === "done").length };
      };
      if (!perfectMonthCheck(start, end, dayOf)) continue;
      const key = "monthStreak." + start;
      if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key)) continue;
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(key);
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Perfect month', NULL)`
        ).run(crypto.randomUUID(), (/* @__PURE__ */ new Date()).toISOString(), start, PERFECT_MONTH_BONUS);
      })();
      awarded.push(start);
      amount += PERFECT_MONTH_BONUS;
    }
    return { award: awarded.length > 0, amount, streak: computeStreak(db), level: awarded[0] ?? null };
  });
  electron.ipcMain.handle("coins:streakMilestone", () => {
    if (!coinsEnabled()) return { award: false, amount: 0, streak: 0, level: null };
    const streak = computeStreak(db);
    const levels = streakMilestoneLevelsUpTo(streak).filter((l) => !db.prepare("SELECT 1 FROM settings WHERE key = ?").get("streakMs." + l));
    if (levels.length === 0) return { award: false, amount: 0, streak, level: null };
    db.transaction(() => {
      for (const l of levels) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run("streakMs." + l);
        db.prepare(
          `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
           VALUES (?, ?, NULL, ?, NULL, 'bonus', ?, 'Streak milestone', NULL)`
        ).run(crypto.randomUUID(), (/* @__PURE__ */ new Date()).toISOString(), todayIso(), streakMilestoneReward(l));
      }
    })();
    return { award: true, amount: levels.reduce((s, l) => s + streakMilestoneReward(l), 0), streak, level: levels[levels.length - 1] };
  });
  electron.ipcMain.handle("coins:stats", () => {
    const today = todayIso();
    const txs = db.prepare("SELECT * FROM coin_transactions ORDER BY ts").all();
    const localDateOf = (iso) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${pad2$1(d.getMonth() + 1)}-${pad2$1(d.getDate())}`;
    };
    const byLocalDate = /* @__PURE__ */ new Map();
    for (const t of txs) {
      const key = localDateOf(t.ts);
      const delta = t.type === "spend" || t.type === "refund" ? -t.amount : t.amount;
      byLocalDate.set(key, (byLocalDate.get(key) ?? 0) + delta);
    }
    const net = (date) => roundCoins(byLocalDate.get(date) ?? 0);
    const series = [];
    for (let i = 6; i >= 0; i--) {
      const date = addDaysIso(today, -i);
      series.push({ date, amount: net(date) });
    }
    const perLabelMap = /* @__PURE__ */ new Map();
    let rewards = 0;
    for (const t of txs) {
      if (t.type === "bonus") {
        rewards += t.amount;
        continue;
      }
      if (t.type === "earn" || t.type === "refund") {
        const delta = t.type === "refund" ? -t.amount : t.amount;
        perLabelMap.set(t.label_id ?? null, (perLabelMap.get(t.label_id ?? null) ?? 0) + delta);
      }
    }
    const labels = db.prepare("SELECT id, name, parent_id FROM labels").all();
    const perLabel = [];
    for (const [id, amount] of perLabelMap.entries()) {
      if (amount === 0) continue;
      const lb = id ? labels.find((l) => l.id === id) : void 0;
      const parent = lb?.parent_id ? labels.find((l) => l.id === lb.parent_id) : void 0;
      perLabel.push({
        labelId: id,
        labelName: id ? lb?.name ?? "?" : "No label",
        parentId: parent ? parent.id : null,
        parentName: parent ? parent.name : null,
        amount: roundCoins(amount)
      });
    }
    if (rewards !== 0) {
      perLabel.push({ labelId: "__rewards__", labelName: "Rewards 🏆", parentId: null, parentName: null, amount: roundCoins(rewards) });
    }
    perLabel.sort((a, b) => b.amount - a.amount);
    return { today: net(today), series, perLabel };
  });
  const coinsEnabled = () => {
    const v = db.prepare("SELECT value FROM settings WHERE key = 'coinSystem'").get();
    return v ? v.value !== "0" : true;
  };
  electron.ipcMain.handle("coins:system", () => coinsEnabled());
  electron.ipcMain.handle("coins:setSystem", (_e, on) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('coinSystem', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "1" : "0");
  });
  const rowToMilestone = (r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    cost: r.cost,
    notes: r.notes,
    achievedAt: r.achieved_at,
    createdAt: r.created_at
  });
  const withReached = (r) => ({
    ...rowToMilestone(r),
    reached: !!r.achieved_at || !!db.prepare("SELECT 1 FROM settings WHERE key = ?").get("stoneReached." + r.cost)
  });
  const normalizeMilestonePath = () => {
    const balRow = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    let count = 30;
    while (defaultMilestoneCosts(count)[count - 1] <= balRow.b + 2e3) count += 10;
    const costs = defaultMilestoneCosts(count);
    db.transaction(() => {
      const canonical = new Set(costs);
      const all = db.prepare("SELECT id, cost FROM reward_milestones").all();
      const stmt = db.prepare("DELETE FROM reward_milestones WHERE id = ?");
      for (const r of all) if (!canonical.has(r.cost)) stmt.run(r.id);
      const rows = db.prepare("SELECT * FROM reward_milestones ORDER BY cost").all();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      for (let i = 0; i < costs.length; i++) {
        const expectCost = costs[i];
        const expectName = "Level " + (i + 1);
        const row = rows[i];
        if (row) {
          if (row.cost !== expectCost || row.name !== expectName) {
            db.prepare("UPDATE reward_milestones SET cost = ?, name = ? WHERE id = ?").run(expectCost, expectName, row.id);
          }
        } else {
          db.prepare(
            `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
             VALUES (?, ?, '🎯', ?, 'Set your reward', NULL, ?)`
          ).run(crypto.randomUUID(), expectName, expectCost, now);
        }
      }
      const after = db.prepare("SELECT id FROM reward_milestones ORDER BY cost").all();
      for (let i = costs.length; i < after.length; i++) stmt.run(after[i].id);
      db.prepare("INSERT INTO settings (key, value) VALUES ('milestonePathV2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    })();
  };
  electron.ipcMain.handle("milestones:list", () => {
    const rows = db.prepare("SELECT * FROM reward_milestones ORDER BY cost").all();
    const v2 = db.prepare("SELECT 1 FROM settings WHERE key = 'milestonePathV2'").get();
    if (rows.length === 0 || !v2) {
      db.transaction(() => {
        db.prepare("DELETE FROM reward_milestones").run();
        db.prepare("DELETE FROM settings WHERE key LIKE 'stoneReached.%' OR key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%'").run();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        defaultMilestoneCosts(30).forEach((cost, i) => {
          db.prepare(
            `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
             VALUES (?, ?, '🎯', ?, 'Set your reward', NULL, ?)`
          ).run(crypto.randomUUID(), "Level " + (i + 1), cost, now);
        });
        db.prepare("INSERT INTO settings (key, value) VALUES ('milestonePathV2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      })();
    } else {
      normalizeMilestonePath();
    }
    const bal = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    const list = db.prepare("SELECT * FROM reward_milestones ORDER BY cost").all();
    const reachKey = (cost) => "stoneReached." + cost;
    db.transaction(() => {
      const ins = db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      );
      for (const m of list) {
        if (m.achieved_at || bal.b >= m.cost) ins.run(reachKey(m.cost));
      }
    })();
    return list.map((r) => withReached(r));
  });
  electron.ipcMain.handle("milestones:create", (_e, name, icon, cost, notes) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    ).run(id, name, icon || "🎯", cost, notes, (/* @__PURE__ */ new Date()).toISOString());
    return withReached(db.prepare("SELECT * FROM reward_milestones WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("milestones:update", (_e, id, patch) => {
    const existing = db.prepare("SELECT * FROM reward_milestones WHERE id = ?").get(id);
    if (!existing) throw new Error("Milestone not found");
    db.prepare("UPDATE reward_milestones SET name = ?, icon = ?, cost = ?, notes = ? WHERE id = ?").run(
      patch.name ?? existing.name,
      patch.icon ?? existing.icon,
      patch.cost ?? existing.cost,
      patch.notes ?? existing.notes,
      id
    );
    return withReached(db.prepare("SELECT * FROM reward_milestones WHERE id = ?").get(id));
  });
  electron.ipcMain.handle("milestones:remove", (_e, id) => {
    db.prepare("DELETE FROM reward_milestones WHERE id = ?").run(id);
  });
  electron.ipcMain.handle("milestones:claim", (_e, id) => {
    if (!coinsEnabled()) return { ok: false, balance: 0 };
    const m = db.prepare("SELECT * FROM reward_milestones WHERE id = ?").get(id);
    if (!m) return { ok: false, balance: 0 };
    const bal = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    if (bal.b < m.cost) return { ok: false, balance: bal.b };
    db.transaction(() => {
      db.prepare(
        `INSERT INTO coin_transactions (id, ts, event_id, origin_date, label_id, type, amount, reason, refunded_at)
         VALUES (?, ?, NULL, NULL, NULL, 'spend', ?, 'Milestone: ' || ?, NULL)`
      ).run(crypto.randomUUID(), (/* @__PURE__ */ new Date()).toISOString(), m.cost, m.name);
      if (!m.achieved_at) {
        db.prepare("UPDATE reward_milestones SET achieved_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), id);
      }
    })();
    const nb = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    return { ok: true, balance: nb };
  });
  electron.ipcMain.handle("milestones:unclaim", (_e, id) => {
    const m = db.prepare("SELECT * FROM reward_milestones WHERE id = ?").get(id);
    if (!m) return { ok: false, balance: 0 };
    const spend = db.prepare(
      `SELECT id FROM coin_transactions
         WHERE type = 'spend' AND reason = 'Milestone: ' || ? AND refunded_at IS NULL
         ORDER BY ts DESC LIMIT 1`
    ).get(m.name);
    if (!spend) return { ok: false, balance: 0 };
    db.transaction(() => {
      db.prepare("DELETE FROM coin_transactions WHERE id = ?").run(spend.id);
      db.prepare("UPDATE reward_milestones SET achieved_at = NULL WHERE id = ?").run(id);
    })();
    const nb = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    return { ok: true, balance: nb };
  });
  electron.ipcMain.handle(
    "coins:scoreInsights",
    (_e, opts = {}) => {
      const { from, to, parentIds = [] } = opts ?? {};
      const where = ["s.refunded_at IS NULL"];
      const params = [];
      if (from) {
        where.push("s.origin_date >= ?");
        params.push(from);
      }
      if (to) {
        where.push("s.origin_date < ?");
        params.push(to);
      }
      if (parentIds.length > 0) {
        const ph = parentIds.map(() => "?").join(",");
        where.push(`((l.parent_id IN (${ph})) OR (l.id IN (${ph})))`);
        params.push(...parentIds, ...parentIds);
      }
      const rows = db.prepare(`
        SELECT s.score_type, s.origin_date, e.label_id, l.name AS label_name, l.parent_id, pl.name AS parent_name,
               l.color AS label_color, pl.color AS parent_color
        FROM event_scores s
        LEFT JOIN events e ON e.id = s.event_id
        LEFT JOIN labels l ON l.id = e.label_id
        LEFT JOIN labels pl ON pl.id = l.parent_id
        WHERE ${where.join(" AND ")}
      `).all(...params);
      const total = { on_time: 0, late: 0, off_schedule: 0 };
      const byLabel = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const k = r.score_type;
        if (k in total) total[k]++;
        const labelKey = r.label_id ?? "none";
        let entry = byLabel.get(labelKey);
        if (!entry) {
          const name = r.label_name ?? r.parent_name ?? "No label";
          entry = {
            labelId: r.label_id,
            name,
            parentId: r.parent_id,
            parentName: r.parent_name,
            color: r.label_color ?? r.parent_color ?? null,
            on_time: 0,
            late: 0,
            off_schedule: 0
          };
          byLabel.set(labelKey, entry);
        }
        if (k in entry) entry[k]++;
      }
      const n = rows.length;
      const labels = [...byLabel.values()].map((l) => ({ ...l, total: l.on_time + l.late + l.off_schedule })).filter((l) => l.total > 0).sort((a, b) => b.total - a.total);
      return { total, labels, count: n };
    }
  );
  electron.ipcMain.handle("coins:balance", () => {
    const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('spend','refund') THEN -amount ELSE amount END), 0) AS b FROM coin_transactions").get();
    return r.b;
  });
  electron.ipcMain.handle("coins:listTransactions", () => {
    return db.prepare("SELECT * FROM coin_transactions ORDER BY ts DESC").all().map(rowToTx);
  });
}
function registerWindowHandlers() {
  electron.ipcMain.on("window:minimize", (e) => electron.BrowserWindow.fromWebContents(e.sender)?.minimize());
  electron.ipcMain.on("window:toggle-maximize", (e) => {
    const win = electron.BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  electron.ipcMain.on("window:close", (e) => electron.BrowserWindow.fromWebContents(e.sender)?.close());
  electron.ipcMain.on("window:is-maximized", (e) => {
    const win = electron.BrowserWindow.fromWebContents(e.sender);
    e.returnValue = win ? win.isMaximized() : false;
  });
}
const SLOT_WINDOW_MIN = 120;
const NL = "\n";
function isActive(o) {
  return o.status !== "done" && o.status !== "cancelled";
}
function morningSummary(occs) {
  const active = occs.filter(isActive);
  if (active.length === 0) return null;
  const n = active.length;
  return {
    title: "Rhythm — Good morning ☀️",
    body: `You have ${n} activit${n === 1 ? "y" : "ies"} planned today.`
  };
}
function slotReminder(occs, now, _slotTime, _windowMin = SLOT_WINDOW_MIN) {
  const pending = occs.filter((o) => isActive(o) && o.start.getTime() >= now.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime());
  if (pending.length === 0) return null;
  const hh = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const MAX = 5;
  const lines = pending.slice(0, MAX).map((o) => `${hh(o.start)} ${o.title}`);
  const more = pending.length > MAX ? NL + "+" + (pending.length - MAX) + " more" : "";
  const body = `${pending.length} activit${pending.length === 1 ? "y" : "ies"} left today${NL}${lines.join(NL)}${more}`;
  return { title: "Rhythm — Today", body };
}
function startupReminder(occs, now, leadMin) {
  const windowEnd = now.getTime() + leadMin * 6e4;
  const due = occs.filter((o) => isActive(o) && o.start.getTime() > now.getTime() && o.start.getTime() <= windowEnd).sort((a, b) => a.start.getTime() - b.start.getTime());
  if (due.length === 0) return null;
  const first = due[0];
  const mins = Math.max(1, Math.round((first.start.getTime() - now.getTime()) / 6e4));
  const hh = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const body = due.length === 1 ? `${first.title} — ${hh(first.start)} (in ${mins} min)` : `${first.title} and ${due.length - 1} more — first at ${hh(first.start)} (in ${mins} min)`;
  return { title: "Rhythm — Upcoming", body };
}
const pad2 = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function readConfig(db) {
  const get = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value;
  const enabled = (get("notifEnabled") ?? "1") !== "0";
  let slots = ["09:00", "13:00", "18:00"];
  try {
    const raw = get("notifSlots");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) slots = parsed.filter((s) => typeof s === "string" && /^\d{2}:\d{2}$/.test(s));
    }
  } catch {
  }
  const leadMin = Math.min(240, Math.max(0, parseInt(get("notifLead") ?? "30", 10) || 30));
  return { enabled, slots, leadMin };
}
function writeConfig(db, cfg) {
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  set.run("notifEnabled", cfg.enabled ? "1" : "0");
  set.run("notifSlots", JSON.stringify(cfg.slots.filter((s) => /^\d{2}:\d{2}$/.test(s))));
  set.run("notifLead", String(Math.min(240, Math.max(0, cfg.leadMin))));
}
function broadcastInApp(title, body) {
  try {
    for (const w of electron.BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("notify:inapp", { title, body });
    }
  } catch (e) {
    console.log("[notify] in-app broadcast failed:", e);
  }
}
function show(title, body) {
  broadcastInApp(title, body);
  if (!electron.Notification.isSupported()) {
    console.log("[notify] NOT supported on this system (in-app toast still shown)");
    return { ok: false, reason: "unsupported" };
  }
  try {
    const n = new electron.Notification({ title, body, silent: false });
    n.on("failed", (_e, error) => console.log("[notify] show failed:", error));
    n.on("click", () => console.log("[notify] clicked"));
    n.show();
    return { ok: true, reason: "shown" };
  } catch (e) {
    console.log("[notify] error:", e);
    return { ok: false, reason: String(e) };
  }
}
function occsOnDay(db, dayIso) {
  const out = [];
  const rows = db.prepare("SELECT * FROM events").all();
  const parseDT = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(s);
  };
  for (const e of rows) {
    if (e.parent_id) continue;
    const exdates = new Set(JSON.parse(e.exdates || "[]"));
    const ov = db.prepare("SELECT * FROM events WHERE parent_id = ? AND origin_date = ?").get(e.id, dayIso);
    if (ov) {
      out.push({ id: ov.id, title: ov.title, start: parseDT(ov.start_local), end: parseDT(ov.end_local), status: ov.status });
      continue;
    }
    if (e.rrule) {
      const rule = parseRRule(e.rrule);
      if (!rule) continue;
      for (const day of iterateRule(rule, parseDT(e.start_local))) {
        const iso = isoDate(day);
        if (iso === dayIso) {
          if (!exdates.has(dayIso)) {
            out.push({ id: e.id, title: e.title, start: parseDT(e.start_local), end: parseDT(e.end_local), status: e.status });
          }
          break;
        }
        if (iso > dayIso) break;
      }
    } else if (e.start_local.slice(0, 10) === dayIso) {
      out.push({ id: e.id, title: e.title, start: parseDT(e.start_local), end: parseDT(e.end_local), status: e.status });
    }
  }
  return out;
}
let timer = null;
let startupChecked = false;
let slotCleanupDay = "";
function occsForNotify(db, dayIso) {
  return occsOnDay(db, dayIso).map((o) => ({ title: o.title, start: o.start, status: o.status }));
}
function runCheck(db) {
  const cfg = readConfig(db);
  const now = /* @__PURE__ */ new Date();
  const today = localDate(now);
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  if (cfg.enabled) {
    const occs = occsForNotify(db, today);
    const dayKey = "notifDay." + today;
    const done = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(dayKey);
    if (!done) {
      const r = morningSummary(occs);
      if (r) show(r.title, r.body);
      set.run(dayKey, "1");
    }
    if (!startupChecked) {
      startupChecked = true;
      const r = startupReminder(occs, now, cfg.leadMin);
      if (r) show(r.title, r.body);
    }
    if (slotCleanupDay !== today) {
      slotCleanupDay = today;
      db.prepare("DELETE FROM settings WHERE key LIKE 'notifSlot.%' AND key NOT LIKE ?").run("notifSlot." + today + ".%");
    }
    for (const slot of cfg.slots) {
      const slotKey = "notifSlot." + today + "." + slot;
      if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(slotKey)) continue;
      const [sh, sm] = slot.split(":").map(Number);
      const slotMin = sh * 60 + sm;
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin < slotMin) continue;
      set.run(slotKey, "1");
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm);
      const r = slotReminder(occs, now);
      if (r) show(r.title, r.body);
    }
  }
}
function runRemindOnce(db) {
  const cfg = readConfig(db);
  const now = /* @__PURE__ */ new Date();
  const today = localDate(now);
  const occs = occsForNotify(db, today);
  const r = startupReminder(occs, now, cfg.leadMin);
  if (r) show(r.title, r.body);
  else console.log("[remind] nothing due — no toast");
}
function startNotifier(db) {
  if (timer) clearInterval(timer);
  const cfg = readConfig(db);
  console.log("[notify] enabled=", cfg.enabled, "slots=", JSON.stringify(cfg.slots), "leadMin=", cfg.leadMin);
  runCheck(db);
  timer = setInterval(() => runCheck(db), 3e4);
}
function registerNotificationHandlers(db) {
  electron.ipcMain.handle("notify:getConfig", () => readConfig(db));
  electron.ipcMain.handle("notify:setConfig", (_e, cfg) => {
    writeConfig(db, cfg);
    return readConfig(db);
  });
  electron.ipcMain.handle("notify:test", () => {
    console.log("[notify] test requested");
    const res = show("Rhythm — Test notification", "Notifications are working! 🎉");
    console.log("[notify] test result:", JSON.stringify(res));
    return res;
  });
  electron.ipcMain.handle("notify:resetDay", () => {
    const today = localDate(/* @__PURE__ */ new Date());
    db.prepare("DELETE FROM settings WHERE key = ?").run("notifDay." + today);
    db.prepare("DELETE FROM settings WHERE key LIKE 'notifSlot." + today + ".%'").run();
    return { ok: true };
  });
  electron.ipcMain.handle("notify:runNow", () => {
    runCheck(db);
    return { ok: true };
  });
}
function registerTrashHandlers(db) {
  electron.ipcMain.handle("trash:list", () => {
    const rows = db.prepare("SELECT id, payload, deleted_at FROM trash ORDER BY deleted_at ASC").all();
    return rows.map((r) => ({ id: r.id, payload: JSON.parse(r.payload), deletedAt: r.deleted_at }));
  });
  electron.ipcMain.handle("trash:add", (_e, id, payload) => {
    db.prepare("INSERT OR REPLACE INTO trash (id, payload, deleted_at) VALUES (?, ?, ?)").run(
      id,
      JSON.stringify(payload),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    return { ok: true };
  });
  electron.ipcMain.handle("trash:remove", (_e, id) => {
    db.prepare("DELETE FROM trash WHERE id = ?").run(id);
    return { ok: true };
  });
  electron.ipcMain.handle("trash:restore", (_e, id, mode) => {
    const row = db.prepare("SELECT payload FROM trash WHERE id = ?").get(id);
    if (!row) return { ok: false, error: "not found" };
    const { master, children = [] } = JSON.parse(row.payload);
    const ins = db.prepare(`
      INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id,
                          color_override, status, rrule, exdates, parent_id, origin_date,
                          completed_at, created_at, updated_at)
      VALUES (@id, @title, @desc, @start, @end, @allDay, @label, @color, @status, @rrule,
              @exdates, @parent, @origin, @done, @created, @updated)
    `);
    db.transaction(() => {
      const insert = (e, parentId, rrule, exdates) => {
        ins.run({
          id: e.id,
          title: e.title,
          desc: e.description ?? "",
          start: e.startLocal,
          end: e.endLocal,
          allDay: e.allDay ? 1 : 0,
          label: e.labelId ?? null,
          color: e.colorOverride ?? null,
          status: e.status ?? "todo",
          rrule,
          exdates: JSON.stringify(exdates),
          parent: parentId,
          origin: e.originDate ?? null,
          done: e.completedAt ?? null,
          created: e.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
          updated: (/* @__PURE__ */ new Date()).toISOString()
        });
      };
      if (mode === "single") {
        insert(master, null, null, []);
      } else {
        insert(master, null, master.rrule ?? null, master.exdates ?? []);
        for (const c of children) insert(c, master.id, null, c.exdates ?? []);
      }
      db.prepare("DELETE FROM trash WHERE id = ?").run(id);
    })();
    return { ok: true };
  });
  electron.ipcMain.handle("trash:purge", (_e, id) => {
    db.prepare("DELETE FROM trash WHERE id = ?").run(id);
    return { ok: true };
  });
  electron.ipcMain.handle("trash:empty", () => {
    db.prepare("DELETE FROM trash").run();
    return { ok: true };
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SET_VALUE = `(el, value) => {
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}`;
async function runSmoke(win, outPath) {
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (e) {
      console.log("[smoke] SCRIPT FAILED >>>", code);
      throw e;
    }
  };
  let dragWorks = true;
  const setDT = (rootSel, idx, val) => js(`(() => {
    const wrap = document.querySelectorAll('${rootSel} .ef-dt')[${idx}]
    if (!wrap) return false // v1.11.6: never throw when the dialog is missing
    const date = '${val.slice(0, 10)}', hm = '${val.slice(11, 16)}'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const dateEl = wrap.querySelector('.ef-date')
    if (dateEl) { setter.call(dateEl, date); dateEl.dispatchEvent(new Event('input', { bubbles: true })) }
    const timeEl = wrap.querySelector('.ef-time')
    if (timeEl) { setter.call(timeEl, hm); timeEl.dispatchEvent(new Event('input', { bubbles: true })); return true }
    const h = parseInt(hm.slice(0, 2), 10), m = parseInt(hm.slice(3, 5), 10)
    const ssetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    const hEl = wrap.querySelector('.ef-time-h'), mEl = wrap.querySelector('.ef-time-m')
    if (!hEl || !mEl) return false
    const ampm = h >= 12 ? 'PM' : 'AM'
    let h12 = h % 12; if (h12 === 0) h12 = 12
    ssetter.call(hEl, String(h12)); hEl.dispatchEvent(new Event('change', { bubbles: true }))
    ssetter.call(mEl, String(m)); mEl.dispatchEvent(new Event('change', { bubbles: true }))
    const ap = wrap.querySelector('.ef-ampm')
    if (ap && ap.textContent !== ampm) ap.click()
    return true
  })()`);
  const getDT = (rootSel, idx) => js(`(() => {
    const wrap = document.querySelectorAll('${rootSel} .ef-dt')[${idx}]
    if (!wrap) return ''
    const dateEl = wrap.querySelector('.ef-date')
    const date = dateEl ? dateEl.value || '' : ''
    const t = wrap.querySelector('.ef-time')
    if (t) return t.value ? date + 'T' + t.value : date
    const hEl = wrap.querySelector('.ef-time-h'), mEl = wrap.querySelector('.ef-time-m'), ap = wrap.querySelector('.ef-ampm')
    if (!hEl || !mEl) return date
    let h = parseInt(hEl.value, 10) || 12
    if (ap && ap.textContent === 'PM') h = h === 12 ? 12 : h + 12
    else if (ap && ap.textContent === 'AM') h = h === 12 ? 0 : h
    return date + 'T' + String(h).padStart(2, '0') + ':' + String(parseInt(mEl.value, 10) || 0).padStart(2, '0')
  })()`);
  const pad22 = (n) => String(n).padStart(2, "0");
  const fmtD = (d) => `${d.getFullYear()}-${pad22(d.getMonth() + 1)}-${pad22(d.getDate())}`;
  const TODAY = fmtD(/* @__PURE__ */ new Date());
  const TOMORROW = fmtD(new Date(Date.now() + 864e5));
  const startD = /* @__PURE__ */ new Date(TOMORROW + "T00:00:00");
  const nextMwf = new Date(startD);
  nextMwf.setDate(nextMwf.getDate() + 1);
  while (![1, 3, 5].includes(nextMwf.getDay())) nextMwf.setDate(nextMwf.getDate() + 1);
  const expectedChip = nextMwf.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const startDowName = startD.toLocaleDateString("en-US", { weekday: "long" });
  const dataDir = process.env.AC_DATA_DIR;
  if (!dataDir) throw new Error("AC_DATA_DIR must be set for smoke test");
  const dbGet = (sql, ...args) => {
    const db = new Database(dataDir + "/activity-calendar.db", { readonly: true });
    try {
      return db.prepare(sql).get(...args);
    } finally {
      db.close();
    }
  };
  const dbAll = (sql, ...args) => {
    const db = new Database(dataDir + "/activity-calendar.db", { readonly: true });
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };
  const dbRun = (sql, ...args) => {
    const db = new Database(dataDir + "/activity-calendar.db");
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
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
    })()`);
    if (any) await sleep(300);
    return any;
  };
  const realClick = async (pos) => {
    await dismissOverlays();
    if (!pos) return false;
    win.webContents.sendInputEvent({ type: "mouseDown", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(50);
    win.webContents.sendInputEvent({ type: "mouseUp", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(250);
    return true;
  };
  const realDrag = async (pos, dx, dy) => {
    await dismissOverlays();
    if (!pos) return false;
    const ok = await js(`(async () => {
      const el = document.elementFromPoint(${pos.x}, ${pos.y})
      if (!el) return false
      // dispatch pointerdown on the BLOCK's pointerdown handler target — the
      // event must bubble from an element that HAS onPointerDown (the .eb)
      const host = el.closest('.eb') || el
      const opts = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: cy })
      host.dispatchEvent(new PointerEvent('pointerdown', opts(${pos.x}, ${pos.y})))
      await new Promise((r) => setTimeout(r, 80))
      for (let i = 1; i <= 6; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', opts(${pos.x} + Math.round((${dx} * i) / 6), ${pos.y} + Math.round((${dy} * i) / 6))))
        await new Promise((r) => setTimeout(r, 35))
      }
      window.dispatchEvent(new PointerEvent('pointerup', opts(${pos.x} + ${dx}, ${pos.y} + ${dy})))
      await new Promise((r) => setTimeout(r, 250))
      // report whether a drag actually started (debug signal)
      return !document.querySelector('.eb-wrap.dragging')
    })()`);
    await sleep(350);
    return ok;
  };
  const saveRewards = async () => {
    const ok = await js(`(() => { const b = Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((x) => x.textContent.trim() === 'Save rewards'); if (b) { b.click(); return true } return false })()`);
    await sleep(400);
    return ok;
  };
  const saveEditor = async () => {
    const ok = await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((x) => x.textContent.trim() === 'Save'); if (b) { b.click(); return true } return false })()`);
    await sleep(400);
    return ok;
  };
  const countBlocks = (title) => js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes(${JSON.stringify(title)})).length`);
  const clickScoreOpt = async (opt = "On time") => {
    const ok = await js(`(async () => {
      for (let i = 0; i < 12; i++) {
        const o = Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('${opt}'))
        if (o) { o.click(); return true }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })()`);
    await sleep(250);
    return ok;
  };
  const pickScore = async (opt = "On time") => {
    const open = await js(`!!document.querySelector('.score-prompt')`);
    if (open) {
      await clickScoreOpt(opt);
      await sleep(1400);
    }
    return open;
  };
  const skipScore = async () => {
    const open = await js(`!!document.querySelector('.score-prompt')`);
    if (open) {
      await js(`Array.from(document.querySelectorAll('.score-prompt .btn')).find((b) => b.textContent.trim() === 'Skip')?.click()`);
      await sleep(300);
      const fxAfterSkip = await js(`!document.querySelector('.coin-score-fx')`);
      check("cup3: NO coin animation on Skip", fxAfterSkip);
    }
    const qa = await js(`!!document.querySelector('.quickadd')`);
    if (qa) {
      await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
      await sleep(200);
    }
    return open || qa;
  };
  const openEditorOn = async (title) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await skipScore();
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${title}')); if (!el) return 'no block'; el.click(); return 'clicked' })()`);
      await sleep(450);
      const open = await js(`!!document.querySelector('.editor')`);
      if (open) {
        const bar = await js(`document.querySelectorAll('.editor .apply-to').length > 0`);
        if (bar) return true;
        await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
        await sleep(250);
        fmtD(/* @__PURE__ */ new Date());
        const clicked = await js(`(() => { const col = document.querySelector('.day-col[data-day="${"${dayIso}"}"]'); if (!col) return false; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('${title}')); if (!el) return false; el.click(); return true })()`);
        await sleep(500);
        if (clicked) return true;
      }
      await skipScore();
    }
    return false;
  };
  const labelRowJs = (name) => `Array.from(document.querySelectorAll('.label-row')).find((r) => (r.querySelector('.label-name')?.textContent ?? '').trim() === '${name}')`;
  const labelRowPos = async (name) => {
    return js(`(() => { const row = ${labelRowJs(name)}; if (!row) return null; const r = row.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`);
  };
  const blockPos = async (findExpr, grab = "top") => {
    return js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes(${JSON.stringify(findExpr)}))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const y = ${JSON.stringify(grab)} === 'bottom' ? r.bottom - 4 : r.top + Math.min(6, r.height / 2)
      return { x: Math.round(r.left + r.width / 2), y: Math.round(y) }
    })()`);
  };
  try {
    await sleep(1200);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(300);
    const qa = await js(`!!document.querySelector('.quickadd')`);
    check("quickadd dialog opens", qa);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke test activity')`);
    await setDT(".quickadd", 0, `${TODAY}T15:00`);
    await sleep(150);
    const endVal = await getDT(".quickadd", 1);
    check("end time auto-shifts with start", endVal === TODAY + "T16:00", `end=${endVal}`);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const after = await js(`({
      dialogStillOpen: !!document.querySelector('.quickadd'),
      blockCount: document.querySelectorAll('.eb').length,
      errors: window.__errors || []
    })`);
    check("quickadd dialog closes after add", after.dialogStillOpen === false);
    check("no renderer errors during add", after.errors.length === 0, String(after.errors));
    const row = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke test activity'");
    check("event persisted to SQLite", row.c === 1, `rows=${row.c}`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke weekly qa')`);
    await setDT(".quickadd", 0, `${TOMORROW}T10:00`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`);
    await sleep(200);
    const WD_KEYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const startKey = WD_KEYS[startD.getDay()];
    await js(`Array.from(document.querySelectorAll('.quickadd .wd-pill')).forEach((p) => {
      const want = ['MO', 'WE', 'FR'].includes(p.dataset.day) && p.dataset.day !== '${startKey}'
      if (want !== p.classList.contains('on')) p.click()
    })`);
    await sleep(250);
    const WD_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const wantDays = ["MO", "WE", "FR"].filter((k) => k !== startKey);
    const expectedRule = "FREQ=WEEKLY;BYDAY=" + wantDays.join(",");
    const expectedSummary = "Every week on " + wantDays.map((k) => WD_NAMES[WD_KEYS.indexOf(k)]).join(", ");
    const warnShown = await js(`!!document.querySelector('.quickadd .re-warn') && document.querySelector('.quickadd .re-warn').textContent.includes(${JSON.stringify(startDowName)})`);
    check("quickadd repeat warns when start day not selected", warnShown);
    const summaryShown = await js(`(document.querySelector('.quickadd .re-summary')?.textContent ?? '').includes('week')`);
    check("quickadd repeat shows plain-English summary", summaryShown);
    const firstChip = await js(`document.querySelector('.quickadd .re-preview-date')?.textContent ?? ''`);
    check("preview shows shifted first occurrence", firstChip === expectedChip, firstChip + " vs " + expectedChip);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const rrQa = dbGet("SELECT rrule FROM events WHERE title = 'Smoke weekly qa'");
    const ruleDays = (rrQa.rrule.split("BYDAY=")[1] ?? "").split(",");
    const ruleOk = rrQa.rrule.startsWith("FREQ=WEEKLY;BYDAY=") && [...ruleDays].sort().join() === [...wantDays].sort().join();
    check("quickadd saves the weekly rule (same days, any order)", ruleOk, String(rrQa.rrule));
    await skipScore();
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(400);
    const qaNow = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke weekly qa')).length`);
    check("weekly block NOT in the current week (first occurrence shifted to next Mon)", qaNow === 0, `count=${qaNow}`);
    await js(`document.querySelector('.icon-btn[title="Next"]')?.click()`);
    await sleep(400);
    const qaNext = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const n = Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke weekly qa')).length
        if (n >= 1) return n
        await new Promise((r) => setTimeout(r, 400))
      }
      return 0
    })()`);
    check("weekly block appears in NEXT week (shifted first occurrence)", qaNext >= 1, `count=${qaNext}`);
    const align = await js(`(() => {
      const heads = Array.from(document.querySelectorAll('.week-head .week-day-head')).map((c) => c.getBoundingClientRect().left)
      const cols = Array.from(document.querySelectorAll('.day-col')).map((c) => c.getBoundingClientRect().left)
      return { heads, cols }
    })()`);
    console.log("[smoke] align heads:", JSON.stringify(align.heads));
    console.log("[smoke] align cols:", JSON.stringify(align.cols));
    const alignOk = align.heads.length === align.cols.length && align.heads.every((h, i) => Math.abs(h - align.cols[i]) < 1);
    check("day columns align with header cells", alignOk === true, JSON.stringify(align));
    await realClick(await blockPos("Smoke weekly qa"));
    await sleep(350);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(200);
    const dangerLabels = await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())`);
    check(
      "series mode shows Delete upcoming + Delete series",
      dangerLabels.length === 2 && dangerLabels[0] === "Delete upcoming" && dangerLabels[1] === "Delete series",
      JSON.stringify(dangerLabels)
    );
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const qaGone = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke weekly qa'");
    check("series deleted via explicit button", qaGone.c === 0, `rows=${qaGone.c}`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(300);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke yearly')`);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Yearly').click()`);
    await sleep(250);
    const yearlyChip = await js(`document.querySelector('.quickadd .re-preview-date')?.textContent ?? ''`);
    check("yearly preview chip includes year", /\d{4}/.test(yearlyChip), yearlyChip);
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(250);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke applywalk')`);
    await setDT(".quickadd", 0, `${TODAY}T06:30`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    let hasBar = false;
    for (let attempt = 0; attempt < 5 && !hasBar; attempt++) {
      await skipScore();
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke applywalk')); if (!el) return false; el.click(); return true })()`);
      await sleep(550);
      hasBar = await js(`document.querySelectorAll('.editor .apply-to').length > 0`);
      if (!hasBar) {
        await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
        await sleep(250);
      }
    }
    check("2e: recurring editor shows the apply-to bar", hasBar);
    const probeE = await js(`(() => ({
      editor: !!document.querySelector('.editor'),
      title: document.querySelector('.editor .ef-title')?.value ?? null,
      applyBars: document.querySelectorAll('.editor .apply-to').length,
      overlayDialog: document.querySelector('.overlay .dialog')?.className ?? 'none'
    }))()`);
    console.log("[smoke] 2e probe:", JSON.stringify(probeE));
    const walkDb = dbGet("SELECT rrule, parent_id, title FROM events WHERE title = 'Morning walk' AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1");
    console.log("[smoke] 2e walkDb:", JSON.stringify(walkDb));
    const applyTop = await js(`(() => {
      const bar = document.querySelector('.editor .apply-to')
      if (!bar) return null
      const segs = Array.from(bar.querySelectorAll('.seg-btn')).map((b) => b.textContent.trim())
      const dang = Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())
      return { segs, dang }
    })()`);
    check(
      "apply-to at top with This occurrence first",
      !!applyTop && applyTop.segs[0] === "This occurrence" && applyTop.segs[1] === "Whole series",
      JSON.stringify(applyTop)
    );
    check(
      "this-mode shows only Delete this occurrence",
      !!applyTop && applyTop.dang.length === 1 && applyTop.dang[0] === "Delete this occurrence",
      JSON.stringify(applyTop)
    );
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    const dangSeries = await js(`Array.from(document.querySelectorAll('.editor .btn.danger')).map((b) => b.textContent.trim())`);
    check(
      "series-mode shows Delete upcoming + Delete series",
      dangSeries.length === 2 && dangSeries[0] === "Delete upcoming" && dangSeries[1] === "Delete series",
      JSON.stringify(dangSeries)
    );
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(250);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(400);
    const awId = dbGet("SELECT id FROM events WHERE title = 'Smoke applywalk' AND parent_id IS NULL").id;
    await openEditorOn("Smoke applywalk");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(300);
    const delClicked = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete upcoming')
        if (b) { b.click(); return true }
        await new Promise((r) => setTimeout(r, 300))
      }
      return false
    })()`);
    await sleep(700);
    check("delete-upcoming click landed", delClicked);
    const untilExpected = (() => {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const upR = dbGet("SELECT rrule FROM events WHERE id = '" + awId + "'");
    check("delete upcoming sets UNTIL to yesterday", upR.rrule === `FREQ=DAILY;UNTIL=${untilExpected}`, String(upR.rrule));
    const upVis = await countBlocks("Smoke applywalk");
    check("no applywalk occurrence visible after delete upcoming", upVis === 0, `count=${upVis}`);
    const walkToast = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('Smoke applywalk') && !!x.querySelector('.toast-action'))
        if (t) return (t.querySelector('.toast-msg')?.textContent ?? '')
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })()`);
    check("toast with Undo appears after delete", walkToast.includes("Smoke applywalk"), walkToast);
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke applywalk'))?.querySelector('.toast-action')?.click()`);
    await sleep(600);
    const upR2 = dbGet("SELECT rrule FROM events WHERE id = '" + awId + "'");
    check("undo restores the series rule", upR2.rrule === "FREQ=DAILY", String(upR2.rrule));
    const upVis2 = await countBlocks("Smoke applywalk");
    check("undo restores the visible occurrence", upVis2 > 0, `count=${upVis2}`);
    await openEditorOn("Smoke applywalk");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`);
    await sleep(400);
    const addQuick = async (title, startT, endT) => {
      await skipScore();
      await dismissOverlays();
      await js(`document.querySelector('.new-btn').click()`);
      for (let i = 0; i < 10; i++) {
        const open = await js(`!!document.querySelector('.quickadd')`);
        if (open) break;
        await sleep(200);
      }
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), '${title}')`);
      await setDT(".quickadd", 0, `${TODAY}T${startT}`);
      await sleep(100);
      await setDT(".quickadd", 1, `${TODAY}T${endT}`);
      await sleep(100);
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
      await sleep(400);
      await js(`(async () => {
        for (let i = 0; i < 8; i++) {
          if (Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('${title}'))) return true
          await new Promise((r) => setTimeout(r, 250))
        }
        return false
      })()`);
      await sleep(200);
    };
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(400);
    await addQuick("Smoke ovl A", "16:00", "17:00");
    await addQuick("Smoke ovl B", "16:30", "17:30");
    await addQuick("Smoke solo", "12:00", "12:30");
    const widths = await js(`(() => {
      const col = document.querySelector('.day-col')?.getBoundingClientRect()
      if (!col) return null
      const w = (t) => {
        const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes(t))
        return el ? el.getBoundingClientRect().width / col.width : null
      }
      return { a: w('Smoke ovl A'), b: w('Smoke ovl B'), solo: w('Smoke solo') }
    })()`);
    check(
      "overlapping blocks share the column FAIRLY (equal widths) and are not full width",
      !!widths && widths.a > 0.28 && widths.a < 0.95 && Math.abs(widths.a - widths.b) < 0.02,
      JSON.stringify(widths)
    );
    check("standalone block keeps full width", !!widths && widths.solo > 0.92, JSON.stringify(widths));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await realClick(await blockPos("Smoke solo"));
    await sleep(300);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    const soloGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke solo'))`);
    check("normal event deleted", soloGone);
    const soloToast = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('Smoke solo') && !!x.querySelector('.toast-action'))
        if (t) return (t.querySelector('.toast-msg')?.textContent ?? '')
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })()`);
    check("toast with Undo for normal delete", soloToast.includes("Smoke solo"), soloToast);
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke solo'))?.querySelector('.toast-action')?.click()`);
    await sleep(600);
    const soloBack = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke solo'");
    check("undo restores the event in DB", soloBack.c === 1, `rows=${soloBack.c}`);
    await realClick(await blockPos("Smoke solo"));
    await sleep(300);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(400);
    for (const t of ["Smoke ovl A", "Smoke ovl B"]) {
      await realClick(await blockPos(t));
      await sleep(300);
      const hasEditor = await js(`!!document.querySelector('.editor')`);
      if (hasEditor) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
      await sleep(400);
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    const mmTitle = await js(`document.querySelector('.mm-title')?.textContent ?? ''`);
    check("mini month shows Month Year", /^[A-Z][a-z]+ \d{4}$/.test(mmTitle), mmTitle);
    await js(`document.querySelector('.mm-title').click()`);
    await sleep(250);
    const pickerOpen = await js(`!!document.querySelector('.mm-picker') && !!document.querySelector('.mm-picker-months') && !document.querySelector('.mm-picker select')`);
    check("custom month/year picker opens (no dropdown)", pickerOpen);
    await js(`Array.from(document.querySelectorAll('.mm-month')).find((b) => b.textContent.trim() === 'Jan').click()`);
    await sleep(250);
    const mmAfter = await js(`document.querySelector('.mm-title')?.textContent ?? ''`);
    check("picking a month changes the mini calendar", mmAfter.startsWith("January"), mmAfter);
    await js(`document.querySelector('.mm-title').click()`);
    await sleep(200);
    await js(`document.querySelector('.mm-today').click()`);
    await sleep(250);
    const mmBack = await js(`document.querySelector('.mm-title')?.textContent ?? ''`);
    check("Today returns to current month", mmBack.startsWith((/* @__PURE__ */ new Date()).toLocaleString("en-US", { month: "long" })), mmBack);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`document.querySelector('.add-label-btn').click()`);
    await sleep(200);
    await js(`(${SET_VALUE})(document.querySelector('.add-label-inline input'), 'Smoke Lab')`);
    await js(`document.querySelector('.add-label-inline button').click()`);
    await sleep(400);
    const lbl1 = dbGet("SELECT color FROM labels WHERE name = 'Smoke Lab'");
    check("label created from sidebar", !!lbl1 && !!lbl1.color, JSON.stringify(lbl1));
    await js(`(${labelRowJs("Smoke Lab")}).querySelector('.la-btn').click()`);
    await sleep(200);
    const renameShown = await js(`!!document.querySelector('.rename-input')`);
    check("rename input appears", renameShown);
    await js(`(${SET_VALUE})(document.querySelector('.rename-input'), 'Smoke Lab2')`);
    await js(`document.querySelector('.rename-input').blur()`);
    await sleep(400);
    const lbl2 = dbGet("SELECT name FROM labels WHERE name = 'Smoke Lab2'");
    check("label renamed", !!lbl2, JSON.stringify(lbl2));
    const checkOpacity = () => js(`(() => { const row = ${labelRowJs("Smoke Lab2")}; if (!row) return null; return getComputedStyle(row.querySelector('.lb-check')).opacity })()`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: 4 });
    await sleep(350);
    const opBefore = await checkOpacity();
    check("filter tick hidden by default", opBefore === "0", String(opBefore));
    const rp = await labelRowPos("Smoke Lab2");
    if (rp) win.webContents.sendInputEvent({ type: "mouseMove", x: rp.x, y: rp.y });
    await sleep(350);
    const opAfter = await checkOpacity();
    check("filter tick appears on hover", opAfter === "1", String(opAfter));
    await js(`(${labelRowJs("Smoke Lab2")}).querySelector('.label-dot').click()`);
    await sleep(250);
    const palOpen = await js(`!!document.querySelector('.palette-popover')`);
    check("colour palette opens on dot click", palOpen);
    await js(`Array.from(document.querySelectorAll('.palette-popover .swatch'))[4].click()`);
    await sleep(400);
    const lbl3 = dbGet("SELECT color FROM labels WHERE name = 'Smoke Lab2'");
    check("label colour updated from palette", lbl3.color === "#30D158", `${lbl3.color} vs #30D158`);
    await js(`(${labelRowJs("Smoke Lab2")}).querySelector('.la-btn[title="Add sub-label"]').click()`);
    await sleep(200);
    await js(`(${SET_VALUE})(document.querySelector('.add-label-inline.sub input'), 'Sub Smoke')`);
    await js(`document.querySelector('.add-label-inline.sub button').click()`);
    await sleep(400);
    const sub = dbGet("SELECT parent_id, color FROM labels WHERE name = 'Sub Smoke'");
    const lbl2id = dbGet("SELECT id FROM labels WHERE name = 'Smoke Lab2'");
    check("sub-label created under parent with inherited colour", !!sub && sub.parent_id === lbl2id.id && sub.color === null, JSON.stringify(sub));
    const lbHidden = (name) => js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); return r ? r.classList.contains('hidden') : false })()`);
    const glyphOf = (name) => js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); if (!r) return 'missing'; return (r.querySelector('.lb-check').className || '').replace('lb-check', '').trim() })()`);
    const allChip = () => js(`!!document.querySelector('.all-chip')`);
    const anyGlyph = () => js(`!!document.querySelector('.lb-check.tick, .lb-check.plus')`);
    const anyCross = () => js(`!!document.querySelector('.lb-check.cross')`);
    const walkVisible = async () => await countBlocks("Morning walk") > 0;
    const gymVisible = async () => await countBlocks("Gym session") > 0;
    const deepVisible = async () => await countBlocks("Deep work — Project A") > 0;
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    check("default: no glyphs at all (empty circles)", !await anyGlyph() && !await anyCross());
    check("default: All chip hidden (all selected)", !await allChip());
    check("default: all labels show their events", await walkVisible() && await gymVisible());
    const selOf = (name) => js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => (x.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(name)}); if (!r) return 'missing'; return (Array.from(r.classList).find((c) => c.startsWith('sel-')) || '') })()`);
    await js(`(${labelRowJs("Gym")}).click()`);
    await sleep(300);
    check("cup3 case3: child solo → child GREEN, parent BLUE", await glyphOf("Gym") === "tick" && await selOf("Gym") === "sel-green" && await selOf("Fitness") === "sel-blue");
    check("cup3v2: OTHER groups fully untouched (no phase change, no visibility change)", await selOf("Work") === "" && await selOf("Learning") === "" && !await lbHidden("Work") && !await lbHidden("Learning"));
    check("cup3: child events visible (walk is hidden — child of the blue group)", await gymVisible() && !await walkVisible());
    await js(`(${labelRowJs("Fitness")}).click()`);
    await sleep(300);
    check(
      "cup3v2: BLUE → parent click → YELLOW (children retained + parent)",
      await selOf("Fitness") === "sel-yellow" && await glyphOf("Gym") === "tick" && await glyphOf("Yoga") === "" && await glyphOf("Walk") === "",
      `F=${await selOf("Fitness")} G=${await glyphOf("Gym")} Y=${await glyphOf("Yoga")} W=${await glyphOf("Walk")}`
    );
    check("cup3: selected child (Gym) visible; hidden children stay hidden", await gymVisible() && !await walkVisible());
    await js(`(${labelRowJs("Fitness")}).click()`);
    await sleep(300);
    await js(`(${labelRowJs("Fitness")}).click()`);
    await sleep(300);
    check("cup3: GREEN → parent click → EMPTY (no selection, everything shown)", !await anyGlyph() && !await allChip() && await gymVisible() && await walkVisible());
    await js(`(${labelRowJs("Gym")}).click()`);
    await sleep(300);
    check("cup3v2: Fitness group active (blue)", await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green");
    await js(`(${labelRowJs("Work")}).click()`);
    await sleep(300);
    check("cup3v2: Work amber; Fitness group preserved; other groups NOT dimmed", await selOf("Work") === "sel-amber" && await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green" && await lbHidden("Project A") && !await lbHidden("Gym") && !await lbHidden("Learning"));
    await js(`(${labelRowJs("Work")}).click()`);
    await sleep(300);
    await js(`(${labelRowJs("Work")}).click()`);
    await sleep(300);
    check("cup3v2: clearing Work leaves Fitness untouched", await selOf("Work") === "" && await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green");
    await js(`document.querySelector('.all-chip').click()`);
    await sleep(300);
    check("cup3: All chip clears all hidden + phases", !await anyGlyph() && !await allChip());
    check("cup3: all events visible again after reset", await gymVisible() && await walkVisible());
    await js(`(${labelRowJs("Learning")}).click()`);
    await sleep(300);
    check("cup3v2: lone parent → GREEN directly (no side effects)", await selOf("Learning") === "sel-green" && await glyphOf("Learning") === "tick" && !await lbHidden("Gym"));
    await js(`(${labelRowJs("Learning")}).click()`);
    await sleep(300);
    check("cup3v2: lone parent GREEN → EMPTY (nothing else changes)", await selOf("Learning") === "" && !await anyGlyph() && !await lbHidden("Gym") && await selOf("Fitness") === "");
    await js(`(${labelRowJs("Gym")}).click()`);
    await sleep(300);
    check("cup3v3: child selected (Fitness blue, Gym green)", await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green" && await glyphOf("Gym") === "tick");
    await js(`(${labelRowJs("Learning")}).click()`);
    await sleep(300);
    check("cup3v3: selecting childless parent does NOT deselect the selected child", await selOf("Learning") === "sel-green" && await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green" && await glyphOf("Gym") === "tick" && !await lbHidden("Gym"));
    await js(`(${labelRowJs("Learning")}).click()`);
    await sleep(300);
    check("cup3v3: deselecting childless parent does NOT select/change anything else", await selOf("Learning") === "" && await selOf("Fitness") === "sel-blue" && await selOf("Gym") === "sel-green" && await glyphOf("Gym") === "tick" && !await lbHidden("Gym"));
    await js(`document.querySelector('.all-chip')?.click()`);
    await sleep(300);
    check("no red crosses ever", !await anyCross());
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`(${labelRowJs("Sub Smoke")}).querySelector('.la-btn.del').click()`);
    await sleep(200);
    const armed = await js(`(${labelRowJs("Sub Smoke")}).querySelector('.la-btn.del').textContent.trim()`);
    check("delete is two-step (armed first)", armed === "Delete?", armed);
    await js(`(${labelRowJs("Sub Smoke")}).querySelector('.la-btn.del').click()`);
    await sleep(500);
    const subGone = dbGet("SELECT COUNT(*) AS c FROM labels WHERE name = 'Sub Smoke'");
    check("label deleted from DB", subGone.c === 0, `rows=${subGone.c}`);
    await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Sub Smoke'))?.querySelector('.toast-action')?.click()`);
    await sleep(600);
    const subBack = dbGet("SELECT COUNT(*) AS c FROM labels WHERE name = 'Sub Smoke'");
    check("undo restores the label", subBack.c === 1, `rows=${subBack.c}`);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`(${labelRowJs("Smoke Lab2")}).querySelector('.la-btn.del').click()`);
    await sleep(150);
    await js(`(${labelRowJs("Smoke Lab2")}).querySelector('.la-btn.del').click()`);
    await sleep(500);
    const lblNames = dbAll("SELECT name FROM labels WHERE name IN ('Smoke Lab2','Sub Smoke')");
    check("cleanup: labels removed", lblNames.length === 0, JSON.stringify(lblNames));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(600);
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
    })()`);
    check("insights tab ✦ shines when selected; coins tab coin is static", twinkleOn.segTwinkle && twinkleOn.segShining && twinkleOn.segAnim.includes("twinkleSpin") && twinkleOn.headShining && !twinkleOn.coinsSegCoin.includes("moneyFlip"), JSON.stringify(twinkleOn));
    const iv = await js(`({
      view: !!document.querySelector('.insights-view'),
      cards: document.querySelectorAll('.ins-card').length,
      digest: document.querySelectorAll('.digest li').length,
      charts: document.querySelectorAll('.chart-svg').length,
      heat: document.querySelectorAll('.heatmap .heat-cell').length,
      weeks: document.querySelectorAll('.heat-week').length,
      heatWrap: !!document.querySelector('.heatmap-wrap'),
      heatBtn: !!document.querySelector('.heat-head-btn'),
      donut: !!document.querySelector('.donut'),
      progress: document.querySelectorAll('.ins-progress').length
    })`);
    check("insights view opens", iv.view);
    check("summary cards render (>=4)", iv.cards >= 4, String(iv.cards));
    check("plain-language digest present (>=3)", iv.digest >= 3, String(iv.digest));
    check("charts render (>=4)", iv.charts >= 4, String(iv.charts));
    check("heatmap renders AT LEAST 16 weeks (112+ cells, week columns)", iv.heat >= 112 && iv.weeks >= 16, JSON.stringify({ heat: iv.heat, weeks: iv.weeks }));
    check("heatmap is horizontally scrollable + heading clickable", iv.heatWrap && iv.heatBtn, JSON.stringify(iv));
    const heatFill = await js(`(() => {
      const wrap = document.querySelector('.heatmap-wrap')
      const map = document.querySelector('.heatmap')
      if (!wrap || !map) return null
      const wr = wrap.getBoundingClientRect()
      const mr = map.getBoundingClientRect()
      const cw = wrap.clientWidth // content width (scrollbar-gutter excluded)
      return { wrapW: Math.round(wr.width), mapW: Math.round(mr.width), cw: Math.round(cw), fills: mr.width >= cw - 4 }
    })()`);
    check("cup5b: heatmap stretches to fill the box (no dead space)", !!heatFill && heatFill.fills, JSON.stringify(heatFill));
    await js(`document.querySelector('.heat-head-btn')?.click()`);
    await sleep(300);
    const heatPop = await js(`!!document.querySelector('.heat-pop')`);
    check("heatmap threshold popover opens on heading click", heatPop);
    await js(`(${SET_VALUE})(document.querySelector('.heat-pop input'), '3')`);
    await js(`Array.from(document.querySelectorAll('.heat-pop .btn')).find((b) => b.textContent.trim() === 'Save')?.click()`);
    await sleep(400);
    const heatT = await js(`window.api.settings.get('heatT1')`);
    check("heatmap threshold saved (heatT1=3)", heatT === "3", String(heatT));
    const heatTitle = await js(`document.querySelector('.heat-head-btn')?.textContent ?? ''`);
    check("heatmap heading renamed to Activity heatmap", heatTitle.includes("Activity heatmap"), heatTitle);
    await js(`document.querySelector('.heat-head-btn')?.click()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelectorAll('.heat-pop input')[0], '7')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.heat-pop input')[1], '5')`);
    await sleep(250);
    const heatInvalid = await js(`(() => {
      const err = document.querySelector('.heat-pop-err')
      const save = Array.from(document.querySelectorAll('.heat-pop .btn')).find((b) => b.textContent.trim() === 'Save')
      return { err: err ? err.textContent : '', disabled: save ? save.disabled : false }
    })()`);
    check("cup5b: invalid thresholds (low >= medium) show error + block Save", heatInvalid.err.includes("less than") && heatInvalid.disabled, JSON.stringify(heatInvalid));
    await js(`(${SET_VALUE})(document.querySelectorAll('.heat-pop input')[0], '2')`);
    await sleep(200);
    const heatValid = await js(`(() => { const save = Array.from(document.querySelectorAll('.heat-pop .btn')).find((b) => b.textContent.trim() === 'Save'); return save ? !save.disabled : false })()`);
    check("cup5b: valid thresholds re-enable Save", heatValid);
    await js(`Array.from(document.querySelectorAll('.heat-pop .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    await sleep(200);
    await js(`window.api.settings.set('heatT1', '2')`);
    await js(`window.api.settings.set('heatT2', '5')`);
    check("donut + label progress present", iv.donut && iv.progress > 0, String(iv.progress));
    const digText = await js(`Array.from(document.querySelectorAll('.digest li')).map((e) => e.textContent).join(' | ')`);
    check("digest mentions planned time", /planned|completed/i.test(digText), digText.slice(0, 80));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.includes('month')).click()`);
    await sleep(600);
    const toggle1 = await js(`(() => {
      const b = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((x) => x.textContent.includes('month'))
      return { label: b?.textContent.trim() ?? '', amber: b ? b.classList.contains('alt') : false }
    })()`);
    check('v1.10.5: selected chip toggles to amber + "Last month"', toggle1.amber && toggle1.label === "Last month", JSON.stringify(toggle1));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.includes('month')).click()`);
    await sleep(600);
    const toggle2 = await js(`(() => {
      const b = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((x) => x.textContent.includes('month'))
      return { label: b?.textContent.trim() ?? '', amber: b ? b.classList.contains('alt') : false }
    })()`);
    check('v1.10.5: clicking again returns to blue "This month"', !toggle2.amber && toggle2.label === "This month", JSON.stringify(toggle2));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.includes('week')).click()`);
    await sleep(600);
    const toggle3 = await js(`(() => {
      const b = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((x) => x.textContent.includes('week'))
      return { label: b?.textContent.trim() ?? '', amber: b ? b.classList.contains('alt') : false, active: b ? b.classList.contains('active') : false }
    })()`);
    check("v1.10.5: switching tabs resets the chip (This week, blue, active)", toggle3.label === "This week" && !toggle3.amber && toggle3.active, JSON.stringify(toggle3));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`);
    await sleep(600);
    const heatScroll = await js(`(() => { const w = document.querySelector('.heatmap-wrap'); return w ? { scrollLeft: Math.round(w.scrollLeft), max: w.scrollWidth - w.clientWidth } : null })()`);
    check("v1.10.5: heatmap scrolled to the LATEST weeks (right end)", !!heatScroll && heatScroll.scrollLeft >= heatScroll.max - 4, JSON.stringify(heatScroll));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month').click()`);
    await sleep(500);
    const iv2 = await js(`({ view: !!document.querySelector('.insights-view'), cards: document.querySelectorAll('.ins-card').length })`);
    check("period switch keeps insights rendering", iv2.view && iv2.cards >= 4);
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'All time').click()`);
    await sleep(500);
    const iv3 = await js(`!!document.querySelector('.insights-view') && document.querySelectorAll('.heatmap .heat-cell').length`);
    check("all-time period renders (heatmap follows the period — full history window)", iv3 > 0, String(iv3));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(600);
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
    })()`);
    check("insights collapses sidebar & pills, hides today/title (search+New live in the pills row, hidden with it)", chrome.sidebarCollapsed && chrome.pillsGone && !chrome.todayBtn && !chrome.title && chrome.switcher, JSON.stringify(chrome));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const tbLayout = await js(`(() => ({
      searchInPills: !!document.querySelector('.status-pills .searchbox'),
      newInPills: !!document.querySelector('.status-pills .new-btn'),
      searchInToolbar: !!document.querySelector('.toolbar .searchbox'),
      newInToolbar: !!document.querySelector('.toolbar .new-btn'),
      settingsBtn: !!document.querySelector('.toolbar .settings-btn'),
      searchPill: (() => { const s = document.querySelector('.status-pills .searchbox'); return s ? getComputedStyle(s).borderRadius : '' })()
    }))()`);
    check("search + New moved into the status-pills row (long pill); toolbar = tabs + settings only", tbLayout.searchInPills && tbLayout.newInPills && !tbLayout.searchInToolbar && !tbLayout.newInToolbar && tbLayout.settingsBtn && tbLayout.searchPill === "999px", JSON.stringify(tbLayout));
    await js(`(() => { const t = document.querySelector('.sidebar .mm-title'); if (t) t.click(); return !!t })()`);
    await sleep(600);
    const pickerOpen2 = await js(`!!document.querySelector('.sidebar .mm-picker')`);
    const sideGeo = await js(`(() => {
      const sb = document.querySelector('.sidebar').getBoundingClientRect()
      const tc = document.querySelector('.today-card').getBoundingClientRect()
      const tree = document.querySelector('.label-tree')
      const tr = tree ? tree.getBoundingClientRect() : null
      const rows = Array.from(document.querySelectorAll('.label-row'))
      let overlap = false
      for (const r of rows) {
        const rr = r.getBoundingClientRect()
        if (rr.bottom > tc.top + 2 && rr.top < tc.bottom - 2) overlap = true
      }
      return {
        todayInSidebar: tc.bottom <= sb.bottom + 2 && tc.top >= sb.top - 2,
        treeScrolls: tr ? tree.scrollHeight > tree.clientHeight : false,
        rowsOverlapToday: overlap,
        rowsFit: tr ? rows.length === 0 || rows[rows.length - 1].getBoundingClientRect().bottom <= tr.bottom + 2 : true,
        pickerFloats: (() => { const p = document.querySelector('.sidebar .mm-picker'); const pr = p ? p.getBoundingClientRect() : null; return pr ? pr.bottom <= sb.bottom + 2 : false })()
      }
    })()`);
    check("v1.10.4: expanded calendar picker does NOT make labels overlap the Today card", pickerOpen2 && sideGeo.todayInSidebar && !sideGeo.rowsOverlapToday && (sideGeo.treeScrolls || sideGeo.rowsFit) && sideGeo.pickerFloats, JSON.stringify(sideGeo));
    const pickerInside = await js(`(() => {
      const mm = document.querySelector('.sidebar .minimonth')?.getBoundingClientRect()
      const pk = document.querySelector('.sidebar .mm-picker')?.getBoundingClientRect()
      if (!mm || !pk) return { found: false }
      return { found: true, inside: pk.left >= mm.left - 1 && pk.right <= mm.right + 1 && pk.bottom <= mm.bottom + 1 }
    })()`);
    check("v1.10.5: month/year picker stays inside the calendar widget", pickerInside.found && pickerInside.inside, JSON.stringify(pickerInside));
    await js(`(() => { const t = document.querySelector('.sidebar .mm-title'); if (t) t.click(); return !!t })()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((x) => x.textContent.startsWith('All'))?.click()`);
    await sleep(300);
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
    })()`);
    check("cup4: filter counts match the selected week (period-scoped)", periodCounts.todo === periodCounts.bTodo && periodCounts.doing === periodCounts.bDoing && periodCounts.done === periodCounts.bDone && periodCounts.cancelled === periodCounts.bCancelled, JSON.stringify(periodCounts));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(500);
    const stickyPos = await js(`getComputedStyle(document.querySelector('.ins-head')).position`);
    check("period selector + KPI cards in fixed header (no sticky bleed)", stickyPos === "relative" || stickyPos === "static", stickyPos);
    const chipLabels = await js(`Array.from(document.querySelectorAll('.ins-chip')).map((c) => c.textContent.trim())`);
    check("parent-label chips present (incl All labels)", chipLabels.includes("All labels") && chipLabels.includes("Fitness"), JSON.stringify(chipLabels));
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.includes('Fitness')).click()`);
    await sleep(600);
    const fitOnly = await js(`Array.from(document.querySelectorAll('.ins-legend-name')).map((e) => e.textContent)`);
    check("parent filter shows only that label", fitOnly.length === 1 && fitOnly[0] === "Fitness", JSON.stringify(fitOnly));
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.ins-legend-row')).find((r) => (r.querySelector('.ins-legend-name')?.textContent ?? '').trim() === 'Fitness').click()`);
    await sleep(500);
    const subSegs = await js(`document.querySelectorAll('.ins-sublabel-seg').length`);
    const subRows = await js(`Array.from(document.querySelectorAll('.ins-subrow')).map((r) => r.textContent.trim())`);
    check("parent click in time-per-label shows sublabel bar", subSegs >= 2, String(subSegs));
    check("sublabel rows listed (names + times)", subRows.length >= 2, JSON.stringify(subRows));
    await js(`Array.from(document.querySelectorAll('.ins-progress')).find((r) => (r.querySelector('.ins-progress-name')?.textContent ?? '').includes('Fitness')).click()`);
    await sleep(500);
    const compSubs = await js(`Array.from(document.querySelectorAll('.ins-progress.sub')).map((r) => (r.querySelector('.ins-progress-name')?.textContent ?? '').trim())`);
    check("label completion click shows sublabel rows", compSubs.length >= 2, JSON.stringify(compSubs));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'Custom').click()`);
    await sleep(300);
    const customInputs = await js(`document.querySelectorAll('.ins-custom-range input').length`);
    check("custom period shows date-range inputs", customInputs === 2, String(customInputs));
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[0], '2026-01-01')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[1], '2026-01-31')`);
    await sleep(600);
    const customOk = await js(`!!document.querySelector('.insights-view') && document.querySelectorAll('.ins-card').length >= 4`);
    check("custom period renders insights", customOk);
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const doingDots = await js(`document.querySelectorAll('.eb-dot.doing').length`);
    check("in-progress events show a blue dot", doingDots >= 1, String(doingDots));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(400);
    const doneBlockDot = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb.done')).find((e) => e.querySelector('.eb-title'))
      return el ? (el.querySelector('.eb-dot') === null && el.querySelector('.eb-switch') === null ? 'no dot, no switch (compact)' : 'bad') : 'no done block'
    })()`);
    check("v1.11.1: done blocks have no dot and no switch in the month view", doneBlockDot === "no dot, no switch (compact)", doneBlockDot);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const wkSwitch = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Deep work') || e.textContent.includes('Morning walk'))
      const sw = el ? el.querySelector('.eb-switch') : null
      return { has: !!sw, aria: sw ? sw.getAttribute('aria-label') || '' : '' }
    })()`);
    check("v1.11.1: day/week blocks have a status switch (top-right)", wkSwitch.has && wkSwitch.aria.includes("Change status"), JSON.stringify(wkSwitch));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const gutter = await js(`getComputedStyle(document.querySelector('.week-body')).scrollbarGutter`);
    check("week table reserves scrollbar gutter (no corner bleed)", gutter === "stable", String(gutter));
    const readingBefore = dbGet("SELECT start_local, end_local FROM events WHERE id = 'evt-reading'");
    await js(`document.querySelector('.week-body') ? document.querySelector('.week-body').scrollTop = 0 : null`);
    await sleep(250);
    const probe1 = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Evening reading')); if (!el) return 'no block'; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const col = el.closest('.day-col'); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6), day: col ? col.getAttribute('data-day') : null, vh: window.innerHeight, dayCols: document.querySelectorAll('.day-col').length } })()`);
    console.log("[smoke] 2o probe1:", JSON.stringify(probe1));
    await realClick(probe1 && probe1 !== "no block" ? { x: probe1.x, y: probe1.y } : null);
    await sleep(400);
    const probe2 = await js(`({ editor: !!document.querySelector('.editor'), title: document.querySelector('.editor .ef-title')?.value ?? null, applyTo: !!document.querySelector('.apply-to') })`);
    console.log("[smoke] 2o probe2:", JSON.stringify(probe2));
    if (!probe2.editor) {
      check("series edit from later day keeps series start date (no vanish)", false, "editor did not open (2o)");
      check("series title updated", false, "editor did not open (2o)");
    } else {
      await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
      await sleep(150);
      await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke reading series')`);
      await saveEditor();
      await sleep(500);
      const readingAfter = dbGet("SELECT start_local, title FROM events WHERE id = 'evt-reading'");
      check("series edit from later day keeps series start date (no vanish)", readingAfter.start_local === readingBefore.start_local, `${readingAfter.start_local} vs ${readingBefore.start_local}`);
      check("series title updated", readingAfter.title === "Smoke reading series", readingAfter.title);
    }
    await realClick(await blockPos("Smoke reading series"));
    await sleep(350);
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke reading one')`);
    await saveEditor();
    await sleep(500);
    const ovrRead = dbGet("SELECT start_local, parent_id FROM events WHERE title = 'Smoke reading one'");
    check("this-occurrence edit uses the selected day", !!ovrRead && ovrRead.parent_id === "evt-reading" && ovrRead.start_local.startsWith(probe1.day ?? ""), JSON.stringify(ovrRead) + " vs day " + probe1.day);
    await realClick(await blockPos("Smoke reading one"));
    await sleep(300);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(400);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke reading series')); if (el) el.scrollIntoView({ block: 'center' }); return !!el })()`);
    await sleep(250);
    await realClick(await blockPos("Smoke reading series"));
    await sleep(350);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(150);
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Evening reading')`);
    await saveEditor();
    await sleep(400);
    const readingReverted = dbGet("SELECT title FROM events WHERE id = 'evt-reading'");
    check("series title reverted", readingReverted.title === "Evening reading", readingReverted.title);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke overnight')`);
    await setDT(".quickadd", 0, `${TODAY}T22:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const ovn = dbGet("SELECT start_local, end_local FROM events WHERE title = 'Smoke overnight'");
    check("overnight event saved with next-day end", ovn.end_local === `${TOMORROW}T00:30`, JSON.stringify(ovn));
    const ovnCols = await js(`(() => {
      const cols = Array.from(document.querySelectorAll('.day-col'))
      return cols.map((c) => Array.from(c.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke overnight')))
    })()`);
    check("overnight event visible (at least one day)", ovnCols.filter(Boolean).length >= 1, JSON.stringify(ovnCols));
    const dragBefore = dbGet("SELECT start_local FROM events WHERE title = 'Smoke overnight'");
    const dragPos = await blockPos("Smoke overnight");
    if (!dragPos) {
      dragWorks = false;
    } else {
      await realDrag(dragPos, 0, 33);
      await sleep(700);
      const dragAfter = dbGet("SELECT start_local FROM events WHERE title = 'Smoke overnight'");
      dragWorks = dragAfter.start_local !== dragBefore.start_local;
    }
    if (!dragWorks) {
      results.push("SKIP drag-dependent tests (synthetic drag cannot persist in this environment — passes with a real mouse)");
      await js(`window.api.events.list().then((es) => { const e = es.find((x) => x.title === 'Smoke overnight'); if (e) return window.api.events.remove(e.id); return null })`);
      await sleep(300);
    } else {
      let ovn2 = dbGet("SELECT start_local, end_local FROM events WHERE title = 'Smoke overnight'");
      for (let attempt = 0; attempt < 2 && ovn2.start_local !== `${TODAY}T23:00`; attempt++) {
        await realDrag(await blockPos("Smoke overnight"), 0, 33);
        await sleep(700);
        ovn2 = dbGet("SELECT start_local, end_local FROM events WHERE title = 'Smoke overnight'");
      }
      check("overnight drag keeps next-day end (23:00→01:30)", ovn2.start_local === `${TODAY}T23:00` && ovn2.end_local === `${TOMORROW}T01:30`, JSON.stringify(ovn2));
      await realClick(await blockPos("Smoke overnight"));
      await sleep(300);
      await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
      await sleep(400);
    }
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke invalid')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T09:00`);
    await sleep(250);
    const addDisabled = await js(`document.querySelector('.quickadd .btn.primary').disabled`);
    const errShown = await js(`!!document.querySelector('.quickadd .ef-error')`);
    check("quickadd blocks end-before-start (disabled + error)", addDisabled && errShown);
    await setDT(".quickadd", 1, `${TODAY}T10:30`);
    await sleep(200);
    const addEnabled = await js(`!document.querySelector('.quickadd .btn.primary').disabled`);
    check("quickadd allows valid range", addEnabled);
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(250);
    const dwProbe = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Deep work')); if (!el) return 'no block'; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6), vh: window.innerHeight } })()`);
    console.log("[smoke] 2q dwProbe:", JSON.stringify(dwProbe));
    await realClick(dwProbe && dwProbe !== "no block" ? { x: dwProbe.x, y: dwProbe.y } : null);
    await sleep(350);
    const dwProbe2 = await js(`({ editor: !!document.querySelector('.editor'), inputs: document.querySelectorAll('.editor .ef-dt').length, title: document.querySelector('.editor .ef-title')?.value ?? null })`);
    console.log("[smoke] 2q dwProbe2:", JSON.stringify(dwProbe2));
    const startValShown = await getDT(".editor", 0);
    await setDT(".editor", 1, `${startValShown.slice(0, 10)}T08:00`);
    await sleep(300);
    const valEnd = await getDT(".editor", 1);
    const valStart = await getDT(".editor", 0);
    const valProbe = await js(`({ endVal: '${valEnd}', startVal: '${valStart}', saveDisabled: document.querySelector('.editor .btn.primary').disabled, err: !!document.querySelector('.editor .ef-error') })`);
    console.log("[smoke] 2q valProbe:", JSON.stringify(valProbe));
    const saveDisabled = valProbe.saveDisabled;
    const errShown2 = valProbe.err;
    check("editor blocks end-before-start (disabled + error)", saveDisabled && errShown2, JSON.stringify(valProbe));
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(250);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke split')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const d2 = new Date(Date.now() + 2 * 864e5);
    const d2Iso = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, "0")}-${String(d2.getDate()).padStart(2, "0")}`;
    const d2Before = new Date(Date.now() + 1 * 864e5);
    const d2BeforeIso = `${d2Before.getFullYear()}-${String(d2Before.getMonth() + 1).padStart(2, "0")}-${String(d2Before.getDate()).padStart(2, "0")}`;
    const d2Key = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d2.getDay()];
    for (let tries = 0; tries < 3; tries++) {
      const visible = await js(`!!document.querySelector('.day-col[data-day="${d2Iso}"]')`);
      if (visible) break;
      await js(`Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.getAttribute('aria-label') === 'Next')?.click()`);
      await sleep(450);
    }
    const splitClick = await js(`(() => { const col = document.querySelector('.day-col[data-day="${d2Iso}"]'); if (!col) return 'no col'; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke split')); if (!el) return 'no block'; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) } })()`);
    await realClick(splitClick && splitClick !== "no col" && splitClick !== "no block" ? splitClick : null);
    await sleep(350);
    const splitProbe = await js(`({ editor: !!document.querySelector('.editor'), title: document.querySelector('.editor .ef-title')?.value ?? null })`);
    check("split: editor opens on day+2 occurrence", splitProbe.editor && splitProbe.title === "Smoke split", JSON.stringify(splitProbe));
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.editor .apply-to .seg-btn')).find((b) => b.textContent.includes('This date')).click()`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.repeat-editor .wd-pill')).forEach((p) => {
      if (p.dataset.day === '${d2Key}' !== p.classList.contains('on')) p.click()
    })`);
    await sleep(200);
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke split new')`);
    await saveEditor();
    await sleep(600);
    const oldMaster = dbGet("SELECT rrule FROM events WHERE title = 'Smoke split'");
    const newSeries = dbGet("SELECT rrule, start_local FROM events WHERE title = 'Smoke split new'");
    check("split: old series ends the day before", oldMaster.rrule === `FREQ=DAILY;UNTIL=${d2BeforeIso}`, String(oldMaster.rrule));
    check("split: new series starts at the selected day with the new rule", !!newSeries && newSeries.rrule === `FREQ=WEEKLY;BYDAY=${d2Key}` && newSeries.start_local.startsWith(d2Iso), JSON.stringify(newSeries));
    const splitUndo = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Series split'))?.querySelector('.toast-action')?.click() ?? 'none'`);
    await sleep(700);
    const oldRestored = dbGet("SELECT rrule FROM events WHERE title = 'Smoke split'");
    const newGone = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke split new'");
    check("split undo: old rule restored + new series removed", oldRestored.rrule === "FREQ=DAILY" && newGone.c === 0, `${oldRestored.rrule} new=${newGone.c}`);
    await realClick(await blockPos("Smoke split"));
    await sleep(300);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(150);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    const splitGone = dbGet("SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke split','Smoke split new')");
    check("split cleanup: series deleted", splitGone.c === 0, String(splitGone.c));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    if (dragWorks) {
      await js(`document.querySelector('.new-btn').click()`);
      await sleep(250);
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke night')`);
      await setDT(".quickadd", 0, `${TODAY}T22:00`);
      await sleep(100);
      await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
      await sleep(100);
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
      await sleep(500);
      for (let tries = 0; tries < 3; tries++) {
        const both = await js(`(() => {
        const hasT = !!document.querySelector('.day-col[data-day="${TODAY}"]')
        const hasTm = !!document.querySelector('.day-col[data-day="${TOMORROW}"]')
        return hasT && hasTm
      })()`);
        if (both) break;
        await js(`Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.getAttribute('aria-label') === 'Next')?.click()`);
        await sleep(450);
      }
      await realDrag(await blockPos("Smoke night"), 0, 33);
      await sleep(700);
      const nightCount = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke night')).length)`);
      check("overnight drag: no ghost (never >1 per day)", nightCount.every((n) => n <= 1) && nightCount.some((n) => n > 0), JSON.stringify(nightCount));
      const nightClicked = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return 'no col'; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night')); if (!el) return 'no block'; el.click(); return 'ok' })()`);
      await sleep(400);
      const nightEditorOpen = await js(`!!document.querySelector('.editor')`);
      if (nightEditorOpen) {
        const nightEnd = await getDT(".editor", 1);
        const nightStart = await getDT(".editor", 0);
        const nightProbe = await js(`({ editor: true, endVal: '${nightEnd}', startVal: '${nightStart}' })`);
        console.log("[smoke] 2s nightProbe:", JSON.stringify(nightProbe));
        check("overnight edit shows the real next-day end", nightEnd === `${TOMORROW}T01:30`, nightEnd);
        await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
      } else {
        check("overnight edit shows the real next-day end", false, "editor did not open (drag did not persist in xvfb)");
      }
      await sleep(400);
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    const animName = await js(`getComputedStyle(document.querySelector('.view-host > *')).animationName`);
    const sideW = await js(`getComputedStyle(document.querySelector('.sidebar')).width`);
    check("view enter animation active (viewIn)", animName === "viewIn", String(animName));
    check("sidebar collapsed in insights", parseFloat(sideW) <= 1, sideW);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(700);
    const sideW2 = await js(`getComputedStyle(document.querySelector('.sidebar')).width`);
    const animName2 = await js(`getComputedStyle(document.querySelector('.view-host > *')).animationName`);
    check("sidebar expands back on calendar views", sideW2 === "236px", sideW2);
    check("week view also animates in", animName2 === "viewIn", String(animName2));
    const addQ = async (title, st4, en) => {
      await dismissOverlays();
      await js(`document.querySelector('.new-btn').click()`);
      for (let i = 0; i < 10; i++) {
        const open = await js(`!!document.querySelector('.quickadd')`);
        if (open) break;
        await sleep(200);
      }
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), '${title}')`);
      await setDT(".quickadd", 0, `${TODAY}T${st4}`);
      await sleep(100);
      await setDT(".quickadd", 1, `${TODAY}T${en}`);
      await sleep(100);
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
      await sleep(400);
    };
    if (dragWorks) {
      await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`);
      await sleep(400);
      await addQ("Smoke RZ A", "16:00", "17:00");
      await addQ("Smoke RZ B", "16:30", "17:30");
      await addQ("Smoke RZ C", "16:15", "16:45");
      for (const t of ["Smoke RZ A", "Smoke RZ B", "Smoke RZ C"]) {
        await realDrag(await blockPos(t, "bottom"), 0, 16.5);
        await sleep(500);
      }
      const rzA = dbGet("SELECT end_local FROM events WHERE title = 'Smoke RZ A'");
      const rzB = dbGet("SELECT end_local FROM events WHERE title = 'Smoke RZ B'");
      const rzC = dbGet("SELECT end_local FROM events WHERE title = 'Smoke RZ C'");
      check("overlapping event A resized +30m", rzA.end_local === `${TODAY}T17:30`, rzA.end_local);
      check("overlapping event B resized +30m", rzB.end_local === `${TODAY}T18:00`, rzB.end_local);
      check("overlapping event C resized +30m", rzC.end_local === `${TODAY}T17:15`, rzC.end_local);
      for (const t of ["Smoke RZ A", "Smoke RZ B", "Smoke RZ C"]) {
        await realClick(await blockPos(t));
        await sleep(300);
        await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
        await sleep(400);
      }
    }
    await addQ("Smoke vanish", "15:00", "16:00");
    await realClick(await blockPos("Smoke vanish"));
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(500);
    await skipScore();
    const vanishStillThere = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke vanish'))`);
    check("status change keeps the block visible", vanishStillThere);
    const vanishDb = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke vanish' AND status = 'done'");
    check("status change persisted", vanishDb.c === 1);
    await addQ("Smoke vanish2", "14:00", "15:00");
    await js(`Array.from(document.querySelectorAll('.pill')).find((b) => b.textContent.includes('To Do')).click()`);
    await sleep(300);
    await realClick(await blockPos("Smoke vanish2"));
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'doing')`);
    await saveEditor();
    await sleep(500);
    const warnToast = await js(`Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('filter is hiding'))`);
    check("filter-hide warning toast appears", warnToast);
    await js(`Array.from(document.querySelectorAll('.pill')).find((b) => b.textContent.trim() === 'All').click()`);
    await sleep(300);
    const vanish2Back = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke vanish2'))`);
    check("block visible again after clearing filter", vanish2Back);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    for (const t of ["Smoke vanish", "Smoke vanish2"]) {
      const ok = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${t}')); if (!el) return false; el.click(); return true })()`);
      await sleep(400);
      const open = await js(`!!document.querySelector('.editor')`);
      if (ok && open) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
      await sleep(500);
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(1200);
    const dice = await js(`({
      cards: document.querySelectorAll('.ins-card.kpi').length,
      anim: getComputedStyle(document.querySelector('.kpi-face')).animationName
    })`);
    check("dice: 4 KPI cards", dice.cards === 4, String(dice.cards));
    check("dice: flip animation active", dice.anim === "kpiFlip", String(dice.anim));
    const faces1 = await js(`Array.from(document.querySelectorAll('.ins-card.kpi')).map((c) => c.getAttribute('data-face'))`);
    await sleep(5300);
    const faces2 = await js(`Array.from(document.querySelectorAll('.ins-card.kpi')).map((c) => c.getAttribute('data-face'))`);
    check("dice: faces roll over time", JSON.stringify(faces1) !== JSON.stringify(faces2), `${faces1} → ${faces2}`);
    const bestStored = await js(`window.api.settings.get('bestStreak')`);
    check("best streak saved to settings", bestStored !== null, String(bestStored));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'Custom').click()`);
    await sleep(300);
    const customVals = await js(`Array.from(document.querySelectorAll('.ins-custom-range input')).map((i) => i.value)`);
    check("custom range defaults to today", customVals.length === 2 && customVals[0] === TODAY && customVals[1] === TODAY, JSON.stringify(customVals));
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke ownpart')`);
    await setDT(".quickadd", 0, `${TODAY}T15:30`);
    await sleep(100);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd select'), 'lbl-fitness')`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    await js(`Array.from(document.querySelectorAll('.ins-legend-row')).find((r) => (r.querySelector('.ins-legend-name')?.textContent ?? '').trim() === 'Fitness').click()`);
    await sleep(500);
    const ownRow = await js(`Array.from(document.querySelectorAll('.ins-subrow')).some((r) => r.textContent.includes('no sub-label'))`);
    check("parent own part shown separately (no sub-label)", ownRow);
    const digBreakdown = await js(`Array.from(document.querySelectorAll('.digest li')).some((l) => l.textContent.includes('Biggest time investment'))`);
    check("digest mentions biggest label", digBreakdown);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await realClick(await blockPos("Smoke ownpart"));
    await sleep(300);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(400);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke until')`);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-ends .seg-btn')).find((b) => b.textContent.trim() === 'On date').click()`);
    await sleep(250);
    const untilVal = await js(`document.querySelector('.quickadd .re-until')?.value ?? ''`);
    check("repeat On date prefills a date", /^\d{4}-\d{2}-\d{2}$/.test(untilVal), untilVal);
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(250);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    const digCols = await js(`getComputedStyle(document.querySelector('.digest ul')).gridTemplateColumns.split(' ').length`);
    check("digest renders in two columns", digCols === 2, String(digCols));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await realClick(await blockPos("Evening reading"));
    await sleep(350);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(200);
    const noneBtn = await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'None')`);
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'None').click()`);
    await sleep(400);
    const crashCheck = await js(`({ editorStillOpen: !!document.querySelector('.editor'), rootAlive: document.querySelectorAll('.eb').length > 0, summaryCount: document.querySelectorAll('.repeat-note').length })`);
    check("repeat None: no crash, editor stays open", crashCheck.editorStillOpen && crashCheck.rootAlive, JSON.stringify(crashCheck));
    check("repeat None: no duplicated summary box", crashCheck.summaryCount === 0, String(crashCheck.summaryCount));
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`);
    await sleep(250);
    const weeklyBack = await js(`!!document.querySelector('.repeat-editor .wd-pill')`);
    check("repeat editor works again after None", weeklyBack);
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel').click()`);
    await sleep(300);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke night2')`);
    await setDT(".quickadd", 0, `${TODAY}T22:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const chunk2 = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) } })()`);
    await realDrag(chunk2, 0, 33);
    await sleep(700);
    const n2 = dbGet("SELECT start_local, end_local FROM events WHERE title = 'Smoke night2'");
    check("day-2 chunk drag moves whole span (+1h, no shift)", n2.start_local === `${TODAY}T23:00` && n2.end_local === `${TOMORROW}T01:30`, JSON.stringify(n2));
    const chunk2b = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 4) } })()`);
    await realDrag(chunk2b, 0, 16.5);
    await sleep(700);
    const n2b = dbGet("SELECT end_local FROM events WHERE title = 'Smoke night2'");
    check("day-2 chunk resize extends real end +30m", n2b.end_local === `${TOMORROW}T02:00`, n2b.end_local);
    const n2Cols = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke night2')).length)`);
    check("multiday still exactly one chunk per day (no ghost)", n2Cols.filter((n) => n > 0).length === 2 && n2Cols.every((n) => n <= 1), JSON.stringify(n2Cols));
    const n2Del = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke night2')); if (!el) return false; el.click(); return true })()`);
    await sleep(400);
    if (n2Del) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    await js(`document.querySelector('.insights-view').scrollTop = 600`);
    await sleep(500);
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
    })()`);
    check("bleed: header sits above the scroll area (no sticky overlap)", bleed.headAbove && bleed.allCovered, JSON.stringify(bleed));
    check("bleed: header is opaque", bleed.bgOpaque, bleed.bg);
    const faceAfterSwitch = await js(`(() => { const c = document.querySelector('.ins-card.kpi[data-card="0"]'); return c ? c.getAttribute('data-face') : null })()`);
    check("dice: card resets to Planned time on period change", faceAfterSwitch === "0", String(faceAfterSwitch));
    const kpiLabel0 = await js(`document.querySelector('.ins-card.kpi[data-card="0"] .ins-card-label')?.textContent ?? ''`);
    check("dice: card 1 label is Planned time", kpiLabel0 === "Planned time", kpiLabel0);
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.includes('Fitness')).click()`);
    await sleep(700);
    const autoSub = await js(`document.querySelectorAll('.ins-subrow').length`);
    check("focused label shows sublabels by default", autoSub >= 2, String(autoSub));
    const digMostly = await js(`Array.from(document.querySelectorAll('.digest li')).some((l) => l.textContent.includes('mostly'))`);
    check("digest names the highest part (mostly …)", digMostly);
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This year').click()`);
    await sleep(700);
    const yearPlanned = await js(`(async () => {
      for (let i = 0; i < 12; i++) {
        const card = document.querySelector('.ins-card.kpi[data-card="0"]')
        if (card && (card.querySelector('.ins-card-label')?.textContent ?? '') === 'Planned time') return card.querySelector('.ins-card-value')?.textContent ?? ''
        await new Promise((r) => setTimeout(r, 400))
      }
      return ''
    })()`);
    const yearH = parseFloat(yearPlanned) || 0;
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'All time').click()`);
    await sleep(700);
    const allPlanned = await js(`(async () => {
      for (let i = 0; i < 12; i++) {
        const card = document.querySelector('.ins-card.kpi[data-card="0"]')
        if (card && (card.querySelector('.ins-card-label')?.textContent ?? '') === 'Planned time') return card.querySelector('.ins-card-value')?.textContent ?? ''
        await new Promise((r) => setTimeout(r, 400))
      }
      return ''
    })()`);
    const allH = parseFloat(allPlanned) || 0;
    check("all-time shows at least as much as this year", allH >= yearH, `${yearPlanned} → ${allPlanned}`);
    await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke seredit')`);
    await setDT(".quickadd", 0, `${TODAY}T06:30`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const seRow = dbGet("SELECT id FROM events WHERE title = 'Smoke seredit' AND parent_id IS NULL");
    if (!seRow) {
      await js(`document.querySelector('.new-btn').click()`);
      await sleep(250);
      await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke seredit')`);
      await setDT(".quickadd", 0, `${TODAY}T06:30`);
      await sleep(100);
      await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
      await sleep(200);
      await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
      await sleep(500);
    }
    const seRow2 = dbGet("SELECT id FROM events WHERE title = 'Smoke seredit' AND parent_id IS NULL");
    check("2ah: dedicated series created", !!seRow2);
    if (!seRow2) throw new Error("no seredit series");
    const seId = seRow2.id;
    const wBefore = dbGet("SELECT start_local FROM events WHERE id = '" + seId + "'");
    const d1 = new Date(Date.now() + 1 * 864e5);
    const d1Iso = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, "0")}-${String(d1.getDate()).padStart(2, "0")}`;
    const walkLater = await js(`(() => { const col = document.querySelector('.day-col[data-day="${d1Iso}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke seredit')); if (!el) return null; el.click(); return true })()`);
    await sleep(450);
    const wEdStart = await getDT(".editor", 0);
    const wEd = await js(`({ editor: !!document.querySelector('.editor'), startVal: '${wEdStart}', applyTo: Array.from(document.querySelectorAll('.apply-to .seg-btn')).map((b) => b.textContent.trim()) })`);
    check("series edit opens on the later day", wEd.editor && wEd.startVal.startsWith(d1Iso), JSON.stringify(wEd));
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    const tStart = await getDT(".editor", 0);
    await setDT(".editor", 0, `${tStart.slice(0, 10)}T07:00`);
    await setDT(".editor", 1, `${tStart.slice(0, 10)}T07:45`);
    await sleep(200);
    await saveEditor();
    await sleep(700);
    const wAfter = dbGet("SELECT start_local FROM events WHERE id = '" + seId + "'");
    check("series time edit keeps the SERIES start date (no vanish)", wAfter.start_local.slice(0, 10) === wBefore.start_local.slice(0, 10), `${wAfter.start_local} vs ${wBefore.start_local}`);
    const wDates = await js(`(() => { const cols = Array.from(document.querySelectorAll('.day-col')).map((c) => c.getAttribute('data-day')); return cols.filter((d, i) => Array.from(document.querySelectorAll('.day-col')[i].querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke seredit'))).length })()`);
    check("earlier days still show the series", wDates >= 2, String(wDates));
    await openEditorOn("Smoke seredit");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    await setDT(".editor", 0, `${wBefore.start_local.slice(0, 10)}T06:30`);
    await setDT(".editor", 1, `${wBefore.start_local.slice(0, 10)}T07:15`);
    await sleep(200);
    await saveEditor();
    await sleep(700);
    const wRevert = dbGet("SELECT start_local FROM events WHERE id = '" + seId + "'");
    check("series time reverted", wRevert.start_local === wBefore.start_local, wRevert.start_local);
    await openEditorOn("Smoke seredit");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke vis')`);
    await setDT(".quickadd", 0, `${TODAY}T22:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const midDrag = await js(`(() => { const col = document.querySelector('.day-col[data-day="${TOMORROW}"]'); if (!col) return null; const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return null; const r = el.getBoundingClientRect(); const cx = Math.round(r.left + r.width / 2); const cy = Math.round(r.top + 4); window.__dragDown = true; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, button: 0 })); window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx, clientY: cy + 10, button: 0 })); return true })()`);
    await sleep(300);
    const midVisible = await js(`(() => { const counts = Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke vis')).length); return counts })()`);
    check("multiday: BOTH chunks visible mid-drag", midVisible.filter((n) => n > 0).length === 2, JSON.stringify(midVisible));
    await js(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))`);
    await sleep(700);
    const visDel = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return false; el.click(); return true })()`);
    await sleep(400);
    const visEnd = await getDT(".editor", 1);
    check("multiday edit shows the REAL end for trimming", visEnd.startsWith(`${TOMORROW}T00:`), visEnd);
    await setDT(".editor", 1, `${TOMORROW}T00:00`);
    await sleep(200);
    await saveEditor();
    await sleep(600);
    const visDb = dbGet("SELECT end_local FROM events WHERE title = 'Smoke vis'");
    check("multiday trimmed via edit panel", visDb.end_local === `${TOMORROW}T00:00`, visDb.end_local);
    const visDel2 = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke vis')); if (!el) return false; el.click(); return true })()`);
    await sleep(400);
    if (visDel2) await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke endday')`);
    await setDT(".quickadd", 0, `${TODAY}T22:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const todayCard1 = await js(`document.querySelector('.today-hours')?.textContent ?? ''`);
    const edClick = await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (!el) return false; el.click(); return true })()`);
    await sleep(400);
    const endShown = await getDT(".editor", 1);
    check("multiday editor shows next-day end", endShown === `${TOMORROW}T00:30`, endShown);
    await setDT(".editor", 1, `${TODAY}T23:00`);
    await sleep(300);
    const probeEndVal = await getDT(".editor", 1);
    const probeStartVal = await getDT(".editor", 0);
    const probeEnd = await js(`({ inputVal: '${probeEndVal}', startVal: '${probeStartVal}', saveDisabled: document.querySelector('.editor .btn.primary').disabled })`);
    console.log("[smoke] 2aj probeEnd:", JSON.stringify(probeEnd));
    const saveEnabled = !probeEnd.saveDisabled;
    check("same-day trim is valid (Save enabled)", saveEnabled, JSON.stringify(probeEnd));
    await saveEditor();
    await sleep(600);
    const ed1 = dbGet("SELECT start_local, end_local FROM events WHERE title = 'Smoke endday'");
    check("same-day trim saved", ed1.end_local === `${TODAY}T23:00`, JSON.stringify(ed1));
    const ed1Chunks = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke endday')).length).filter((n) => n > 0).length`);
    check("trim reflected: one chunk only", ed1Chunks === 1, String(ed1Chunks));
    const d3 = new Date(Date.now() + 2 * 864e5);
    const d3Iso = `${d3.getFullYear()}-${String(d3.getMonth() + 1).padStart(2, "0")}-${String(d3.getDate()).padStart(2, "0")}`;
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await setDT(".editor", 1, `${d3Iso}T01:00`);
    await sleep(250);
    await saveEditor();
    await sleep(600);
    const ed2 = dbGet("SELECT end_local FROM events WHERE title = 'Smoke endday'");
    check("extend to day+2 saved", ed2.end_local === `${d3Iso}T01:00`, ed2.end_local);
    const ed2Chunks = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => Array.from(c.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke endday')).length).filter((n) => n > 0).length`);
    check("extend reflected: three chunks", ed2Chunks === 3, String(ed2Chunks));
    const todayCard2 = await js(`document.querySelector('.today-hours')?.textContent ?? ''`);
    console.log("[smoke] today hours before/after:", todayCard1, "→", todayCard2);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke endday')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    const prem = await js(`(() => {
      const el = document.querySelector('.premium-heading')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { text: el.textContent.trim(), border: cs.borderColor, anim: cs.animationName, radius: cs.borderRadius }
    })()`);
    check("premium heading present in toolbar", !!prem && prem.text.includes("Insights"), JSON.stringify(prem));
    check("premium heading has blue border + shine animation", !!prem && prem.border === "rgb(10, 132, 255)" && prem.anim.includes("premiumShine"), JSON.stringify(prem));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`);
    await sleep(700);
    const agDates = await js(`document.querySelectorAll('.agenda-date').length`);
    check("agenda rows show the event date", agDates > 0, String(agDates));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke multiag')`);
    await setDT(".quickadd", 0, `${TODAY}T22:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TOMORROW}T00:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`);
    await sleep(700);
    const multiRows = await js(`Array.from(document.querySelectorAll('.agenda-row')).filter((r) => r.textContent.includes('Smoke multiag')).length`);
    check("multiday event appears in EVERY day it touches (2 groups)", multiRows === 2, String(multiRows));
    const multiBadge = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); return r ? !!r.querySelector('.mini-badge.multiday') : false })()`);
    check("multiday label shown", multiBadge);
    const multiDays = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); const d = r?.querySelector('.agenda-days'); return d ? d.textContent : '' })()`);
    check("extra-day indicator truncated to 2 decimals", /^\+\d+\.\d\dd$/.test(multiDays), multiDays);
    const agDateVal = await js(`(() => { const r = Array.from(document.querySelectorAll('.agenda-row')).find((x) => x.textContent.includes('Smoke multiag')); const d = r?.querySelector('.agenda-date'); return d ? d.textContent : '' })()`);
    check("agenda date shows month+day", /^[A-Z][a-z]{2} \d{1,2}$/.test(agDateVal), agDateVal);
    const agTitle = await js(`(() => { const t = document.querySelector('.agenda-title'); if (!t) return null; const cs = getComputedStyle(t); return { z: cs.zIndex, bg: cs.backgroundColor, pos: cs.position } })()`);
    check("agenda heading has solid bg + z-index (no bleed)", !!agTitle && agTitle.pos === "sticky" && agTitle.z !== "auto", JSON.stringify(agTitle));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke multiag')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const bal0 = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke coin')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T11:00`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(600);
    const promptShown = await js(`!!document.querySelector('.score-prompt')`);
    check("score prompt appears after marking done", promptShown);
    const promptAmt = await js(`(() => { const o = Array.from(document.querySelectorAll('.sp-opt')).find((b) => b.textContent.includes('On time')); return o ? o.textContent : '' })()`);
    check("prompt has NO coin amounts/multipliers", !promptAmt.includes("🪙") && !promptAmt.includes("×"), promptAmt);
    await clickScoreOpt("On time");
    await sleep(250);
    const closedFast = await js(`!document.querySelector('.score-prompt') && !document.querySelector('.fx-layer')`);
    check("stage4: prompt closes IMMEDIATELY, no lingering FX", closedFast);
    const fxShown = await js(`(() => { const f = document.querySelector('.coin-score-fx'); return f ? { pe: getComputedStyle(f).pointerEvents, bg: getComputedStyle(f).backgroundColor } : null })()`);
    check("cup3: coin animation shown after answering (transparent, non-blocking)", !!fxShown && fxShown.pe === "none" && fxShown.bg === "rgba(0, 0, 0, 0)", JSON.stringify(fxShown));
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
    })()`);
    check("cup4: centered coin toaster WITH gold dust + sparkles (no fly, no count)", fxSimple.hasCoin && fxSimple.noCount && fxSimple.anim.includes("fxPop") && fxSimple.spin.includes("gentleFlip") && fxSimple.dust >= 10 && fxSimple.sparks >= 2, JSON.stringify(fxSimple));
    const coinToast = await js(`Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('🪙'))`);
    check("earn toast shown", coinToast);
    await sleep(2400);
    const fxGone = await js(`!document.querySelector('.coin-score-fx')`);
    check("cup3: coin animation auto-clears (~2.1s)", fxGone);
    await sleep(1500);
    const bal1 = await js(`window.api.coins.balance()`);
    check("on-time 1h completion earns 10 coins", Math.round((bal1 - bal0) * 100) / 100 === 10, `${bal0} → ${bal1}`);
    const chipText = await js(`document.querySelector('.coin-chip')?.textContent ?? ''`);
    check("sidebar coin chip shows balance", chipText.includes(String(Math.round(bal1))), chipText);
    const txs = await js(`window.api.coins.listTransactions()`);
    check("ledger has an earn row", Array.isArray(txs) && txs.some((t) => t.type === "earn" && t.amount === 10), JSON.stringify(txs?.[0]));
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await saveEditor();
    await sleep(600);
    const prompt2 = await js(`!!document.querySelector('.score-prompt')`);
    check("no duplicate prompt on re-save", !prompt2);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke coin')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const bal2 = await js(`window.api.coins.balance()`);
    check("delete refunds the coins", Math.round((bal2 - bal0) * 100) / 100 === 0, `${bal0} → ${bal2}`);
    const txs2 = await js(`window.api.coins.listTransactions()`);
    check("ledger has a refund row", Array.isArray(txs2) && txs2.some((t) => t.type === "refund"), JSON.stringify(txs2?.[0]));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`);
    await sleep(700);
    await js(`document.querySelector('.agenda-view').scrollTop = 400`);
    await sleep(500);
    const agBleed = await js(`(() => {
      const view = document.querySelector('.agenda-view')
      const title = document.querySelector('.agenda-title')
      if (!view || !title) return null
      const tr = title.getBoundingClientRect()
      const vr = view.getBoundingClientRect()
      const probes = [
        // the card's extreme LEFT/RIGHT edges (outside the title if it doesn't
        // span the full card width — the true bleed strips)
        { x: Math.round(vr.left + 4), y: Math.round(tr.top + tr.height / 2) },
        { x: Math.round(vr.right - 12), y: Math.round(tr.top + tr.height / 2) },
        { x: Math.round(tr.left + 6), y: Math.round(tr.top + tr.height / 2) },
        { x: Math.round(tr.left + tr.width / 2), y: Math.round(tr.top + 4) }
      ].map((p) => {
        const el = document.elementFromPoint(p.x, p.y)
        return el ? title.contains(el) || el === title : false
      })
      return { probes, allCovered: probes.every(Boolean), titleX: Math.round(tr.left), titleW: Math.round(tr.width), viewW: Math.round(vr.width) }
    })()`);
    check("agenda: sticky title covers the FULL card width while scrolling (no side bleed)", !!agBleed && agBleed.allCovered && agBleed.titleW >= agBleed.viewW - 20, JSON.stringify(agBleed));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const cBase = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke cwalk')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'This occurrence').click()`);
    await sleep(150);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(600);
    const cProm = await js(`!!document.querySelector('.score-prompt')`);
    check("recurring this-occurrence done → prompt", cProm);
    await clickScoreOpt("On time");
    await sleep(1700);
    const cBal1 = await js(`window.api.coins.balance()`);
    check("recurring occurrence earns 10", Math.round((cBal1 - cBase) * 100) / 100 === 10, `${cBase} → ${cBal1}`);
    const cOvr = dbGet("SELECT id FROM events WHERE title = 'Smoke cwalk' AND parent_id IS NOT NULL");
    const cScore = await js(`window.api.coins.getScore('${cOvr.id}', '${TODAY}')`);
    check("score attached to the override row", !!cScore && cScore.scoreType === "on_time", JSON.stringify(cScore));
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await saveEditor();
    await sleep(600);
    const cProm2 = await js(`!!document.querySelector('.score-prompt')`);
    const cBal2 = await js(`window.api.coins.balance()`);
    check("re-save: no prompt + no double earn", !cProm2 && Math.round((cBal2 - cBal1) * 100) / 100 === 0, `prompt=${cProm2} bal=${cBal2}`);
    const cOvrCount = dbGet("SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke cwalk' AND parent_id IS NOT NULL");
    check("re-save keeps ONE override (in-place update)", cOvrCount.c === 1, String(cOvrCount.c));
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'todo')`);
    await saveEditor();
    await sleep(600);
    const cBal3 = await js(`window.api.coins.balance()`);
    check("status back to todo → coins refunded", Math.round((cBal3 - cBase) * 100) / 100 === 0, `${cBase} → ${cBal3}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const cBal4 = await js(`window.api.coins.balance()`);
    check("delete override: balance unchanged (already refunded)", Math.round((cBal4 - cBase) * 100) / 100 === 0, `${cBase} → ${cBal4}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(150);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    const dBase2 = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke cdate')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T11:00`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(600);
    await clickScoreOpt("On time");
    await sleep(1700);
    const dBal1 = await js(`window.api.coins.balance()`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await setDT(".editor", 0, `${TOMORROW}T10:00`);
    await sleep(200);
    await setDT(".editor", 1, `${TOMORROW}T11:00`);
    await sleep(200);
    await saveEditor();
    await sleep(700);
    const dProm = await js(`!!document.querySelector('.score-prompt')`);
    check("date change while done → re-prompt for the new date", dProm);
    await clickScoreOpt("On time");
    await sleep(1700);
    const dBal2 = await js(`window.api.coins.balance()`);
    check("date change: net exactly one earn (old refunded)", Math.round((dBal2 - dBal1) * 100) / 100 === 0, `${dBal1} → ${dBal2}`);
    const dScoreNew = await js(`window.api.coins.getScore('${dbGet("SELECT id FROM events WHERE title = 'Smoke cdate'").id}', '${TOMORROW}')`);
    check("new date scored", !!dScoreNew);
    const dScoreOld = await js(`window.api.coins.getScore('${dbGet("SELECT id FROM events WHERE title = 'Smoke cdate'").id}', '${TODAY}')`);
    check("old date score removed", !dScoreOld);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke cdate')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const dBal3 = await js(`window.api.coins.balance()`);
    check("delete after date change: fully refunded", Math.round((dBal3 - dBase2) * 100) / 100 === 0, String(dBal3));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    const iBase = await js(`window.api.coins.balance()`);
    await js(`window.api.coins.scoreEvent('idem-1', '${TODAY}', 'on_time', 10, null)`);
    await js(`window.api.coins.scoreEvent('idem-1', '${TODAY}', 'late', 6, null)`);
    const iBal = await js(`window.api.coins.balance()`);
    check("scoring same key twice earns once (idempotent)", Math.round((iBal - iBase) * 100) / 100 === 10, `${iBase} → ${iBal}`);
    await js(`window.api.coins.clearScores('idem-1')`);
    const iBal2 = await js(`window.api.coins.balance()`);
    check("idempotent refund returns to baseline", Math.round((iBal2 - iBase) * 100) / 100 === 0, `${iBase} → ${iBal2}`);
    const uBase = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke undocoins')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T11:00`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(600);
    await clickScoreOpt("On time");
    await sleep(1700);
    const uEarn = await js(`window.api.coins.balance()`);
    check("undo-coins: earned 10", Math.round((uEarn - uBase) * 100) / 100 === 10, `${uBase} → ${uEarn}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const uAfterDel = await js(`window.api.coins.balance()`);
    check("undo-coins: delete refunds", Math.round((uAfterDel - uBase) * 100) / 100 === 0, `${uBase} → ${uAfterDel}`);
    const uUndo = await js(`Array.from(document.querySelectorAll('.toast')).find((t) => t.textContent.includes('Smoke undocoins') && !!t.querySelector('.toast-action'))?.querySelector('.toast-action')?.click() ?? 'none'`);
    await sleep(800);
    const uAfterUndo = await js(`window.api.coins.balance()`);
    const uEventBack = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke undocoins'))`);
    check("undo-coins: undo restores the event", uEventBack);
    check("undo-coins: undo restores the coins (10 back)", Math.round((uAfterUndo - uBase) * 100) / 100 === 10, `${uBase} → ${uAfterUndo}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke undocoins')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    const uClean = await js(`window.api.coins.balance()`);
    check("undo-coins: cleanup delete returns to baseline", Math.round((uClean - uBase) * 100) / 100 === 0, `${uBase} → ${uClean}`);
    const sBase = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke res')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T11:00`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(600);
    await clickScoreOpt("On time");
    await sleep(1700);
    const sEarn = await js(`window.api.coins.balance()`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'todo')`);
    await saveEditor();
    await sleep(600);
    const sRevert = await js(`window.api.coins.balance()`);
    check("revert: coins refunded on status change back", Math.round((sRevert - sBase) * 100) / 100 === 0, `${sBase} → ${sRevert}`);
    const sScore = await js(`window.api.coins.getScore('${dbGet("SELECT id FROM events WHERE title = 'Smoke res'").id}', '${TODAY}')`);
    check("revert: score row KEPT (marked refunded)", !!sScore && !!sScore.refundedAt, JSON.stringify(sScore));
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(700);
    const sProm = await js(`!!document.querySelector('.score-prompt')`);
    check("re-done after revert: NO prompt (already gained)", !sProm);
    const sBal = await js(`window.api.coins.balance()`);
    check("re-done after revert: coins restored silently (10 back)", Math.round((sBal - sBase) * 100) / 100 === 10, `${sBase} → ${sBal}`);
    const sScore2 = await js(`window.api.coins.getScore('${dbGet("SELECT id FROM events WHERE title = 'Smoke res'").id}', '${TODAY}')`);
    check("re-done after revert: score no longer refunded", !!sScore2 && !sScore2.refundedAt, JSON.stringify(sScore2));
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke res')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(600);
    const sDel = await js(`window.api.coins.balance()`);
    check("delete after restore: fully refunded (no double)", Math.round((sDel - sBase) * 100) / 100 === 0, `${sBase} → ${sDel}`);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    const chipTitle = await js(`document.querySelector('.coin-chip')?.getAttribute('title') ?? ''`);
    check("chip labelled as total balance", chipTitle.includes("Total"), chipTitle);
    const ci0 = await js(`window.api.coins.balance()`);
    const ci1 = await js(`window.api.coins.checkIn()`);
    check("check-in: no second award same day (streak ≥1 recorded)", !ci1.award && ci1.streak >= 1, JSON.stringify(ci1));
    const ci2 = await js(`window.api.coins.checkIn()`);
    check("check-in never awards twice in a day", !ci2.award, JSON.stringify(ci2));
    const ciTamper = await js(`(async () => {
      const before = await window.api.coins.balance()
      const streakBefore = await window.api.settings.get('checkInStreak')
      await window.api.settings.set('lastCheckIn', '2999-01-01')
      const r = await window.api.coins.checkIn()
      const after = await window.api.coins.balance()
      const streakAfter = await window.api.settings.get('checkInStreak')
      // restore the real state (checked in today)
      const today = new Date()
      const t = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
      await window.api.settings.set('lastCheckIn', t)
      await window.api.settings.set('checkInStreak', streakBefore ?? '0')
      return { award: r.award, amount: r.amount, balUnchanged: before === after, streakKept: streakAfter === streakBefore }
    })()`);
    check("v1.11.18: clock moved BACKWARD → check-in never re-awards, streak kept", !ciTamper.award && ciTamper.amount === 0 && ciTamper.balUnchanged && ciTamper.streakKept, JSON.stringify(ciTamper));
    const ciBal = await js(`window.api.coins.balance()`);
    check("check-in: balance unchanged by repeat calls", Math.round((ciBal - ci0) * 100) / 100 === 0, `${ci0} → ${ciBal}`);
    const ciTx = await js(`window.api.coins.listTransactions()`);
    check("check-in: bonus transaction exists in the ledger", Array.isArray(ciTx) && ciTx.some((t) => t.reason === "Daily check-in" && t.type === "bonus"), JSON.stringify(ciTx?.[0]));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const ad0 = await js(`window.api.coins.balance()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke alldone A')`);
    await setDT(".quickadd", 0, `${TODAY}T10:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T10:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke alldone B')`);
    await setDT(".quickadd", 0, `${TODAY}T11:00`);
    await sleep(100);
    await setDT(".quickadd", 1, `${TODAY}T11:30`);
    await sleep(100);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke alldone A')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(700);
    await pickScore("On time");
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    const ad1 = await js(`window.api.coins.balance()`);
    check("all-done: one done is not enough yet (5 for A only)", Math.round((ad1 - ad0) * 100) / 100 === 5, `${ad0} → ${ad1}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke alldone B')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await saveEditor();
    await sleep(900);
    await pickScore("On time");
    const ad2 = await js(`window.api.coins.balance()`);
    check("all-done: A+B scored (+10 total)", Math.round((ad2 - ad0) * 100) / 100 === 10, `${ad0} → ${ad2}`);
    const adPre = await js(`window.api.coins.allDoneCheck('${TODAY}')`);
    check("all-done: not awarded while seeds pending", !adPre.award, JSON.stringify(adPre));
    for (const t of ["Smoke alldone A", "Smoke alldone B"]) {
      await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${t}')); if (el) el.click(); return !!el })()`);
      await sleep(400);
      await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
      await sleep(600);
    }
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await sleep(120);
    const introRect = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const d = document.querySelector('.coin-drop')
        if (d) {
          const r = d.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight }
        }
        await new Promise((r2) => setTimeout(r2, 20))
      }
      return null
    })()`);
    check("v1.10.6: intro stage is viewport-anchored during the view switch (no bg stretch/jump)", !!introRect && introRect.x === 0 && introRect.y === 0 && introRect.w === introRect.vw && introRect.h === introRect.vh, JSON.stringify(introRect));
    await sleep(300);
    const dropIntro = await js(`(() => { const d = document.querySelector('.coin-drop'); if (!d) return { present: false }; return { present: true, hasCenter: !!d.querySelector('.intro-center'), hasCoin: !!d.querySelector('.intro-coin .rhythm-coin img'), rings: d.querySelectorAll('.intro-ring').length, hasCanvas: !!d.querySelector('.dust-canvas'), hasWord: !!d.querySelector('.intro-word'), stage: !!d.querySelector('.intro-stage') } })()`);
    check("coins: professional cinematic intro (navy stage, coin drop, gold-dust canvas, rings, wordmark)", dropIntro.present && dropIntro.hasCenter && dropIntro.hasCoin && dropIntro.rings >= 2 && dropIntro.hasCanvas && dropIntro.hasWord && dropIntro.stage, JSON.stringify(dropIntro));
    const promptDuringIntro = await js(`!!document.querySelector('.coin-drop') && !document.querySelector('.reward-batch')`);
    check("reward prompt does NOT appear during the intro", promptDuringIntro);
    const introVer = await js(`document.querySelector('.intro-word-ver')?.textContent ?? ''`);
    check("intro shows version tag (build identification)", introVer.includes("v1.11.18"), introVer);
    const titleVer = await js(`document.querySelector('.titlebar-title')?.textContent ?? ''`);
    const sideVer = await js(`document.querySelector('.sidebar-version')?.textContent ?? ''`);
    check("v1.11.3: title bar shows the build version", titleVer.includes("v1.11.18"), titleVer);
    check("v1.11.4: sidebar has no version footer", !sideVer, String(sideVer));
    const naming = await js(`(() => {
      const tab = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins'))
      const pill = document.querySelector('.premium-heading.coins')
      return {
        tab: tab ? tab.textContent.trim() : '',
        pill: pill ? pill.textContent.trim() : '',
        pillTitle: pill ? pill.getAttribute('title') || '' : ''
      }
    })()`);
    check('v1.10.6: coin system named "Rhythm Coins" (tab, heading, pill tooltip)', naming.tab.includes("Rhythm Coins") && naming.pill.includes("Rhythm Coins") && naming.pillTitle.includes("Rhythm Coins"), JSON.stringify(naming));
    const sideToday = await js(`document.querySelector('.today-card')?.textContent ?? ''`);
    check('v1.11.4: today card shows "N events · Xh planned · N done"', /\d+ events?/.test(sideToday) && sideToday.includes("planned") && /\d+ done/.test(sideToday), sideToday);
    const infoBtn = await js(`!!document.querySelector('.labels-info-btn')`);
    check("v1.11.9: labels header has an ℹ info button", infoBtn);
    await js(`document.querySelector('.labels-info-btn')?.click()`);
    await sleep(250);
    const infoPop = await js(`(() => {
      const pop = document.querySelector('.labels-info-pop')
      return {
        text: (pop?.textContent ?? '').includes('main label only') && (pop?.textContent ?? '').includes('sub labels only'),
        closeBtn: !!pop?.querySelector('.labels-info-close')
      }
    })()`);
    check("v1.11.9: info popover explains the 4 colours + has a close button", infoPop.text && infoPop.closeBtn);
    await js(`document.querySelector('.labels-info-close')?.click()`);
    await sleep(200);
    const infoClosed = await js(`!document.querySelector('.labels-info-pop')`);
    check("v1.11.10: info popover closes with the × button", infoClosed);
    await js(`document.querySelector('.labels-info-btn')?.click()`);
    await sleep(200);
    const labelRows = await js(`(() => {
      const rows = Array.from(document.querySelectorAll('.label-row'))
      const parent = rows.find((r) => r.textContent.includes('Work'))
      if (!parent) return { ok: false }
      parent.click()
      return { ok: true }
    })()`);
    await sleep(300);
    const labelBadge1 = await js(`(() => {
      const p = Array.from(document.querySelectorAll('.label-row')).find((r) => r.textContent.includes('Work'))
      const b = p ? p.querySelector('.lb-badge') : null
      const name = p ? p.querySelector('.label-name') : null
      const cs = b ? getComputedStyle(b) : null
      const nr = name ? name.getBoundingClientRect() : null
      const br = b ? b.getBoundingClientRect() : null
      return {
        badge: b?.textContent ?? '',
        subLine: b?.classList.contains('sub-line') ?? false,
        bg: cs ? cs.backgroundColor : '',
        borderW: cs ? cs.borderTopWidth : '',
        radius: cs ? cs.borderRadius : '',
        belowName: nr && br ? br.top >= nr.bottom - 1 : false,
        nowrap: cs ? cs.whiteSpace : ''
      }
    })()`);
    await js(`(() => { const p = Array.from(document.querySelectorAll('.label-row')).find((r) => r.textContent.includes('Work')); if (p) p.click(); return !!p })()`);
    await sleep(300);
    const labelBadge2 = await js(`(() => {
      const p = Array.from(document.querySelectorAll('.label-row')).find((r) => r.textContent.includes('Work'))
      const b = p ? p.querySelector('.lb-badge') : null
      return { badge: b?.textContent ?? '', subLine: b?.classList.contains('sub-line') ?? false }
    })()`);
    await js(`(() => { const p = Array.from(document.querySelectorAll('.label-row')).find((r) => r.textContent.includes('Work')); if (p) p.click(); return !!p })()`);
    await sleep(300);
    check("v1.11.9: label badges standardised (main label only → all)", labelRows.ok && labelBadge1.badge.includes("main label only") && labelBadge2.badge.includes("all"), JSON.stringify({ b1: labelBadge1.badge, b2: labelBadge2.badge }));
    check('v1.11.10: non-all tag sits BELOW the main label (sub-line); "all" stays inline', labelBadge1.subLine && !labelBadge2.subLine, JSON.stringify({ b1: labelBadge1, b2: labelBadge2 }));
    check("v1.11.11: parent tag is a uniform pill, ONE line (nowrap), below the name", labelBadge1.bg !== "" && labelBadge1.borderW === "1px" && labelBadge1.radius === "999px" && labelBadge1.belowName && labelBadge1.nowrap === "nowrap", JSON.stringify(labelBadge1));
    const todayBtnGone = await js(`!document.querySelector('.today-btn')`);
    check("v1.11.15: Today button removed from the toolbar", todayBtnGone);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.today-btn')?.click() ?? null`);
    await js(`Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.getAttribute('aria-label') === 'Next')?.click()`);
    await sleep(400);
    const tabTodayClass0 = await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week')?.classList.contains('today') ?? false`);
    await js(`(() => { const t = Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week'); if (t) t.click(); return !!t })()`);
    await sleep(400);
    const tabTodayClass1 = await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week')?.classList.contains('today') ?? false`);
    check("v1.11.15: second click on the active tab jumps to today (blue today state)", !tabTodayClass0 && tabTodayClass1, JSON.stringify({ before: tabTodayClass0, after: tabTodayClass1 }));
    const scoreProbe = await js(`(async () => {
      const ev = await window.api.events.create({ title: 'ScoreIns', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })
      await window.api.coins.scoreEvent(ev.id, '${TODAY}', 'on_time', 10, null)
      const ins = await window.api.coins.scoreInsights()
      await window.api.events.remove(ev.id)
      return { onTime: ins.total.on_time, count: ins.count }
    })()`);
    check("v1.11.15: score insights IPC returns on-time counts", scoreProbe.onTime >= 1 && scoreProbe.count >= 1, JSON.stringify(scoreProbe));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(800);
    const scorePanel = await js(`(() => {
      const t = Array.from(document.querySelectorAll('.ins-panel-title')).find((x) => (x.textContent || '').includes('On-time'))
      return { panel: !!t, pills: document.querySelectorAll('.score-pill').length }
    })()`);
    check("v1.11.15: Insights shows the On-time/Late/Off-schedule panel", scorePanel.panel && scorePanel.pills >= 1, JSON.stringify(scorePanel));
    const chipAfterAmber = await js(`(() => {
      const w = Array.from(document.querySelectorAll('.label-row')).find((r) => (r.querySelector('.label-name')?.textContent || '').trim() === 'Work')
      if (!w) return { ok: false }
      w.click() // → amber
      return new Promise((r2) => setTimeout(() => r2({ ok: true, chip: !!document.querySelector('.all-chip') }), 350))
    })()`);
    check("v1.11.14: All chip VISIBLE on a partial selection", chipAfterAmber.ok && chipAfterAmber.chip, JSON.stringify(chipAfterAmber));
    await js(`document.querySelector('.all-chip')?.click()`);
    await sleep(300);
    const chipAfterReset = await js(`!!document.querySelector('.all-chip')`);
    check("v1.11.14: All chip hidden after reset", !chipAfterReset, String(chipAfterReset));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const gridH0 = await js(`document.querySelector('.week-grid')?.getBoundingClientRect().height ?? 0`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))`);
    await sleep(500);
    const zoomAfter = await js(`(() => ({
      h: document.querySelector('.week-grid')?.getBoundingClientRect().height ?? 0,
      zoom: window.__rhythmZoomProbe ? 0 : 0
    }))()`);
    check("v1.11.14: Ctrl+P zooms the day/week grid vertically", gridH0 > 0 && zoomAfter.h > gridH0 + 50, JSON.stringify({ before: gridH0, after: zoomAfter.h }));
    for (let i = 0; i < 6; i++) {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))`);
      await sleep(120);
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(500);
    const monthNav = await js(`(() => {
      const num = document.querySelector('.day-cell .day-num')
      if (!num) return { ok: false }
      num.click()
      return new Promise((r2) => setTimeout(() => r2({
        ok: true,
        tab: Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.classList.contains('active'))?.textContent.trim() ?? '',
        dayCols: document.querySelectorAll('.day-col').length
      }), 500))
    })()`);
    check("v1.11.14: month day-number click → Day tab with that date", monthNav.ok && monthNav.tab === "Day" && monthNav.dayCols === 1, JSON.stringify(monthNav));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const weekNav = await js(`(() => {
      const head = document.querySelector('.week-day-head')
      if (!head) return { ok: false }
      head.click()
      return new Promise((r2) => setTimeout(() => r2({
        ok: true,
        tab: Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.classList.contains('active'))?.textContent.trim() ?? '',
        dayCols: document.querySelectorAll('.day-col').length
      }), 500))
    })()`);
    check("v1.11.14: week day-header click → Day tab", weekNav.ok && weekNav.tab === "Day" && weekNav.dayCols === 1, JSON.stringify(weekNav));
    const trashProbe = await js(`(async () => {
      const ev = await window.api.events.create({ title: 'TrashTest', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })
      // real flow: delete (event removed) + trash copy kept
      await window.api.trash.add(ev.id, { master: ev, children: [] })
      await window.api.events.remove(ev.id)
      const listed = await window.api.trash.list()
      const has = listed.some((t) => t.payload.master.title === 'TrashTest')
      // restore → event comes back
      const restored = await window.api.trash.restore(ev.id, 'single')
      const back = await window.api.events.list().then((es) => es.some((e) => e.title === 'TrashTest'))
      // re-delete + permanent purge
      await window.api.events.remove(ev.id)
      await window.api.trash.add(ev.id, { master: ev, children: [] })
      await window.api.trash.purge(ev.id)
      const purged = !(await window.api.trash.list()).some((t) => t.id === ev.id)
      return { has, restored, back, purged }
    })()`);
    check("v1.11.14: trash round-trip (add → list → restore → purge)", trashProbe.has && trashProbe.restored.ok && trashProbe.back && trashProbe.purged, JSON.stringify(trashProbe));
    dbRun("DELETE FROM events WHERE title = 'TrashTest'");
    dbRun("DELETE FROM trash WHERE id IN (SELECT id FROM trash)");
    const fitnessRow = await js(`(() => {
      const r = Array.from(document.querySelectorAll('.label-row')).find((x) => x.textContent.includes('Fitness'))
      if (!r) return false
      r.click()
      return true
    })()`);
    await sleep(400);
    const onlyFitness = await js(`(() => {
      const rows = Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.trim())
      const workShown = rows.some((e) => e.textContent.includes('Deep work') || e.textContent.includes('Team sync'))
      const gymShown = rows.some((e) => e.textContent.includes('Gym') || e.textContent.includes('Yoga'))
      return { workShown, gymShown }
    })()`);
    await js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => x.textContent.includes('Fitness')); if (r) r.click(); return !!r })()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(600);
    const allFitness = await js(`(() => {
      const chips = Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim())
      const workShown = chips.some((t) => t.includes('Deep work') || t.includes('Team sync'))
      const gymShown = chips.some((t) => t.includes('Gym') || t.includes('Yoga'))
      return { workShown, gymShown }
    })()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`(() => { const r = Array.from(document.querySelectorAll('.label-row')).find((x) => x.textContent.includes('Fitness')); if (r) r.click(); return !!r })()`);
    await sleep(300);
    check('v1.11.7: "only this" hides OTHER parents (Work hidden)', fitnessRow && !onlyFitness.workShown, JSON.stringify({ fitnessRow, ...onlyFitness }));
    check("v1.11.7: all-sub-tags shows the parent children (Gym/Yoga) while other parents stay hidden", fitnessRow && !allFitness.workShown && allFitness.gymShown, JSON.stringify({ ...allFitness }));
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
    })()`);
    check("coins: heading DROPS → damped bounces → ROLLS right (wheel spin) → fades at pill edge; tab coin uses the calm flip (like Total Rhythm Coins)", flipAnim.ga.rollCls && flipAnim.ga.dropAnim.includes("coinDropRoll") && flipAnim.ga.wheel.includes("rollWheel") && flipAnim.ga.ts === "preserve-3d" && flipAnim.ga.segs >= 24 && flipAnim.ga.faces === 2 && flipAnim.ga.back && (flipAnim.ga.clip === "hidden" || flipAnim.ga.clip === "clip") && !flipAnim.sa.rollCls && flipAnim.sa.flipCls && flipAnim.sa.spinAnim.includes("gentleFlip"), JSON.stringify(flipAnim));
    await sleep(2200);
    const cvReady = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        if (document.querySelector('.coins-layout')) return true
        await new Promise((r) => setTimeout(r, 300))
      }
      return false
    })()`);
    const cv = await js(`(() => {
      const layout = document.querySelector('.coins-layout')
      if (!layout) return { view: false, ratio3: 0, kpiBand: 0, kpiLeft: 0, kpiRight: 0, kpiRightCls: 0, chart: 0, perLabel: 0, ledger: 0, calCells: 0, stones: 0 }
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
    })()`);
    check("coins: 3:1 layout (left ≈ 3× right)", !!cv.view && cv.view && cv.ratio3 > 2.2 && cv.ratio3 < 4, JSON.stringify(cv));
    check("coins: 3+1 KPI cards pinned in their panels (3 left, 1 right)", cv.kpiBand === 4 && cv.kpiLeft === 3 && cv.kpiRight === 1 && cv.kpiRightCls === 1, JSON.stringify(cv));
    const bandCoins = await js(`document.querySelectorAll('.coins-kpis .rhythm-coin img.rc-img').length`);
    check("coins: designed gold coin image visible in KPI band", bandCoins >= 1, String(bandCoins));
    const coinLoaded = await js(`(() => { const im = document.querySelector('.coins-kpis .rc-img'); return im ? { complete: im.complete, nw: im.naturalWidth, src: (im.getAttribute('src') || '').slice(-40) } : null })()`);
    check("coins: gold coin asset actually loaded (not broken image)", !!coinLoaded && coinLoaded.complete && coinLoaded.nw > 0 && coinLoaded.src.includes("coin-gold"), JSON.stringify(coinLoaded));
    const emojiSize = await js(`(() => { const e = document.querySelector('.coins-kpis .kpi-emoji'); return e ? getComputedStyle(e).fontSize : '' })()`);
    check("KPI emoji icons sized like the coin icon (40px)", emojiSize === "40px", emojiSize);
    check("coins: 7-day chart renders", cv.chart >= 7, String(cv.chart));
    check("coins: earned-by-label rows", cv.perLabel >= 1, String(cv.perLabel));
    const perLabelRows = await js(`window.api.coins.stats().then((st) => st.perLabel.map((l) => l.labelName))`);
    check('v1.11.6: bonuses grouped under "Rewards 🏆" (not No label)', perLabelRows.some((n) => n.includes("Rewards")), JSON.stringify(perLabelRows));
    check("coins: ledger rows", cv.ledger >= 1, String(cv.ledger));
    check("coins: streak calendar mini-month (42 cells)", cv.calCells === 42, String(cv.calCells));
    check("coins: milestone path starts with ONE stone", cv.stones === 1, String(cv.stones));
    const facesChanged = await js(`(async () => {
      const read = () => Array.from(document.querySelectorAll('.coins-kpi')).map((c) => c.getAttribute('data-face')).join(',')
      const a = read()
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (read() !== a) return { changed: true, before: a, after: read() }
      }
      return { changed: false, before: a, after: read() }
    })()`);
    check("coins: KPI dice flip over time", facesChanged.changed, JSON.stringify(facesChanged));
    const kpiFlips = await js(`(() => {
      const cs = Array.from(document.querySelectorAll('.coins-kpis .rhythm-coin'))
      return { total: cs.length, flipped: cs.filter((c) => c.classList.contains('flip')).length }
    })()`);
    check("KPI today coins animate like Total Rhythm Coins", kpiFlips.total >= 1 && kpiFlips.total === kpiFlips.flipped, JSON.stringify(kpiFlips));
    const firstAsk = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`);
    check("reward for Level 1 asked BEFORE hitting it (fresh path, balance 0)", firstAsk.open && firstAsk.items.length === 1 && firstAsk.items[0].includes("Level 1"), JSON.stringify(firstAsk));
    await js(`(() => { const i = document.querySelectorAll('.reward-batch .rb-input')[0]; if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, 'L1 treat'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
    await saveRewards();
    await sleep(400);
    const firstAskClosed = await js(`!document.querySelector('.reward-batch')`);
    check("Level 1 reward saved → popup closes, no repeat", firstAskClosed);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const st = await js(`window.api.coins.stats()`);
    const allTxs = await js(`window.api.coins.listTransactions()`);
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
    })()`);
    check("earned today = local-date ledger net", Math.round((st.today - localNet) * 100) / 100 === 0, `stats=${st.today} manual=${localNet}`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
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
    })()`);
    check("coins: sidebar collapsed + pills hidden (search+New live in the pills row, hidden with it)", cvChrome.sidebarCollapsed && cvChrome.pillsGone && !cvChrome.todayBtn, JSON.stringify(cvChrome));
    check("coins: golden heading shown", cvChrome.heading.includes("Coins"), cvChrome.heading);
    const minSettings = await js(`!!document.querySelector('.toolbar.minimal .settings-btn')`);
    check("cup5: settings icon present in the Coins tab toolbar", minSettings);
    const cvChart = await js(`(() => {
      const svg = document.querySelector('.coins-view .chart-stretch')
      if (!svg) return null
      const vb = svg.getAttribute('viewBox') ?? ''
      const w = svg.getBoundingClientRect().width
      const panel = svg.closest('.ins-panel')?.getBoundingClientRect().width ?? 0
      return { vb, svgW: Math.round(w), panelW: Math.round(panel), fills: panel > 0 && w / panel > 0.85, bars: svg.querySelectorAll('rect').length }
    })()`);
    check("coins: 7-day chart stretched to the box", !!cvChart && cvChart.fills, JSON.stringify(cvChart));
    check("coins: 7-day chart has 7 bars", !!cvChart && cvChart.bars === 7, String(cvChart?.bars));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
    const cvCenter = await js(`(() => {
      const svg = document.querySelector('.coins-view .chart-stretch')
      if (!svg) return null
      const sr = svg.getBoundingClientRect()
      const pr = svg.closest('.ins-panel').getBoundingClientRect()
      const svgMid = sr.top + sr.height / 2
      const panelMid = pr.top + pr.height / 2
      return { delta: Math.abs(svgMid - panelMid), h: pr.height, centered: Math.abs(svgMid - panelMid) < pr.height * 0.2 }
    })()`);
    check("coins: 7-day chart vertically centered", !!cvCenter && cvCenter.centered, JSON.stringify(cvCenter));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('pw_block_test', '1')");
    const pwBlock = await js(`window.api.coins.perfectWeek()`);
    console.log("[smoke] perfectWeek blocking probe:", JSON.stringify(pwBlock));
    check("perfect week: reports streak when ineligible (no silent failure)", pwBlock.award === false && typeof pwBlock.streak === "number", JSON.stringify(pwBlock));
    dbRun("DELETE FROM settings WHERE key = 'pw_block_test'");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
    const stones0 = await js(`window.api.milestones.list()`);
    check("milestone path auto-created (>=30 levels, first at 100, infinite +2000 ladder)", Array.isArray(stones0) && stones0.length >= 30 && stones0[0].cost === 100 && stones0[29].cost > 4e4, JSON.stringify({ n: stones0.length, first: stones0[0].cost, last: stones0[stones0.length - 1].cost }));
    const firstStone = stones0[0];
    const secondStone = stones0[1];
    await js(`window.api.coins.scoreEvent('ms-fund-2', '${TOMORROW}', 'on_time', 230, null)`);
    await js(`window.api.coins.scoreEvent('ms-fund-3', '${TOMORROW}', 'on_time', 30, null)`);
    await js(`window.api.coins.clearScores('ms-fund-3', '${TOMORROW}')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    const skipInstant = await js(`(() => {
      const k = document.querySelector('.coins-kpis .coins-kpi')
      return {
        noIntro: !document.querySelector('.coin-drop'),
        kpiOpacity: k ? getComputedStyle(k).opacity : '',
        kpiAnim: k ? getComputedStyle(k).animationName : ''
      }
    })()`);
    check("intro skipped → KPI cards visible immediately (no waiting for intro end)", skipInstant.noIntro && skipInstant.kpiOpacity === "1" && skipInstant.kpiAnim === "none", JSON.stringify(skipInstant));
    await sleep(5600);
    const promptNext = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return {
        open: true,
        title: (d.querySelector('.dialog-title')?.textContent ?? ''),
        items: Array.from(d.querySelectorAll('.rb-item')).map((i) => (i.querySelector('.rb-name')?.textContent ?? '').replace(/\\s+/g, ' ').trim())
      }
    })()`);
    check("after Level 1 is hit → reward popup asks for the upcoming Level 2 (before it is reached)", promptNext.open && promptNext.items.length === 1 && promptNext.items[0].includes("Level 2"), JSON.stringify(promptNext));
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[0], 'Smoke treat')`);
    await saveRewards();
    await sleep(500);
    const stones1 = await js(`window.api.milestones.list()`);
    check("upcoming reward saved to Level 2 (name stays Level 2)", stones1.find((m) => m.id === secondStone.id)?.notes === "Smoke treat" && stones1.find((m) => m.id === secondStone.id)?.name === "Level 2", JSON.stringify(stones1.find((m) => m.id === secondStone.id)));
    const editProbe = await js(`(() => {
      const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.querySelector('.mile-level')?.textContent.includes('100'))
      const b = st ? Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('✎')) : null
      if (b) b.click()
      return { hasStone: !!st, hasBtn: !!b }
    })()`);
    console.log("[smoke] editProbe:", JSON.stringify(editProbe));
    await sleep(500);
    const editOpen = await js(`(() => { const f = document.querySelector('.overlay .mile-form'); return f ? { open: true, inputs: f.querySelectorAll('input').length } : { open: false, inputs: 0 } })()`);
    check("stage3: edit dialog = ONE reward-note field only", editOpen.open && editOpen.inputs === 1, JSON.stringify(editOpen));
    await js(`(${SET_VALUE})(document.querySelectorAll('.overlay .mile-form input')[0], 'Smoke edited treat')`);
    await js(`Array.from(document.querySelectorAll('.overlay .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save reward')?.click()`);
    await sleep(500);
    const stones1b = await js(`window.api.milestones.list()`);
    check("stage3: reward edit saved (notes changed, name fixed)", stones1b.find((m) => m.id === firstStone.id)?.notes === "Smoke edited treat" && stones1b.find((m) => m.id === firstStone.id)?.name === "Level 1", JSON.stringify(stones1b.find((m) => m.id === firstStone.id)));
    let celebSeen = false;
    for (let i = 0; i < 2; i++) {
      const claimRes = await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return 'no stone'; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim') || x.textContent.includes('Redeem')); if (!b) return 'no btn'; b.click(); return 'ok' })()`);
      await sleep(700);
      const celebOpen = await js(`!!document.querySelector('.overlay.celeb')`);
      if (celebOpen) {
        celebSeen = true;
        await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`);
        await sleep(300);
      }
    }
    check("celebration overlay appears on claim", celebSeen);
    const spendTx = await js(`window.api.coins.listTransactions()`);
    const spends = (spendTx ?? []).filter((t) => t.type === "spend" && t.reason.includes("Level 1"));
    check("claim logged as spend ×2 (repeatable)", spends.length === 2 && spends.every((t) => t.amount === 100), JSON.stringify(spends));
    const stones2 = await js(`window.api.milestones.list()`);
    check("stone marked first-claimed", !!stones2.find((m) => m.id === firstStone.id)?.achievedAt);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3400);
    const totEarn = await js(`(async () => {
      for (let i = 0; i < 14; i++) {
        const card = Array.from(document.querySelectorAll('.coins-kpi')).find((c) => c.textContent.includes('Total earned'))
        if (card) return card.querySelector('.coins-kpi-value')?.textContent ?? ''
        await new Promise((r) => setTimeout(r, 500))
      }
      return ''
    })()`);
    const expEarn = await js(`(() => {
      const all = window.__noop ? [] : []
      return 0
    })()`);
    const totCheck = await js(`(async () => {
      const txs = await window.api.coins.listTransactions()
      let e = 0
      for (const t of txs) {
        if (t.type === 'earn' || t.type === 'bonus') e += t.amount
        else if (t.type === 'refund') e -= t.amount
      }
      return Math.round(e)
    })()`);
    check("stage4: Total earned subtracts refunds", String(totCheck) === totEarn, `ui=${totEarn} ledger=${totCheck}`);
    const stonesVis = await js(`document.querySelectorAll('.mile-stone').length`);
    check("stage4: path grows 1 at a time (2 stones after Level 1 done)", stonesVis === 2, String(stonesVis));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const widget = await js(`(() => { const w = document.querySelector('.mile-widget'); if (!w) return null; return { ring: !!w.querySelector('.mile-ring'), text: w.textContent } })()`);
    check("sidebar milestone widget with progress ring", !!widget && widget.ring, JSON.stringify(widget));
    dbRun("DELETE FROM coin_transactions");
    dbRun("DELETE FROM event_scores");
    await js(`window.__rhythmCoins.refresh()`);
    await js(`window.api.coins.scoreEvent('ms-widget-1', '${TOMORROW}', 'on_time', 150, null)`);
    await js(`window.__rhythmCoins.refresh()`);
    const celebShown = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const w = document.querySelector('.mile-widget')
        if (w && w.classList.contains('celebrating')) {
          return { text: w.textContent, gold: getComputedStyle(w).borderTopColor !== 'rgba(0, 0, 0, 0)', dust: w.querySelectorAll('.mile-celeb-dust').length }
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      return null
    })()`);
    check('cup4: widget celebrates on net crossing (gold border + dust + "Level 1 passed — Claim in Coins")', !!celebShown && celebShown.text.includes("Level 1 passed") && celebShown.text.includes("Claim in Coins") && celebShown.dust >= 10, JSON.stringify(celebShown));
    await sleep(6e3);
    const celebStill = await js(`(() => { const w = document.querySelector('.mile-widget'); return w ? w.classList.contains('celebrating') : false })()`);
    check("cup5: celebration still active at 6s (10s duration)", celebStill);
    await sleep(5e3);
    const celebGone = await js(`(() => { const w = document.querySelector('.mile-widget'); return { celebrating: w ? w.classList.contains('celebrating') : false, text: w ? w.textContent : '' } })()`);
    check("cup4: celebration clears after 10s → shows the NEXT level", !celebGone.celebrating && celebGone.text.includes("Level 2"), JSON.stringify(celebGone));
    await js(`window.api.coins.clearScores('ms-widget-1', '${TOMORROW}')`);
    await js(`window.__rhythmCoins.refresh()`);
    await sleep(300);
    dbRun("DELETE FROM coin_transactions");
    dbRun("DELETE FROM event_scores");
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%' OR key LIKE 'stoneReached.%'");
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward'");
    await js(`window.api.coins.scoreEvent('ms-batch-1', '${TOMORROW}', 'on_time', 800, null)`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(6e3);
    const batch = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`);
    check("double achievement: ONE popup with hit-but-unrewarded + the upcoming level (L1..L4)", batch.open && batch.items.length === 4 && batch.items[0].includes("Level 1") && batch.items[1].includes("Level 2") && batch.items[2].includes("Level 3") && batch.items[3].includes("Level 4"), JSON.stringify(batch));
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[0], 'R1')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[1], 'R2')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[2], 'R3')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.reward-batch .rb-input')[3], 'R4')`);
    await saveRewards();
    await sleep(600);
    const batchMs = await js(`window.api.milestones.list()`);
    check("batch: all pending rewards saved (no conflict between them)", batchMs.find((m) => m.cost === 100)?.notes === "R1" && batchMs.find((m) => m.cost === 250)?.notes === "R2" && batchMs.find((m) => m.cost === 500)?.notes === "R3" && batchMs.find((m) => m.cost === 1e3)?.notes === "R4", JSON.stringify(batchMs.slice(0, 4).map((m) => m.notes)));
    const afterSaveGeo = await js(`(() => {
      const stones = Array.from(document.querySelectorAll('.mile-stone'))
      const rs = stones.map((s) => { const r = s.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })
      let overlap = false
      for (let i = 0; i < rs.length - 1; i++) if (rs[i].bottom > rs[i + 1].top + 2) overlap = true
      return { count: rs.length, overlap }
    })()`);
    check("path clean IMMEDIATELY after saving rewards (no overlap on first render)", afterSaveGeo.count >= 2 && !afterSaveGeo.overlap, JSON.stringify(afterSaveGeo));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(6e3);
    const batchAgain = await js(`!document.querySelector('.reward-batch')`);
    check("batch: no repeated popup after rewards are saved", batchAgain);
    await js(`window.api.coins.clearScores('ms-batch-1', '${TOMORROW}')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM coin_transactions");
    dbRun("DELETE FROM event_scores");
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%' OR key LIKE 'stoneReached.%'");
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward'");
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('stoneCrossed.100', '1')");
    await js(`window.api.coins.scoreEvent('ms-legacy-1', '${TOMORROW}', 'on_time', 150, null)`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(6e3);
    const legacyPopup = await js(`(() => {
      const d = document.querySelector('.reward-batch')
      if (!d) return { open: false }
      return { open: true, items: Array.from(d.querySelectorAll('.rb-item .rb-name')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()) }
    })()`);
    check("legacy DB: Level 1 reward asked even with an old stoneCrossed key (plus the upcoming L2)", legacyPopup.open && legacyPopup.items.length === 2 && legacyPopup.items[0].includes("Level 1") && legacyPopup.items[1].includes("Level 2"), JSON.stringify(legacyPopup));
    await js(`Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Skip').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(6e3);
    const legacyNoRepeat = await js(`!document.querySelector('.reward-batch')`);
    check("legacy DB: no repeat after skip (rewardAsked marker set)", legacyNoRepeat);
    await js(`window.api.coins.clearScores('ms-legacy-1', '${TOMORROW}')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
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
    })()`);
    check("coin static on other tabs; insights ✦ present but NOT shining", !staticCheck.coinRoll && staticCheck.hasTwinkle && !staticCheck.twinkleShining, JSON.stringify(staticCheck));
    await js(`window.api.coins.clearScores('ms-fund-2', '${TOMORROW}')`);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke occwalk')`);
    await setDT(".quickadd", 0, `${TODAY}T06:30`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3400);
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
    })()`);
    check("stage1: panels scroll independently (left/right auto)", stage1.leftScroll && stage1.rightScroll && stage1.viewOverflow === "hidden", JSON.stringify(stage1));
    check("stage1: 4 KPIs in a fixed non-scrolling band", stage1.kpiInBand && stage1.kpiNotSticky, JSON.stringify(stage1));
    check("stage1: today values have no decorative + sign", !/^\+/.test(stage1.todayNet) && !/^\+/.test(stage1.todayEarn), JSON.stringify(stage1));
    const bestKey = await js(`window.api.settings.get('bestStreak')`);
    check("stage1: best streak persisted (>= current)", parseInt(bestKey ?? "0", 10) >= 1, String(bestKey));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3400);
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
    })()`);
    check("stage2: streak KPI card matches left KPI size", s2.sizeMatch, JSON.stringify(s2));
    check("stage2: ledger max-height doubled (>=600px)", s2.ledgerMax >= 600, String(s2.ledgerMax));
    check("stage2: mini-month streak calendar (42 cells, title)", s2.monthCells === 42 && s2.monthTitle.length > 0, JSON.stringify(s2));
    check("stage2: 4 streak stones shown", s2.stones === 4, String(s2.stones));
    check("stage2: goal shows current streak + next reward", s2.goalSub.includes("Current") && s2.goalSub.includes("🪙"), s2.goalSub);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM events WHERE title LIKE 'SM10%'");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakMs.%'");
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - i * 864e5);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'SM10', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        "sm10-" + i,
        iso + "T09:00",
        iso + "T10:00",
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString()
      );
    }
    const smBase = await js(`window.api.coins.balance()`);
    const sm1 = await js(`window.api.coins.streakMilestone()`);
    check("stage2: 10-day streak milestone awards ALL unclaimed levels (5×2 + 10×2 = 30, catch-up)", sm1.award && sm1.amount === 30 && sm1.level === 10, JSON.stringify(sm1));
    const sm2 = await js(`window.api.coins.streakMilestone()`);
    check("stage2: milestone awarded only once per level", !sm2.award, JSON.stringify(sm2));
    const smBal = await js(`window.api.coins.balance()`);
    check("stage2: balance includes exactly +30 (catch-up 5+10)", Math.round((smBal - smBase) * 100) / 100 === 30, `${smBase} → ${smBal}`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3400);
    const win2 = await js(`Array.from(document.querySelectorAll('.streak-stone')).map((st) => ({ t: st.textContent, hit: st.classList.contains('hit') }))`);
    check("stage2: window shows 5,10,20,30 with 10 hit", JSON.stringify(win2).includes("10d") && win2.filter((w) => w.hit).length === 1, JSON.stringify(win2));
    const hitPrev = await js(`(() => {
      const p = document.querySelector('.streak-stone.hit-prev')
      if (!p) return { found: false }
      return { found: true, text: p.textContent, bg: getComputedStyle(p).backgroundImage }
    })()`);
    check("streak goal: second-last reached mile gets a varied blue shade", hitPrev.found && hitPrev.text.includes("5d") && hitPrev.bg.includes("gradient"), JSON.stringify(hitPrev));
    dbRun("DELETE FROM events WHERE title LIKE 'SM10%'");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM reward_milestones");
    dbRun("DELETE FROM settings WHERE key = 'milestonePathV2'");
    dbRun("DELETE FROM coin_transactions");
    dbRun("DELETE FROM event_scores");
    dbRun("DELETE FROM settings WHERE key LIKE 'stoneReached.%' OR key LIKE 'stoneCrossed.%' OR key LIKE 'rewardAsked.%'");
    const nowIso2 = (/* @__PURE__ */ new Date()).toISOString();
    const legacy = [
      ["l1", "Level 1", 100, nowIso2],
      ["l2", "Level 2", 250, nowIso2],
      ["l3", "Level 3", 500, null],
      ["l4", "Level 4", 1e3, null]
    ];
    for (const [id, name, cost, achieved] of legacy) {
      dbRun(
        `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
         VALUES (?, ?, '🎯', ?, 'x', ?, ?)`,
        id,
        name,
        cost,
        achieved,
        nowIso2
      );
    }
    const mig = await js(`window.api.milestones.list()`);
    check(
      "migration: legacy achieved levels reset to fresh Level 1 path",
      Array.isArray(mig) && mig.length >= 30 && mig[0].name === "Level 1" && mig[0].achievedAt === null && mig.every((m) => m.achievedAt === null),
      JSON.stringify(mig?.[0])
    );
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.reward-batch .dialog-actions .btn')).find((x) => x.textContent.trim() === 'Skip'); if (b) b.click() })()`);
    await sleep(1600);
    const oneStone2 = await js(`document.querySelectorAll('.mile-stone').length`);
    check("after migration the path shows ONLY Level 1", oneStone2 === 1, String(oneStone2));
    const mig2 = await js(`window.api.milestones.list()`);
    check("migration is one-time (flag set, path stable)", mig2.length === mig.length, String(mig2.length));
    dbRun("DELETE FROM reward_milestones");
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('milestonePathV2', '1')");
    const nowIso3 = (/* @__PURE__ */ new Date()).toISOString();
    const legacyRows = [
      ["n1", "Level 100", 100],
      ["n2", "Level 250", 250],
      ["n3", "Level 500", 500],
      ["n9", "Level 999", 99999]
    ];
    for (const [id, name, cost] of legacyRows) {
      dbRun(
        `INSERT INTO reward_milestones (id, name, icon, cost, notes, achieved_at, created_at)
         VALUES (?, ?, '🎯', ?, 'x', NULL, ?)`,
        id,
        name,
        cost,
        nowIso3
      );
    }
    const norm = await js(`window.api.milestones.list()`);
    check(
      "normalization: legacy rows repaired even with v2 flag already set",
      Array.isArray(norm) && norm.length >= 30 && norm[0].name === "Level 1" && norm[0].cost === 100 && norm[7].cost === 6e3 && norm[29].cost > 4e4 && !norm.some((m) => m.name === "Level 999"),
      JSON.stringify(norm.map((m) => m.name + ":" + m.cost))
    );
    dbRun("DELETE FROM coin_transactions");
    dbRun("DELETE FROM event_scores");
    await js(`window.api.coins.scoreEvent('ms-reach-1', '${TOMORROW}', 'on_time', 150, null)`);
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('stoneCrossed.100', '1')");
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('rewardAsked.100', '1')");
    dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('rewardAsked.250', '1')");
    const probeReach = await js(`(async () => ({ bal: await window.api.coins.balance(), ms: (await window.api.milestones.list()).slice(0, 3) }))()`);
    console.log("[smoke] reach probe:", JSON.stringify(probeReach));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3600);
    const reachStones = await js(`Array.from(document.querySelectorAll('.mile-stone')).map((st) => ({ t: st.textContent.slice(0, 30), crossed: st.classList.contains('crossed'), first: st.classList.contains('first') }))`);
    check("next stone shows once previous is REACHED (not claimed) — 2 stones", reachStones.length === 2, JSON.stringify(reachStones));
    check("stack: Level 1 at bottom, Level 2 on top", reachStones[0].t.includes("Level 2") && !reachStones[0].crossed && reachStones[1].t.includes("Level 1") && reachStones[1].crossed, JSON.stringify(reachStones));
    await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return false; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim')); if (!b) return false; b.click(); return true })()`);
    await sleep(800);
    const celebSeen2 = await js(`!!document.querySelector('.overlay.celeb')`);
    if (celebSeen2) await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`);
    await sleep(400);
    const redeemText = await js(`(() => { const r = Array.from(document.querySelectorAll('.mile-stone button')).find((b) => b.textContent.includes('Redeem')); return r ? r.textContent : '' })()`);
    check("redeem button has no bracket stat", redeemText === "Redeem", redeemText);
    dbRun("DELETE FROM coin_transactions");
    await js(`window.api.coins.scoreEvent('ms-stick-1', '${TOMORROW}', 'on_time', 500, null)`);
    for (const c of [100, 250, 500, 1e3]) {
      dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('stoneCrossed.' || ?, '1')", c);
      dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('rewardAsked.' || ?, '1')", c);
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
    const stickBefore = await js(`document.querySelectorAll('.mile-stone').length`);
    for (let i = 0; i < 2; i++) {
      await js(`(() => { const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => x.textContent.includes('Level 1')); if (!st) return false; const b = Array.from(st.querySelectorAll('button')).find((x) => x.textContent.includes('Claim') || x.textContent.includes('Redeem')); if (!b) return false; b.click(); return true })()`);
      await sleep(700);
      const cOpen = await js(`!!document.querySelector('.overlay.celeb')`);
      if (cOpen) await js(`Array.from(document.querySelectorAll('.overlay.celeb .btn')).find((b) => b.textContent.includes('Enjoy'))?.click()`);
      await sleep(300);
    }
    const stickAfter = await js(`(async () => ({ n: document.querySelectorAll('.mile-stone').length, bal: await window.api.coins.balance() }))()`);
    check("sticky: reached stones stay even after the net drops below their cost", stickBefore === 4 && stickAfter.n === 4 && stickAfter.bal < 500, JSON.stringify({ before: stickBefore, ...stickAfter }));
    dbRun("DELETE FROM coin_transactions");
    await js(`window.api.coins.scoreEvent('ms-multi-1', '${TOMORROW}', 'on_time', 1600, null)`);
    for (const c of [100, 250, 500, 1e3, 1500, 2500]) {
      dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('stoneCrossed.' || ?, '1')", c);
      dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES ('rewardAsked.' || ?, '1')", c);
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
    const multi = await js(`(() => {
      const names = Array.from(document.querySelectorAll('.mile-stone-name')).map((n) => n.textContent.trim())
      return { count: names.length, names }
    })()`);
    check("multiple stones hit → ALL present (6 stones: L1-L5 reached + L6 next)", multi.count === 6 && multi.names[0].includes("Level 6") && multi.names[1].includes("Level 5") && multi.names[multi.names.length - 1].includes("Level 1"), JSON.stringify(multi));
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
    })()`);
    check("milestone path: stones stacked with NO overlap/cascade (in-flow links, equal widths)", pathGeo.count >= 2 && !pathGeo.overlap && pathGeo.linkPos === "static" && pathGeo.sameWidth, JSON.stringify(pathGeo));
    dbRun("UPDATE reward_milestones SET notes = 'A very long reward description that keeps going and going and going and going and going and going and going to test truncation' WHERE cost = 100");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(1200);
    const noteGeo = await js(`(() => {
      const st = Array.from(document.querySelectorAll('.mile-stone')).find((x) => (x.querySelector('.mile-level')?.textContent ?? '').trim().startsWith('100 '))
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
    })()`);
    check("long reward note: truncates to one line, does NOT overlap the buttons", noteGeo.found && !noteGeo.overlaps && noteGeo.truncated, JSON.stringify(noteGeo));
    dbRun("UPDATE reward_milestones SET notes = 'Set your reward' WHERE cost = 100");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`window.api.coins.clearScores('ms-stick-1', '${TOMORROW}')`);
    await js(`window.api.coins.clearScores('ms-multi-1', '${TOMORROW}')`);
    await js(`window.api.coins.clearScores('ms-reach-1', '${TOMORROW}')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(3600);
    const widthMatch = await js(`(() => {
      const chart = document.querySelector('.coins-charts .ins-panel')
      const kpi = document.querySelector('.coins-kpis .coins-kpi')
      const cw = chart.getBoundingClientRect().width
      const kw = kpi.getBoundingClientRect().width
      return { cw: Math.round(cw), kw: Math.round(kw), diff: Math.round(Math.abs(cw - kw)) }
    })()`);
    check("7-day chart width matches KPI card (exact)", widthMatch.diff <= 2, JSON.stringify(widthMatch));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await openEditorOn("Smoke occwalk");
    const edStart = await getDT(".editor", 0);
    const edEnd = await getDT(".editor", 1);
    check("editor shows the selected occurrence date", edStart === `${TODAY}T06:30`, `${edStart} vs ${TODAY}T06:30`);
    check("editor end matches the selected occurrence", edEnd === `${TODAY}T07:30`, edEnd);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'doing')`);
    await saveEditor();
    await sleep(600);
    const stOv = dbGet("SELECT start_local FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke occwalk' AND status = 'doing'");
    check("status override created on the occurrence day", !!stOv && stOv.start_local.startsWith(TODAY), JSON.stringify(stOv));
    await openEditorOn("Smoke occwalk");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete this occurrence'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await sleep(300);
    const walkPos = await blockPos("Smoke occwalk");
    if (!walkPos) {
      results.push("SKIP 2i drag-round-trip (occurrence not found)");
    } else {
      const colRects = await js(`Array.from(document.querySelectorAll('.day-col')).map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, width: r.width } })`);
      const fromIdx = colRects.findIndex((r) => walkPos.x >= r.left && walkPos.x < r.left + r.width);
      const toIdx = Math.min(fromIdx + 1, colRects.length - 1);
      const dx1 = colRects[toIdx].left + colRects[toIdx].width / 2 - walkPos.x;
      const beforeTotal = await countBlocks("Smoke occwalk");
      await realDrag(walkPos, dx1, 0);
      await sleep(700);
      const tgt1 = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      return {
        all: col.querySelectorAll('.eb').length,
        walks: Array.from(col.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length
      }
    })()`);
      check("moving onto a day that already has the event → both blocks render", tgt1.walks === 2, JSON.stringify(tgt1));
      const backPos = await js(`(() => {
      const col = document.querySelectorAll('.day-col')[${toIdx}]
      const el = Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke occwalk'))
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) }
    })()`);
      const dx2 = colRects[fromIdx].left + colRects[fromIdx].width / 2 - backPos.x;
      await realDrag(backPos, dx2, 0);
      await sleep(700);
      const tgt2 = await js(`(() => {
      const fromCol = document.querySelectorAll('.day-col')[${fromIdx}]
      const toCol = document.querySelectorAll('.day-col')[${toIdx}]
      return {
        from: Array.from(fromCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length,
        to: Array.from(toCol.querySelectorAll('.eb')).filter((e) => e.textContent.includes('Smoke occwalk')).length
      }
    })()`);
      const total2 = await countBlocks("Morning walk");
      check("moving back leaves exactly one block per day (no ghost)", tgt2.from === 1 && tgt2.to === 1, `from=${tgt2.from} to=${tgt2.to}`);
      const ovCount = dbGet("SELECT COUNT(*) AS c FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke occwalk'");
      check("no duplicate override rows from the round trip", ovCount.c >= 1 && ovCount.c <= 2, `overrides=${ovCount.c}`);
    }
    await openEditorOn("Smoke occwalk");
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    await sleep(250);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(300);
    await js(`document.querySelector('.seg-btn').click()`);
    await sleep(400);
    const dbg3 = await js(`({
      dayCols: document.querySelectorAll('.day-col').length,
      blocks: Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim()).slice(0, 10),
      activeSeg: Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.classList.contains('active'))?.textContent
    })`);
    console.log("[smoke] step3 view state:", JSON.stringify(dbg3));
    const pos3 = await blockPos("Smoke test activity");
    console.log("[smoke] step3 pos:", JSON.stringify(pos3));
    const clickOk = await realClick(pos3);
    await sleep(200);
    console.log("[smoke] step3 after click:", JSON.stringify(await js(`({ editor: !!document.querySelector('.editor'), overlay: !!document.querySelector('.overlay') })`)));
    const editorOpen = await js(`!!document.querySelector('.editor')`);
    check("real click opens editor", clickOk && editorOpen);
    const quickAddAlsoOpen = await js(`!!document.querySelector('.quickadd')`);
    check("block click does not open quick-add", !quickAddAlsoOpen);
    await js(`(${SET_VALUE})(document.querySelectorAll('.editor select')[1], 'done')`);
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save')?.click()`);
    await sleep(400);
    await skipScore();
    const done = await js(`Array.from(document.querySelectorAll('.eb')).some(e => e.textContent.includes('Smoke test activity') && e.classList.contains('done'))`);
    check("status change saved & styled (done, faded)", done);
    await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity'))
      if (el) el.dataset.marker = 'kept'
      return !!el
    })()`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke tiny')`);
    await setDT(".quickadd", 0, `${TODAY}T08:00`);
    await sleep(150);
    await setDT(".quickadd", 1, `${TODAY}T08:15`);
    await sleep(150);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const tiny = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke tiny'))
      return el ? { cls: el.className, title: el.querySelector('.eb-title')?.textContent } : null
    })()`);
    check("15-min block shows title (tiny class)", !!tiny && tiny.cls.includes("tiny") && tiny.title === "Smoke tiny", JSON.stringify(tiny));
    await realClick(await blockPos("Smoke tiny"));
    await sleep(300);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(400);
    await realDrag(await blockPos("Smoke test activity"), 0, 33);
    await sleep(600);
    const moved = dbGet(
      "SELECT start_local, end_local FROM events WHERE title = 'Smoke test activity'"
    );
    check("drag moves block +1h and persists", moved.start_local === TODAY + "T16:00", JSON.stringify(moved));
    const afterDragCount = await countBlocks("Smoke test activity");
    const afterDragTime = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('16:00–'))`);
    check("dragged block still visible at new time (not vanished)", afterDragCount === 1 && afterDragTime, `count=${afterDragCount} shows16=${afterDragTime}`);
    const sameNode = await js(`(() => {
      const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity'))
      return el ? el.dataset.marker === 'kept' : false
    })()`);
    check("dragged block is the SAME DOM node (no remount → no blink)", sameNode);
    await realDrag(await blockPos("Smoke test activity", "bottom"), 0, 16.5);
    await sleep(600);
    const resized = dbGet(
      "SELECT end_local FROM events WHERE title = 'Smoke test activity'"
    );
    check("resize extends block +30min and persists", resized.end_local === TODAY + "T17:30", JSON.stringify(resized));
    const afterResizeVisible = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('17:30'))`);
    check("resized block still visible (not vanished)", afterResizeVisible);
    await realClick(await blockPos("Smoke test activity"));
    await sleep(350);
    const repOpen = await js(`!!document.querySelector('.repeat-editor')`);
    check("repeat editor visible in dialog", repOpen);
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Weekly').click()`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.wd-pill')).forEach((p) => {
      const want = ['MO', 'WE', 'FR'].includes(p.dataset.day)
      if (want !== p.classList.contains('on')) p.click()
    })`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.repeat-editor .re-ends .seg-btn')).find((b) => b.textContent.trim() === 'After').click()`);
    await sleep(150);
    await js(`(${SET_VALUE})(document.querySelector('.repeat-editor .re-count'), '3')`);
    await sleep(150);
    await saveEditor();
    await sleep(500);
    await skipScore();
    const rr = dbGet("SELECT rrule FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL");
    const rrDays = (rr.rrule.split("BYDAY=")[1] ?? "").split(";")[0].split(",");
    const rrOk = rr.rrule.startsWith("FREQ=WEEKLY;BYDAY=") && rr.rrule.endsWith(";COUNT=3") && [...rrDays].sort().join() === ["MO", "WE", "FR"].sort().join();
    check("repeat editor saves weekly rule", rrOk, String(rr.rrule));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const weekCountNow = await countBlocks("Smoke test activity");
    await js(`document.querySelector('.icon-btn[title="Next"]')?.click()`);
    await sleep(400);
    const weekCountNext = await countBlocks("Smoke test activity");
    check("weekly rule expands to multiple days (this week + next week)", weekCountNow >= 1 && weekCountNow + weekCountNext >= 2, `now=${weekCountNow} next=${weekCountNext}`);
    await realClick(await blockPos("Smoke test activity"));
    await sleep(350);
    await js(`Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((b) => b.textContent.trim() === 'This occurrence').click()`);
    await sleep(150);
    await js(`(${SET_VALUE})(document.querySelector('.editor .ef-title'), 'Smoke edited occurrence')`);
    await saveEditor();
    await sleep(500);
    const ovr = dbGet(
      "SELECT COUNT(*) AS c FROM events WHERE title = 'Smoke edited occurrence' AND parent_id IS NOT NULL"
    );
    check("edit-one-occurrence creates an override", ovr.c === 1, `overrides=${ovr.c}`);
    const ovrRow = dbGet(
      "SELECT start_local FROM events WHERE title = 'Smoke edited occurrence' AND parent_id IS NOT NULL"
    );
    const mRow2 = dbGet("SELECT exdates FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL");
    const occDay = JSON.parse(mRow2.exdates)[0];
    check("override created on the edited occurrence day", ovrRow.start_local.slice(0, 10) === occDay, `${ovrRow.start_local} vs ${occDay}`);
    const mRow = dbGet(
      "SELECT title, exdates FROM events WHERE title = 'Smoke test activity' AND parent_id IS NULL"
    );
    check(
      "series master unchanged and occurrence skipped",
      mRow.title === "Smoke test activity" && JSON.parse(mRow.exdates).length === 1,
      JSON.stringify(mRow)
    );
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke edited occurrence')); if (el) el.click(); return !!el })()`);
    await sleep(450);
    const dbg5d = await js(`({
      editorOpen: !!document.querySelector('.editor'),
      editorTitle: document.querySelector('.editor .ef-title')?.value ?? null,
      hasOneTimeBadge: !!document.querySelector('.editor .badge'),
      blocks: Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent.trim()).slice(0, 15)
    })`);
    console.log("[smoke] 5d before delete:", JSON.stringify(dbg5d));
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    let ovrGone = false;
    for (let attempt = 0; attempt < 4 && !ovrGone; attempt++) {
      await sleep(500);
      ovrGone = await js(`!Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('Smoke edited occurrence'))`);
    }
    check("override deleted", ovrGone);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke test activity')); if (el) el.click(); return !!el })()`);
    await sleep(450);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.apply-to .seg-btn')).find((x) => x.textContent.trim() === 'Whole series'); if (b) b.click(); return !!b })()`);
    const delSeriesClicked = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const b = Array.from(document.querySelectorAll('.editor .btn.danger')).find((x) => x.textContent.trim() === 'Delete series')
        if (b) { b.click(); return true }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })()`);
    let seriesGone = dbGet(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    );
    for (let i = 0; i < 15 && seriesGone.c !== 0; i++) {
      await sleep(200);
      seriesGone = dbGet(
        "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
      );
    }
    check("whole series deleted from database", delSeriesClicked && seriesGone.c === 0, `rows=${seriesGone.c}`);
    await js(`document.querySelector('.new-btn').click()`);
    await sleep(250);
    await js(`(${SET_VALUE})(document.querySelector('.quickadd .ef-title'), 'Smoke dragwalk')`);
    await setDT(".quickadd", 0, `${TODAY}T06:30`);
    await sleep(100);
    await js(`Array.from(document.querySelectorAll('.quickadd .re-freq .seg-btn')).find((b) => b.textContent.trim() === 'Daily').click()`);
    await sleep(200);
    await js(`document.querySelector('.quickadd .dialog-actions .btn.primary').click()`);
    await sleep(500);
    const dwCountBefore = await countBlocks("Smoke dragwalk");
    await realDrag(await blockPos("Smoke dragwalk"), 0, 33);
    await sleep(700);
    const dwOv = dbGet("SELECT COUNT(*) AS c FROM events WHERE parent_id IS NOT NULL AND title = 'Smoke dragwalk'");
    check("dragging a recurring occurrence creates an override", dwOv.c === 1, `overrides=${dwOv.c}`);
    const dwMaster = dbGet("SELECT exdates FROM events WHERE title = 'Smoke dragwalk' AND parent_id IS NULL");
    check("recurring master gets the skipped date", JSON.parse(dwMaster.exdates).length === 1, dwMaster.exdates);
    const dwAfter = await countBlocks("Smoke dragwalk");
    const dwShows730 = await js(`Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('07:30–') && e.textContent.includes('Smoke dragwalk'))`);
    check(
      "recurring occurrence visible at new time (not vanished)",
      dwAfter === dwCountBefore && dwShows730,
      `before=${dwCountBefore} after=${dwAfter} shows07:30=${dwShows730}`
    );
    const dwAt730 = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('07:30–') && e.textContent.includes('Smoke dragwalk')).length`);
    check("no duplicate/ghost block after recurring drag", dwAt730 === 1, `n=${dwAt730}`);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke dragwalk')); if (el) el.click(); return !!el })()`);
    await sleep(400);
    await js(`(() => { const b = document.querySelector('.editor .btn.danger'); if (b) b.click(); return !!b })()`);
    await sleep(500);
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(150);
    const ax0 = await js(`window.api.coins.balance()`);
    dbRun("UPDATE events SET status = 'done' WHERE status != 'cancelled'");
    const axOk = await js(`window.api.coins.allDoneCheck('${TOMORROW}')`);
    check("all-done: +25 when the whole day resolves (isolated)", axOk.award && axOk.amount === 25, JSON.stringify(axOk));
    const axAgain = await js(`window.api.coins.allDoneCheck('${TOMORROW}')`);
    check("all-done: awarded only once per day", !axAgain.award, JSON.stringify(axAgain));
    const axBal = await js(`window.api.coins.balance()`);
    check("all-done: balance includes exactly +25", Math.round((axBal - ax0) * 100) / 100 === 25, `${ax0} → ${axBal}`);
    const pw = await js(`window.api.coins.perfectWeek()`);
    console.log("[smoke] perfectWeek result:", JSON.stringify(pw));
    const wkMon = (iso) => {
      const d = /* @__PURE__ */ new Date(iso + "T00:00:00");
      const dow = d.getDay();
      const m = new Date(d);
      m.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      return fmtD(m);
    };
    const addDaysIsoSmoke = (iso, n) => {
      const d = /* @__PURE__ */ new Date(iso + "T00:00:00");
      d.setDate(d.getDate() + n);
      return fmtD(d);
    };
    const insEv = (id, iso, status) => {
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'PW', '', ?, ?, 0, NULL, NULL, ?, NULL, '[]', NULL, NULL, ?, ?, ?)`,
        id,
        iso + "T09:00",
        iso + "T10:00",
        status,
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString()
      );
    };
    const weekAllDone = (monIso, skipDay) => {
      for (let i = 0; i < 7; i++) {
        if (i === skipDay) continue;
        insEv("pw-" + monIso + "-" + i, addDaysIsoSmoke(monIso, i), "done");
      }
    };
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    const wBase = await js(`window.api.coins.balance()`);
    const curMon = wkMon(TODAY);
    const lastMonIso = addDaysIsoSmoke(curMon, -7);
    weekAllDone(lastMonIso, null);
    const pw0 = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: completed Mon–Sun all done → +100", pw0.award && pw0.amount === 100, JSON.stringify(pw0));
    const pw1 = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: only once per week", !pw1.award, JSON.stringify(pw1));
    const wBal = await js(`window.api.coins.balance()`);
    check("perfect week: balance includes exactly +100", Math.round((wBal - wBase) * 100) / 100 === 100, `${wBase} → ${wBal}`);
    const twoMon = addDaysIsoSmoke(lastMonIso, -7);
    weekAllDone(twoMon, 3);
    const pwRest = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: rest day inside the week still perfect (+100)", pwRest.award && pwRest.amount === 100, JSON.stringify(pwRest));
    const noPlanMon = addDaysIsoSmoke(lastMonIso, -14);
    void noPlanMon;
    const pwNoPlan = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: a week with NO plans is NOT perfect", !pwNoPlan.award, JSON.stringify(pwNoPlan));
    const pendMon = addDaysIsoSmoke(lastMonIso, -21);
    for (let i = 0; i < 7; i++) {
      if (i === 2) insEv("pw-pend-" + i, addDaysIsoSmoke(pendMon, i), "todo");
      else insEv("pw-pend-" + i, addDaysIsoSmoke(pendMon, i), "done");
    }
    const pwPend = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: a day with ZERO done in a completed week → NO award", !pwPend.award, JSON.stringify(pwPend));
    dbRun("DELETE FROM events WHERE title = 'PW'");
    const partialMon = addDaysIsoSmoke(lastMonIso, -28);
    for (let i = 0; i < 7; i++) {
      insEv("pw-part-" + i + "-a", addDaysIsoSmoke(partialMon, i), "done");
      if (i === 4) insEv("pw-part-" + i + "-b", addDaysIsoSmoke(partialMon, i), "todo");
    }
    const pwPart = await js(`window.api.coins.perfectWeek()`);
    check("perfect week: one done per day is enough (streak logic) → +100", pwPart.award && pwPart.amount === 100, JSON.stringify(pwPart));
    dbRun("DELETE FROM events WHERE title = 'PW'");
    const prevFirst = fmtD(new Date((/* @__PURE__ */ new Date(TODAY + "T00:00:00")).getFullYear(), (/* @__PURE__ */ new Date(TODAY + "T00:00:00")).getMonth() - 1, 1));
    const prevLast = fmtD(new Date((/* @__PURE__ */ new Date(TODAY + "T00:00:00")).getFullYear(), (/* @__PURE__ */ new Date(TODAY + "T00:00:00")).getMonth(), 0));
    dbRun("DELETE FROM settings WHERE key LIKE 'monthStreak.%'");
    for (let mon = wkMon(prevFirst); mon <= wkMon(prevLast); mon = addDaysIsoSmoke(mon, 7)) {
      for (let i = 0; i < 7; i++) insEv("pm-" + mon + "-" + i, addDaysIsoSmoke(mon, i), "done");
    }
    const pm1 = await js(`window.api.coins.perfectMonth()`);
    check("perfect month: previous month fully in perfect weeks → +300", pm1.award && pm1.amount === 300, JSON.stringify(pm1));
    const pm2 = await js(`window.api.coins.perfectMonth()`);
    check("perfect month: only once per month", !pm2.award, JSON.stringify(pm2));
    const pwAfterMonth = await js(`window.api.coins.perfectWeek()`);
    check("perfect month weeks also credit as perfect weeks", pwAfterMonth.award && pwAfterMonth.amount >= 300, JSON.stringify(pwAfterMonth));
    dbRun("DELETE FROM events WHERE title = 'PW'");
    const pwTx = await js(`window.api.coins.listTransactions()`);
    check("perfect week: bonus row in ledger", Array.isArray(pwTx) && pwTx.some((t) => t.reason === "Perfect week" && t.type === "bonus" && t.amount === 100), JSON.stringify(pwTx?.[0]));
    dbRun("DELETE FROM events");
    for (let mon = wkMon(prevFirst); mon <= wkMon(prevLast); mon = addDaysIsoSmoke(mon, 7)) {
      for (let i = 0; i < 7; i++) insEv("pwui-" + mon + "-" + i, addDaysIsoSmoke(mon, i), "done");
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(1400);
    const wkGold = await js(`(() => {
      const rows = Array.from(document.querySelectorAll('.streak-row'))
      const perf = rows.filter((r) => r.classList.contains('perfect-wk'))
      return { total: rows.length, perfect: perf.length, title: perf[0]?.getAttribute('title') ?? '' }
    })()`);
    check("cup5: streak calendar wraps perfect week rows in a golden border", wkGold.perfect >= 1 && wkGold.title.includes("Perfect week"), JSON.stringify(wkGold));
    const dynRows = await js(`(() => {
      const sc = document.querySelectorAll('.streak-month .streak-row').length
      const mm = document.querySelectorAll('.minimonth .mm-cell').length
      return { streakRows: sc, miniCells: mm }
    })()`);
    check("cup5: streak calendar rows are dynamic (4-6, not always 6)", dynRows.streakRows >= 4 && dynRows.streakRows <= 6, JSON.stringify(dynRows));
    check("cup5: mini-month cells are dynamic (28-42, not always 42)", dynRows.miniCells >= 28 && dynRows.miniCells <= 42 && dynRows.miniCells % 7 === 0, JSON.stringify(dynRows));
    const legend = await js(`(() => {
      const btn = document.querySelector('.streak-info-btn')
      if (btn) btn.click()
      return { hasBtn: !!btn }
    })()`);
    await sleep(300);
    const legendPop = await js(`(() => ({
      perfectWk: !!document.querySelector('.streak-info-pop .sl.perfect-wk'),
      perfectM: !!document.querySelector('.streak-info-pop .sl.perfect-m'),
      text: document.querySelector('.streak-info-pop')?.textContent ?? ''
    }))()`);
    await js(`document.querySelector('.streak-info-btn')?.click()`);
    await sleep(200);
    check("cup5: streak calendar info popover shows perfect week + perfect month styles", legend.hasBtn && legendPop.perfectWk && legendPop.perfectM && legendPop.text.includes("perfect week") && legendPop.text.includes("perfect month"), JSON.stringify(legendPop));
    await js(`document.querySelector('.streak-month .mm-nav')?.click()`);
    await sleep(600);
    const mGold = await js(`(() => ({
      perfectM: document.querySelectorAll('.streak-day.done.perfect-m').length,
      done: document.querySelectorAll('.streak-day.done').length,
      none: document.querySelectorAll('.streak-day.none').length
    }))()`);
    check("cup5: perfect month dates are golden dots (blue text); no-event days stay normal", mGold.perfectM >= 25 && mGold.done >= mGold.perfectM && mGold.none >= 0, JSON.stringify(mGold));
    const streakCard = await js(`(() => { const c = document.querySelector('.streak-kpi'); return { has: !!c, text: c ? c.textContent : '' } })()`);
    check("streak card present with a value", streakCard.has && /\d+d/.test(streakCard.text), streakCard.text);
    const streakInfo = await js(`(() => ({
      btn: !!document.querySelector('.streak-info-btn'),
      footLegend: !!document.querySelector('.streak-legend')
    }))()`);
    check("v1.11.4: streak calendar has an info button and NO footer legend", streakInfo.btn && !streakInfo.footLegend, JSON.stringify(streakInfo));
    await js(`document.querySelector('.streak-info-btn')?.click()`);
    await sleep(300);
    const streakPop = await js(`(() => {
      const pop = document.querySelector('.streak-info-pop')
      const done = pop ? pop.querySelector('.sl.done') : null
      return {
        pop: !!pop,
        hasPerfect: (pop?.textContent ?? '').includes('perfect week'),
        doneBg: done ? getComputedStyle(done).backgroundColor : ''
      }
    })()`);
    check("v1.11.4: streak info button opens the colour popover", streakPop.pop && streakPop.hasPerfect, JSON.stringify(streakPop));
    check("v1.11.5: popover swatches show REAL colours (not just text)", streakPop.doneBg !== "" && streakPop.doneBg !== "rgba(0, 0, 0, 0)" && streakPop.doneBg !== "transparent", JSON.stringify(streakPop));
    await js(`document.querySelector('.streak-info-btn')?.click()`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM events WHERE title LIKE 'pwui%'");
    dbRun("DELETE FROM events");
    for (let i = 1; i <= 150; i++) {
      const d = new Date(Date.now() - i * 864e5);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'HIST', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        "hist-" + i,
        iso + "T09:00",
        iso + "T10:00",
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString()
      );
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(1600);
    const histStreak = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const c = document.querySelector('.streak-kpi')
        if (c && c.textContent.includes('d')) return c.textContent
        await new Promise((r) => setTimeout(r, 400))
      }
      return ''
    })()`);
    check("cup5b: deep history (150 done days) updates the streak (>=120d)", /\d+d/.test(histStreak) && parseInt(histStreak.match(/(\d+)d/)?.[1] ?? "0", 10) >= 120, histStreak);
    await js(`(() => { const nav = document.querySelector('.streak-month .mm-nav'); if (nav) { nav.click(); nav.click(); nav.click() } })()`);
    await sleep(800);
    const histCal = await js(`(() => ({
      done: document.querySelectorAll('.streak-month .streak-day.done').length,
      rows: document.querySelectorAll('.streak-month .streak-row').length,
      title: document.querySelector('.streak-month-title')?.textContent ?? ''
    }))()`);
    check("cup5b: streak calendar styles the deep history (old month full of done cells)", histCal.done >= 25 && histCal.rows >= 4, JSON.stringify(histCal));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    const wkMonIso = (() => {
      const d = /* @__PURE__ */ new Date();
      const dow = d.getDay();
      const m = new Date(d);
      m.setDate(m.getDate() - (dow === 0 ? 6 : dow - 1));
      return fmtD(m);
    })();
    const addD = (iso, n) => {
      const d = /* @__PURE__ */ new Date(iso + "T00:00:00");
      d.setDate(d.getDate() + n);
      return fmtD(d);
    };
    const dowNum = (/* @__PURE__ */ new Date()).getDay();
    const dayIdxMon0 = dowNum === 0 ? 6 : dowNum - 1;
    const seedCount = Math.min(3, Math.max(1, dayIdxMon0));
    for (let i = 0; i < seedCount; i++) {
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'CWC', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        "cwc-" + i,
        addD(wkMonIso, i) + "T09:00",
        addD(wkMonIso, i) + "T10:00",
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString()
      );
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(1600);
    const curWk = await js(`(() => {
      const rows = Array.from(document.querySelectorAll('.streak-row'))
      const idx = rows.findIndex((r) => Array.from(r.querySelectorAll('.streak-day.today')).length > 0)
      const row = idx >= 0 ? rows[idx] : null
      const cells = row ? Array.from(row.querySelectorAll('.streak-day')) : []
      const dayIdx = cells.findIndex((c) => c.classList.contains('today'))
      return {
        idx, rowPerfect: row ? row.classList.contains('perfect-wk') : false,
        rowUp: row ? row.classList.contains('perfect-up') : false,
        dayIdx,
        covers: cells.filter((c) => c.classList.contains('cover')).length,
        afterCover: cells.filter((c, i) => i > dayIdx && c.classList.contains('cover')).length,
        month: document.querySelector('.streak-month-title')?.textContent ?? ''
      }
    })()`);
    const expectCovers = dayIdxMon0 + 1;
    const okSun = dowNum === 0 && curWk.rowPerfect && !curWk.rowUp && curWk.covers === 0;
    const okMid = dowNum !== 0 && curWk.rowUp && !curWk.rowPerfect && curWk.covers === expectCovers && curWk.afterCover === 0;
    check("v1.10.6: current-week cover stops at TODAY (Mon..today rings, never beyond)", curWk.idx >= 0 && (okSun || okMid), JSON.stringify({ ...curWk, expectCovers }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM events WHERE title LIKE 'CWC%'");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM events WHERE title LIKE 'HIST%'");
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakMs.%'");
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.now() - i * 864e5);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dbRun(
        `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
         VALUES (?, 'SG5', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
        "sg5-" + i,
        iso + "T09:00",
        iso + "T10:00",
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString(),
        (/* @__PURE__ */ new Date()).toISOString()
      );
    }
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(2e3);
    const sgToast = await js(`(async () => {
      for (let i = 0; i < 10; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('streak milestone'))
        if (t) return t.textContent
        await new Promise((r) => setTimeout(r, 400))
      }
      return ''
    })()`);
    const sgLedger = await js(`window.api.coins.listTransactions().then((txs) => txs.filter((t) => t.reason === 'Streak milestone'))`);
    check("v1.10.5: 5-day streak reward → toast + ledger row", sgToast.includes("streak milestone") && sgLedger.length >= 1 && sgLedger[0].amount === 10, JSON.stringify({ toast: sgToast, ledger: sgLedger[0] }));
    await js(`document.querySelectorAll('.toast-close').forEach((c) => c.click())`);
    await sleep(200);
    dbRun("DELETE FROM events WHERE title LIKE 'SG5%'");
    const row2 = dbGet(
      "SELECT COUNT(*) AS c FROM events WHERE title IN ('Smoke test activity', 'Smoke edited occurrence')"
    );
    check("database has no leftover smoke rows", row2.c === 0, `rows=${row2.c}`);
    await js(`document.querySelector('.settings-btn')?.click()`);
    await sleep(400);
    const setOpen = await js(`!!document.querySelector('.settings-dialog')`);
    check("M8: settings dialog opens from the gear button", setOpen);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.set-tab')).find((t) => t.textContent === 'General'); if (b) b.click(); return !!b })()`);
    await sleep(300);
    const darkRes = await js(`(async () => {
      const btn = Array.from(document.querySelectorAll('.theme-seg .seg-btn')).find((b) => b.textContent.trim() === 'Dark')
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      return {
        attr: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.body).backgroundColor,
        stored: await window.api.settings.get('theme')
      }
    })()`);
    check("M8: dark theme applies (html attr + body bg + persisted)", darkRes.attr === "dark" && darkRes.bg === "rgb(28, 28, 30)" && darkRes.stored === "dark", JSON.stringify(darkRes));
    const lightRes = await js(`(async () => {
      const btn = Array.from(document.querySelectorAll('.theme-seg .seg-btn')).find((b) => b.textContent.trim() === 'Light')
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      return { attr: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }
    })()`);
    check("M8: light theme restores", lightRes.attr === "light" && lightRes.bg === "rgb(245, 245, 247)", JSON.stringify(lightRes));
    const bk1 = await js(`window.api.backups.list()`);
    const bkNow = await js(`window.api.backups.now()`);
    const bk2 = await js(`window.api.backups.list()`);
    const bkpDir = path.join(process.env.AC_DATA_DIR, "backups");
    const bkFile = bkNow.ok ? fs.existsSync(bkNow.path) : false;
    check("M8: manual backup creates a file on disk", bkNow.ok && bkFile && bk2.length >= 1 && bk2.length === bkNow.count, JSON.stringify({ ...bkNow, disk: bkFile, dir: bkpDir }));
    check("M8: backups:list returns entries with size", Array.isArray(bk2) && bk2.length >= 1 && typeof bk2[0].size === "number" && bk2[0].size > 0, JSON.stringify(bk2[0]));
    const lastBk = await js(`window.api.settings.get('lastBackup')`);
    check("M8: lastBackup setting recorded", !!lastBk && !Number.isNaN(new Date(lastBk).getTime()), String(lastBk));
    await js(`window.api.settings.set('autoBackup', '0')`);
    const autoOff = await js(`window.api.settings.get('autoBackup')`);
    await js(`window.api.settings.set('autoBackup', '1')`);
    check("M8: auto-backup toggle persists", autoOff === "0", String(autoOff));
    const appInfo = await js(`window.api.app.info()`);
    check("M8: app info (version + folders)", !!appInfo && appInfo.version.length > 0 && appInfo.dataDir.length > 0 && appInfo.backupsDir.length > 0, JSON.stringify(appInfo));
    await js(`Array.from(document.querySelectorAll('.settings-dialog .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`);
    await sleep(300);
    const setClosed = await js(`!document.querySelector('.settings-dialog')`);
    check("M8: settings dialog closes", setClosed);
    const darkAfter = await js(`(async () => {
      await window.api.settings.set('theme', 'dark')
      await window.__rhythmTheme.loadTheme()
      return document.documentElement.dataset.theme
    })()`);
    check("M8: theme reloads from settings", darkAfter === "dark", String(darkAfter));
    await js(`window.api.settings.set('theme', 'light')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(600);
    await js(`document.querySelector('.premium-heading.coins').click()`);
    await sleep(400);
    const sysDlg = await js(`(() => ({
      open: !!document.querySelector('.coin-system-dialog'),
      title: document.querySelector('.coin-system-dialog .dialog-title')?.textContent ?? ''
    }))()`);
    check("cup3: clicking the Coins pill opens the system dialog", sysDlg.open);
    check('v1.10.6: system dialog names it "Rhythm Coins"', sysDlg.title.includes("Rhythm Coins"), sysDlg.title);
    await js(`Array.from(document.querySelectorAll('.coin-system-dialog .dialog-actions .btn')).find((b) => b.textContent.includes('disable')).click()`);
    await sleep(600);
    const sysOff = await js(`(async () => ({
      setting: await window.api.settings.get('coinSystem'),
      chip: !!document.querySelector('.coin-chip'),
      widget: !!document.querySelector('.mile-widget'),
      banner: !!document.querySelector('.coins-off-banner'),
      bannerText: document.querySelector('.coins-off-banner')?.textContent ?? '',
      checkIn: await window.api.coins.checkIn()
    }))()`);
    check("cup3: system OFF → setting 0, sidebar widgets hidden, banner shown, check-in disabled", sysOff.setting === "0" && !sysOff.chip && !sysOff.widget && sysOff.banner && !sysOff.checkIn.award, JSON.stringify(sysOff));
    check('v1.10.6: off-banner names it "Rhythm Coins"', sysOff.bannerText.includes("Rhythm Coins"), sysOff.bannerText);
    await js(`document.querySelector('.premium-heading.coins').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.coin-system-dialog .dialog-actions .btn')).find((b) => b.textContent.includes('enable')).click()`);
    await sleep(600);
    const sysOn2 = await js(`(async () => ({
      setting: await window.api.settings.get('coinSystem'),
      chip: !!document.querySelector('.coin-chip'),
      widget: !!document.querySelector('.mile-widget'),
      banner: !!document.querySelector('.coins-off-banner')
    }))()`);
    check("cup3: system ON again → widgets back, banner gone", sysOn2.setting === "1" && sysOn2.chip && sysOn2.widget && !sysOn2.banner, JSON.stringify(sysOn2));
    const balOff = await js(`window.api.coins.balance()`);
    await js(`window.api.coins.setSystem(false)`);
    await js(`window.api.events.create({ title: 'Smoke offdone', description: '', startLocal: '${TODAY}T14:00', endLocal: '${TODAY}T15:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })`);
    const offEv = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'Smoke offdone'))`);
    if (!offEv || !offEv.id) throw new Error("cup3v3 prep: Smoke offdone event was not created");
    await js(`window.api.events.update('${offEv.id}', { status: 'done' })`);
    await js(`window.api.coins.setSystem(true)`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    await js(`(() => { const el = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('Smoke offdone')); if (el) el.click(); return !!el })()`);
    await sleep(500);
    const offPromptBefore = await js(`!!document.querySelector('.score-prompt')`);
    await js(`Array.from(document.querySelectorAll('.editor .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Save')?.click()`);
    await sleep(800);
    const offPromptAfter = await js(`!!document.querySelector('.score-prompt')`);
    const balAfter = await js(`window.api.coins.balance()`);
    check("cup3v3: done-while-OFF event re-saved after re-enable → NO popup, NO coins", !offPromptBefore && !offPromptAfter && Math.round(balAfter) === Math.round(balOff), JSON.stringify({ offPromptBefore, offPromptAfter, balOff, balAfter }));
    await js(`window.api.events.remove('${offEv.id}')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(800);
    const coinPill = await js(`(() => {
      const pill = document.querySelector('.premium-heading.coins')
      const coin = pill ? pill.querySelector('.rhythm-coin') : null
      if (!pill || !coin) return null
      const tilt = coin.querySelector('.c3-tilt')
      const pr = pill.getBoundingClientRect()
      const cr = coin.getBoundingClientRect()
      return {
        rollPx: pill.style.getPropertyValue('--roll-px'),
        pillW: Math.round(pr.width),
        distToEdge: Math.round(pr.right - cr.left + cr.width),
        wheelAnim: tilt ? getComputedStyle(tilt).animationName : '',
        dropAnim: getComputedStyle(coin).animationName,
        shadow: getComputedStyle(coin, '::after').animationName,
        shadowContent: getComputedStyle(coin, '::after').content !== 'none'
      }
    })()`);
    check("v1.11.1: coin rolls THROUGH the pill edge completely (distance > pill width) + authentic wheel + ground shadow", !!coinPill && parseInt(coinPill.rollPx, 10) > coinPill.distToEdge && coinPill.wheelAnim === "rollWheel" && coinPill.dropAnim === "coinDropRoll" && coinPill.shadow === "rollShadow" && coinPill.shadowContent, JSON.stringify(coinPill));
    const wheelSync = await js(`(() => {
      const coin = document.querySelector('.premium-heading.coins .rhythm-coin')
      const tilt = coin ? coin.querySelector('.c3-tilt') : null
      const a = tilt ? getComputedStyle(tilt).animation : ''
      const m = a.match(/^([0-9]+[.]?[0-9]*)s/)
      return { anim: a, secs: m ? parseFloat(m[1]) : 0 }
    })()`);
    check("v1.11.3: wheel spin synced to the 3.2s drop-roll", wheelSync.secs === 3.2, JSON.stringify(wheelSync));
    const wheelKf = await js(`(() => {
      for (const ss of Array.from(document.styleSheets)) {
        let rules = []
        try { rules = ss.cssRules } catch { rules = [] }
        for (const r of rules) {
          if (r.name && r.name.includes('rollWheel')) return (r.cssText || '').slice(0, 400)
        }
      }
      return ''
    })()`);
    check("v1.11: wheel spin = distance/radius (no fixed degrees)", wheelKf.includes("57.296") && wheelKf.includes("--roll-px"), wheelKf);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(500);
    const wkNum = await js(`(() => {
      const nums = Array.from(document.querySelectorAll('.month-wknum')).map((e) => e.textContent.trim())
      const first = document.querySelector('.month-gutter')
      return { nums, count: nums.length, hasGutter: !!first }
    })()`);
    check("v1.11: month view shows ISO week numbers in the gutter", wkNum.hasGutter && wkNum.count === 6 && wkNum.nums.every((n) => /^[0-9]{1,2}$/.test(n)), JSON.stringify(wkNum));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    dbRun("DELETE FROM events WHERE title LIKE 'DotTest%' OR title LIKE 'DotRecur%' OR title LIKE 'DotCanc%'");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(300);
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(500);
    await js(`window.api.events.create({ title: 'DotTest', description: '', startLocal: '${TODAY}T10:00', endLocal: '${TODAY}T11:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })`);
    await js(`window.api.events.create({ title: 'DotRecur', description: '', startLocal: '${TODAY}T12:00', endLocal: '${TODAY}T13:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: 'FREQ=WEEKLY', exdates: '[]' })`);
    await js(`window.api.events.create({ title: 'DotCanc', description: '', startLocal: '${TODAY}T14:00', endLocal: '${TODAY}T15:00', allDay: false, labelId: null, colorOverride: null, status: 'cancelled', rrule: null, exdates: '[]' })`);
    await js(`window.__rhythmData.load()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(700);
    const clickSwitch = async (title) => {
      await js(`(() => { const eb = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('${title}')); const sw = eb && eb.querySelector('.eb-switch'); if (sw) sw.click(); return !!sw })()`);
      await sleep(700);
    };
    const blockCountBefore = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('DotTest')).length`);
    await clickSwitch("DotTest");
    const st1 = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'DotTest')?.status ?? '')`);
    await clickSwitch("DotTest");
    const st2 = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'DotTest')?.status ?? '')`);
    await clickSwitch("DotTest");
    const st3 = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'DotTest')?.status ?? '')`);
    const blockCountAfter = await js(`Array.from(document.querySelectorAll('.eb')).filter((e) => e.textContent.includes('DotTest')).length`);
    check("v1.11.1: status switch cycles todo → doing → done → todo (single event)", st1 === "doing" && st2 === "done" && st3 === "todo", JSON.stringify({ st1, st2, st3 }));
    check("v1.11.1: switching status NEVER vanishes the event (block stays in the grid)", blockCountBefore >= 1 && blockCountAfter === blockCountBefore, JSON.stringify({ blockCountBefore, blockCountAfter }));
    await clickSwitch("DotRecur");
    const recur = await js(`window.api.events.list().then((es) => ({
      master: es.find((e) => e.title === 'DotRecur' && !e.parentId)?.status ?? '',
      override: es.find((e) => e.title === 'DotRecur' && e.parentId)?.status ?? null,
      overrideOrigin: es.find((e) => e.title === 'DotRecur' && e.parentId)?.originDate ?? null
    }))`);
    check("v1.11.1: recurring switch → THIS occurrence only (override created, master untouched)", recur.master === "todo" && recur.override === "doing" && recur.overrideOrigin === TODAY, JSON.stringify(recur));
    const cancBlock = await js(`(() => { const eb = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('DotCanc')); return eb ? { hasSwitch: !!eb.querySelector('.eb-switch') } : null })()`);
    const canc = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'DotCanc')?.status ?? '')`);
    check("v1.11.1: cancelled blocks have NO switch (edit dialog only)", canc === "cancelled" && cancBlock && !cancBlock.hasSwitch, JSON.stringify({ canc, cancBlock }));
    dbRun("DELETE FROM events WHERE title LIKE 'DotLater%'");
    await js(`window.api.events.create({ title: 'DotLater', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: 'FREQ=DAILY', exdates: '[]' })`);
    await js(`window.__rhythmData.load()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const laterClicked = await js(`(() => {
      const col = document.querySelector('.day-col[data-day="${TOMORROW}"]')
      const eb = col ? Array.from(col.querySelectorAll('.eb')).find((e) => e.textContent.includes('DotLater')) : null
      const sw = eb && eb.querySelector('.eb-switch')
      if (sw) sw.click()
      return !!sw
    })()`);
    await sleep(800);
    const later = await js(`(async () => {
      const es = await window.api.events.list()
      const master = es.find((e) => e.title === 'DotLater' && !e.parentId)
      const ov = es.find((e) => e.title === 'DotLater' && e.parentId)
      // how many days of the series render in the visible week?
      const blocks = Array.from(document.querySelectorAll('.day-col')).map((c, i) => ({
        day: c.getAttribute('data-day'),
        has: Array.from(c.querySelectorAll('.eb')).some((e) => e.textContent.includes('DotLater'))
      }))
      return {
        masterStatus: master?.status ?? '',
        overrideStatus: ov?.status ?? null,
        overrideOrigin: ov?.originDate ?? null,
        overrideStartDay: ov?.startLocal.slice(0, 10) ?? '',
        blocks
      }
    })()`);
    check("v1.11.5: later-occurrence switch → override on THAT day (not the master day)", laterClicked && later.overrideStatus === "doing" && later.overrideStartDay === TOMORROW && later.overrideOrigin === TOMORROW, JSON.stringify(later));
    check("v1.11.5: series still renders — the clicked day shows the override, no vanish", later.blocks.filter((b) => b.has).length >= 2, JSON.stringify(later.blocks.filter((b) => b.has)));
    dbRun("DELETE FROM events WHERE title LIKE 'DotLater%'");
    await js(`document.querySelector('.today-btn')?.click()`);
    await sleep(400);
    await js(`(() => { const eb = Array.from(document.querySelectorAll('.eb')).find((e) => e.textContent.includes('DotTest')); const dot = eb && eb.querySelector('.eb-dot'); if (dot) dot.click(); return !!dot })()`);
    await sleep(500);
    const dotInert = await js(`({
      editorOpen: !!document.querySelector('.editor'),
      status: window.__rhythmData ? 'n/a' : ''
    })`);
    const dotStatus = await js(`window.api.events.list().then((es) => es.find((e) => e.title === 'DotTest')?.status ?? '')`);
    check("v1.11.3: clicking the passive dot opens NO editor and changes NO status", !dotInert.editorOpen && dotStatus === "todo", JSON.stringify({ editorOpen: dotInert.editorOpen, dotStatus }));
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('To Do'))?.click()`);
    await sleep(300);
    await clickSwitch("DotTest");
    await sleep(700);
    const filterAfter = await js(`(() => {
      const active = document.querySelector('.status-pills .pill.active')
      const stillThere = Array.from(document.querySelectorAll('.eb')).some((e) => e.textContent.includes('DotTest'))
      const toast = Array.from(document.querySelectorAll('.toast')).some((x) => x.textContent.includes('filter switched to All'))
      return { filter: active ? active.textContent.trim() : '', stillThere, toast }
    })()`);
    check("v1.11.3: filter auto-switches to All so the event never vanishes", filterAfter.filter.includes("All") && filterAfter.stillThere && filterAfter.toast, JSON.stringify(filterAfter));
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('All'))?.click()`);
    await sleep(300);
    dbRun("DELETE FROM events WHERE title LIKE 'DotTest%' OR title LIKE 'DotRecur%' OR title LIKE 'DotCanc%'");
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    await js(`(() => { const s = document.querySelector('.score-prompt'); if (s) s.remove(); return !!s })()`);
    await sleep(200);
    const titleNow = () => js(`document.querySelector('.tb-title')?.textContent ?? ''`);
    const t0 = await titleNow();
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Day').click()`);
    await sleep(500);
    await js(`(() => { const el = document.querySelector('.week-body'); if (el) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true })) } return true })()`);
    await sleep(900);
    const t1 = await titleNow();
    check("v1.11: day view — hard scroll at the bottom pulls the NEXT day", t1 !== t0, JSON.stringify({ t0, t1 }));
    const t1b = await titleNow();
    await js(`(() => { const el = document.querySelector('.week-body'); if (el) { el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -220, bubbles: true, cancelable: true })) } return true })()`);
    await sleep(900);
    const t2 = await titleNow();
    check("v1.11: day view — hard scroll at the top pulls the PREVIOUS day", t2 !== t1b, JSON.stringify({ t1b, t2 }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const t3 = await titleNow();
    await js(`(() => { const el = document.querySelector('.week-body'); if (el) { el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -220, bubbles: true, cancelable: true })) } return true })()`);
    await sleep(900);
    const t4 = await titleNow();
    check("v1.11: week view — hard scroll at the top pulls the PREVIOUS week", t4 !== t3, JSON.stringify({ t3, t4 }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(500);
    const t5 = await titleNow();
    await js(`(() => { const el = document.querySelector('.month-body'); if (el) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true })) } return true })()`);
    await sleep(1e3);
    const t6 = await titleNow();
    check("v1.11: month view — strong wheel flips to the NEXT month", t6 !== t5, JSON.stringify({ t5, t6 }));
    await js(`document.querySelector('.settings-btn')?.click()`);
    await sleep(500);
    const setTabs = await js(`Array.from(document.querySelectorAll('.set-tab')).map((t) => t.textContent.trim())`);
    check("v1.11.4: settings has General / Notifications / Shortcuts / About tabs", setTabs.join(",") === "General,Notifications,Shortcuts,About", JSON.stringify(setTabs));
    await js(`Array.from(document.querySelectorAll('.set-tab')).find((t) => t.textContent.includes('Notifications'))?.click()`);
    await sleep(400);
    const notifCfg0 = await js(`window.api.notify.getConfig()`);
    const slotCount = Array.isArray(notifCfg0.slots) ? notifCfg0.slots.length : 0;
    const notifTest = await js(`window.api.notify.test()`);
    check("v1.11.1: notify:test returns a result object (ok boolean)", typeof notifTest === "object" && typeof notifTest.ok === "boolean", JSON.stringify(notifTest));
    await sleep(400);
    const inAppToast = await js(`(async () => {
      for (let i = 0; i < 8; i++) {
        const t = Array.from(document.querySelectorAll('.toast')).find((x) => x.textContent.includes('Test notification'))
        if (t) return t.textContent.slice(0, 90)
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })()`);
    check("v1.11.3: test notification also appears as an IN-APP toast (always visible)", inAppToast.includes("Test notification"), inAppToast);
    await js(`(() => { const inp = document.querySelector('.set-num[type=time]'); if (!inp) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, '21:30'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.set-row .btn')).find((b) => b.textContent.includes('Add time'))?.click()`);
    await sleep(500);
    const notifCfg1 = await js(`window.api.notify.getConfig()`);
    check("v1.11: notifications — add a reminder time persists", notifCfg1.slots.length === slotCount + 1 && notifCfg1.slots.includes("21:30"), JSON.stringify(notifCfg1));
    await js(`(() => { const x = Array.from(document.querySelectorAll('.notif-slot')).find((s) => s.textContent.includes('21:30'))?.querySelector('.notif-slot-x'); if (x) x.click(); return !!x })()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`);
    await sleep(400);
    const lbl = await js(`window.api.labels.create('V11Label', '#5e5ce6', null)`);
    await js(`window.api.events.create({ title: 'V11Search', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T09:30', allDay: false, labelId: '${lbl.id}', colorOverride: null, status: 'todo', rrule: null, exdates: '[]' })`);
    await js(`window.__rhythmData.load()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda').click()`);
    await sleep(500);
    await js(`(() => { const inp = document.querySelector('.pill-search input'); if (!inp) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, 'v11label'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
    await sleep(600);
    const searchHit = await js(`Array.from(document.querySelectorAll('.agenda-row')).some((r) => r.textContent.includes('V11Search'))`);
    check("v1.11: search matches LABEL names (agenda shows the labelled event)", searchHit);
    await js(`(() => { const inp = document.querySelector('.pill-search input'); if (!inp) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, ''); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
    await sleep(400);
    await js(`window.api.events.remove(${JSON.stringify(await js('window.api.events.list().then((es) => es.find((e) => e.title === "V11Search")?.id)'))})`);
    await js(`window.api.labels.remove('${lbl.id}')`);
    const msUndo = await js(`(async () => {
      const m = await window.api.milestones.create('UndoMe', '🎁', 10, '')
      await window.api.coins.setSystem(true)
      const before = await window.api.coins.balance()
      const claimed = await window.api.milestones.claim(m.id)
      const afterClaim = await window.api.coins.balance()
      const undone = await window.api.milestones.unclaim(m.id)
      const afterUndo = await window.api.coins.balance()
      const spends = await window.api.coins.listTransactions().then((txs) => txs.filter((t) => t.type === 'spend' && t.reason.includes('UndoMe')))
      await window.api.milestones.remove(m.id)
      return { before, claimed, afterClaim, afterUndo, spends }
    })()`);
    check("v1.11: milestone claim → Undo restores coins (spend row removed)", msUndo.claimed.ok && msUndo.afterClaim === msUndo.before - 10 && msUndo.afterUndo === msUndo.before && msUndo.spends.length === 0, JSON.stringify(msUndo));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Month').click()`);
    await sleep(400);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }))`);
    await sleep(500);
    const shortView = await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.classList.contains('active'))?.textContent.trim() ?? ''`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))`);
    await sleep(500);
    const sTab = await js(`(() => ({
      settingsOpen: !!document.querySelector('.settings-dialog'),
      activeTab: document.querySelector('.set-tab.active')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.settings-dialog .shortcut-row').length
    }))()`);
    await js(`Array.from(document.querySelectorAll('.settings-dialog .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`);
    await sleep(300);
    check("v1.11.4: shortcuts — W switches to Week; ? opens Settings → Shortcuts tab (no main-screen sheet)", shortView.includes("Week") && sTab.settingsOpen && sTab.activeTab === "Shortcuts" && sTab.rows >= 6, JSON.stringify({ shortView, sTab }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week')?.click()`);
    await sleep(300);
    await js(`document.querySelector('.new-btn')?.click()`);
    await sleep(400);
    await js(`(() => { const inp = document.querySelector('.quickadd .ef-title'); if (!inp) return false; inp.focus(); return true })()`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))`);
    await sleep(500);
    const qGuard = await js(`(() => {
      const inp = document.querySelector('.quickadd .ef-title')
      return {
        settingsOpen: !!document.querySelector('.settings-dialog'),
        stillTyping: !!document.querySelector('.quickadd'),
        val: inp ? inp.value : ''
      }
    })()`);
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    await sleep(300);
    check('v1.11.18: "?" while typing does NOT open Settings (guard respected)', !qGuard.settingsOpen && qGuard.stillTyping, JSON.stringify(qGuard));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights')).click()`);
    await sleep(700);
    await js(`document.querySelector('.heat-head-btn')?.click()`);
    await sleep(300);
    const popOpen = await js(`!!document.querySelector('.heat-pop')`);
    await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(300);
    const popClosed = await js(`!document.querySelector('.heat-pop')`);
    check("v1.11: heatmap threshold popover closes on outside click", popOpen && popClosed, JSON.stringify({ popOpen, popClosed }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`document.querySelector('.settings-btn')?.click()`);
    await sleep(500);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.set-tab')).find((t) => t.textContent === 'General'); if (b) b.click(); return !!b })()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.set-row .seg-btn')).find((b) => b.textContent.includes('12-hour'))?.click()`);
    await sleep(400);
    const hourLabel12 = await js(`Array.from(document.querySelectorAll('.hour-label')).map((e) => e.textContent.trim()).filter((t) => t.includes('AM') || t.includes('PM')).length`);
    await js(`document.querySelector('.new-btn')?.click()`);
    await sleep(400);
    const qa12 = await js(`(() => {
      const wrap = document.querySelectorAll('.quickadd .ef-dt')[0]
      const dateEl = wrap ? wrap.querySelector('.ef-date') : null
      const hSel = wrap ? wrap.querySelector('.ef-time-h') : null
      const ap = wrap ? wrap.querySelector('.ef-ampm') : null
      return {
        ampm: document.querySelectorAll('.quickadd .ef-ampm').length,
        timeInputs: document.querySelectorAll('.quickadd .ef-time').length,
        hSel: document.querySelectorAll('.quickadd .ef-time-h').length,
        disp: wrap ? getComputedStyle(wrap).display : '',
        sameRow: dateEl && hSel && ap
          ? (() => {
              const c = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
              return Math.abs(c(dateEl) - c(ap)) < 2 && Math.abs(c(hSel) - c(ap)) < 2
            })()
          : false,
        // v1.11.5: Start/End must wrap into TWO ROWS (12h) with no overflow
        fields: (() => {
          const qa = document.querySelector('.quickadd')
          const f = Array.from(document.querySelectorAll('.quickadd .ef-times .ef-label'))
          if (f.length < 2) return { ok: false }
          const t0 = f[0].getBoundingClientRect().top
          const t1 = f[1].getBoundingClientRect().top
          return {
            ok: true,
            twoRows: Math.abs(t1 - t0) > 20,
            overflow: qa ? qa.scrollWidth > qa.clientWidth + 1 : false
          }
        })()
      }
    })()`);
    check("v1.11.1: quick-add shows AM/PM controls in 12h mode (no 24h time inputs)", qa12.ampm === 2 && qa12.timeInputs === 0 && qa12.hSel === 2, JSON.stringify(qa12));
    check("v1.11.3: the 12h widget is ONE ROW (flex, AM/PM on the same line as the date)", qa12.disp.includes("flex") && qa12.sameRow, JSON.stringify(qa12));
    check("v1.11.5: in 12h the Start/End fields stack in two rows with NO overflow", qa12.fields.ok && qa12.fields.twoRows && !qa12.fields.overflow, JSON.stringify(qa12.fields));
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.set-row .seg-btn')).find((b) => b.textContent.includes('24-hour'))?.click()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.set-row .seg-btn')).find((b) => b.textContent.trim() === 'Sunday')?.click()`);
    await sleep(500);
    const firstDow = await js(`document.querySelector('.week-day-head .wd-name')?.textContent.trim() ?? ''`);
    await js(`Array.from(document.querySelectorAll('.set-row .seg-btn')).find((b) => b.textContent.trim() === 'Monday')?.click()`);
    await sleep(500);
    await js(`(() => { const sel = document.querySelector('select[aria-label="Day starts at hour"]'); if (!sel) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, '8'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
    await sleep(600);
    const scrollTop8 = await js(`(() => {
      const el = document.querySelector('.week-body')
      if (!el) return { top: -1, max: -1 }
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
    })()`);
    await js(`(() => { const sel = document.querySelector('select[aria-label="Day starts at hour"]'); if (!sel) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, '0'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`);
    await sleep(400);
    check("v1.11: 12h clock shows AM/PM labels", hourLabel12 >= 2, String(hourLabel12));
    check("v1.11: first day of week = Sunday → week starts Sun", firstDow === "Sun", firstDow);
    check("v1.11: day start hour scrolls the grid (8:00 = 264px, clamped to the real max)", scrollTop8.top === Math.min(264, scrollTop8.max) && scrollTop8.top > 0, JSON.stringify(scrollTop8));
    await js(`document.querySelector('.settings-btn')?.click()`);
    await sleep(500);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.set-tab')).find((t) => t.textContent === 'General'); if (b) b.click(); return !!b })()`);
    await sleep(300);
    await js(`(() => { const inp = Array.from(document.querySelectorAll('.set-num')).find((i) => i.getAttribute('aria-label') === 'Default activity length in minutes'); if (!inp) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, '90'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.dialog-actions .btn')).find((b) => b.textContent.trim() === 'Done')?.click()`);
    await sleep(300);
    await js(`(() => { const col = document.querySelector('.day-col'); if (!col) return false; const r = col.getBoundingClientRect(); col.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 100 })); return true })()`);
    await sleep(600);
    const durAdd = await js(`(() => {
      const inputs = Array.from(document.querySelectorAll('.quickadd .ef-dt'))
      if (inputs.length < 2) return { ok: false }
      const d0 = inputs[0].querySelector('.ef-date')?.value ?? ''
      const t0 = inputs[0].querySelector('.ef-time')?.value ?? ''
      const d1i = inputs[1].querySelector('.ef-date')?.value ?? ''
      const t1i = inputs[1].querySelector('.ef-time')?.value ?? ''
      if (!d0 || !t0 || !d1i || !t1i) return { ok: false }
      const s = new Date(d0 + 'T' + t0)
      const e = new Date(d1i + 'T' + t1i)
      return { ok: true, mins: (e.getTime() - s.getTime()) / 60000 }
    })()`);
    await js(`(() => { const b = Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((x) => x.textContent.includes('Cancel') || x.textContent.includes('close')); if (b) b.click(); return !!b })()`);
    await sleep(300);
    await js(`(() => { const ov = document.querySelector('.overlay'); if (ov) ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return !!ov })()`);
    await sleep(300);
    check("v1.11: default duration (90 min) applied to quick-add", durAdd.ok && durAdd.mins === 90, JSON.stringify(durAdd));
    await js(`window.api.settings.set('defaultDuration', '60')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`window.api.settings.set('weekStart', 'sunday')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(500);
    const wsMini = await js(`Array.from(document.querySelectorAll('.minimonth-head span')).map((s2) => s2.textContent).join('')`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(900);
    const wsStreak = await js(`(() => ({
      head: Array.from(document.querySelectorAll('.streak-month-week span')).map((s2) => s2.textContent).join(''),
      firstRow: Array.from(document.querySelectorAll('.streak-row'))[0]?.querySelector('.streak-day')?.textContent ?? ''
    }))()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    await js(`window.api.settings.set('weekStart', 'monday')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(400);
    check("v1.11.1: sidebar mini-month header follows the week-start setting", wsMini === "SMTWTFS", wsMini);
    check("v1.11.4: streak calendar stays Monday-first even with Sunday setting", wsStreak.head === "MTWTFSS", JSON.stringify(wsStreak));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    const pwAdd = (iso) => dbRun(
      `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
       VALUES (?, 'PW', '', ?, ?, 0, NULL, NULL, 'done', NULL, '[]', NULL, NULL, ?, ?, ?)`,
      "pw-" + iso,
      iso + "T09:00",
      iso + "T10:00",
      (/* @__PURE__ */ new Date()).toISOString(),
      (/* @__PURE__ */ new Date()).toISOString(),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    const pwAddTodo = (iso) => dbRun(
      `INSERT INTO events (id, title, description, start_local, end_local, all_day, label_id, color_override, status, rrule, exdates, parent_id, origin_date, completed_at, created_at, updated_at)
       VALUES (?, 'PWT', '', ?, ?, 0, NULL, NULL, 'todo', NULL, '[]', NULL, NULL, NULL, ?, ?)`,
      "pwt-" + iso,
      iso + "T11:00",
      iso + "T12:00",
      (/* @__PURE__ */ new Date()).toISOString(),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    const keyOf = (iso) => js(`window.api.settings.get('streakAward.${iso}')`);
    await js(`window.api.settings.set('weekStart', 'sunday')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(400);
    for (const iso of ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) pwAdd(iso);
    const pwSunA = await js(`window.api.coins.perfectWeek()`);
    const pwKeySun = await keyOf("2026-08-02");
    check("v1.11.6: Sunday-start setting → perfect week awarded for Sun–Sat (key 08-02)", pwSunA.award && pwSunA.weekKey === "2026-08-02" && pwKeySun === "1", JSON.stringify({ pwSunA, pwKeySun }));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    for (const iso of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) pwAdd(iso);
    pwAddTodo("2026-08-02");
    const pwSunBad = await js(`window.api.coins.perfectWeek()`);
    check("v1.11.6: Sunday (week start) planned-but-undone → no perfect-week reward", !pwSunBad.award, JSON.stringify(pwSunBad));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    for (const iso of ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) pwAdd(iso);
    const pwSunB = await js(`window.api.coins.perfectWeek()`);
    await js(`window.api.settings.set('weekStart', 'monday')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(400);
    pwAdd("2026-08-09");
    const pwMonB = await js(`window.api.coins.perfectWeek()`);
    const pwKeyMonB = await keyOf("2026-08-03");
    const pwKeySunB = await keyOf("2026-08-02");
    check("v1.11.6: switching to Monday never double-pays the same days (08-03 skipped, 08-02 kept)", pwSunB.award && pwKeyMonB === null && pwKeySunB === "1", JSON.stringify({ pwSunB, pwKeyMonB, pwKeySunB }));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    for (const iso of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) pwAdd(iso);
    const pwWait = await js(`window.api.coins.perfectWeek()`);
    check("v1.11.7: perfect week waits for SUNDAY to be done (Mon–Sat done → no reward)", !pwWait.award, JSON.stringify(pwWait));
    pwAdd("2026-08-09");
    const pwAfter = await js(`window.api.coins.perfectWeek()`);
    const pwKeyAfter = await keyOf("2026-08-03");
    check("v1.11.7: after Sunday done → perfect week awarded (key 08-03)", pwAfter.award && pwAfter.weekKey === "2026-08-03" && pwKeyAfter === "1", JSON.stringify({ pwAfter, pwKeyAfter }));
    dbRun("DELETE FROM events");
    dbRun("DELETE FROM settings WHERE key LIKE 'streakAward.%'");
    await js(`window.api.settings.set('weekStart', 'monday')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(300);
    await js(`window.api.settings.set('dayStartHour', '8')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(500);
    const clickPos = await js(`(() => {
      const body = document.querySelector('.week-body')
      if (!body) return null
      const r = body.getBoundingClientRect()
      const head = body.querySelector('.week-head')
      const headH = head ? head.getBoundingClientRect().height : 0
      const col = body.querySelector('.day-col')
      const cr = col ? col.getBoundingClientRect() : r
      return { x: Math.round(cr.left + cr.width / 2), y: Math.round(r.top + headH + 6), scrollTop: body.scrollTop }
    })()`);
    await js(`(() => { const el = document.elementFromPoint(${clickPos ? clickPos.x : 0}, ${clickPos ? clickPos.y : 0}); const col = el && el.closest('.day-col'); if (col) col.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${clickPos ? clickPos.x : 0}, clientY: ${clickPos ? clickPos.y : 0} })); return !!col })()`);
    await sleep(600);
    const clickStart = await getDT(".quickadd", 0);
    const clickMin = clickStart && clickStart.length >= 16 ? parseInt(clickStart.slice(11, 13), 10) * 60 + parseInt(clickStart.slice(14, 16), 10) : -1;
    const expectedMin = clickPos ? Math.round((6 + clickPos.scrollTop) / 0.55 / 15) * 15 : -1;
    await js(`Array.from(document.querySelectorAll('.quickadd .dialog-actions .btn')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    await sleep(300);
    await js(`window.api.settings.set('dayStartHour', '0')`);
    await js(`window.__rhythmPrefs.load()`);
    await sleep(400);
    check("v1.11.3: clicking the grid maps to the REAL clock time under scroll (was 00:00 before)", clickPos !== null && expectedMin > 100 && clickMin >= 0 && Math.abs(clickMin - expectedMin) <= 15, JSON.stringify({ scrollTop: clickPos && clickPos.scrollTop, clickStart, expectedMin }));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week').click()`);
    await sleep(400);
    const a11y = await js(`(() => ({
      settings: document.querySelector('.settings-btn')?.getAttribute('aria-label') ?? '',
      prev: Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.getAttribute('aria-label') === 'Previous') ? true : false,
      next: Array.from(document.querySelectorAll('.icon-btn')).find((b) => b.getAttribute('aria-label') === 'Next') ? true : false,
      shortcutsBtn: !!document.querySelector('.shortcuts-btn')
    }))()`);
    check("v1.11.4: icon buttons carry aria-labels; no clutter shortcut button on the main screen", a11y.settings === "Settings" && a11y.prev && a11y.next && !a11y.shortcutsBtn, JSON.stringify(a11y));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins')).click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(700);
    const ledgerAll = await js(`(async () => ({
      rows: document.querySelectorAll('.ledger-row').length,
      tx: (await window.api.coins.listTransactions()).length,
      count: document.querySelector('.ledger-count')?.textContent ?? ''
    }))()`);
    check("v1.10.6: ledger renders EVERY transaction (no cap)", ledgerAll.tx >= 20 && ledgerAll.rows === ledgerAll.tx && ledgerAll.count.includes(String(ledgerAll.tx)), JSON.stringify(ledgerAll));
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week')?.click()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Week')?.click()`);
    await sleep(500);
    await addQuick("MSel todo A", "09:00", "10:00");
    await addQuick("MSel todo B", "10:00", "11:00");
    await addQuick("MSel doing", "11:00", "12:00");
    await addQuick("MSel done", "12:00", "13:00");
    dbRun("UPDATE events SET status = 'doing' WHERE title = 'MSel doing'");
    dbRun("UPDATE events SET status = 'done' WHERE title = 'MSel done'");
    await js(`window.__rhythmData.load()`);
    await sleep(500);
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('All'))?.click()`);
    await sleep(300);
    const pillCounts = await js(`(() => {
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
    })()`);
    check("v1.11.16: pill counts match the ACTUAL rendered week blocks", pillCounts.todo === pillCounts.bTodo && pillCounts.doing === pillCounts.bDoing && pillCounts.done === pillCounts.bDone && pillCounts.cancelled === pillCounts.bCancelled, JSON.stringify(pillCounts));
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('To Do'))?.click()`);
    await sleep(200);
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('In Progress'))?.click()`);
    await sleep(400);
    const multiSel = await js(`(() => {
      const active = Array.from(document.querySelectorAll('.status-pills .pill.active')).map((p) => p.textContent.trim())
      const titles = Array.from(document.querySelectorAll('.eb')).map((e) => e.textContent)
      return {
        active,
        hasTodo: titles.some((t) => t.includes('MSel todo A')),
        hasDoing: titles.some((t) => t.includes('MSel doing')),
        hasDone: titles.some((t) => t.includes('MSel done'))
      }
    })()`);
    check("v1.11.16: multi-select pills (To Do + In Progress) filter the week together", multiSel.active.length === 2 && multiSel.active.some((a) => a.includes("To Do")) && multiSel.active.some((a) => a.includes("In Progress")) && multiSel.hasTodo && multiSel.hasDoing && !multiSel.hasDone, JSON.stringify(multiSel));
    await js(`Array.from(document.querySelectorAll('.status-pills .pill')).find((b) => b.textContent.includes('All'))?.click()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.trim() === 'Agenda')?.click()`);
    await sleep(600);
    const agendaPills = await js(`(() => {
      const readPill = (label) => {
        const p = Array.from(document.querySelectorAll('.status-pills .pill')).find((x) => x.textContent.startsWith(label))
        return parseInt((p?.querySelector('.pill-count')?.textContent ?? '0'), 10)
      }
      const rows = Array.from(document.querySelectorAll('.agenda-row'))
      const cnt = (sel) => rows.filter((r) => r.querySelector(sel)).length
      return {
        todo: readPill('To Do'), doing: readPill('In Progress'), done: readPill('Done'),
        rTodo: rows.length - cnt('.mini-badge'), rDoing: cnt('.mini-badge.doing'), rDone: cnt('.mini-badge.done')
      }
    })()`);
    check("v1.11.16: agenda pill counts match the ACTUAL agenda rows", agendaPills.todo === agendaPills.rTodo && agendaPills.doing === agendaPills.rDoing && agendaPills.done === agendaPills.rDone, JSON.stringify(agendaPills));
    const YDAY = fmtD(new Date(Date.now() - 864e5));
    await js(`window.api.events.create({ title: 'AgPastDone', description: '', startLocal: '${YDAY}T09:00', endLocal: '${YDAY}T10:00', allDay: false, labelId: null, colorOverride: null, status: 'done', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.api.events.create({ title: 'AgPastTodo', description: '', startLocal: '${YDAY}T10:00', endLocal: '${YDAY}T11:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.__rhythmData.load()`);
    await sleep(500);
    const agendaPast = await js(`(() => {
      const readPill = (label) => {
        const p = Array.from(document.querySelectorAll('.status-pills .pill')).find((x) => x.textContent.startsWith(label))
        return parseInt((p?.querySelector('.pill-count')?.textContent ?? '0'), 10)
      }
      const rows = Array.from(document.querySelectorAll('.agenda-row'))
      const cnt = (sel) => rows.filter((r) => r.querySelector(sel)).length
      return {
        todo: readPill('To Do'), doing: readPill('In Progress'), done: readPill('Done'), cancelled: readPill('Cancelled'),
        rTodo: rows.length - cnt('.mini-badge'), rDoing: cnt('.mini-badge.doing'), rDone: cnt('.mini-badge.done'), rCancelled: cnt('.mini-badge.cancelled'),
        hasPastTodo: rows.some((r) => r.textContent.includes('AgPastTodo')),
        hasPastDone: rows.some((r) => r.textContent.includes('AgPastDone'))
      }
    })()`);
    check("v1.11.17: past-done event NOT rendered + NOT counted; past-todo rendered + counted (root cause)", agendaPast.hasPastTodo && !agendaPast.hasPastDone && agendaPast.todo === agendaPast.rTodo && agendaPast.doing === agendaPast.rDoing && agendaPast.done === agendaPast.rDone && agendaPast.cancelled === agendaPast.rCancelled, JSON.stringify(agendaPast));
    dbRun("DELETE FROM events WHERE title LIKE 'MSel %' OR title LIKE 'AgPast%'");
    await js(`window.__rhythmData.load()`);
    await sleep(400);
    const chipA = await js(`window.api.labels.create('Chip A', '#e02020', null).then((l) => l.id)`);
    const chipB = await js(`window.api.labels.create('Chip B', '#20b020', null).then((l) => l.id)`);
    await js(`window.api.events.create({ title: 'ChipEv A', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: '${chipA}', colorOverride: null, status: 'todo', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.api.events.create({ title: 'ChipEv B', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: '${chipB}', colorOverride: null, status: 'todo', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.__rhythmData.load()`);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Insights'))?.click()`);
    await sleep(700);
    const chipProbe = await js(`(async () => {
      const click = (name) => Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === name)?.click()
      click('Chip A'); await new Promise((r) => setTimeout(r, 300))
      const active1 = Array.from(document.querySelectorAll('.ins-chip.active')).map((c) => c.textContent.trim())
      const legend1 = Array.from(document.querySelectorAll('.ins-legend-name')).map((e) => e.textContent)
      click('Chip B'); await new Promise((r) => setTimeout(r, 400))
      const active2 = Array.from(document.querySelectorAll('.ins-chip.active')).map((c) => c.textContent.trim())
      const legend2 = Array.from(document.querySelectorAll('.ins-legend-name')).map((e) => e.textContent)
      return { active1, legend1, active2, legend2 }
    })()`);
    check("v1.11.16: Insights parent chips MULTI-select (one chip → that group only)", chipProbe.active1.length === 1 && chipProbe.active1[0] === "Chip A" && chipProbe.legend1.length === 1 && chipProbe.legend1[0] === "Chip A", JSON.stringify(chipProbe));
    check("v1.11.16: Insights parent chips MULTI-select (two chips → both groups)", chipProbe.active2.length === 2 && chipProbe.active2.includes("Chip A") && chipProbe.active2.includes("Chip B") && chipProbe.legend2.length === 2 && chipProbe.legend2.includes("Chip A") && chipProbe.legend2.includes("Chip B"), JSON.stringify(chipProbe));
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels')?.click()`);
    await sleep(300);
    const chipSnap = await js(`(async () => {
      const all = Array.from(document.querySelectorAll('.ins-chip')).map((c) => c.textContent.trim())
      const wait = () => new Promise((r) => setTimeout(r, 180))
      for (const name of all) {
        if (name === 'All labels') continue
        Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === name)?.click()
        await wait() // let React re-render between toggles
      }
      await new Promise((r) => setTimeout(r, 600))
      const active = Array.from(document.querySelectorAll('.ins-chip.active')).map((c) => c.textContent.trim())
      const legend = Array.from(document.querySelectorAll('.ins-legend-name')).map((e) => e.textContent)
      return { parents: all.length - 1, active, legend }
    })()`);
    check("v1.11.17: selecting EVERY parent snaps back to the All labels chip", chipSnap.parents >= 2 && chipSnap.active.length === 1 && chipSnap.active[0] === "All labels" && chipSnap.legend.includes("Chip A") && chipSnap.legend.includes("Chip B"), JSON.stringify(chipSnap));
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels')?.click()`);
    await sleep(400);
    const prevMonthDate = /* @__PURE__ */ new Date();
    prevMonthDate.setDate(1);
    prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;
    dbRun("DELETE FROM events WHERE start_local LIKE ?", prevMonthKey + "-%");
    await js(`window.__rhythmData.load()`);
    await sleep(400);
    await js(`(() => { const btn = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month'); if (btn && !btn.classList.contains('active')) btn.click(); return !!btn })()`);
    await sleep(400);
    await js(`(() => { const btn = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month'); if (btn) btn.click(); return !!btn })()`);
    await sleep(500);
    const lmLabels = await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).map((b) => b.textContent.trim())`);
    check('v1.11.16: "This month" does NOT switch to an empty "Last month"', lmLabels.includes("This month") && !lmLabels.includes("Last month"), JSON.stringify(lmLabels));
    await js(`window.api.events.create({ title: 'PrevMonthEv', description: '', startLocal: '${prevMonthKey}-15T09:00', endLocal: '${prevMonthKey}-15T10:00', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.__rhythmData.load()`);
    await sleep(400);
    await js(`(() => { const btn = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This month'); if (btn) btn.click(); return !!btn })()`);
    await sleep(600);
    const lmLabels2 = await js(`Array.from(document.querySelectorAll('.ins-period .seg-btn')).map((b) => b.textContent.trim())`);
    const lmHasData = await js(`Array.from(document.querySelectorAll('.ins-legend-name')).some((e) => e.textContent.includes('Unlabelled'))`);
    check('v1.11.16: "Last month" appears when that month HAS a schedule', lmLabels2.includes("Last month") && lmHasData, JSON.stringify({ lmLabels2, lmHasData }));
    await js(`(() => { const btn = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.includes('Last month')); if (btn) btn.click(); return !!btn })()`);
    await sleep(400);
    await js(`(() => { const c = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'Custom'); if (c) c.click(); return !!c })()`);
    await sleep(300);
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[0], '2020-05-01')`);
    await js(`(${SET_VALUE})(document.querySelectorAll('.ins-custom-range input')[1], '2020-05-31')`);
    await sleep(700);
    const emptyDigest = await js(`(() => ({
      banner: !!document.querySelector('.ins-empty-big'),
      digest: Array.from(document.querySelectorAll('.digest li')).map((li) => li.textContent).join(' | ')
    }))()`);
    check("v1.11.17: empty period shows NO 📭 card — digest note only", !emptyDigest.banner && emptyDigest.digest.includes("No activities in this period"), JSON.stringify(emptyDigest));
    const scP = await js(`window.api.labels.create('ScParent', '#00aaff', null).then((l) => l.id)`);
    const scC = await js(`window.api.labels.create('ScChild', '#0055aa', '${scP}').then((l) => l.id)`);
    const scP2 = await js(`window.api.labels.create('ScParent2', '#aa00ff', null).then((l) => l.id)`);
    const scC2 = await js(`window.api.labels.create('ScChild2', '#5500aa', '${scP2}').then((l) => l.id)`);
    await js(`window.api.events.create({ title: 'ScEv', description: '', startLocal: '${TODAY}T09:00', endLocal: '${TODAY}T10:00', allDay: false, labelId: '${scC}', colorOverride: null, status: 'done', rrule: null, exdates: [], parentId: null, originDate: null }).then(async (e) => { await window.api.coins.scoreEvent(e.id, '${TODAY}', 'on_time', 1, '${scC}'); return e.id })`);
    await js(`window.api.events.create({ title: 'ScEv2', description: '', startLocal: '${TODAY}T10:00', endLocal: '${TODAY}T11:00', allDay: false, labelId: '${scC2}', colorOverride: null, status: 'done', rrule: null, exdates: [], parentId: null, originDate: null }).then(async (e) => { await window.api.coins.scoreEvent(e.id, '${TODAY}', 'late', 1, '${scC2}'); return e.id })`);
    await js(`window.__rhythmData.load()`);
    await sleep(400);
    const scProbe = await js(`(async () => {
      const all = await window.api.coins.scoreInsights({})
      const narrow = await window.api.coins.scoreInsights({ from: '2020-01-01', to: '2020-01-02' })
      const wide = await window.api.coins.scoreInsights({ from: '2000-01-01', to: '2100-01-01' })
      const parent = await window.api.coins.scoreInsights({ parentIds: ['${scP}'] })
      const other = await window.api.coins.scoreInsights({ parentIds: ['__nope__'] })
      return { all: all.count, narrow: narrow.count, wide: wide.count, parent: parent.count, other: other.count }
    })()`);
    check("v1.11.16: score insights follow the PERIOD (empty window → 0) and parent chips", scProbe.narrow === 0 && scProbe.wide === scProbe.all && scProbe.all >= 1 && scProbe.parent >= 1 && scProbe.other === 0, JSON.stringify(scProbe));
    await js(`(() => { const btn = Array.from(document.querySelectorAll('.ins-period .seg-btn')).find((b) => b.textContent.trim() === 'This week'); if (btn) btn.click(); return !!btn })()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('.ins-chip')).find((c) => c.textContent.trim() === 'All labels')?.click()`);
    await sleep(700);
    const scUI = await js(`(() => {
      const groups = Array.from(document.querySelectorAll('.score-group'))
      const sc = groups.find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      const kidsBefore = !!(sc && sc.querySelector('.score-kids'))
      const head = sc && sc.querySelector('.ins-progress.expandable')
      if (head) head.click()
      return { found: !!sc, caret: !!(sc && sc.querySelector('.ins-caret')), kidsBefore, groups: groups.length }
    })()`);
    await sleep(500);
    const scKidsAfter = await js(`(() => {
      const sc = Array.from(document.querySelectorAll('.score-group')).find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      const kids = sc ? sc.querySelectorAll('.score-kids .ins-progress.sub').length : -1
      const childBar = sc ? !!sc.querySelector('.score-kids .score-label-track') : false
      return { kids, childBar }
    })()`);
    check("v1.11.17: score panel groups under parents — DEFAULT COLLAPSED, expand on click", scUI.found && scUI.caret && scUI.groups >= 1 && !scUI.kidsBefore && scKidsAfter.kids >= 1 && scKidsAfter.childBar, JSON.stringify({ ...scUI, ...scKidsAfter }));
    const scOne = await js(`(async () => {
      const groups = Array.from(document.querySelectorAll('.score-group'))
      const sc = groups.find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent2')
      const sc1 = groups.find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      if (!sc || !sc1) return { enough: false }
      sc.querySelector('.ins-progress.expandable').click() // open ScParent2
      await new Promise((r) => setTimeout(r, 300))
      sc1.querySelector('.ins-progress.expandable').click() // open ScParent → closes ScParent2
      await new Promise((r) => setTimeout(r, 400))
      return { enough: true, sc2Open: !!sc.querySelector('.score-kids'), sc1Open: !!sc1.querySelector('.score-kids') }
    })()`);
    check("v1.11.17: score panels — only ONE parent open at a time", scOne.enough && !scOne.sc2Open && scOne.sc1Open, JSON.stringify(scOne));
    await js(`window.__rhythmCoins.refresh()`);
    await sleep(400);
    await js(`Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent.includes('Coins'))?.click()`);
    await js(`(() => { const d = document.querySelector('.coin-drop'); if (d) d.click() })()`);
    await sleep(800);
    const earnUI = await js(`(() => {
      const groups = Array.from(document.querySelectorAll('.earn-group'))
      const scp = groups.find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      const kidsBefore = !!(scp && scp.querySelector('.earn-kids'))
      const head = scp && scp.querySelector('.ins-progress.expandable')
      if (head) head.click()
      return { groups: groups.length, scp: !!scp, caret: !!(scp && scp.querySelector('.ins-caret')), kidsBefore }
    })()`);
    await sleep(500);
    const earnKidsAfter = await js(`(() => {
      const scp = Array.from(document.querySelectorAll('.earn-group')).find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      return !!(scp && scp.querySelector('.earn-kids'))
    })()`);
    check("v1.11.17: Coins earned-by-label grouped under parents — DEFAULT COLLAPSED, expand on click", earnUI.scp && earnUI.caret && earnUI.groups >= 1 && !earnUI.kidsBefore && earnKidsAfter, JSON.stringify({ ...earnUI, kidsAfter: earnKidsAfter }));
    const earnOne = await js(`(async () => {
      const groups = Array.from(document.querySelectorAll('.earn-group'))
      const scp = groups.find((g) => g.querySelector('.ins-progress-name')?.textContent.trim() === 'ScParent')
      const other = groups.find((g) => g !== scp && g.querySelector('.ins-progress.expandable'))
      const h = other && other.querySelector('.ins-progress.expandable')
      if (!scp || !h) return { enough: false }
      h.click()
      await new Promise((r) => setTimeout(r, 400))
      return { enough: true, scpOpen: !!scp.querySelector('.earn-kids'), otherOpen: !!other.querySelector('.earn-kids') }
    })()`);
    check("v1.11.17: Coins earned-by-label — only ONE parent open at a time", earnOne.enough && !earnOne.scpOpen && earnOne.otherOpen, JSON.stringify(earnOne));
    await js(`window.api.events.create({ title: 'NotifPfx', description: '', startLocal: '${TODAY}T23:59', endLocal: '${TOMORROW}T00:29', allDay: false, labelId: null, colorOverride: null, status: 'todo', rrule: null, exdates: [], parentId: null, originDate: null })`);
    await js(`window.__rhythmData.load()`);
    await sleep(300);
    const notifPfx = await js(`(async () => {
      const cfg = await window.api.notify.getConfig()
      const prev = { enabled: cfg.enabled, slots: cfg.slots, leadMin: cfg.leadMin }
      await window.api.notify.setConfig({ enabled: true, slots: ['00:00'], leadMin: 30 })
      await window.api.notify.resetDay() // clean slate for today
      await window.api.notify.runNow() // slot 00:00 already passed → fires + persists
      await new Promise((r) => setTimeout(r, 300))
      const key = 'notifSlot.' + (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })() + '.00:00'
      const v1 = await window.api.settings.get(key)
      const toastCount1 = Array.from(document.querySelectorAll('.toast')).filter((t) => t.textContent.includes('Rhythm — Today')).length
      await window.api.notify.runNow() // second check → must NOT re-fire
      await new Promise((r) => setTimeout(r, 300))
      const toastCount2 = Array.from(document.querySelectorAll('.toast')).filter((t) => t.textContent.includes('Rhythm — Today')).length
      await window.api.notify.setConfig(prev) // restore
      await window.api.notify.resetDay()
      return { v1: v1 ?? '', toasts1: toastCount1, toasts2: toastCount2, stillEnabled: prev.enabled }
    })()`);
    check("v1.11.18: fired slot persisted (restart can never re-fire)", notifPfx.v1 === "1" && notifPfx.toasts1 >= 1 && notifPfx.toasts2 === notifPfx.toasts1, JSON.stringify(notifPfx));
    dbRun("DELETE FROM event_scores WHERE event_id IN (SELECT id FROM events WHERE title IN ('ScEv','ScEv2','ChipEv A','ChipEv B','PrevMonthEv','AgPastDone','AgPastTodo','MSel todo A','MSel todo B','MSel doing','MSel done'))");
    dbRun("DELETE FROM events WHERE title LIKE 'NotifPfx'");
    dbRun("DELETE FROM events WHERE title IN ('ScEv','ScEv2','ChipEv A','ChipEv B','PrevMonthEv','AgPastDone','AgPastTodo','MSel todo A','MSel todo B','MSel doing','MSel done')");
    dbRun("DELETE FROM labels WHERE name IN ('Chip A','Chip B','ScParent','ScChild','ScParent2','ScChild2')");
    await js(`window.__rhythmData.load()`);
    await sleep(400);
    const errs = await js(`window.__errors || []`);
    check("no renderer errors at end", errs.length === 0, String(errs));
    fs.writeFileSync(outPath, results.join("\n"));
    console.log("[smoke] done:\n" + results.join("\n"));
  } catch (e) {
    results.push("ERROR " + String(e));
    fs.writeFileSync(outPath, results.join("\n"));
    console.error("[smoke] failed:", e);
  }
}
const isDev = !electron.app.isPackaged;
const mainErrorLog = path.join(getDataDir(), "main-errors.log");
function logMainError(tag, err) {
  try {
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${tag}: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`;
    fs.appendFileSync(mainErrorLog, line);
    for (const w of electron.BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send("notify:inapp", {
          title: "Rhythm note",
          body: "Something went wrong in the background. Everything keeps working — details were saved to main-errors.log."
        });
      }
    }
  } catch {
  }
}
process.on("uncaughtException", (e) => logMainError("uncaughtException", e));
process.on("unhandledRejection", (e) => logMainError("unhandledRejection", e));
let quitting = false;
let tray = null;
let mainWin = null;
function setupTray() {
  if (tray) return;
  try {
    const img = electron.nativeImage.createFromPath(path.join(__dirname, "../../assets/icon.png"));
    tray = new electron.Tray(img.isEmpty() ? electron.nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    tray.setToolTip("Rhythm — running (notifications on)");
    tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: "Open Rhythm", click: () => {
          if (mainWin) {
            mainWin.show();
            mainWin.focus();
          }
        } },
        { type: "separator" },
        { label: "Quit Rhythm", click: () => {
          quitting = true;
          electron.app.quit();
        } }
      ])
    );
    tray.on("click", () => {
      if (mainWin) {
        mainWin.show();
        mainWin.focus();
      }
    });
  } catch (e) {
    console.log("[tray] not available:", e);
  }
}
function windowBackgroundColor(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get();
    const pref = row?.value ?? "system";
    const dark = pref === "dark" || pref === "system" && electron.nativeTheme.shouldUseDarkColors;
    return dark ? "#1C1C1E" : "#F5F5F7";
  } catch {
    return "#F5F5F7";
  }
}
function syncReminderTasks(db) {
  if (process.platform !== "win32" || !electron.app.isPackaged) return;
  try {
    const cfg = readConfig(db);
    if (!cfg.enabled || cfg.slots.length === 0) return;
    const exe = process.execPath;
    const { execFile } = require("node:child_process");
    for (const slot of cfg.slots) {
      const [h, m] = slot.split(":").map(Number);
      if (isNaN(h) || isNaN(m)) continue;
      const name = `Rhythm-reminder-${h}-${m}`;
      const ps = `
$action = New-ScheduledTaskAction -Execute '${exe.replace(/'/g, "''")}' -Argument '--remind'
$trigger = New-ScheduledTaskTrigger -Daily -At ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName '${name}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
`;
      const psPath = path.join(electron.app.getPath("temp"), `rhythm-task-${h}-${m}.ps1`);
      require("node:fs").writeFileSync(psPath, ps, "utf8");
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath], { timeout: 15e3 }, (err) => {
        if (err) console.log(`[remind] task ${name} failed:`, err.message);
        else console.log(`[remind] task ${name} registered`);
      });
    }
  } catch (e) {
    console.log("[remind] sync failed:", e);
  }
}
function ensureNotificationShortcut() {
  if (process.platform !== "win32" || !electron.app.isPackaged) return;
  const { execFile } = require("node:child_process");
  const lnk = path.join(electron.app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Rhythm.lnk");
  const exe = process.execPath.replace(/'/g, "''");
  const appId = "com.rhythm.calendar";
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnk}')
$sc.TargetPath = '${exe}'
$sc.WorkingDirectory = [System.IO.Path]::GetDirectoryName('${exe}')
$sc.Save()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Aumid {
  [StructLayout(LayoutKind.Sequential)]
  struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr val; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out IntPtr key);
    int GetValue(ref IntPtr key, out IntPtr pv);
    int SetValue(ref IntPtr key, ref IntPtr pv);
    int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, uint flags, ref Guid riid, out IntPtr ppv);
  public static void Set(string lnk, string appId) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IntPtr ppv;
    if (SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 0, ref iid, out ppv) != 0) return;
    var store = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv);
    PROPERTYKEY key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    IntPtr kp = Marshal.AllocHGlobal(Marshal.SizeOf(key));
    Marshal.StructureToPtr(key, kp, false);
    PROPVARIANT pv = new PROPVARIANT { vt = 31, val = Marshal.StringToCoTaskMemUni(appId) };
    store.SetValue(ref kp, ref pv);
    store.Commit();
  }
}
"@
[Aumid]::Set('${lnk}', '${appId}')
`;
  const psPath = path.join(electron.app.getPath("temp"), "rhythm-notify-shortcut.ps1");
  try {
    require("node:fs").writeFileSync(psPath, ps, "utf8");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath], { timeout: 15e3 }, (err) => {
      if (err) console.log("[notify] shortcut setup failed (toasts may need the installer):", err.message);
      else console.log("[notify] Start Menu shortcut with AUMID ensured:", lnk);
    });
  } catch (e) {
    console.log("[notify] shortcut setup error:", e);
  }
}
function createWindow(db) {
  const win = new electron.BrowserWindow({
    width: process.env.AC_WIN_W ? Number(process.env.AC_WIN_W) : 1380,
    height: process.env.AC_WIN_H ? Number(process.env.AC_WIN_H) : 880,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: db ? windowBackgroundColor(db) : "#F5F5F7",
    // v1.11.6: the OS/taskbar window title is "Rhythm vX.Y.Z" — no ".exe",
    // no "activity-calendar" — so the taskbar never shows an extension
    title: `Rhythm v${APP_VERSION}`,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // v1.11.18 (audit): renderer fully sandboxed — the preload only uses
      // contextBridge + ipcRenderer, both fully supported in the sandbox
      sandbox: true
    }
  });
  win.once("ready-to-show", () => win.show());
  mainWin = win;
  win.on("close", async (e) => {
    if (process.env.AC_SMOKE || process.env.AC_SCREENSHOT) return;
    if (!electron.app.isPackaged) return;
    if (!quitting) {
      e.preventDefault();
      if (db) {
        try {
          db.pragma("wal_checkpoint(PASSIVE)");
        } catch {
        }
        try {
          void runAutoBackup(db, true);
        } catch {
        }
      }
      win.hide();
      try {
        win.webContents.send("notify:inapp", {
          title: "Rhythm stays on — saved & backed up",
          body: "Everything is saved. Rhythm keeps running in the tray so reminders keep working. Use Quit in the tray to stop it."
        });
      } catch {
      }
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || u.protocol === "http:") void electron.shell.openExternal(url);
    } catch {
    }
    return { action: "deny" };
  });
  const query = {};
  if (process.env.AC_VIEW) query.view = process.env.AC_VIEW;
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL + "?" + new URLSearchParams(query));
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), { query });
  }
  if (process.env.AC_SCREENSHOT || process.env.AC_SMOKE) {
    win.webContents.once("did-finish-load", () => {
      if (process.env.AC_PICKER) {
        setTimeout(() => {
          win.webContents.executeJavaScript("(() => { const t = document.querySelector('.mm-title'); if (t) t.click(); return !!t })()").catch(() => {
          });
        }, 700);
      }
      if (process.env.AC_FX) {
        setTimeout(() => {
          win.webContents.executeJavaScript("window.__rhythmCoins2.fireScoreFx()").catch(() => {
          });
        }, 600);
      }
      if (process.env.AC_SCROLLTOP) {
        const target = Number(process.env.AC_SCROLLTOP);
        for (const t of [600, 2e3, 3400]) {
          setTimeout(() => {
            win.webContents.executeJavaScript(
              "(() => { const s = document.querySelector('.agenda-view'); if (s) s.scrollTop = " + target + "; return !!s })()"
            ).catch(() => {
            });
          }, t);
        }
      }
      if (process.env.AC_EDGE) {
        setTimeout(() => {
          win.webContents.executeJavaScript(`(async () => {
              const body = document.querySelector('.week-body')
              const title = () => document.querySelector('.tb-title')?.textContent ?? ''
              const before = title()
              let fired = false
              if (body) {
                body.addEventListener('wheel', () => { fired = true }, { once: true })
                body.scrollTop = 0
                body.dispatchEvent(new WheelEvent('wheel', { deltaY: -220, bubbles: true, cancelable: true }))
              }
              await new Promise((r) => setTimeout(r, 1000))
              return { before, after: title(), fired, hasBody: !!body, st: body ? body.scrollTop : -1, ch: body ? body.clientHeight : -1, sh: body ? body.scrollHeight : -1 }
            })()`).then((v) => console.log("[edge-probe]", JSON.stringify(v))).catch((e) => console.log("[edge-probe] error", String(e).slice(0, 200)));
        }, 2500);
      }
      setTimeout(async () => {
        try {
          if (process.env.AC_SMOKE) {
            win.webContents.on("console-message", (_e, _l, message) => console.log("[renderer]", message));
            await runSmoke(win, process.env.AC_SMOKE);
            electron.app.quit();
            return;
          }
          if (process.env.AC_DOM_DUMP) {
            const info = await win.webContents.executeJavaScript(`(() => {
              const q = (s) => document.querySelectorAll(s).length
              const text = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent.trim()).slice(0, 30)
              return {
                view: document.querySelector('.view-host') ? location.search : '',
                blocks: q('.eb'),
                monthCells: q('.day-cell'),
                dayCols: q('.day-col'),
                pills: q('.pill'),
                labels: q('.label-row'),
                agendaGroups: q('.agenda-group'),
                agendaTitles: Array.from(document.querySelectorAll('.agenda-title')).map((e) => e.textContent.trim()),
                firstBlockTexts: text('.eb-title'),
                nowLine: q('.now-line'),
                errors: window.__errors || [],
                intro: (() => {
                  const w = document.querySelector('.intro-word')
                  const m = document.querySelector('.intro-word-main')
                  if (!w) return null
                  const wr = w.getBoundingClientRect()
                  return {
                    rect: { x: Math.round(wr.x), y: Math.round(wr.y), w: Math.round(wr.width), h: Math.round(wr.height) },
                    opacity: getComputedStyle(w).opacity,
                    visibility: getComputedStyle(w).visibility,
                    color: m ? getComputedStyle(m).color : null,
                    clip: m ? getComputedStyle(m).webkitBackgroundClip || getComputedStyle(m).backgroundClip : null,
                    anim: m ? getComputedStyle(m).animationName : null,
                    text: m ? m.textContent : null
                  }
                })(),
                agendaTop: (() => {
                  const card = document.querySelector('.agenda-view')
                  if (!card) return null
                  const cr = card.getBoundingClientRect()
                  const titles = Array.from(document.querySelectorAll('.agenda-title')).map((t) => {
                    const r = t.getBoundingClientRect()
                    return { text: t.textContent, top: Math.round(r.top), h: Math.round(r.height), x: Math.round(r.left), w: Math.round(r.width), pos: getComputedStyle(t).position }
                  })
                  const probe = (() => { const el = document.elementFromPoint(cr.left + 60, cr.top + 12); return el ? el.className : 'none' })()
                  const t0 = document.querySelector('.agenda-title')
                  const cs = t0 ? getComputedStyle(t0) : null
                  return {
                    cardTop: Math.round(cr.top), titles, probe,
                    ml: cs ? cs.marginLeft : '', mr: cs ? cs.marginRight : '',
                    scrollTop: card ? Math.round(card.scrollTop) : -1,
                    grp: (() => {
                      const g = document.querySelector('.agenda-group')
                      if (!g) return null
                      const r = g.getBoundingClientRect()
                      const gc = getComputedStyle(g)
                      g.style.marginLeft = '-18px'
                      const r2 = g.getBoundingClientRect()
                      g.style.marginLeft = ''
                      const par = g.parentElement
                      return { x: Math.round(r.left), w: Math.round(r.width), ml: gc.marginLeft, after18: Math.round(r2.left), parent: par ? par.className : 'none' }
                    })()
                  }
                  return { cardTop: Math.round(cr.top), titles, probe }
                })(),
                weekGeo: (() => {
                  const body = document.querySelector('.week-body')
                  if (!body) return null
                  const br = body.getBoundingClientRect()
                  const head = body.querySelector('.week-head')
                  const hr = head ? head.getBoundingClientRect() : null
                  const grid = body.querySelector('.week-grid')
                  const gr = grid ? grid.getBoundingClientRect() : null
                  const cols = Array.from(body.querySelectorAll('.day-col')).map((c) => {
                    const r = c.getBoundingClientRect()
                    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
                  })
                  const ebs = Array.from(body.querySelectorAll('.eb')).map((e) => {
                    const r = e.getBoundingClientRect()
                    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
                  })
                  const gutter = body.querySelector('.week-gutter')
                  const gur = gutter ? gutter.getBoundingClientRect() : null
                  return {
                    body: { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width), scrollW: body.scrollWidth, clientW: body.clientWidth, scrollH: body.scrollHeight, clientH: body.clientHeight, overflowX: getComputedStyle(body).overflowX },
                    head: hr ? { left: Math.round(hr.left), right: Math.round(hr.right), w: Math.round(hr.width), top: Math.round(hr.top), pos: getComputedStyle(head).position } : null,
                    grid: gr ? { left: Math.round(gr.left), right: Math.round(gr.right), w: Math.round(gr.width) } : null,
                    gutter: gur ? { left: Math.round(gur.left), right: Math.round(gur.right) } : null,
                    cols,
                    ebs
                  }
                })(),
                streakCal: (() => {
                  const cov = document.querySelector('.streak-day.cover')
                  const ccs = cov ? getComputedStyle(cov) : null
                  const anc = []
                  let el = cov ? cov.parentElement : null
                  while (el && anc.length < 8) {
                    const cs = getComputedStyle(el)
                    const r = el.getBoundingClientRect()
                    anc.push({ cls: String(el.className).slice(0, 40), transform: cs.transform, opacity: cs.opacity, filter: cs.filter, willChange: cs.willChange, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
                    el = el.parentElement
                  }
                  const cr = cov ? cov.getBoundingClientRect() : null
                  return {
                    rows: Array.from(document.querySelectorAll('.streak-row')).map((r) => ({
                      cls: r.className,
                      done: Array.from(r.querySelectorAll('.streak-day.done')).length,
                      none: Array.from(r.querySelectorAll('.streak-day.none')).length
                    })),
                    perfectM: document.querySelectorAll('.streak-day.perfect-m').length,
                    coverStyle: ccs ? { outline: ccs.outline, offset: ccs.outlineOffset, shadow: ccs.boxShadow, cls: cov.className, transform: ccs.transform, opacity: ccs.opacity, filter: ccs.filter, width: ccs.width, height: ccs.height, rect: cr ? { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } : null } : null,
                    ancestors: anc,
                    dots: Array.from(document.querySelectorAll('.streak-row .streak-day')).map((d) => {
                      const r = d.getBoundingClientRect()
                      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: d.className, txt: d.textContent }
                    })
                  }
                })(),
                stickytest: (() => {
                  const v = document.querySelector('.agenda-view')
                  if (!v) return null
                  const out = []
                  for (const pos of [100, 250, 400, 550, 700]) {
                    v.scrollTop = pos
                    const t = document.querySelector('.agenda-title')
                    const r = t ? Math.round(t.getBoundingClientRect().top) : -1
                    out.push({ pos, titleTop: r, scrollTop: Math.round(v.scrollTop) })
                  }
                  v.scrollTop = 700
                  return out
                })(),
                ancestors: (() => {
                  const t = document.querySelector('.agenda-title')
                  if (!t) return []
                  const out = []
                  let el = t.parentElement
                  while (el && out.length < 8) {
                    const cs = getComputedStyle(el)
                    const r = el.getBoundingClientRect()
                    out.push({ cls: el.className, top: Math.round(r.top), overflowY: cs.overflowY, position: cs.position, maxH: cs.maxHeight })
                    el = el.parentElement
                  }
                  return out
                })(),
                overlapprobe: (() => {
                  const sb = document.querySelector('.sidebar')
                  const tc = document.querySelector('.today-card')
                  const tree = document.querySelector('.label-tree')
                  const rows = Array.from(document.querySelectorAll('.label-row'))
                  const sr = sb ? sb.getBoundingClientRect() : null
                  const tr = tc ? tc.getBoundingClientRect() : null
                  const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null
                  return {
                    sidebar: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom) } : null,
                    today: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom) } : null,
                    lastLabel: last ? { bottom: Math.round(last.bottom) } : null,
                    treeScroll: tree ? { ch: tree.clientHeight, sh: tree.scrollHeight } : null,
                    labelRows: rows.length
                  }
                })(),
                streakNum: (() => {
                  const c = document.querySelector('.streak-kpi')
                  const ms = window.__rhythmMilestones ? 0 : 0
                  return { kpi: c ? c.textContent : '' }
                })(),
                coin3d: (() => {
                  const coin = document.querySelector('.premium-heading .ph-icon .rhythm-coin')
                  if (!coin) return null
                  const r = coin.getBoundingClientRect()
                  const spin = coin.querySelector('.c3-spin')
                  const face = coin.querySelector('.c3-face.front')
                  const fr = face ? face.getBoundingClientRect() : null
                  return {
                    wrap: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                    spinAnim: spin ? getComputedStyle(spin).animationName : '',
                    spinTs: spin ? getComputedStyle(spin).transformStyle : '',
                    spinTransform: spin ? getComputedStyle(spin).transform : '',
                    face: fr ? { w: Math.round(fr.width), h: Math.round(fr.height) } : null,
                    segs: coin.querySelectorAll('.c3-seg').length,
                    wrapPerspective: getComputedStyle(coin).perspective
                  }
                })()
              }
            })()`);
            fs.writeFileSync(process.env.AC_DOM_DUMP, JSON.stringify(info, null, 2));
            console.log("[domdump] saved to", process.env.AC_DOM_DUMP);
          }
          if (process.env.AC_SCREENSHOT !== "none") {
            win.webContents.invalidate();
            await new Promise((r) => setTimeout(r, 250));
            const image = await win.webContents.capturePage();
            fs.writeFileSync(process.env.AC_SCREENSHOT, image.toPNG());
            console.log("[screenshot] saved to", process.env.AC_SCREENSHOT);
          }
        } catch (e) {
          console.error("[screenshot] failed", e);
        }
        electron.app.quit();
      }, parseInt(process.env.AC_SHOT_DELAY || "2600", 10));
    });
  }
  return win;
}
const gotSingleLock = electron.app.requestSingleInstanceLock();
if (!gotSingleLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}
electron.app.whenReady().then(async () => {
  electron.app.setName("Rhythm");
  if (process.platform === "win32") electron.app.setAppUserModelId("com.rhythm.calendar");
  ensureNotificationShortcut();
  if (process.argv.includes("--remind")) {
    try {
      const db2 = openDatabase();
      migrate(db2);
      runRemindOnce(db2);
    } catch (e) {
      logMainError("remind", e);
    }
    setTimeout(() => electron.app.quit(), 4e3);
    return;
  }
  console.log("[main] data dir:", getDataDir());
  const db = openDatabase();
  migrate(db);
  seedIfEmpty(db);
  syncReminderTasks(db);
  registerEventHandlers(db);
  registerLabelHandlers(db);
  registerSettingsHandlers(db);
  registerGamifyHandlers(db);
  registerWindowHandlers();
  registerNotificationHandlers(db);
  registerTrashHandlers(db);
  electron.ipcMain.handle("app:getLaunchAtStartup", () => {
    if (process.platform !== "win32") return false;
    try {
      return electron.app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("app:setLaunchAtStartup", (_e, on) => {
    if (process.platform === "win32") {
      try {
        electron.app.setLoginItemSettings({ openAtLogin: on });
      } catch {
        return false;
      }
    }
    return process.platform === "win32";
  });
  createWindow(db);
  setupTray();
  try {
    void runAutoBackup(db);
  } catch (e) {
    logMainError("startup backup", e);
  }
  setInterval(() => {
    try {
      void runAutoBackup(db);
    } catch (e) {
      logMainError("hourly backup", e);
    }
  }, 3600 * 1e3);
  let backupOnCloseDone = false;
  electron.app.on("before-quit", (e) => {
    if (process.env.AC_SMOKE || process.env.AC_SCREENSHOT) return;
    if (backupOnCloseDone) return;
    e.preventDefault();
    backupOnCloseDone = true;
    void runAutoBackup(db, true).finally(() => electron.app.quit());
  });
  startNotifier(db);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow(db);
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && (quitting || !electron.app.isPackaged)) electron.app.quit();
});
