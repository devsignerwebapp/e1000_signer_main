// Applies db/migrations/*.sql in filename order, once each.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function main() {
  console.log(`Migrating ${pool.options.host}:${pool.options.port}/${pool.options.database}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✔ applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`✖ failed ${file}:`, e.message);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
  console.log('migrations complete');
  await pool.end();
}

main();
