import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { usertypeById, usertypeByCode } from '../services/rbac.js';
import { forbidden, sha256, unauthorized } from '../utils/http.js';
import { avatarUrl } from '../utils/avatar.js';

export const signToken = (userId) => jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

async function loadUser(id) {
  const { rows } = await query(
    `SELECT id,email,full_name,company,locale,avatar_path,password_changed_at,last_login_at,usertype_id,is_verified,is_active,webhook_url,created_at FROM users WHERE id=$1`,
    [id],
  );
  const u = rows[0];
  if (!u || !u.is_active || !u.is_verified) return null;
  const ut = await usertypeById(u.usertype_id);
  return { ...u, usertype: ut.code, usertypeName: ut.name, permissions: ut.permissions };
}

/** Public shape sent to the frontend. */
export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  company: u.company,
  locale: u.locale || 'en',
  avatarUrl: avatarUrl(u.avatar_path),
  passwordChangedAt: u.password_changed_at || null,
  lastLoginAt: u.last_login_at || null,
  usertype: u.usertype,
  usertypeName: u.usertypeName,
  permissions: [...u.permissions].sort(),
  webhookUrl: u.webhook_url,
  createdAt: u.created_at,
});

/** Attach req.user (or null) from a Bearer JWT. Also sets req.permissions. */
export async function authenticate(req, _res, next) {
  req.user = null;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ') && !h.startsWith('Bearer e1k_')) {
    try {
      const { sub } = jwt.verify(h.slice(7), env.jwtSecret);
      req.user = await loadUser(sub);
    } catch {
      /* invalid/expired token → treat as guest */
    }
  }
  req.permissions = req.user ? req.user.permissions : (await usertypeByCode('guest'))?.permissions || new Set();
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export const requirePermission = (...codes) => (req, _res, next) => {
  const missing = codes.filter((c) => !req.permissions?.has(c));
  if (missing.length) return next(req.user ? forbidden(`Missing permission: ${missing.join(', ')}`, 'MISSING_PERMISSION') : unauthorized());
  next();
};

/** API-key auth for /api/v1. Accepts `X-API-Key: e1k_…` or `Authorization: Bearer e1k_…`. */
export async function apiKeyAuth(req, _res, next) {
  const raw = req.headers['x-api-key'] || (req.headers.authorization?.startsWith('Bearer e1k_') ? req.headers.authorization.slice(7) : null);
  if (!raw) return next(unauthorized('Missing API key (X-API-Key header)', 'API_KEY_MISSING'));
  const { rows } = await query(`SELECT id,user_id,last_used_at FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL`, [sha256(String(raw))]);
  const key = rows[0];
  if (!key) return next(unauthorized('Invalid or revoked API key', 'API_KEY_INVALID'));
  const user = await loadUser(key.user_id);
  if (!user) return next(unauthorized('API key owner is inactive', 'API_KEY_INVALID'));
  if (!user.permissions.has('api.access')) return next(forbidden('Your plan does not include API access', 'MISSING_PERMISSION'));
  req.user = user;
  req.permissions = user.permissions;
  req.apiKeyId = key.id;
  if (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60_000) {
    query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1`, [key.id]).catch(() => {});
  }
  next();
}
