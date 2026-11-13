import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

// ── Transports ──────────────────────────────────────────────────────────
// smtp  : nodemailer (Gmail etc.). Outbound SMTP ports are blocked on some hosts (e.g. Render free plan).
// brevo : HTTPS API, free tier, works with a single verified sender address (even a Gmail).
// resend: HTTPS API, needs a verified domain to email arbitrary recipients.
const smtp = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.secure,
  auth: { user: env.smtp.user, pass: env.smtp.pass },
  connectionTimeout: env.smtp.timeoutMs,
  greetingTimeout: env.smtp.timeoutMs,
  socketTimeout: env.smtp.timeoutMs,
});

/** "Name <a@b.c>" | "a@b.c" → { name, email } */
function parseAddress(s = '') {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: s.trim() };
}
const formatAddress = ({ name, email }) => (name ? `"${name.replace(/"/g, '')}" <${email}>` : email);

/** Sender for a kind of email: codes use MAIL_FROM_CONFIRM, or MAIL_FROM's address named "<App> Confirm". */
function senderFor(kind) {
  if (kind === 'confirm') {
    if (env.smtp.fromConfirm) return parseAddress(env.smtp.fromConfirm);
    return { name: `${env.appName} Confirm`, email: parseAddress(env.smtp.from).email };
  }
  const from = parseAddress(env.smtp.from);
  return { name: from.name || env.appName, email: from.email };
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.smtp.timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function deliver({ from, to, subject, html, text }) {
  const replyTo = env.smtp.replyTo ? parseAddress(env.smtp.replyTo) : null;
  switch (env.smtp.transport) {
    case 'brevo':
      return postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': env.smtp.brevoApiKey }, {
        sender: { name: from.name, email: from.email },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        ...(replyTo ? { replyTo: { email: replyTo.email, name: replyTo.name || undefined } } : {}),
      });
    case 'resend':
      return postJson('https://api.resend.com/emails', { Authorization: `Bearer ${env.smtp.resendApiKey}` }, {
        from: formatAddress(from),
        to: [to],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo.email } : {}),
      });
    default:
      return smtp.sendMail({ from: formatAddress(from), replyTo: env.smtp.replyTo || undefined, to, subject, html, text });
  }
}

export const LOCALES = ['en', 'az'];
export const normLocale = (l) => (LOCALES.includes(String(l || '').slice(0, 2).toLowerCase()) ? String(l).slice(0, 2).toLowerCase() : 'en');

