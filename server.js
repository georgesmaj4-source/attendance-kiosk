// Attendance kiosk server — Express + libSQL. Runs locally (file DB) or in the
// cloud (Turso via DATABASE_URL). Photos are stored inline in the DB so nothing
// depends on a local disk that a cloud host would wipe.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { get, all, run, batch, sha256, init, CLOUD } = require('./db');
const L = require('./logic');

const app = express();
app.use(express.json({ limit: '8mb' }));

// Wrap async route handlers so rejections become clean 500s.
const A = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server error.' });
});

function nowIso() { return new Date().toISOString(); }

// Validate an incoming image data URL (kept inline in the DB as a small thumbnail).
function sanitizePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  if (!/^data:image\/(png|jpe?g);base64,/.test(dataUrl)) return null;
  if (dataUrl.length > 700000) return null; // ~500 KB decoded cap
  return dataUrl;
}

// ---------- admin auth ----------
const validTokens = new Set(); // in-memory; cleared on restart (re-login required)
async function checkPin(pin) {
  const row = await get('SELECT value FROM settings WHERE key = ?', ['admin_pin_hash']);
  return row && row.value === sha256(pin);
}
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (token && validTokens.has(token)) return next();
  res.status(401).json({ error: 'Not authorized. Please log in.' });
}
async function getSetting(key, def) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : def;
}
async function livenessConfig() {
  return {
    enabled: (await getSetting('liveness_enabled', '1')) === '1',
    challenges: Math.max(1, Math.min(2, parseInt(await getSetting('liveness_challenges', '2'), 10) || 2)),
  };
}

// ---------- shared writes ----------
async function upsertSchedule(employeeId, schedule) {
  const stmts = [];
  for (let wd = 0; wd < 7; wd++) {
    const s = (schedule && schedule[wd]) || {};
    stmts.push({
      sql: `INSERT INTO schedules (employee_id, weekday, is_working, start_time, end_time)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(employee_id, weekday) DO UPDATE SET
              is_working=excluded.is_working, start_time=excluded.start_time, end_time=excluded.end_time`,
      args: [employeeId, wd, s.is_working ? 1 : 0, s.start_time || null, s.end_time || null],
    });
  }
  await batch(stmts);
}
async function addSamples(employeeId, samples) {
  const stmts = (samples || [])
    .filter((d) => Array.isArray(d) && d.length === 128)
    .map((d) => ({ sql: 'INSERT INTO face_samples (employee_id, descriptor, created_at) VALUES (?, ?, ?)', args: [employeeId, JSON.stringify(d), nowIso()] }));
  if (stmts.length) await batch(stmts);
}

// ========================= KIOSK API (open) =========================
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/kiosk/config', A(async (req, res) => {
  const lv = await livenessConfig();
  res.json({ liveness: lv.enabled, challenges: lv.challenges, brand: await getSetting('brand_name', 'Attendance Kiosk') });
}));

app.post('/api/kiosk/identify', A(async (req, res) => {
  const match = await L.identify(req.body.descriptor);
  if (!match) return res.json({ matched: false });
  const { date } = L.localParts();
  const state = await L.currentState(match.employee.id, date);
  res.json({
    matched: true,
    employee: { id: match.employee.id, name: match.employee.name },
    state, suggested: L.nextActionFor(state),
    confidence: +(1 - match.distance).toFixed(3),
  });
}));

