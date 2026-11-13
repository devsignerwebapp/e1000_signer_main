import 'dotenv/config';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
// Tolerant boolean: ignores surrounding spaces/quotes; true|1|yes|on → true, false|0|no|off → false.
const bool = (v, d) => {
  if (v === undefined) return d;
  const s = String(v).trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return d;
};

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  appName: process.env.APP_NAME || 'E1000Signer',
  apiPublicUrl: process.env.API_PUBLIC_URL || 'http://localhost:4000',
  webPublicUrl: process.env.WEB_PUBLIC_URL || 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'signer',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    // Supabase (and most hosted Postgres) require TLS.
    ssl: bool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : undefined,
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(), // local | supabase
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucket: process.env.SUPABASE_BUCKET || 'data-files',
  },

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  otpTtlMinutes: num(process.env.OTP_TTL_MINUTES, 10),
  otpMaxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),
  otpResendCooldown: num(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60),

  // ── EMAIL IS SWITCHED OFF IN CODE ─────────────────────────────────────────────────────────
  // The hosting plan cannot send email, so nothing is sent, the confirmation code is ALWAYS "0000"
  // (the UI tells users), and password reset by email is disabled.
  // No environment variable can change this. To turn real emails back on later, replace the line
  // below with the commented one (then MAIL_ENABLED=true + MAIL_TRANSPORT decide):
  //   mailEnabled: bool(process.env.MAIL_ENABLED, true),
  mailEnabled: false,
  otpFallbackCode: '0000',
  deployedCommit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: num(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    // Sender for verification / password-reset codes (falls back to MAIL_FROM's address with a "Confirm" name).
    fromConfirm: process.env.MAIL_FROM_CONFIRM || '',
    replyTo: process.env.MAIL_REPLY_TO || '',
    // smtp (default; blocked on Render's free plan) | brevo | resend — the last two use HTTPS APIs.
    transport: (process.env.MAIL_TRANSPORT || 'smtp').toLowerCase(),
    brevoApiKey: process.env.BREVO_API_KEY || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    timeoutMs: num(process.env.MAIL_TIMEOUT_MS, 15000),
  },

  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Administrator',
  },

  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 20) * 1024 * 1024,
  storageDir: path.resolve(process.env.STORAGE_DIR || './storage'),
};
