import { query } from '../db/pool.js';

// usertype code → { id, code, name, permissions:Set } cached briefly; invalidated on admin edits.
const TTL_MS = 30_000;
let cache = { at: 0, byId: new Map(), byCode: new Map() };

async function load() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  const { rows } = await query(`
    SELECT ut.id, ut.code, ut.name, COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS perms
    FROM usertypes ut
    LEFT JOIN usertype_permissions up ON up.usertype_id = ut.id
    LEFT JOIN permissions p ON p.id = up.permission_id
    GROUP BY ut.id`);
  const byId = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const t = { id: r.id, code: r.code, name: r.name, permissions: new Set(r.perms) };
    byId.set(r.id, t);
    byCode.set(r.code, t);
  }
  cache = { at: Date.now(), byId, byCode };
  return cache;
}

export async function usertypeById(id) {
  return (await load()).byId.get(id);
}
export async function usertypeByCode(code) {
  return (await load()).byCode.get(code);
}
export function invalidateRbac() {
  cache.at = 0;
}
