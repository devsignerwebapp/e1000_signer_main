// Unauthenticated endpoints: client signing links + the stateless guest demo.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { demoLimiter, publicLimiter, uploadPdf } from '../middleware/common.js';
import { requirePermission } from '../middleware/auth.js';
import { getActiveTemplateByToken, submitTemplate, submissionDto } from '../services/templates.js';
import { inspectPdf, stampPdf } from '../services/pdf.js';
import { readFile } from '../services/storage.js';
import { sendPdf } from '../services/documents.js';
import { logEvent } from '../services/events.js';
import { badRequest, notFound, parse } from '../utils/http.js';
import { placementSchema } from './documents.js';

const r = Router();
r.use(publicLimiter);

r.get('/sign/:token', async (req, res) => {
  const t = await getActiveTemplateByToken(req.params.token);
  await logEvent({ req, userId: t.owner_id, type: 'submission.link_opened', entityId: t.id });
  res.json({
    template: {
      name: t.name,
      message: t.message,
      ownerName: t.owner_name,
      ownerCompany: t.owner_company,
      allowedSignTypes: t.allowed_sign_types,
      fields: t.fields,
      pageCount: t.page_count,
    },
  });
});

r.get('/sign/:token/file', async (req, res) => {
  const t = await getActiveTemplateByToken(req.params.token);
  sendPdf(res, await readFile(t.file_path), `${t.document_title}.pdf`, true);
});

r.post('/sign/:token/submit', async (req, res) => {
  const tpl = await getActiveTemplateByToken(req.params.token);
  const sub = await submitTemplate({ req, tpl, body: req.body });
  res.status(201).json({ submission: submissionDto(sub) });
});

r.get('/submissions/:token/download', async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, t.name AS template_name FROM submissions s JOIN templates t ON t.id=s.template_id WHERE s.download_token=$1`,
    [String(req.params.token)],
  );
  if (!rows[0]) throw notFound('File not found');
  sendPdf(res, await readFile(rows[0].signed_path), `${rows[0].template_name}-signed.pdf`.replace(/[^\w\-. ]+/g, ''));
});

// Profile photos (file names are random UUIDs; only keys referenced by a user are served).
r.get('/avatars/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!/^[0-9a-f-]{36}\.(png|jpg)$/i.test(file)) throw notFound('Not found');
  const { rows } = await query(`SELECT avatar_path FROM users WHERE avatar_path=$1`, [`avatars/${file}`]);
  if (!rows[0]) throw notFound('Not found');
  const buf = await readFile(rows[0].avatar_path);
  res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.send(buf);
});

// Demo: upload + placements in one request → signed PDF back. Nothing is stored.
r.post('/demo/sign', demoLimiter, requirePermission('demo.use'), uploadPdf, async (req, res) => {
  if (!req.file) throw badRequest('Attach a PDF in the "file" field');
  let placements;
  try {
    placements = JSON.parse(req.body.placements || '[]');
  } catch {
    throw badRequest('placements must be a JSON array');
  }
  placements = parse(z.array(placementSchema).min(1), placements);
  const { pageCount } = await inspectPdf(req.file.buffer);
  const out = await stampPdf(req.file.buffer, placements);
  await logEvent({ req, type: 'demo.signed', meta: { pages: pageCount, placements: placements.length } });
  sendPdf(res, out, `${req.file.originalname.replace(/\.pdf$/i, '')}-signed.pdf`);
});

export default r;
