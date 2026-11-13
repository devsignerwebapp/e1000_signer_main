import { z } from 'zod';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { badRequest, notFound, parse, randomToken } from '../utils/http.js';
import { getOwnedDocument } from './documents.js';
import { logEvent } from './events.js';
import { stampPdf } from './pdf.js';
import { readFile, saveFile } from './storage.js';
import { fireWebhook } from './webhooks.js';
import { sendSubmissionNotice } from './mailer.js';

export const SIGN_TYPES = ['draw', 'type', 'upload'];

const ratio = z.number().min(0).max(1);
export const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(['signature', 'initials', 'text', 'date']).default('signature'),
  label: z.string().max(80).optional(),
  page: z.number().int().min(0),
  x: ratio, y: ratio, w: ratio.refine((v) => v > 0), h: ratio.refine((v) => v > 0),
  required: z.boolean().default(true),
});

export const templateSchema = z.object({
  documentId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  message: z.string().max(2000).optional().nullable(),
  allowedSignTypes: z.array(z.enum(SIGN_TYPES)).min(1).default(SIGN_TYPES),
  fields: z.array(fieldSchema).min(1, 'Add at least one field').max(100),
});

export const shareUrl = (token) => `${env.webPublicUrl}/sign/${token}`;

export const templateDto = (t) => ({
  id: t.id,
  documentId: t.document_id,
  name: t.name,
  message: t.message,
  allowedSignTypes: t.allowed_sign_types,
  fields: t.fields,
  shareToken: t.share_token,
  shareUrl: shareUrl(t.share_token),
  isActive: t.is_active,
  pageCount: t.page_count,
  documentTitle: t.document_title,
  submissionCount: t.submission_count !== undefined ? Number(t.submission_count) : undefined,
  lastSubmissionAt: t.last_submission_at,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

export const submissionDto = (s) => ({
  id: s.id,
  templateId: s.template_id,
  signerName: s.signer_name,
  signerEmail: s.signer_email,
  signTypesUsed: s.sign_types_used,
  downloadUrl: `${env.apiPublicUrl}/api/public/submissions/${s.download_token}/download`,
  createdAt: s.created_at,
});

function checkFieldsWithinDoc(fields, pageCount) {
  for (const f of fields) {
    if (f.page >= pageCount) throw badRequest(`Field "${f.label || f.id}" is on page ${f.page + 1}, but the document has ${pageCount} pages`);
    if (f.x + f.w > 1.001 || f.y + f.h > 1.001) throw badRequest(`Field "${f.label || f.id}" is outside the page`);
  }
}

const SELECT = `SELECT t.*, d.page_count, d.title AS document_title,
  (SELECT count(*) FROM submissions s WHERE s.template_id=t.id) AS submission_count,
  (SELECT max(created_at) FROM submissions s WHERE s.template_id=t.id) AS last_submission_at
  FROM templates t JOIN documents d ON d.id=t.document_id`;

export async function createTemplate({ req, body }) {
  const data = parse(templateSchema, body);
  const doc = await getOwnedDocument(req.user.id, data.documentId);
  checkFieldsWithinDoc(data.fields, doc.page_count);
  const { rows } = await query(
    `INSERT INTO templates(owner_id,document_id,name,message,allowed_sign_types,fields,share_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.user.id, doc.id, data.name, data.message || null, data.allowedSignTypes, JSON.stringify(data.fields), randomToken(18)],
  );
  await logEvent({ req, type: 'template.created', entityId: rows[0].id, meta: { fields: data.fields.length } });
  return getOwnedTemplate(req.user.id, rows[0].id);
}

export async function listTemplates(userId) {
  const { rows } = await query(`${SELECT} WHERE t.owner_id=$1 ORDER BY t.created_at DESC`, [userId]);
  return rows;
}

export async function getOwnedTemplate(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Template not found');
  const { rows } = await query(`${SELECT} WHERE t.id=$1 AND t.owner_id=$2`, [id, userId]);
  if (!rows[0]) throw notFound('Template not found');
  return rows[0];
}

export async function updateTemplate({ req, tpl, body }) {
  const data = parse(templateSchema.partial().omit({ documentId: true }).extend({ isActive: z.boolean().optional() }), body);
  if (data.fields) checkFieldsWithinDoc(data.fields, tpl.page_count);
  await query(
    `UPDATE templates SET
       name=COALESCE($2,name), message=CASE WHEN $3::boolean THEN $4 ELSE message END,
       allowed_sign_types=COALESCE($5,allowed_sign_types), fields=COALESCE($6,fields),
       is_active=COALESCE($7,is_active), updated_at=now()
     WHERE id=$1`,
    [tpl.id, data.name ?? null, data.message !== undefined, data.message ?? null, data.allowedSignTypes ?? null, data.fields ? JSON.stringify(data.fields) : null, data.isActive ?? null],
  );
  await logEvent({ req, type: 'template.updated', entityId: tpl.id });
  return getOwnedTemplate(req.user.id, tpl.id);
}

export async function listSubmissions(templateId) {
  const { rows } = await query(`SELECT * FROM submissions WHERE template_id=$1 ORDER BY created_at DESC`, [templateId]);
  return rows;
}

// ── Public signing (clients opening a share link) ──────────────────────────
export async function getActiveTemplateByToken(token) {
  const { rows } = await query(
    `SELECT t.*, d.page_count, d.file_path, d.title AS document_title, u.full_name AS owner_name, u.email AS owner_email, u.company AS owner_company, u.locale AS owner_locale
     FROM templates t JOIN documents d ON d.id=t.document_id JOIN users u ON u.id=t.owner_id
     WHERE t.share_token=$1 AND t.is_active AND u.is_active`,
    [String(token)],
  );
  if (!rows[0]) throw notFound('This signing link is invalid or no longer active');
  return rows[0];
}

const valueSchema = z.union([
  z.object({ type: z.enum(SIGN_TYPES), image: z.string().min(20) }),
  z.object({ text: z.string().trim().min(1).max(500), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }),
]);
const submitSchema = z.object({
  signerName: z.string().trim().min(1).max(120),
  signerEmail: z.email().optional().or(z.literal('')).nullable(),
  values: z.record(z.string(), valueSchema),
});

export async function submitTemplate({ req, tpl, body }) {
  const data = parse(submitSchema, body);
  const placements = [];
  const typesUsed = new Set();
  for (const f of tpl.fields) {
    const v = data.values[f.id];
    if (!v) {
      if (f.required) throw badRequest(`Please complete the "${f.label || f.kind}" field`, 'FIELD_REQUIRED');
      continue;
    }
    const isImageField = f.kind === 'signature' || f.kind === 'initials';
    if (isImageField) {
      if (!v.image) throw badRequest(`"${f.label || f.kind}" requires a signature`);
      if (!tpl.allowed_sign_types.includes(v.type)) throw badRequest(`Sign type "${v.type}" is not allowed for this document`, 'SIGN_TYPE_NOT_ALLOWED');
      typesUsed.add(v.type);
      placements.push({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, image: v.image });
    } else if (v.image) {
      // Text rendered client-side as an image (non-Latin characters).
      placements.push({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, image: v.image });
    } else {
      placements.push({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, text: v.text, color: v.color });
    }
  }
  if (!placements.length) throw badRequest('Nothing to sign', 'NO_PLACEMENTS');

  const signed = await stampPdf(await readFile(tpl.file_path), placements);
  const rel = await saveFile('signed', signed);
  const { rows } = await query(
    `INSERT INTO submissions(template_id,signer_name,signer_email,signed_path,download_token,sign_types_used,ip_address,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tpl.id, data.signerName, data.signerEmail || null, rel, randomToken(24), [...typesUsed], req.ip, String(req.headers['user-agent'] || '').slice(0, 400)],
  );
  const sub = rows[0];
  await logEvent({ req, userId: tpl.owner_id, type: 'submission.created', entityId: sub.id, meta: { templateId: tpl.id, signer: data.signerName, types: [...typesUsed] } });
  fireWebhook(tpl.owner_id, 'submission.created', { templateId: tpl.id, templateName: tpl.name, submission: submissionDto(sub) });
  sendSubmissionNotice({ to: tpl.owner_email, ownerName: tpl.owner_name, templateName: tpl.name, signerName: data.signerName, link: `${env.webPublicUrl}/app/templates/${tpl.id}`, lang: tpl.owner_locale });
  return sub;
}
