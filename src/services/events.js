import { query } from '../db/pool.js';
import { clientIp } from '../utils/http.js';

/**
 * Record an activity event. Never throws — auditing must not break requests.
 * type: "<category>.<action>", e.g. "document.signed".
 */
export async function logEvent({ req, userId, type, entityId, meta = {} }) {
  const category = type.split('.')[0];
  try {
    await query(
      `INSERT INTO events(user_id,type,category,entity_id,meta,ip_address) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId ?? req?.user?.id ?? null, type, category, entityId ? String(entityId) : null, meta, req ? clientIp(req) : null],
    );
  } catch (e) {
    console.error('[events] failed to log', type, e.message);
  }
}
