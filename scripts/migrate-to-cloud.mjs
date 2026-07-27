// Copies all data from the LOCAL file database into the cloud (Turso) database.
// Run with the cloud creds in the environment:
//   DATABASE_URL=... DATABASE_AUTH_TOKEN=... node scripts/migrate-to-cloud.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { createClient } from '@libsql/client';

if (!process.env.DATABASE_URL || !process.env.DATABASE_AUTH_TOKEN) {
  console.error('Set DATABASE_URL and DATABASE_AUTH_TOKEN in the environment.');
  process.exit(1);
}

// db.js reads DATABASE_URL/-TOKEN at require time → this targets the CLOUD db.
const require = createRequire(import.meta.url);
const db = require('../db.js');

// Local source (read-only).
const local = createClient({ url: 'file:' + path.join(process.cwd(), 'data', 'attendance.db') });

const TABLES = ['employees', 'face_samples', 'schedules', 'events', 'settings'];

(async () => {
  await db.init(); // creates the schema on the cloud db

  for (const t of TABLES) {
    const remoteCols = (await db.all(`PRAGMA table_info(${t})`)).map((r) => r.name);
    const localCols = (await local.execute(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);
    const cols = remoteCols.filter((c) => localCols.includes(c)); // only columns both sides share
    const rows = (await local.execute(`SELECT ${cols.join(',')} FROM ${t}`)).rows;

    await db.run(`DELETE FROM ${t}`); // start clean (removes any seeded defaults)
    const ph = cols.map(() => '?').join(',');
    for (const r of rows) {
      await db.run(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${ph})`, cols.map((c) => r[c]));
    }
    console.log(`  ${t}: ${rows.length} rows copied`);
  }
  console.log('\n  Migration complete.');
  process.exit(0);
})().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
