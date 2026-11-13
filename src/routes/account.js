import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { publicUser, requireAuth, requirePermission } from '../middleware/auth.js';
import { logEvent } from '../services/events.js';
import { deliver } from '../services/webhooks.js';
import { badRequest, notFound, parse, sha256 } from '../utils/http.js';
import { LOCALES } from '../services/mailer.js';
import { decodeImage } from '../services/pdf.js';
import { removeFile, saveFile } from '../services/storage.js';
import { avatarUrl } from '../utils/avatar.js';

const r = Router();
r.use(requireAuth);

r.patch('/profile', async (req, res) => {
  const data = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional(), company: z.string().trim().max(120).nullable().optional(), locale: z.enum(LOCALES).optional() }), req.body);
  await query(`UPDATE users SET full_name=COALESCE($2,full_name), company=CASE WHEN $3::boolean THEN $4 ELSE company END, locale=COALESCE($5,locale), updated_at=now() WHERE id=$1`, [
    req.user.id, data.fullName ?? null, data.company !== undefined, data.company ?? null, data.locale ?? null,
  ]);
  res.json({ user: publicUser({ ...req.user, full_name: data.fullName ?? req.user.full_name, company: data.company !== undefined ? data.company : req.user.company, locale: data.locale ?? req.user.locale }) });
});

// ── Password ────────────────────────────────────────────────────────────────
r.post('/password', async (req, res) => {
  const data = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128) }), req.body);
  const { rows: [u] } = await query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
  if (!(await bcrypt.compare(data.currentPassword, u.password_hash))) throw badRequest('Current password is incorrect', 'WRONG_PASSWORD');
  if (data.currentPassword === data.newPassword) throw badRequest('The new password must be different', 'SAME_PASSWORD');
  await query(`UPDATE users SET password_hash=$2, password_changed_at=now(), updated_at=now() WHERE id=$1`, [req.user.id, await bcrypt.hash(data.newPassword, 12)]);
  await logEvent({ req, type: 'auth.password_changed', entityId: req.user.id });
  res.json({ ok: true });
});

// ── Profile photo ───────────────────────────────────────────────────────────
// Body: { image: "data:image/png;base64,…" } (the web app crops/resizes to 256×256 first). Max 3 MB.
r.put('/avatar', async (req, res) => {
  const { image } = parse(z.object({ image: z.string().min(20) }), req.body);
  const { bytes, kind } = decodeImage(image);
  const rel = await saveFile('avatars', bytes, kind === 'png' ? '.png' : '.jpg');
  const { rows: [old] } = await query(`SELECT avatar_path FROM users WHERE id=$1`, [req.user.id]);
  await query(`UPDATE users SET avatar_path=$2, updated_at=now() WHERE id=$1`, [req.user.id, rel]);
  await removeFile(old?.avatar_path);
  await logEvent({ req, type: 'auth.avatar_changed', entityId: req.user.id });
  res.json({ avatarUrl: avatarUrl(rel) });
});

r.delete('/avatar', async (req, res) => {
  const { rows: [old] } = await query(`SELECT avatar_path FROM users WHERE id=$1`, [req.user.id]);
  await query(`UPDATE users SET avatar_path=NULL, updated_at=now() WHERE id=$1`, [req.user.id]);
  await removeFile(old?.avatar_path);
  res.status(204).end();
});

// ── API keys ────────────────────────────────────────────────────────────────
const keyDto = (k) => ({ id: k.id, name: k.name, prefix: k.key_prefix, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, createdAt: k.created_at });

r.get('/api-keys', requirePermission('api.keys.manage'), async (req, res) => {
  const { rows } = await query(`SELECT * FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]);
  res.json({ apiKeys: rows.map(keyDto) });
});

r.post('/api-keys', requirePermission('api.keys.manage'), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  const { rows: [{ count }] } = await query(`SELECT count(*)::int FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL`, [req.user.id]);
  if (count >= 10) throw badRequest('You can have at most 10 active API keys');
  const key = `e1k_${crypto.randomBytes(24).toString('base64url')}`;
  const { rows } = await query(`INSERT INTO api_keys(user_id,name,key_prefix,key_hash) VALUES ($1,$2,$3,$4) RETURNING *`, [req.user.id, name, key.slice(0, 10), sha256(key)]);
  await logEvent({ req, type: 'api.key_created', entityId: rows[0].id });
  // The full key is only ever returned once.
  res.status(201).json({ apiKey: keyDto(rows[0]), key });
});

r.delete('/api-keys/:id', requirePermission('api.keys.manage'), async (req, res) => {
  const { rowCount } = await query(`UPDATE api_keys SET revoked_at=now() WHERE id::text=$1 AND user_id=$2 AND revoked_at IS NULL`, [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('API key not found');
  await logEvent({ req, type: 'api.key_revoked', entityId: req.params.id });
  res.status(204).end();
});

// ── Webhook ─────────────────────────────────────────────────────────────────
function assertSafeUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('Webhook URL must be http(s)');
  if (env.nodeEnv === 'production') {
    if (u.protocol !== 'https:') throw badRequest('Webhook URL must use https');
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?)/i.test(u.hostname)) throw badRequest('Webhook URL cannot point to a private address');
  }
}

r.get('/webhook', requirePermission('webhook.manage'), async (req, res) => {
  const { rows } = await query(`SELECT webhook_url, webhook_secret FROM users WHERE id=$1`, [req.user.id]);
  res.json({ url: rows[0].webhook_url, secret: rows[0].webhook_secret });
});

r.put('/webhook', requirePermission('webhook.manage'), async (req, res) => {
  const { url } = parse(z.object({ url: z.url().max(500).nullable() }), req.body);
  if (url) assertSafeUrl(url);
  const secret = url ? `whsec_${crypto.randomBytes(20).toString('hex')}` : null;
  await query(`UPDATE users SET webhook_url=$2, webhook_secret=COALESCE($3, NULL), updated_at=now() WHERE id=$1`, [req.user.id, url, secret]);
  await logEvent({ req, type: url ? 'api.webhook_set' : 'api.webhook_removed' });
  res.json({ url, secret });
});

r.post('/webhook/test', requirePermission('webhook.manage'), async (req, res) => {
  const { rows } = await query(`SELECT webhook_url, webhook_secret FROM users WHERE id=$1`, [req.user.id]);
  if (!rows[0].webhook_url) throw badRequest('Set a webhook URL first');
  res.json(await deliver(req.user.id, rows[0].webhook_url, rows[0].webhook_secret, 'webhook.test', { message: 'Hello from E1000Signer' }));
});

// ── Personal stats for the user dashboard ───────────────────────────────────
r.get('/stats', async (req, res) => {
  const { rows: [s] } = await query(
    `SELECT
      (SELECT count(*) FROM documents WHERE owner_id=$1)::int AS documents,
      (SELECT count(*) FROM documents WHERE owner_id=$1 AND signed_path IS NOT NULL)::int AS signed,
      (SELECT count(*) FROM templates WHERE owner_id=$1)::int AS templates,
      (SELECT count(*) FROM submissions s JOIN templates t ON t.id=s.template_id WHERE t.owner_id=$1)::int AS submissions,
      (SELECT count(*) FROM events WHERE user_id=$1 AND type='api.request' AND created_at > now() - interval '30 days')::int AS api_calls_30d`,
    [req.user.id],
  );
  const { rows: activity } = await query(
    `SELECT type, entity_id, meta, created_at FROM events WHERE user_id=$1 AND type <> 'api.request' ORDER BY created_at DESC LIMIT 12`,
    [req.user.id],
  );
  res.json({ stats: s, activity });
});

export default r;