app.post('/api/kiosk/event', A(async (req, res) => {
  const { type, descriptor, photo, liveness } = req.body || {};
  if (!L.TYPES.includes(type)) return res.status(400).json({ error: 'Invalid action.' });

  const match = await L.identify(descriptor);
  if (!match) return res.json({ ok: false, reason: 'no_match', message: 'Face not recognized. Please try again or see your manager.' });

  const emp = match.employee;
  const now = new Date();
  const { date, time } = L.localParts(now);
  const state = await L.currentState(emp.id, date);

  const check = L.validateTransition(state, type);
  if (!check.ok) return res.json({ ok: false, reason: 'bad_transition', employee: emp, message: check.error, state });

  const lvCfg = await livenessConfig();
  if (lvCfg.enabled && !(liveness && liveness.passed)) {
    return res.json({ ok: false, reason: 'liveness', employee: emp,
      message: 'Liveness check required — please complete the on-screen prompts with your real face.' });
  }

  await run(
    'INSERT INTO events (employee_id, type, ts, local_date, match_distance, photo, liveness) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [emp.id, type, now.toISOString(), date, match.distance, sanitizePhoto(photo), liveness ? JSON.stringify(liveness) : null]
  );

  let statusLine = '';
  if (type === 'clock_in' || type === 'clock_out') {
    const sched = await get('SELECT is_working, start_time, end_time FROM schedules WHERE employee_id = ? AND weekday = ?', [emp.id, now.getDay()]);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (type === 'clock_in' && sched && sched.is_working && sched.start_time) {
      const startMin = L.hhmmToMinutes(sched.start_time);
      if (nowMin < startMin) statusLine = `Early by ${startMin - nowMin} min`;
      else if (nowMin <= startMin + (emp.grace_minutes || 0)) statusLine = 'On time';
      else statusLine = `Late by ${nowMin - startMin} min`;
    } else if (type === 'clock_out' && sched && sched.is_working && sched.end_time) {
      const endMin = L.hhmmToMinutes(sched.end_time);
      if (nowMin < endMin) statusLine = `Left ${endMin - nowMin} min early`;
      else if (nowMin === endMin) statusLine = 'Right on time';
      // Overtime is intentionally NOT shown to the employee on the kiosk —
      // only the manager sees it in the admin report.
    }
  }
  const labels = { clock_in: 'Clocked in', break_start: 'Break started', break_end: 'Back from break', clock_out: 'Clocked out' };
  res.json({ ok: true, employee: emp, type, label: labels[type], time, time12: L.formatClock(time), status: statusLine, confidence: +(1 - match.distance).toFixed(3) });
}));

// ========================= ADMIN API =========================
app.post('/api/admin/login', A(async (req, res) => {
  if (!(await checkPin(String(req.body.pin || '')))) return res.status(401).json({ error: 'Incorrect PIN.' });
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.add(token);
  res.json({ token });
}));

app.get('/api/admin/settings', requireAdmin, A(async (req, res) => {
  const lv = await livenessConfig();
  res.json({ liveness_enabled: lv.enabled, liveness_challenges: lv.challenges, brand_name: await getSetting('brand_name', 'Attendance Kiosk') });
}));
app.post('/api/admin/settings', requireAdmin, A(async (req, res) => {
  const { liveness_enabled, liveness_challenges, brand_name } = req.body || {};
  if (liveness_enabled != null) await run('UPDATE settings SET value = ? WHERE key = ?', [liveness_enabled ? '1' : '0', 'liveness_enabled']);
  if (liveness_challenges != null) {
    const n = Math.max(1, Math.min(2, parseInt(liveness_challenges, 10) || 2));
    await run('UPDATE settings SET value = ? WHERE key = ?', [String(n), 'liveness_challenges']);
  }
  if (brand_name != null) {
    const name = String(brand_name).trim().slice(0, 40) || 'Attendance Kiosk';
    await run('UPDATE settings SET value = ? WHERE key = ?', [name, 'brand_name']);
  }
  res.json({ ok: true });
}));

app.post('/api/admin/change-pin', requireAdmin, A(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
  await run('UPDATE settings SET value = ? WHERE key = ?', [sha256(pin), 'admin_pin_hash']);
  res.json({ ok: true });
}));

