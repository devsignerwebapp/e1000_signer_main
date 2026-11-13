import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logEvent } from '../services/events.js';
import { invalidateRbac } from '../services/rbac.js';
import { removeFile } from '../services/storage.js';
import { avatarUrl } from '../utils/avatar.js';
import { badRequest, conflict, notFound, pagination, parse } from '../utils/http.js';

const r = Router();
r.use(requireAuth, requirePermission('admin.dashboard.view'));

// Headline numbers
r.get('/stats', async (_req, res) => {
  const { rows: [totals] } = await query(`SELECT
    (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM users WHERE is_verified)::int AS verified_users,
    (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_users_7d,
    (SELECT count(*) FROM documents)::int AS documents,
    (SELECT count(*) FROM documents WHERE signed_path IS NOT NULL)::int AS signed_documents,
    (SELECT count(*) FROM templates)::int AS templates,
    (SELECT count(*) FROM submissions)::int AS submissions,
    (SELECT count(*) FROM api_keys WHERE revoked_at IS NULL)::int AS active_api_keys,
    (SELECT count(*) FROM events WHERE type='demo.signed')::int AS demo_signatures,
    (SELECT count(*) FROM events WHERE created_at > now() - interval '24 hours')::int AS events_24h`);
  const { rows: byType } = await query(`SELECT ut.code, ut.name, count(u.id)::int AS count FROM usertypes ut LEFT JOIN users u ON u.usertype_id=ut.id GROUP BY ut.id ORDER BY ut.sort_order`);
  res.json({ totals, usersByType: byType });
});

// Daily time series for the linear overview chart
const METRICS = {
  registrations: `type='auth.registered'`,
  logins: `type='auth.login'`,
  uploads: `type='document.uploaded'`,
  signatures: `type IN ('document.signed','submission.created','demo.signed')`,
  templates: `type='template.created'`,
  api: `type='api.request'`,
};
r.get('/overview', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
  const cols = Object.entries(METRICS).map(([k, cond]) => `count(e.id) FILTER (WHERE e.${cond})::int AS ${k}`).join(',\n');
  const { rows } = await query(
    `SELECT to_char(d.day,'YYYY-MM-DD') AS date, ${cols}, count(e.id)::int AS total
     FROM generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') AS d(day)
     LEFT JOIN events e ON e.created_at >= d.day AND e.created_at < d.day + interval '1 day'
     GROUP BY d.day ORDER BY d.day`,
    [days],
  );
  res.json({ days, metrics: Object.keys(METRICS), series: rows });
});

