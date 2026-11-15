import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { uploadPdf } from '../middleware/common.js';
import { createDocument, deleteDocument, documentDto, getOwnedDocument, listDocuments, sendPdf, signDocument, signedName } from '../services/documents.js';
import { readFile } from '../services/storage.js';
import { analysisDto, requestAnalysis } from '../services/ai.js';
import { aiAvailable, aiLimiter } from './ai.js';
import { normLocale } from '../services/mailer.js';
import { badRequest, pagination, parse } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

export const placementSchema = z.object({
  page: z.number().int().min(0),
  x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
  unit: z.enum(['ratio', 'pt']).optional(),
  image: z.string().optional(),
  text: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb').optional(),
});

r.get('/', requirePermission('document.read'), async (req, res) => {
  res.json({ documents: (await listDocuments(req.user.id, pagination(req.query, 200))).map(documentDto) });
});

r.post('/', requirePermission('document.create'), uploadPdf, async (req, res) => {
  if (!req.file) throw badRequest('Attach a PDF in the "file" field');
  const doc = await createDocument({ req, buffer: req.file.buffer, originalName: req.file.originalname, title: req.body?.title });
  res.status(201).json({ document: documentDto(doc) });
});

r.get('/:id', requirePermission('document.read'), async (req, res) => {
  res.json({ document: documentDto(await getOwnedDocument(req.user.id, req.params.id)) });
});

// Original PDF bytes — rendered to HTML pages in the browser via pdf.js.
r.get('/:id/file', requirePermission('document.read'), async (req, res) => {
  const doc = await getOwnedDocument(req.user.id, req.params.id);
  sendPdf(res, await readFile(doc.file_path), doc.original_name, true);
});

r.post('/:id/sign', requirePermission('document.sign'), async (req, res) => {
  const { placements } = parse(z.object({ placements: z.array(placementSchema).min(1) }), req.body);
  const doc = await signDocument({ req, doc: await getOwnedDocument(req.user.id, req.params.id), placements });
  res.json({ document: documentDto(doc) });
});

r.get('/:id/download', requirePermission('document.read'), async (req, res) => {
  const doc = await getOwnedDocument(req.user.id, req.params.id);
  const signed = req.query.version !== 'original' && doc.signed_path;
  sendPdf(res, await readFile(signed ? doc.signed_path : doc.file_path), signed ? signedName(doc) : doc.original_name);
});

// AI legal analysis (Pro) of the original PDF. Returns 202 + { analysis } — poll GET /api/ai/analyses/:id.
r.post('/:id/analysis', aiAvailable, requirePermission('pro.ai_analysis'), aiLimiter, async (req, res) => {
  const doc = await getOwnedDocument(req.user.id, req.params.id);
  const a = await requestAnalysis({ req, pdf: await readFile(doc.file_path), lang: normLocale(req.body?.lang || req.headers['x-lang']), source: 'document', sourceId: doc.id, refresh: req.body?.refresh === true });
  res.status(a.status === 'pending' ? 202 : 200).json({ analysis: analysisDto(a) });
});

r.delete('/:id', requirePermission('document.delete'), async (req, res) => {
  await deleteDocument({ req, doc: await getOwnedDocument(req.user.id, req.params.id) });
  res.status(204).end();
});

export default r;
