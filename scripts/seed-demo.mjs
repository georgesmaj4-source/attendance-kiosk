// Seeds a DEMO database with sample employees + realistic attendance so the
// dashboard looks alive for showcasing to prospects.
// Run against the DEMO database only:
//   DATABASE_URL=... DATABASE_AUTH_TOKEN=... node scripts/seed-demo.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (!process.env.DATABASE_URL || !process.env.DATABASE_AUTH_TOKEN) {
  console.error('Set DATABASE_URL and DATABASE_AUTH_TOKEN for the DEMO database.');
  process.exit(1);
}

// db.js reads DATABASE_URL/-TOKEN at require → targets the demo DB; init() builds schema.
const db = require('../db.js');
await db.init();
const { run, batch, sha256 } = db;

const nowIso = () => new Date().toISOString();
const randDesc = () => JSON.stringify(Array.from({ length: 128 }, () => +(Math.random() * 0.4 - 0.2).toFixed(4)));
const pad = (n) => String(n).padStart(2, '0');

// One event at a given local wall-clock time on a given day (local TZ = server TZ).
function mkEvent(empId, dateObj, hhmm, type) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(dateObj);
  d.setHours(hh, mm, Math.floor(Math.random() * 55), 0);
  const local_date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { sql: 'INSERT INTO events (employee_id, type, ts, local_date, match_distance) VALUES (?, ?, ?, ?, ?)', args: [empId, type, d.toISOString(), local_date, +(Math.random() * 0.25).toFixed(3)] };
}
const addMin = (hhmm, delta) => {
  let [h, m] = hhmm.split(':').map(Number); let t = h * 60 + m + delta;
  return `${pad(Math.floor(t / 60))}:${pad(((t % 60) + 60) % 60)}`;
};

const EMPLOYEES = [
  { name: 'Sarah Johnson', start: '09:00', end: '17:00', grace: 5 },
  { name: 'Mike Chen',     start: '09:00', end: '17:00', grace: 5 },
  { name: 'Aisha Rahman',  start: '08:30', end: '16:30', grace: 10 },
  { name: 'David Miller',  start: '09:00', end: '17:00', grace: 5 },
  { name: 'Elena Rossi',   start: '10:00', end: '18:00', grace: 5 },
  { name: 'Omar Haddad',   start: '08:00', end: '16:00', grace: 0 },
];

(async () => {
  // Clean slate (idempotent reseed) + demo settings.
  await batch([
    { sql: 'DELETE FROM events', args: [] },
    { sql: 'DELETE FROM face_samples', args: [] },
    { sql: 'DELETE FROM schedules', args: [] },
    { sql: 'DELETE FROM employees', args: [] },
  ]);
  await run("UPDATE settings SET value = ? WHERE key = 'brand_name'", ['Attendance Kiosk Demo']);
  await run("UPDATE settings SET value = ? WHERE key = 'liveness_enabled'", ['0']); // smooth demos (enable to showcase anti-spoof)
  await run("UPDATE settings SET value = ? WHERE key = 'admin_pin_hash'", [sha256('1234')]); // easy demo PIN

  // Employees + Mon–Fri schedules + 3 (placeholder) face samples each.
  for (const e of EMPLOYEES) {
    const r = await run('INSERT INTO employees (name, active, grace_minutes, consent_at, created_at) VALUES (?, 1, ?, ?, ?)', [e.name, e.grace, nowIso(), nowIso()]);
    e.id = Number(r.lastInsertRowid);
    const stmts = [];
    // Demo staff work every day so "today" always looks populated when showcasing.
    for (let wd = 0; wd < 7; wd++) {
      stmts.push({ sql: 'INSERT INTO schedules (employee_id, weekday, is_working, start_time, end_time) VALUES (?, ?, ?, ?, ?)', args: [e.id, wd, 1, e.start, e.end] });
    }
    for (let i = 0; i < 3; i++) stmts.push({ sql: 'INSERT INTO face_samples (employee_id, descriptor, created_at) VALUES (?, ?, ?)', args: [e.id, randDesc(), nowIso()] });
    await batch(stmts);
  }

  // Today + the previous 5 days (index 0 = today), so the default view is populated.
  const days = []; const cur = new Date(); cur.setHours(0, 0, 0, 0);
  for (let i = 0; i < 6; i++) { days.push(new Date(cur)); cur.setDate(cur.getDate() - 1); }

  const arr = [-18, -6, 2, 9, 14, 22];   // arrival offsets (min vs start): early..late
  const dep = [-14, -4, 0, 12, 28];      // departure offsets (min vs end): early..overtime
  const events = [];

  days.forEach((day, di) => {
    EMPLOYEES.forEach((e, ei) => {
      const today = di === 0;
      // one person absent on a couple of days for realism
      if ((ei === 3 && (di === 0 || di === 2)) || (ei === 1 && di === 3)) return;

      const aOff = arr[(ei + di) % arr.length];
      const inT = addMin(e.start, aOff);
      events.push(mkEvent(e.id, day, inT, 'clock_in'));

      // lunch break most days
      const bStart = addMin('12:30', (ei * 7) % 40 - 20);
      const bEnd = addMin(bStart, 30 + (ei % 3) * 10);

      if (today) {
        // leave "today" partial to show live states
        if (ei === 0) { events.push(mkEvent(e.id, day, bStart, 'break_start')); }          // on break now
        else if (ei === 2) { events.push(mkEvent(e.id, day, bStart, 'break_start'), mkEvent(e.id, day, bEnd, 'break_end'), mkEvent(e.id, day, addMin(e.end, 10), 'clock_out')); } // done, overtime
        else if (ei === 4) { events.push(mkEvent(e.id, day, bStart, 'break_start'), mkEvent(e.id, day, bEnd, 'break_end'), mkEvent(e.id, day, addMin(e.end, -10), 'clock_out')); } // done, left early
        // others (Mike, Omar) still working — just the clock_in
      } else {
        events.push(mkEvent(e.id, day, bStart, 'break_start'), mkEvent(e.id, day, bEnd, 'break_end'));
        events.push(mkEvent(e.id, day, addMin(e.end, dep[(ei + di) % dep.length]), 'clock_out'));
      }
    });
  });

  // insert events in chunks
  for (let i = 0; i < events.length; i += 40) await batch(events.slice(i, i + 40));

  console.log(`\n  Demo seeded: ${EMPLOYEES.length} employees, ${events.length} events across ${days.length} weekdays.`);
  console.log('  Brand: "Attendance Kiosk Demo"  |  Admin PIN: 1234  |  Liveness: off');
  process.exit(0);
})().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