// Event log with filters
r.get('/events', requirePermission('admin.events.view'), async (req, res) => {
  const { limit, offset, page } = pagination(req.query, 200);
  const where = [];
  const params = [];
  if (req.query.category) { params.push(req.query.category); where.push(`e.category=$${params.length}`); }
  if (req.query.type) { params.push(req.query.type); where.push(`e.type=$${params.length}`); }
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(u.email ILIKE $${params.length} OR e.type ILIKE $${params.length} OR e.entity_id ILIKE $${params.length} OR e.meta::text ILIKE $${params.length})`); }
  if (req.query.hideApi === 'true') where.push(`e.type <> 'api.request'`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM events e LEFT JOIN users u ON u.id=e.user_id ${w}`, params);
  const { rows } = await query(
    `SELECT e.id, e.type, e.category, e.entity_id, e.meta, e.ip_address, e.created_at, u.email AS user_email, u.full_name AS user_name
     FROM events e LEFT JOIN users u ON u.id=e.user_id ${w} ORDER BY e.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const { rows: cats } = await query(`SELECT DISTINCT category FROM events ORDER BY 1`);
  res.json({ events: rows, total, page, limit, categories: cats.map((c) => c.category) });
});

// ── Users ──────────────────────────────────────────────────────────────────
r.get('/users', async (req, res) => {
  const { limit, offset, page } = pagination(req.query, 200);
  const params = [];
  const where = [];
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR u.company ILIKE $${params.length})`); }
  if (req.query.usertypeId) { params.push(Number(req.query.usertypeId)); where.push(`u.usertype_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM users u ${w}`, params);
  const { rows } = await query(
    `SELECT u.id,u.email,u.full_name,u.company,u.is_verified,u.is_active,u.last_login_at,u.created_at,u.avatar_path,
            ut.id AS usertype_id, ut.code AS usertype, ut.name AS usertype_name,
            (SELECT count(*) FROM documents d WHERE d.owner_id=u.id)::int AS documents,
            (SELECT count(*) FROM templates t WHERE t.owner_id=u.id)::int AS templates
     FROM users u JOIN usertypes ut ON ut.id=u.usertype_id ${w}
     ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ users: rows.map(({ avatar_path, ...u }) => ({ ...u, avatar_url: avatarUrl(avatar_path) })), total, page, limit });
});

/** Number of OTHER active users that can still open the admin console (lockout protection). */
async function otherAdmins(excludeUserId) {
  const { rows: [{ n }] } = await query(
    `SELECT count(*)::int AS n FROM users u
     JOIN usertype_permissions up ON up.usertype_id=u.usertype_id
     JOIN permissions p ON p.id=up.permission_id AND p.code='admin.dashboard.view'
     WHERE u.is_active AND u.id::text <> $1`,
    [excludeUserId],
  );
  return n;
}

const userCreateSchema = z.object({
  email: z.email().max(255).transform((s) => s.trim().toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  company: z.string().trim().max(120).optional().nullable(),
  password: z.string().min(8).max(128),
  usertypeId: z.number().int(),
  isVerified: z.boolean().default(true),
});

r.post('/users', requirePermission('admin.users.manage'), async (req, res) => {
  const data = parse(userCreateSchema, req.body);
  const ut = (await query(`SELECT id, code FROM usertypes WHERE id=$1`, [data.usertypeId])).rows[0];
  if (!ut || ut.code === 'guest') throw badRequest('Choose a valid user type');
  const exists = (await query(`SELECT 1 FROM users WHERE lower(email)=$1`, [data.email])).rows[0];
  if (exists) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const { rows } = await query(
    `INSERT INTO users(email,password_hash,full_name,company,usertype_id,is_verified,locale)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.email, await bcrypt.hash(data.password, 12), data.fullName, data.company || null, ut.id, data.isVerified, req.user.locale || 'en'],
  );
  await logEvent({ req, type: 'admin.user_created', entityId: rows[0].id, meta: { email: data.email, usertype: ut.code } });
  res.status(201).json({ id: rows[0].id });
});

r.patch('/users/:id', requirePermission('admin.users.manage'), async (req, res) => {
  const data = parse(
    z.object({
      usertypeId: z.number().int().optional(),
      isActive: z.boolean().optional(),
      isVerified: z.boolean().optional(),
      fullName: z.string().trim().min(2).max(120).optional(),
      company: z.string().trim().max(120).nullable().optional(),
      password: z.string().min(8).max(128).optional(),
    }),
    req.body,
  );
  const self = req.params.id === req.user.id;
  if (self && (data.usertypeId !== undefined || data.isActive !== undefined)) throw badRequest('You cannot change your own role or status');
  const target = (await query(`SELECT u.id, u.usertype_id FROM users u WHERE u.id::text=$1`, [req.params.id])).rows[0];
  if (!target) throw notFound('User not found');
  if (data.usertypeId !== undefined) {
    const ut = (await query(`SELECT code FROM usertypes WHERE id=$1`, [data.usertypeId])).rows[0];
    if (!ut || ut.code === 'guest') throw badRequest('Choose a valid user type');
  }
  // Demoting/deactivating must leave at least one other admin.
  if ((data.usertypeId !== undefined && data.usertypeId !== target.usertype_id) || data.isActive === false) {
    const { rows: [isAdmin] } = await query(
      `SELECT 1 AS yes FROM usertype_permissions up JOIN permissions p ON p.id=up.permission_id
       WHERE up.usertype_id=$1 AND p.code='admin.dashboard.view'`, [target.usertype_id]);
    if (isAdmin && (await otherAdmins(target.id)) === 0) throw badRequest('This is the last administrator; promote someone else first');
  }
  await query(
    `UPDATE users SET usertype_id=COALESCE($2,usertype_id), is_active=COALESCE($3,is_active), is_verified=COALESCE($4,is_verified),
       full_name=COALESCE($5,full_name), company=CASE WHEN $6::boolean THEN $7 ELSE company END,
       password_hash=COALESCE($8,password_hash), password_changed_at=CASE WHEN $8::text IS NULL THEN password_changed_at ELSE now() END,
       updated_at=now()
     WHERE id=$1`,
    [target.id, data.usertypeId ?? null, data.isActive ?? null, data.isVerified ?? null, data.fullName ?? null,
      data.company !== undefined, data.company ?? null, data.password ? await bcrypt.hash(data.password, 12) : null],
  );
  const { password, ...meta } = data;
  await logEvent({ req, type: 'admin.user_updated', entityId: target.id, meta: { ...meta, passwordReset: !!password } });
  res.json({ ok: true });
});

