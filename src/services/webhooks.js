import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { logEvent } from './events.js';

/**
 * Fire-and-forget webhook delivery to the user's configured URL.
 * Header `X-E1000-Signature: sha256=<hex HMAC of raw body using webhook_secret>`.
 */
export async function fireWebhook(userId, event, data) {
  const { rows } = await query(`SELECT webhook_url, webhook_secret FROM users WHERE id=$1`, [userId]);
  const u = rows[0];
  if (!u?.webhook_url) return { skipped: true };
  return deliver(userId, u.webhook_url, u.webhook_secret, event, data);
}

export async function deliver(userId, url, secret, event, data) {
  const body = JSON.stringify({ id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data });
  const sig = crypto.createHmac('sha256', secret || '').update(body).digest('hex');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'E1000Signer-Webhooks/1.0', 'X-E1000-Event': event, 'X-E1000-Signature': `sha256=${sig}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await logEvent({ userId, type: res.ok ? 'api.webhook_delivered' : 'api.webhook_failed', meta: { event, status: res.status } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    await logEvent({ userId, type: 'api.webhook_failed', meta: { event, error: e.message } });
    return { ok: false, error: e.message };
  }
}