// ── Email copy in every supported language ──────────────────────────────
const T = {
  en: {
    footer: (app) => `You received this email from ${app}. If you didn't expect it, you can ignore it.`,
    otpSubjectVerify: (code, app) => `${code} is your ${app} verification code`,
    otpSubjectReset: (code, app) => `${code} is your ${app} password reset code`,
    otpTitleVerify: 'Confirm your email',
    otpTitleReset: 'Reset your password',
    hi: (n) => `Hi ${n},`,
    otpBodyVerify: 'Use this 4-digit code to activate your account:',
    otpBodyReset: 'Use this 4-digit code to reset your password:',
    otpExpires: (m) => `The code expires in ${m} minutes.`,
    otpText: (n, app, code, m) => `Hi ${n}, your ${app} code is ${code}. It expires in ${m} minutes.`,
    inviteSubject: (s, t) => `${s} asked you to sign "${t}"`,
    inviteTitle: (t) => `Signature requested: ${t}`,
    inviteBody: (s) => `<b>${s}</b> invited you to review and sign a document.`,
    inviteButton: 'Review & sign',
    orOpen: 'Or open:',
    inviteText: (s, t, l) => `${s} invited you to sign "${t}": ${l}`,
    signedSubject: (s, t) => `${s} signed "${t}"`,
    signedTitle: 'A document was signed',
    signedBody: (s, t) => `<b>${s}</b> just signed <b>${t}</b>.`,
    signedButton: 'Open dashboard',
    signedText: (s, t, l) => `${s} signed "${t}". View: ${l}`,
  },
  az: {
    footer: (app) => `Bu məktubu ${app} göndərib. Əgər gözləmirdinizsə, sadəcə nəzərə almayın.`,
    otpSubjectVerify: (code, app) => `${code} — ${app} təsdiq kodunuz`,
    otpSubjectReset: (code, app) => `${code} — ${app} şifrə bərpa kodunuz`,
    otpTitleVerify: 'E-poçtunuzu təsdiqləyin',
    otpTitleReset: 'Şifrənizi bərpa edin',
    hi: (n) => `Salam, ${n}!`,
    otpBodyVerify: 'Hesabınızı aktivləşdirmək üçün bu 4 rəqəmli koddan istifadə edin:',
    otpBodyReset: 'Şifrənizi bərpa etmək üçün bu 4 rəqəmli koddan istifadə edin:',
    otpExpires: (m) => `Kodun etibarlılıq müddəti ${m} dəqiqədir.`,
    otpText: (n, app, code, m) => `Salam, ${n}! ${app} kodunuz: ${code}. Kod ${m} dəqiqə etibarlıdır.`,
    inviteSubject: (s, t) => `${s} sizdən "${t}" sənədini imzalamağı xahiş edir`,
    inviteTitle: (t) => `İmza tələb olunur: ${t}`,
    inviteBody: (s) => `<b>${s}</b> sizi sənədi nəzərdən keçirib imzalamağa dəvət edir.`,
    inviteButton: 'Bax və imzala',
    orOpen: 'Və ya bu linki açın:',
    inviteText: (s, t, l) => `${s} sizi "${t}" sənədini imzalamağa dəvət edir: ${l}`,
    signedSubject: (s, t) => `${s} "${t}" sənədini imzaladı`,
    signedTitle: 'Sənəd imzalandı',
    signedBody: (s, t) => `<b>${s}</b> indicə <b>${t}</b> sənədini imzaladı.`,
    signedButton: 'İdarə panelini aç',
    signedText: (s, t, l) => `${s} "${t}" sənədini imzaladı. Bax: ${l}`,
  },
};
const tr = (lang) => T[normLocale(lang)];

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(lang, title, bodyHtml) {
  return `<!doctype html><html lang="${normLocale(lang)}"><body style="margin:0;background:#f3f6ff;font-family:Segoe UI,Arial,sans-serif;color:#0f1535">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 10px 40px rgba(60,80,200,.12)">
      <tr><td style="padding:22px 28px;background:linear-gradient(120deg,#5b6cff,#22d3ee);color:#fff;font-size:20px;font-weight:700;letter-spacing:.5px">E1000<span style="opacity:.85">Signer</span></td></tr>
      <tr><td style="padding:28px">
        <h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f7f9ff;color:#7a83a8;font-size:12px">${esc(tr(lang).footer(env.appName))}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:18px 0;padding:12px 22px;border-radius:12px;background:#5b6cff;color:#fff;text-decoration:none;font-weight:600">${esc(label)}</a>`;

async function send({ to, subject, html, text, kind = 'notify' }) {
  if (!env.mailEnabled) {
    // Email is switched off (MAIL_ENABLED=false). Everything above stays ready for when it's turned back on.
    console.log(`[mail] disabled — skipped "${subject}" to ${to}`);
    return false;
  }
  try {
    await deliver({ from: senderFor(kind), to, subject, html, text });
    return true;
  } catch (e) {
    console.error(`[mail] ${env.smtp.transport} send failed:`, e.message);
    return false;
  }
}

export async function sendOtpEmail({ to, name, code, purpose, lang }) {
  const L = tr(lang);
  const isReset = purpose === 'reset';
  if (env.nodeEnv !== 'production') console.log(`[mail:dev] OTP for ${to} (${purpose}, ${normLocale(lang)}): ${code}`);
  const digits = code.split('').map((d) => `<span style="display:inline-block;width:46px;height:56px;line-height:56px;margin:0 4px;border-radius:12px;background:#eef1ff;font-size:28px;font-weight:700;color:#3b46d6">${d}</span>`).join('');
  return send({
    kind: 'confirm',
    to,
    subject: isReset ? L.otpSubjectReset(code, env.appName) : L.otpSubjectVerify(code, env.appName),
    text: L.otpText(name, env.appName, code, env.otpTtlMinutes),
    html: layout(lang, isReset ? L.otpTitleReset : L.otpTitleVerify, `<p>${esc(L.hi(name))}</p><p>${esc(isReset ? L.otpBodyReset : L.otpBodyVerify)}</p>
      <div style="text-align:center;margin:22px 0">${digits}</div>
      <p style="color:#7a83a8">${esc(L.otpExpires(env.otpTtlMinutes))}</p>`),
  });
}

export async function sendTemplateInvite({ to, senderName, templateName, link, message, lang }) {
  const L = tr(lang);
  return send({
    to,
    subject: L.inviteSubject(senderName, templateName),
    text: L.inviteText(senderName, templateName, link),
    html: layout(lang, L.inviteTitle(templateName), `<p>${L.inviteBody(esc(senderName))}</p>
      ${message ? `<blockquote style="margin:12px 0;padding:12px 16px;border-left:3px solid #5b6cff;background:#f7f9ff;border-radius:8px">${esc(message)}</blockquote>` : ''}
      ${button(link, L.inviteButton)}<p style="color:#7a83a8;font-size:13px">${esc(L.orOpen)} ${esc(link)}</p>`),
  });
}

export async function sendSubmissionNotice({ to, ownerName, templateName, signerName, link, lang }) {
  const L = tr(lang);
  return send({
    to,
    subject: L.signedSubject(signerName, templateName),
    text: L.signedText(signerName, templateName, link),
    html: layout(lang, L.signedTitle, `<p>${esc(L.hi(ownerName))}</p><p>${L.signedBody(esc(signerName), esc(templateName))}</p>${button(link, L.signedButton)}`),
  });
}