r.delete('/users/:id', requirePermission('admin.users.manage'), async (req, res) => {
  if (req.params.id === req.user.id) throw badRequest('You cannot delete your own account here');
  const target = (await query(`SELECT id, email, usertype_id, avatar_path FROM users WHERE id::text=$1`, [req.params.id])).rows[0];
  if (!target) throw notFound('User not found');
  const { rows: [isAdmin] } = await query(
    `SELECT 1 AS yes FROM usertype_permissions up JOIN permissions p ON p.id=up.permission_id
     WHERE up.usertype_id=$1 AND p.code='admin.dashboard.view'`, [target.usertype_id]);
  if (isAdmin && (await otherAdmins(target.id)) === 0) throw badRequest('This is the last administrator and cannot be deleted');
  // Collect stored files before the cascade removes the rows.
  const { rows: files } = await query(
    `SELECT file_path AS p FROM documents WHERE owner_id=$1 UNION ALL SELECT signed_path FROM documents WHERE owner_id=$1 AND signed_path IS NOT NULL
     UNION ALL SELECT s.signed_path FROM submissions s JOIN templates t ON t.id=s.template_id WHERE t.owner_id=$1`, [target.id]);
  await query(`DELETE FROM users WHERE id=$1`, [target.id]);
  await Promise.all([...files.map((f) => removeFile(f.p)), removeFile(target.avatar_path)]);
  await logEvent({ req, type: 'admin.user_deleted', entityId: target.id, meta: { email: target.email, files: files.length } });
  res.status(204).end();
});

// ── User types (roles) & permissions ───────────────────────────────────────
const BUILTIN_TYPES = ['guest', 'user', 'pro', 'admin'];

r.get('/rbac', async (_req, res) => {
  const { rows: usertypes } = await query(
    `SELECT ut.*, (SELECT count(*) FROM users u WHERE u.usertype_id=ut.id)::int AS user_count FROM usertypes ut ORDER BY sort_order, id`);
  const { rows: permissions } = await query(`SELECT * FROM permissions ORDER BY category, code`);
  const { rows: links } = await query(`SELECT usertype_id, permission_id FROM usertype_permissions`);
  res.json({ usertypes: usertypes.map((u) => ({ ...u, builtin: BUILTIN_TYPES.includes(u.code) })), permissions, links });
});

const usertypeSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Code: 2–32 chars, lowercase letters, digits, underscore'),
  name: z.string().trim().min(2).max(64),
  description: z.string().trim().max(500).optional().nullable(),
  isPaid: z.boolean().default(false),
  copyFromId: z.number().int().optional().nullable(),
  permissionIds: z.array(z.number().int()).optional(),
});

