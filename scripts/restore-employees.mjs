// Restores the original employees from the LOCAL backup into the cloud DB,
// WITHOUT deleting anything already there (gio, settings, PIN all preserved).
// Usage: DATABASE_URL=... DATABASE_AUTH_TOKEN=... node scripts/restore-employees.mjs
import { createClient } from '@libsql/client';
import path from 'node:path';

if (!process.env.DATABASE_URL || !process.env.DATABASE_AUTH_TOKEN) {
  console.error('Set DATABASE_URL and DATABASE_AUTH_TOKEN'); process.exit(1);
}
const local = createClient({ url: 'file:' + path.join(process.cwd(), 'data', 'attendance.db') });
const remote = createClient({ url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });

const remoteEmpCols = (await remote.execute('PRAGMA table_info(employees)')).rows.map(r => r.name);
const emps = (await local.execute('SELECT * FROM employees ORDER BY id')).rows;

for (const e of emps) {
  const id = Number(e.id);
  const exists = (await remote.execute({ sql: 'SELECT id FROM employees WHERE id = ?', args: [id] })).rows.length > 0;
  if (exists) { console.log(`  skip: id ${id} (${e.name}) already in cloud`); continue; }

  const cols = remoteEmpCols.filter(c => c in e);
  await remote.execute({
    sql: `INSERT INTO employees (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    args: cols.map(c => e[c]),
  });
  // face samples (keep employee_id link; let sample id auto-assign)
  await remote.execute({ sql: 'DELETE FROM face_samples WHERE employee_id = ?', args: [id] });
  const samples = (await local.execute({ sql: 'SELECT descriptor, created_at FROM face_samples WHERE employee_id = ?', args: [id] })).rows;
  for (const s of samples) {
    await remote.execute({ sql: 'INSERT INTO face_samples (employee_id, descriptor, created_at) VALUES (?, ?, ?)', args: [id, s.descriptor, s.created_at] });
  }
  // weekly schedule
  await remote.execute({ sql: 'DELETE FROM schedules WHERE employee_id = ?', args: [id] });
  const sch = (await local.execute({ sql: 'SELECT weekday, is_working, start_time, end_time FROM schedules WHERE employee_id = ?', args: [id] })).rows;
  for (const s of sch) {
    await remote.execute({ sql: 'INSERT INTO schedules (employee_id, weekday, is_working, start_time, end_time) VALUES (?, ?, ?, ?, ?)', args: [id, s.weekday, s.is_working, s.start_time, s.end_time] });
  }
  console.log(`  restored ${e.name} (id ${id}): ${samples.length} face samples, ${sch.length} schedule days`);
}
console.log('\n  Restore complete.');
