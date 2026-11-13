import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { badRequest, HttpError } from '../utils/http.js';
import { sendOtpEmail } from './mailer.js';

const fourDigits = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

/** Create & email a fresh 4-digit OTP. Enforces a resend cooldown. */
export async function issueOtp(user, purpose = 'register', lang) {
  const { rows } = await query(
    `SELECT created_at FROM email_otps WHERE user_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`,
    [user.id, purpose],
  );
  if (rows[0]) {
    const elapsed = (Date.now() - new Date(rows[0].created_at).getTime()) / 1000;
    if (elapsed < env.otpResendCooldown) {
      throw new HttpError(429, `Please wait ${Math.ceil(env.otpResendCooldown - elapsed)}s before requesting a new code`, 'OTP_COOLDOWN', {
        retryAfter: Math.ceil(env.otpResendCooldown - elapsed),
      });
    }
  }
  // Email disabled → fixed code (e.g. "0000") that the UI tells the user to enter. Real emails: random code.
  const code = env.mailEnabled ? fourDigits() : env.otpFallbackCode;
  // Invalidate previous unused codes for the same purpose.
  await query(`UPDATE email_otps SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL`, [user.id, purpose]);
  await query(
    `INSERT INTO email_otps(user_id,purpose,code_hash,expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
    [user.id, purpose, await bcrypt.hash(code, 8), String(env.otpTtlMinutes)],
  );
  // When email is disabled, sendOtpEmail returns false immediately (see mailer.send).
  const sent = await sendOtpEmail({ to: user.email, name: user.full_name, code, purpose, lang: lang || user.locale });
  return { sent, mailEnabled: env.mailEnabled, expiresInMinutes: env.otpTtlMinutes, resendAfter: env.otpResendCooldown };
}

/** Verify and consume the latest active OTP; throws on failure. */
export async function verifyOtp(userId, code, purpose = 'register') {
  const { rows } = await query(
    `SELECT * FROM email_otps WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose],
  );
  const otp = rows[0];
  if (!otp) throw badRequest('No active code. Please request a new one.', 'OTP_MISSING');
  if (new Date(otp.expires_at) < new Date()) throw badRequest('This code has expired. Please request a new one.', 'OTP_EXPIRED');
  if (otp.attempts >= env.otpMaxAttempts) throw badRequest('Too many attempts. Please request a new code.', 'OTP_LOCKED');

  const ok = await bcrypt.compare(String(code), otp.code_hash);
  if (!ok) {
    await query(`UPDATE email_otps SET attempts=attempts+1 WHERE id=$1`, [otp.id]);
    const left = env.otpMaxAttempts - otp.attempts - 1;
    throw badRequest(left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Too many attempts. Please request a new code.', 'OTP_INVALID');
  }
  await query(`UPDATE email_otps SET consumed_at=now() WHERE id=$1`, [otp.id]);
}