app.get('/api/admin/employees', requireAdmin, A(async (req, res) => {
  const emps = await all('SELECT id, name, active, grace_minutes, consent_at, created_at, photo FROM employees ORDER BY active DESC, name');
  const out = [];
  for (const e of emps) {
    const sc = await get('SELECT COUNT(*) c FROM face_samples WHERE employee_id = ?', [e.id]);
    const schedule = await all('SELECT weekday, is_working, start_time, end_time FROM schedules WHERE employee_id = ? ORDER BY weekday', [e.id]);
    out.push({
      id: Number(e.id), name: e.name, active: Number(e.active), grace_minutes: Number(e.grace_minutes),
      consent_at: e.consent_at, photo: e.photo, sample_count: Number(sc.c),
      schedule: schedule.map((s) => ({ weekday: Number(s.weekday), is_working: Number(s.is_working), start_time: s.start_time, end_time: s.end_time })),
    });
  }
  res.json({ employees: out });
}));

app.post('/api/admin/employees', requireAdmin, A(async (req, res) => {
  const { name, grace_minutes, consent, schedule, samples, photo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!consent) return res.status(400).json({ error: 'Employee consent to face enrollment is required.' });
  const valid = (samples || []).filter((d) => Array.isArray(d) && d.length === 128);
  if (valid.length < 1) return res.status(400).json({ error: 'Capture at least one clear face sample.' });

  const r = await run('INSERT INTO employees (name, active, grace_minutes, consent_at, created_at, photo) VALUES (?, 1, ?, ?, ?, ?)',
    [String(name).trim(), Number.isFinite(+grace_minutes) ? +grace_minutes : 5, nowIso(), nowIso(), sanitizePhoto(photo)]);
  const id = Number(r.lastInsertRowid);
  await addSamples(id, valid);
  await upsertSchedule(id, schedule);
  res.json({ ok: true, id });
}));

app.put('/api/admin/employees/:id', requireAdmin, A(async (req, res) => {
  const id = +req.params.id;
  const emp = await get('SELECT * FROM employees WHERE id = ?', [id]);
  if (!emp) return res.status(404).json({ error: 'Not found.' });
  const { name, grace_minutes, active, schedule } = req.body || {};
  await run('UPDATE employees SET name = ?, grace_minutes = ?, active = ? WHERE id = ?', [
    name != null ? String(name).trim() : emp.name,
    Number.isFinite(+grace_minutes) ? +grace_minutes : Number(emp.grace_minutes),
    active != null ? (active ? 1 : 0) : Number(emp.active),
    id,
  ]);
  if (schedule) await upsertSchedule(id, schedule);
  res.json({ ok: true });
}));

app.post('/api/admin/employees/:id/faces', requireAdmin, A(async (req, res) => {
  const id = +req.params.id;
  const emp = await get('SELECT id FROM employees WHERE id = ?', [id]);
  if (!emp) return res.status(404).json({ error: 'Not found.' });
  const { samples, photo, replace } = req.body || {};
  const valid = (samples || []).filter((d) => Array.isArray(d) && d.length === 128);
  if (valid.length < 1) return res.status(400).json({ error: 'No valid face samples.' });
  if (replace) await run('DELETE FROM face_samples WHERE employee_id = ?', [id]);
  await addSamples(id, valid);
  const photoData = sanitizePhoto(photo);
  if (photoData) await run('UPDATE employees SET photo = ? WHERE id = ?', [photoData, id]);
  const c = await get('SELECT COUNT(*) c FROM face_samples WHERE employee_id = ?', [id]);
  res.json({ ok: true, sample_count: Number(c.c) });
}));

app.delete('/api/admin/employees/:id', requireAdmin, A(async (req, res) => {
  const id = +req.params.id;
  if (req.query.hard === '1') {
    await batch([
      { sql: 'DELETE FROM events WHERE employee_id = ?', args: [id] },
      { sql: 'DELETE FROM face_samples WHERE employee_id = ?', args: [id] },
      { sql: 'DELETE FROM schedules WHERE employee_id = ?', args: [id] },
      { sql: 'DELETE FROM employees WHERE id = ?', args: [id] },
    ]);
  } else {
    await run('UPDATE employees SET active = 0 WHERE id = ?', [id]);
  }
  res.json({ ok: true });
}));

