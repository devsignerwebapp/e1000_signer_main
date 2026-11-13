import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({ ...env.db, max: 10 });

pool.on('error', (err) => console.error('[db] idle client error', err));

export const query = (text, params) => pool.query(text, params);

/** Run `fn(client)` inside a transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