r.post('/usertypes', requirePermission('admin.rbac.manage'), async (req, res) => {
  const data = parse(usertypeSchema, req.body);
  if ((await query(`SELECT 1 FROM usertypes WHERE code=$1`, [data.code])).rows[0]) throw conflict('A user type with this code already exists');
  const ut = await tx(async (c) => {
    const { rows: [{ next }] } = await c.query(`SELECT COALESCE(max(sort_order) FILTER (WHERE code <> 'admin'), 20) + 5 AS next FROM usertypes`);
    const { rows } = await c.query(
      `INSERT INTO usertypes(code,name,description,is_paid,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [data.code, data.name, data.description || null, data.isPaid, Math.min(next, 99)],
    );
    if (data.copyFromId) {
      await c.query(`INSERT INTO usertype_permissions SELECT $1, permission_id FROM usertype_permissions WHERE usertype_id=$2`, [rows[0].id, data.copyFromId]);
    } else if (data.permissionIds?.length) {
      await c.query(`INSERT INTO usertype_permissions SELECT $1, id FROM permissions WHERE id = ANY($2::int[])`, [rows[0].id, data.permissionIds]);
    }
    return rows[0];
  });
  invalidateRbac();
  await logEvent({ req, type: 'admin.usertype_created', entityId: ut.code, meta: { name: ut.name } });
  res.status(201).json({ usertype: ut });
});

r.patch('/usertypes/:id', requirePermission('admin.rbac.manage'), async (req, res) => {
  const data = parse(usertypeSchema.pick({ name: true, description: true, isPaid: true }).partial(), req.body);
  const { rows } = await query(
    `UPDATE usertypes SET name=COALESCE($2,name), description=CASE WHEN $3::boolean THEN $4 ELSE description END, is_paid=COALESCE($5,is_paid)
     WHERE id=$1 RETURNING *`,
    [Number(req.params.id), data.name ?? null, data.description !== undefined, data.description ?? null, data.isPaid ?? null],
  );
  if (!rows[0]) throw notFound('User type not found');
  invalidateRbac();
  await logEvent({ req, type: 'admin.usertype_updated', entityId: rows[0].code, meta: data });
  res.json({ usertype: rows[0] });
});

r.delete('/usertypes/:id', requirePermission('admin.rbac.manage'), async (req, res) => {
  const ut = (await query(`SELECT * FROM usertypes WHERE id=$1`, [Number(req.params.id)])).rows[0];
  if (!ut) throw notFound('User type not found');
  if (BUILTIN_TYPES.includes(ut.code)) throw badRequest('Built-in user types cannot be deleted');
  const reassignTo = req.query.reassignTo ? Number(req.query.reassignTo) : null;
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM users WHERE usertype_id=$1`, [ut.id]);
  if (n > 0) {
    const target = reassignTo && (await query(`SELECT code FROM usertypes WHERE id=$1 AND id<>$2`, [reassignTo, ut.id])).rows[0];
    if (!target || target.code === 'guest') throw conflict(`${n} user(s) still have this type; choose another type to move them to`, 'USERTYPE_IN_USE');
  }
  await tx(async (c) => {
    if (n > 0) await c.query(`UPDATE users SET usertype_id=$2, updated_at=now() WHERE usertype_id=$1`, [ut.id, reassignTo]);
    await c.query(`DELETE FROM usertypes WHERE id=$1`, [ut.id]);
  });
  invalidateRbac();
  await logEvent({ req, type: 'admin.usertype_deleted', entityId: ut.code, meta: { movedUsers: n, reassignTo } });
  res.status(204).end();
});

const PROTECTED = ['admin.dashboard.view', 'admin.rbac.manage'];
r.put('/rbac/:usertypeId/:permissionId', requirePermission('admin.rbac.manage'), async (req, res) => {
  const { granted } = parse(z.object({ granted: z.boolean() }), req.body);
  const ut = (await query(`SELECT * FROM usertypes WHERE id=$1`, [Number(req.params.usertypeId)])).rows[0];
  const perm = (await query(`SELECT * FROM permissions WHERE id=$1`, [Number(req.params.permissionId)])).rows[0];
  if (!ut || !perm) throw notFound();
  if (!granted && ut.code === 'admin' && PROTECTED.includes(perm.code)) throw badRequest('This permission cannot be removed from administrators (lockout protection)');
  if (granted) await query(`INSERT INTO usertype_permissions VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ut.id, perm.id]);
  else await query(`DELETE FROM usertype_permissions WHERE usertype_id=$1 AND permission_id=$2`, [ut.id, perm.id]);
  invalidateRbac();
  await logEvent({ req, type: 'admin.rbac_changed', entityId: `${ut.code}:${perm.code}`, meta: { granted } });
  res.json({ ok: true });
});

export default r;
