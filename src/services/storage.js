// File storage with two drivers, selected by STORAGE_DRIVER:
//   local    → files under STORAGE_DIR (default)
//   supabase → Supabase Storage bucket (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET)
// The DB always stores the same relative key, e.g. "uploads/<uuid>.pdf", so switching drivers only
// requires copying the files (see scripts/migrate-to-supabase.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const CONTENT_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ── local ────────────────────────────────────────────────────────────────
export function absPath(rel) {
  const abs = path.resolve(env.storageDir, rel);
  if (!abs.startsWith(env.storageDir)) throw new Error('Invalid storage path');
  return abs;
}

const local = {
  async put(rel, buffer) {
    const abs = absPath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
  },
  get: (rel) => fs.readFile(absPath(rel)),
  remove: (rel) => fs.rm(absPath(rel), { force: true }),
};

// ── supabase ─────────────────────────────────────────────────────────────
const sb = env.storage;
const sbHeaders = (extra = {}) => ({ Authorization: `Bearer ${sb.serviceRoleKey}`, apikey: sb.serviceRoleKey, ...extra });
const objectUrl = (rel) => `${sb.supabaseUrl}/storage/v1/object/${encodeURIComponent(sb.bucket)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

async function sbError(res, action) {
  let msg = '';
  try { msg = (await res.json()).message; } catch { /* not json */ }
  return new Error(`Supabase storage ${action} failed (${res.status}) ${msg || ''}`.trim());
}

export const supabase = {
  async put(rel, buffer, { upsert = false } = {}) {
    const res = await fetch(objectUrl(rel), {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': CONTENT_TYPES[path.extname(rel)] || 'application/octet-stream', 'x-upsert': String(upsert) }),
      body: buffer,
    });
    if (!res.ok) throw await sbError(res, 'upload');
  },
  async get(rel) {
    const res = await fetch(objectUrl(rel), { headers: sbHeaders() });
    if (!res.ok) throw await sbError(res, 'download');
    return Buffer.from(await res.arrayBuffer());
  },
  async remove(rel) {
    const res = await fetch(`${sb.supabaseUrl}/storage/v1/object/${encodeURIComponent(sb.bucket)}`, {
      method: 'DELETE',
      headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [rel] }),
    });
    if (!res.ok && res.status !== 404) throw await sbError(res, 'delete');
  },
};

function driver() {
  if (sb.driver === 'supabase') {
    if (!sb.supabaseUrl || !sb.serviceRoleKey) throw new Error('STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return supabase;
  }
  return local;
}

// ── public API used by services ──────────────────────────────────────────
export async function saveFile(folder, buffer, ext = '.pdf') {
  const rel = path.posix.join(folder, `${crypto.randomUUID()}${ext}`);
  await driver().put(rel, buffer);
  return rel;
}

export const readFile = (rel) => driver().get(rel);

export async function removeFile(rel) {
  if (!rel) return;
  try {
    await driver().remove(rel);
  } catch (e) {
    console.error('[storage] remove failed', rel, e.message);
  }
}
