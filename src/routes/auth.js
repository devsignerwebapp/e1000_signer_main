import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authLimiter } from '../middleware/common.js';
import { authenticate, publicUser, requireAuth, signToken } from '../middleware/auth.js';
import { issueOtp, verifyOtp } from '../services/otp.js';
import { logEvent } from '../services/events.js';
import { usertypeById } from '../services/rbac.js';
import { badRequest, conflict, forbidden, HttpError, parse, unauthorized } from '../utils/http.js';
import { normLocale } from '../services/mailer.js';
import { env } from '../config/env.js';

// With email disabled the reset code would be the public fallback code, so reset must be off.
const requireMail = (_req, _res, next) =>
  next(env.mailEnabled ? undefined : new HttpError(503, 'Password reset by email is currently unavailable. Please contact an administrator.', 'PASSWORD_RESET_UNAVAILABLE'));

const r = Router();
r.use(authLimiter);

const email = z.email().max(255).transform((s) => s.trim().toLowerCase());
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const code = z.string().regex(/^\d{4}$/, 'Code must be 4 digits');
const locale = z.string().max(10).optional().transform((v) => (v ? normLocale(v) : undefined));

const findByEmail = async (e) => (await query(`SELECT * FROM users WHERE lower(email)=$1`, [e])).rows[0];

async function session(user) {
  const ut = await usertypeById(user.usertype_id);
  return { token: signToken(user.id), user: publicUser({ ...user, usertype: ut.code, usertypeName: ut.name, permissions: ut.permissions }) };
}

r.post('/register', async (req, res) => {
  const data = parse(
    z.object({ fullName: z.string().trim().min(2).max(120), email, password, company: z.string().trim().max(120).optional(), locale }),
    req.body,
  );
  let user = await findByEmail(data.email);
  if (user?.is_verified) throw conflict('An account with this email already exists. Please sign in.', 'EMAIL_TAKEN');

  const hash = await bcrypt.hash(data.password, 12);
  const lang = data.locale || normLocale(req.headers['x-lang']);
  if (user) {
    // Unverified re-registration: refresh details and send a new code.
    user = (await query(`UPDATE users SET full_name=$2,password_hash=$3,company=$4,locale=$5,updated_at=now() WHERE id=$1 RETURNING *`, [user.id, data.fullName, hash, data.company || null, lang])).rows[0];
  } else {
    user = (
      await query(
        `INSERT INTO users(email,password_hash,full_name,company,locale,usertype_id)
         SELECT $1,$2,$3,$4,$5,id FROM usertypes WHERE code='user' RETURNING *`,
        [data.email, hash, data.fullName, data.company || null, lang],
      )
    ).rows[0];
    await logEvent({ req, userId: user.id, type: 'auth.registered', entityId: user.id });
  }
  let otp;
  try {
    otp = await issueOtp(user, 'register');
  } catch (e) {
    if (e.code !== 'OTP_COOLDOWN') throw e;
    otp = { sent: true, cooldown: e.details?.retryAfter };
  }
  res.status(201).json({ email: user.email, needsVerification: true, emailSent: otp.sent, resendAfter: otp.resendAfter ?? otp.cooldown });
});

r.post('/verify-otp', async (req, res) => {
  const data = parse(z.object({ email, code }), req.body);
  const user = await findByEmail(data.email);
  if (!user) throw badRequest('Incorrect code', 'OTP_INVALID');
  if (user.is_verified) throw badRequest('This email is already verified. Please sign in.', 'ALREADY_VERIFIED');
  await verifyOtp(user.id, data.code, 'register');
  const updated = (await query(`UPDATE users SET is_verified=TRUE,last_login_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [user.id])).rows[0];
  await logEvent({ req, userId: user.id, type: 'auth.verified', entityId: user.id });
  res.json(await session(updated));
});

r.post('/resend-otp', async (req, res) => {
  const data = parse(z.object({ email, purpose: z.enum(['register', 'reset']).default('register'), locale }), req.body);
  const user = await findByEmail(data.email);
  // Don't reveal whether the account exists.
  if (!user || (data.purpose === 'register' && user.is_verified)) return res.json({ ok: true });
  const otp = await issueOtp(user, data.purpose, data.locale);
  res.json({ ok: true, resendAfter: otp.resendAfter });
});

r.post('/login', async (req, res) => {
  const data = parse(z.object({ email, password: z.string().min(1) }), req.body);
  const user = await findByEmail(data.email);
  if (!user || !(await bcrypt.compare(data.password, user.password_hash))) {
    await logEvent({ req, userId: user?.id, type: 'auth.login_failed', meta: { email: data.email } });
    throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  }
  if (!user.is_active) throw forbidden('This account has been deactivated', 'ACCOUNT_DISABLED');
  if (!user.is_verified) {
    try {
      await issueOtp(user, 'register');
    } catch (e) {
      if (e.code !== 'OTP_COOLDOWN') throw e;
    }
    throw new HttpError(403, 'Please confirm your email. We sent you a 4-digit code.', 'EMAIL_NOT_VERIFIED', { email: user.email });
  }
  await query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [user.id]);
  await logEvent({ req, userId: user.id, type: 'auth.login', entityId: user.id });
  res.json(await session(user));
});

r.post('/forgot-password', requireMail, async (req, res) => {
  const data = parse(z.object({ email, locale }), req.body);
  const user = await findByEmail(data.email);
  if (user?.is_verified && user.is_active) {
    try {
      await issueOtp(user, 'reset', data.locale);
    } catch (e) {
      if (e.code !== 'OTP_COOLDOWN') throw e;
    }
  }
  res.json({ ok: true });
});

r.post('/reset-password', requireMail, async (req, res) => {
  const data = parse(z.object({ email, code, password }), req.body);
  const user = await findByEmail(data.email);
  if (!user) throw badRequest('Incorrect code', 'OTP_INVALID');
  await verifyOtp(user.id, data.code, 'reset');
  const updated = (await query(`UPDATE users SET password_hash=$2,updated_at=now(),last_login_at=now() WHERE id=$1 RETURNING *`, [user.id, await bcrypt.hash(data.password, 12)])).rows[0];
  await logEvent({ req, userId: user.id, type: 'auth.password_reset', entityId: user.id });
  res.json(await session(updated));
});

r.get('/me', authenticate, requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

export default r;
