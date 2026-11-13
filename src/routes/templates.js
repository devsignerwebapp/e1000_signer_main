import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { createTemplate, getOwnedTemplate, listSubmissions, listTemplates, shareUrl, submissionDto, templateDto, updateTemplate } from '../services/templates.js';
import { normLocale, sendTemplateInvite } from '../services/mailer.js';
import { logEvent } from '../services/events.js';
import { readFile } from '../services/storage.js';
import { sendPdf } from '../services/documents.js';
import { notFound, parse, randomToken } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

r.get('/', requirePermission('template.create'), async (req, res) => {
  res.json({ templates: (await listTemplates(req.user.id)).map(templateDto) });
});

r.post('/', requirePermission('template.create'), async (req, res) => {
  res.status(201).json({ template: templateDto(await createTemplate({ req, body: req.body })) });
});

r.get('/:id', requirePermission('template.create'), async (req, res) => {
  res.json({ template: templateDto(await getOwnedTemplate(req.user.id, req.params.id)) });
});

r.patch('/:id', requirePermission('template.manage'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  res.json({ template: templateDto(await updateTemplate({ req, tpl, body: req.body })) });
});

r.post('/:id/rotate-link', requirePermission('template.manage'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  await query(`UPDATE templates SET share_token=$2, updated_at=now() WHERE id=$1`, [tpl.id, randomToken(18)]);
  await logEvent({ req, type: 'template.link_rotated', entityId: tpl.id });
  res.json({ template: templateDto(await getOwnedTemplate(req.user.id, tpl.id)) });
});

r.delete('/:id', requirePermission('template.manage'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  await query(`DELETE FROM templates WHERE id=$1`, [tpl.id]);
  await logEvent({ req, type: 'template.deleted', entityId: tpl.id });
  res.status(204).end();
});

// Email the share link to one or more clients.
r.post('/:id/send', requirePermission('template.share'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  const { emails, message } = parse(z.object({ emails: z.array(z.email()).min(1).max(20), message: z.string().max(2000).optional() }), req.body);
  const results = await Promise.all(
    emails.map(async (to) => ({
      email: to,
      sent: await sendTemplateInvite({ to, senderName: req.user.full_name, templateName: tpl.name, link: shareUrl(tpl.share_token), message: message ?? tpl.message, lang: normLocale(req.headers['x-lang'] || req.user.locale) }),
    })),
  );
  await logEvent({ req, type: 'template.sent', entityId: tpl.id, meta: { recipients: emails.length } });
  res.json({ results });
});

r.get('/:id/submissions', requirePermission('submission.read'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  res.json({ submissions: (await listSubmissions(tpl.id)).map(submissionDto) });
});

r.get('/:id/submissions/:sid/download', requirePermission('submission.read'), async (req, res) => {
  const tpl = await getOwnedTemplate(req.user.id, req.params.id);
  const { rows } = await query(`SELECT * FROM submissions WHERE id::text=$1 AND template_id=$2`, [req.params.sid, tpl.id]);
  if (!rows[0]) throw notFound('Submission not found');
  sendPdf(res, await readFile(rows[0].signed_path), `${tpl.name}-${rows[0].signer_name}-signed.pdf`.replace(/[^\w\-. ]+/g, ''));
});

export default r;
