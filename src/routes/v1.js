// Public developer API — authenticated with API keys (X-API-Key: e1k_…).
import { Router } from 'express';
import { z } from 'zod';
import { apiKeyAuth, requirePermission } from '../middleware/auth.js';
import { apiLimiter, uploadPdf } from '../middleware/common.js';
import { logEvent } from '../services/events.js';
import { createDocument, deleteDocument, documentDto, getOwnedDocument, listDocuments, sendPdf, signDocument, signedName } from '../services/documents.js';
import { createTemplate, getOwnedTemplate, listSubmissions, listTemplates, shareUrl, submissionDto, templateDto, updateTemplate } from '../services/templates.js';
import { sendTemplateInvite } from '../services/mailer.js';
import { inspectPdf, stampPdf } from '../services/pdf.js';
import { readFile } from '../services/storage.js';
import { badRequest, pagination, parse } from '../utils/http.js';
import { placementSchema } from './documents.js';
import { openapiSpec } from './openapi.js';

const r = Router();

r.get('/openapi.json', (_req, res) => res.json(openapiSpec()));

r.use(apiLimiter, apiKeyAuth);
r.use((req, res, next) => {
  res.on('finish', () => logEvent({ req, type: 'api.request', entityId: req.apiKeyId, meta: { method: req.method, path: req.path, status: res.statusCode } }));
  next();
});

// Accept multipart (`file`) or JSON (`fileBase64`) uploads.
const maybeMultipart = (req, res, next) => (req.is('multipart/form-data') ? uploadPdf(req, res, next) : next());
function fileFrom(req) {
  if (req.file) return { buffer: req.file.buffer, name: req.file.originalname };
  if (req.body?.fileBase64) {
    const b64 = String(req.body.fileBase64).replace(/^data:application\/pdf;base64,/, '');
    return { buffer: Buffer.from(b64, 'base64'), name: req.body.fileName || 'document.pdf' };
  }
  throw badRequest('Provide a PDF as multipart field "file" or JSON "fileBase64"', 'FILE_REQUIRED');
}
function placementsFrom(body) {
  let p = body?.placements;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { throw badRequest('placements must be a JSON array'); }
  }
  return parse(z.array(placementSchema).min(1), p);
}

r.get('/me', (req, res) => res.json({ id: req.user.id, email: req.user.email, fullName: req.user.full_name, plan: req.user.usertype }));

// Documents
r.get('/documents', requirePermission('document.read'), async (req, res) => {
  res.json({ data: (await listDocuments(req.user.id, pagination(req.query, 200))).map(documentDto) });
});
r.post('/documents', requirePermission('document.create'), maybeMultipart, async (req, res) => {
  const f = fileFrom(req);
  const doc = await createDocument({ req, buffer: f.buffer, originalName: f.name, title: req.body?.title, source: 'api' });
  res.status(201).json({ data: documentDto(doc) });
});
r.get('/documents/:id', requirePermission('document.read'), async (req, res) => {
  res.json({ data: documentDto(await getOwnedDocument(req.user.id, req.params.id)) });
});
r.post('/documents/:id/sign', requirePermission('document.sign'), async (req, res) => {
  const doc = await signDocument({ req, doc: await getOwnedDocument(req.user.id, req.params.id), placements: placementsFrom(req.body), source: 'api' });
  res.json({ data: documentDto(doc) });
});
r.get('/documents/:id/download', requirePermission('document.read'), async (req, res) => {
  const doc = await getOwnedDocument(req.user.id, req.params.id);
  const signed = req.query.version !== 'original' && doc.signed_path;
  sendPdf(res, await readFile(signed ? doc.signed_path : doc.file_path), signed ? signedName(doc) : doc.original_name);
});
r.delete('/documents/:id', requirePermission('document.delete'), async (req, res) => {
  await deleteDocument({ req, doc: await getOwnedDocument(req.user.id, req.params.id) });
  res.status(204).end();
});

// One-shot stateless signing: PDF in → signed PDF out (nothing stored).
r.post('/sign', requirePermission('document.sign'), maybeMultipart, async (req, res) => {
  const f = fileFrom(req);
  const placements = placementsFrom(req.body);
  await inspectPdf(f.buffer);
  const out = await stampPdf(f.buffer, placements);
  await logEvent({ req, type: 'document.signed', meta: { stateless: true, placements: placements.length, source: 'api' } });
  sendPdf(res, out, `${f.name.replace(/\.pdf$/i, '')}-signed.pdf`);
});

// Templates
r.get('/templates', requirePermission('template.create'), async (req, res) => {
  res.json({ data: (await listTemplates(req.user.id)).map(templateDto) });
});
r.post('/templates', requirePermission('template.create'), async (req, res) => {
  res.status(201).json({ data: templateDto(await createTemplate({ req, body: req.body })) });
});
r.get('/templates/:id', requirePermission('template.create'), async (req, res) => {
  res.json({ data: templateDto(await getOwnedTemplate(req.user.id, req.params.id)) });
});
r.patch('/templates/:id', requirePermission('template.manage'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  res.json({ data: templateDto(await updateTemplate({ req, tpl, body: req.body })) });
});
r.post('/templates/:id/send', requirePermission('template.share'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  const { emails, message } = parse(z.object({ emails: z.array(z.email()).min(1).max(20), message: z.string().max(2000).optional() }), req.body);
  const results = await Promise.all(emails.map(async (to) => ({ email: to, sent: await sendTemplateInvite({ to, senderName: req.user.full_name, templateName: tpl.name, link: shareUrl(tpl.share_token), message: message ?? tpl.message, lang: req.body?.locale || req.user.locale }) })));
  await logEvent({ req, type: 'template.sent', entityId: tpl.id, meta: { recipients: emails.length, source: 'api' } });
  res.json({ data: results });
});
r.get('/templates/:id/submissions', requirePermission('submission.read'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  res.json({ data: (await listSubmissions(tpl.id)).map(submissionDto) });
});

export default r;