app.get('/api/admin/report', requireAdmin, A(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : L.localParts().date;
  res.json(await L.buildDayReport(date));
}));

app.get('/api/admin/report.csv', requireAdmin, A(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : L.localParts().date;
  const report = await L.buildDayReport(date);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const t = (iso) => (iso ? L.formatClock(L.localParts(new Date(iso)).time) : '');
  const statusText = { on_time: 'On time', early: 'Early', late: 'Late', absent: 'Absent', off: 'Day off' };
  const lines = [['Date', 'Employee', 'Scheduled start', 'Arrival', 'Status', 'Early (min)', 'Late (min)', 'Scheduled end', 'Departure', 'Left early (min)', 'Overtime (min)', 'Breaks', 'Break min', 'Worked min'].join(',')];
  for (const r of report.rows) {
    const leftEarly = r.departure_status === 'early' ? r.departure_diff : 0;
    const overtime = r.departure_status === 'over' ? r.departure_diff : 0;
    lines.push([date, r.name, r.scheduled_start || '', t(r.arrival_ts), statusText[r.status] || r.status, r.early_minutes || 0, r.late_minutes || 0, r.scheduled_end || '', t(r.departure_ts), leftEarly, overtime, r.break_count, r.break_minutes, r.worked_minutes == null ? '' : r.worked_minutes].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.csv"`);
  res.send(lines.join('\n'));
}));

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- start ----------
const DATA_DIR = path.join(__dirname, 'data');
const HTTPS_PORT = +(process.env.HTTPS_PORT || 3443);

function lanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) for (const n of nets[name]) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  return ips;
}
async function loadOrCreateCert() {
  const certDir = path.join(DATA_DIR, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'key.pem'), certPath = path.join(certDir, 'cert.pem'), ipsPath = path.join(certDir, 'ips.json');
  const ips = lanIPs();
  const changed = !fs.existsSync(ipsPath) || fs.readFileSync(ipsPath, 'utf8') !== JSON.stringify(ips);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && !changed) return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  const selfsigned = require('selfsigned');
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'attendance-kiosk' }],
    { days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] });
  fs.writeFileSync(keyPath, pems.private); fs.writeFileSync(certPath, pems.cert); fs.writeFileSync(ipsPath, JSON.stringify(ips));
  return { key: pems.private, cert: pems.cert };
}

function start() {
  const PORT = +(process.env.PORT || 3000);
  const ips = lanIPs();

  http.createServer(app).listen(PORT, () => {
    if (CLOUD) {
      console.log(`\n  Attendance kiosk running (cloud mode) on port ${PORT}. HTTPS is handled by the platform.\n`);
      return;
    }
    console.log('\n  Attendance kiosk running (local mode)');
    console.log(`  On this computer:  http://localhost:${PORT}/         (kiosk)`);
    console.log(`                     http://localhost:${PORT}/admin    (admin console)`);
  });

  if (!CLOUD) {
    (async () => {
      try {
        const creds = await loadOrCreateCert();
        https.createServer(creds, app).listen(HTTPS_PORT, () => {
          if (ips.length) {
            console.log('\n  On the iPad / other devices (use HTTPS — required for the camera):');
            for (const ip of ips) console.log(`     https://${ip}:${HTTPS_PORT}/`);
            console.log('     (First visit: accept the self-signed certificate warning — one-time.)');
          }
          console.log('\n  Default admin PIN: 1234  (change it in the admin console → Settings)\n');
        });
      } catch (e) {
        console.warn('\n  [warn] Could not start local HTTPS server:', e.message, '\n');
      }
    })();
  }
}

init().then(start).catch((err) => { console.error('Database init failed:', err); process.exit(1); });
