// Attendance logic: face matching, event state machine, daily report.
// DB access is async (libSQL); pure helpers stay synchronous.
const { get, all } = require('./db');

const DEFAULT_MATCH_THRESHOLD = 0.55;

async function matchThreshold() {
  const row = await get('SELECT value FROM settings WHERE key = ?', ['match_threshold']);
  const v = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(v) ? v : DEFAULT_MATCH_THRESHOLD;
}

// ---- date/time helpers (server local time is the source of truth) ----
function pad(n) { return String(n).padStart(2, '0'); }
function localParts(date = new Date()) {
  const y = date.getFullYear();
  return {
    date: `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    weekday: date.getDay(),
    minutes: date.getHours() * 60 + date.getMinutes(),
  };
}
function hhmmToMinutes(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function formatClock(hhmm) {
  const mins = hhmmToMinutes(hhmm);
  if (mins == null) return hhmm || '';
  let h = Math.floor(mins / 60); const m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad(m)} ${ampm}`;
}

// ---- face matching ----
function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}
// Returns { employee, distance } for the best match under threshold, or null.
async function identify(descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) return null;
  const rows = await all(`
    SELECT s.descriptor AS descriptor, e.id AS id, e.name AS name, e.grace_minutes AS grace_minutes
    FROM face_samples s JOIN employees e ON e.id = s.employee_id
    WHERE e.active = 1`);
  let best = null;
  for (const r of rows) {
    let sample;
    try { sample = JSON.parse(r.descriptor); } catch { continue; }
    if (!Array.isArray(sample) || sample.length !== 128) continue;
    const dist = euclidean(descriptor, sample);
    if (!best || dist < best.distance) {
      best = { distance: dist, employee: { id: Number(r.id), name: r.name, grace_minutes: Number(r.grace_minutes) } };
    }
  }
  if (best && best.distance <= (await matchThreshold())) return best;
  return null;
}

// ---- event state machine ----
const TYPES = ['clock_in', 'break_start', 'break_end', 'clock_out'];

async function currentState(employeeId, localDate) {
  const rows = await all('SELECT type FROM events WHERE employee_id = ? AND local_date = ? ORDER BY id ASC', [employeeId, localDate]);
  let state = 'OUT';
  for (const r of rows) {
    if (r.type === 'clock_in') state = 'IN';
    else if (r.type === 'break_start') state = 'BREAK';
    else if (r.type === 'break_end') state = 'IN';
    else if (r.type === 'clock_out') state = 'OUT';
  }
  return state;
}
function nextActionFor(state) {
  switch (state) {
    case 'OUT': return 'clock_in';
    case 'IN': return 'clock_out';
    case 'BREAK': return 'break_end';
    default: return 'clock_in';
  }
}
function validateTransition(state, type) {
  if (!TYPES.includes(type)) return { ok: false, error: 'Unknown action.' };
  const allowed = {
    OUT: { clock_in: true },
    IN: { break_start: true, clock_out: true },
    BREAK: { break_end: true },
  }[state];
  if (allowed && allowed[type]) return { ok: true };
  if (type === 'clock_in' && state !== 'OUT') return { ok: false, error: "You're already clocked in." };
  if (type === 'break_start' && state === 'OUT') return { ok: false, error: 'Clock in before starting a break.' };
  if (type === 'break_start' && state === 'BREAK') return { ok: false, error: "You're already on a break." };
  if (type === 'break_end' && state !== 'BREAK') return { ok: false, error: "You're not on a break." };
  if (type === 'clock_out' && state === 'OUT') return { ok: false, error: "You haven't clocked in yet." };
  if (type === 'clock_out' && state === 'BREAK') return { ok: false, error: 'End your break before clocking out.' };
  return { ok: false, error: 'That action is not allowed right now.' };
}

// ---- daily report ----
async function scheduleFor(employeeId, weekday) {
  return (await get('SELECT is_working, start_time, end_time FROM schedules WHERE employee_id = ? AND weekday = ?', [employeeId, weekday]))
    || { is_working: 0, start_time: null, end_time: null };
}

async function buildDayReport(localDate) {
  const weekday = new Date(localDate + 'T00:00:00').getDay();
  const employees = await all('SELECT * FROM employees WHERE active = 1 ORDER BY name');
  const rows = [];

  for (const emp of employees) {
    const sched = await scheduleFor(emp.id, weekday);
    const events = await all('SELECT type, ts, photo FROM events WHERE employee_id = ? AND local_date = ? ORDER BY id ASC', [emp.id, localDate]);

    const clockIns = events.filter(e => e.type === 'clock_in');
    const clockOuts = events.filter(e => e.type === 'clock_out');
    const arrival = clockIns[0] || null;
    const departure = clockOuts.length ? clockOuts[clockOuts.length - 1] : null;

    const breaks = [];
    let openBreak = null;
    for (const e of events) {
      if (e.type === 'break_start') openBreak = e.ts;
      else if (e.type === 'break_end' && openBreak) { breaks.push({ start: openBreak, end: e.ts }); openBreak = null; }
    }
    if (openBreak) breaks.push({ start: openBreak, end: null });

    let status = 'off', lateMinutes = 0;
    const startMin = hhmmToMinutes(sched.start_time);
    if (sched.is_working) {
      if (!arrival) status = 'absent';
      else if (startMin == null) status = 'on_time';
      else {
        const arr = new Date(arrival.ts);
        const arrMin = arr.getHours() * 60 + arr.getMinutes();
        if (arrMin <= startMin + (emp.grace_minutes || 0)) status = 'on_time';
        else { status = 'late'; lateMinutes = arrMin - startMin; }
      }
    } else {
      status = arrival ? 'on_time' : 'off';
    }

    let breakMinutes = 0;
    for (const b of breaks) if (b.end) breakMinutes += Math.max(0, Math.round((new Date(b.end) - new Date(b.start)) / 60000));
    let workedMinutes = null;
    if (arrival && departure) {
      const gross = Math.round((new Date(departure.ts) - new Date(arrival.ts)) / 60000);
      workedMinutes = Math.max(0, gross - breakMinutes);
    }

    rows.push({
      employee_id: Number(emp.id),
      name: emp.name,
      is_working: !!sched.is_working,
      scheduled_start: sched.start_time,
      scheduled_end: sched.end_time,
      grace_minutes: Number(emp.grace_minutes),
      arrival_ts: arrival ? arrival.ts : null,
      arrival_photo: arrival ? arrival.photo : null,   // inline base64 data URL
      departure_ts: departure ? departure.ts : null,
      status, late_minutes: lateMinutes,
      breaks, break_count: breaks.length, break_minutes: breakMinutes,
      worked_minutes: workedMinutes, still_on_break: !!openBreak,
    });
  }
  return { date: localDate, weekday, rows };
}

module.exports = {
  TYPES, DEFAULT_MATCH_THRESHOLD, matchThreshold,
  localParts, hhmmToMinutes, formatClock,
  identify, currentState, nextActionFor, validateTransition,
  buildDayReport,
};
