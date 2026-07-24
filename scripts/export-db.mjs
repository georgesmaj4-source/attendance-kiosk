// Makes a clean, single-file copy of your LOCAL database (data/attendance.db)
// so you can import it into Turso and keep your existing employees/schedules.
//
//   1) stop the local server first (so all data is flushed)
//   2) npm run export:db
//   3) turso db create attendance --from-file ./attendance-export.db
//
import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';

const srcFile = path.join(process.cwd(), 'data', 'attendance.db');
if (!fs.existsSync(srcFile)) {
  console.error('No local database found at', srcFile);
  process.exit(1);
}
const out = path.join(process.cwd(), 'attendance-export.db');
try { fs.rmSync(out, { force: true }); } catch {}

const db = createClient({ url: 'file:' + srcFile });
// VACUUM INTO writes a consolidated, WAL-free copy including all committed data.
await db.execute(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

const emps = (await db.execute('SELECT COUNT(*) c FROM employees')).rows[0].c;
const ev = (await db.execute('SELECT COUNT(*) c FROM events')).rows[0].c;
console.log(`\n  Exported ${Number(emps)} employees and ${Number(ev)} events to:\n     ${out}`);
console.log('\n  Next: turso db create attendance --from-file ./attendance-export.db\n');
