// One-off migration from the local setup to Supabase.
//
//   node scripts/migrate-to-supabase.js --files
//       Uploads every file under STORAGE_DIR (uploads/, signed/) to the Supabase bucket,
//       keeping the same keys the database already references. Safe to re-run (upsert).
//
//   node scripts/migrate-to-supabase.js --db --source "postgres://postgres:PASS@localhost:5432/signer"
//       Copies all rows from the SOURCE database into the database configured in .env (the
//       target, e.g. Supabase). Run `npm run db:migrate` against the target first.
//       The target tables are TRUNCATED first, so ids and foreign keys are preserved exactly.
//
// Uses SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET / DB_* from .env.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { supabase } from '../src/services/storage.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

// Parent tables before children.
const TABLES = ['usertypes', 'permissions', 'usertype_permissions', 'users', 'email_otps', 'documents', 'templates', 'submissions', 'api_keys', 'events'];
const SERIAL_TABLES = ['usertypes', 'permissions', 'email_otps', 'events'];

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (!e.name.startsWith('.')) out.push(p);
  }
  return out;
}

async function migrateFiles() {
  if (!env.storage.supabaseUrl || !env.storage.serviceRoleKey) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  const files = await walk(env.storageDir);
  console.log(`Uploading ${files.length} file(s) to bucket "${env.storage.bucket}"…`);
  let ok = 0;
  for (const abs of files) {
    const rel = path.relative(env.storageDir, abs).split(path.sep).join('/');
    try {
      await supabase.put(rel, await fs.readFile(abs), { upsert: true });
      ok++;
    } catch (e) {
      console.error(`  ✖ ${rel}: ${e.message}`);
    }
  }
  console.log(`✔ uploaded ${ok}/${files.length}`);
}

async function migrateDb() {
  const source = opt('--source');
  if (!source) throw new Error('--db needs --source "postgres://user:pass@host:port/db"');
  const src = new pg.Client({ connectionString: source });
  const dst = new pg.Client({ ...env.db });
  await src.connect();
  await dst.connect();
  console.log(`Copying ${source.replace(/:[^:@/]+@/, ':****@')} → ${env.db.host}/${env.db.database}`);
  try {
    await dst.query('BEGIN');
    await dst.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      const { rows } = await src.query(`SELECT * FROM ${t}`);
      for (let i = 0; i < rows.length; i += 500) {
        await dst.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
      console.log(`  ${t}: ${rows.length}`);
    }
    for (const t of SERIAL_TABLES) {
      await dst.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST(COALESCE((SELECT max(id) FROM ${t}), 0), 1), (SELECT count(*) > 0 FROM ${t}))`);
    }
    await dst.query('COMMIT');
    console.log('✔ database copied');
  } catch (e) {
    await dst.query('ROLLBACK');
    throw e;
  } finally {
    await src.end();
    await dst.end();
  }
}

(async () => {
  if (!flag('--files') && !flag('--db')) {
    console.log('Usage: node scripts/migrate-to-supabase.js [--files] [--db --source <postgres-url>]');
    process.exit(1);
  }
  if (flag('--files')) await migrateFiles();
  if (flag('--db')) await migrateDb();
})().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
