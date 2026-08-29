// Database layer: libSQL (@libsql/client). Works two ways from the SAME code:
//   • Local:  a file DB at data/attendance.db  (when DATABASE_URL is unset)
//   • Cloud:  a hosted Turso database          (when DATABASE_URL is set)
// libSQL speaks SQLite, so the schema/queries are identical in both modes.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const CLOUD = !!process.env.DATABASE_URL;
let url = process.env.DATABASE_URL;
if (!url) {
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = 'file:' + path.join(dataDir, 'attendance.db');
}
const authToken = process.env.DATABASE_AUTH_TOKEN;
const db = createClient(authToken ? { url, authToken } : { url });

// ---- thin async helpers (mirror better-sqlite3's get/all/run) ----
async function get(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows[0]; }
async function all(sql, args = []) { const r = await db.execute({ sql, args }); return r.rows; }
async function run(sql, args = []) { return db.execute({ sql, args }); }
async function batch(stmts) { return db.batch(stmts, 'write'); }

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

async function columnExists(table, col) {
  const rows = (await db.execute(`PRAGMA table_info(${table})`)).rows;
  return rows.some(r => r.name === col);
}
async function ensureColumn(table, col, ddl) {
  if (!(await columnExists(table, col))) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
async function seedSetting(key, value) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) await run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

async function init() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS employees (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      grace_minutes INTEGER NOT NULL DEFAULT 5,
      consent_at    TEXT,
      created_at    TEXT NOT NULL,
      photo         TEXT
    );
    CREATE TABLE IF NOT EXISTS face_samples (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      descriptor  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      weekday     INTEGER NOT NULL,
      is_working  INTEGER NOT NULL DEFAULT 0,
      start_time  TEXT,
      end_time    TEXT,
      PRIMARY KEY (employee_id, weekday)
    );
    CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,
      ts             TEXT NOT NULL,
      local_date     TEXT NOT NULL,
      match_distance REAL,
      photo          TEXT,
      liveness       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(local_date);
    CREATE INDEX IF NOT EXISTS idx_events_emp ON events(employee_id, local_date);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migrations for pre-existing local databases.
  await ensureColumn('employees', 'photo', 'photo TEXT');
  await ensureColumn('events', 'photo', 'photo TEXT');
  await ensureColumn('events', 'liveness', 'liveness TEXT');

  // Seeds (only if absent). ADMIN_PIN env overrides the default 1234 on first run.
  const envPin = process.env.ADMIN_PIN && /^\d{4,8}$/.test(process.env.ADMIN_PIN) ? process.env.ADMIN_PIN : '1234';
  await seedSetting('admin_pin_hash', sha256(envPin));
  await seedSetting('liveness_enabled', '1');
  await seedSetting('liveness_challenges', '2');
  // White-label company name shown on the kiosk + admin. Editable in admin Settings.
  await seedSetting('brand_name', process.env.BRAND_NAME || 'Attendance Kiosk');
}

module.exports = { db, get, all, run, batch, sha256, init, CLOUD };
