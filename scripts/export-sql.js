// Builds ONE SQL file containing the full schema (all migrations) + all current data, to paste into
// the Supabase Dashboard → SQL Editor (no database password needed on this machine).
//   node scripts/export-sql.js [out.sql]     (default: db/supabase-import.sql — git-ignored, contains data!)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'db', 'supabase-import.sql'));
const TABLES = ['usertypes', 'permissions', 'usertype_permissions', 'users', 'email_otps', 'documents', 'templates', 'submissions', 'api_keys', 'events'];
const SERIAL = ['usertypes', 'permissions', 'email_otps', 'events'];
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const migDir = path.join(root, 'db', 'migrations');
const files = (await fs.readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();

let sql = `-- E1000Signer: schema + data export (${new Date().toISOString()})\n-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to run once on an EMPTY database.\nBEGIN;\n\n`;
sql += `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());\n\n`;
for (const f of files) {
  sql += `-- ── migration ${f} ──\n${await fs.readFile(path.join(migDir, f), 'utf8')}\nINSERT INTO schema_migrations(name) VALUES (${lit(f)});\n\n`;
}
sql += '-- ── data ──\n';
for (const t of TABLES) {
  const { rows } = await pool.query(`SELECT * FROM ${t}`);
  console.log(`  ${t}: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 500) {
    sql += `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, ${lit(JSON.stringify(rows.slice(i, i + 500)))}::json);\n`;
  }
}
for (const t of SERIAL) {
  sql += `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST(COALESCE((SELECT max(id) FROM ${t}), 0), 1), (SELECT count(*) > 0 FROM ${t}));\n`;
}
sql += '\nCOMMIT;\n';
await fs.writeFile(out, sql);
console.log(`✔ wrote ${out} (${(sql.length / 1024).toFixed(0)} KB)`);
await pool.end();
