// AI legal analysis (Pro) — polling endpoint. Starting an analysis lives next to its source:
//   POST /api/documents/:id/analysis           (owner's own document)
//   POST /api/public/sign/:token/analysis      (client on a signing link, signed in with Pro)
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { analysisDto, assertAiEnabled, getAnalysis } from '../services/ai.js';
import { notFound } from '../utils/http.js';

/** 503 AI_UNAVAILABLE (no API key yet) is checked before permissions, so the UI can say "coming soon". */
export const aiAvailable = (_req, _res, next) => {
  try { assertAiEnabled(); next(); } catch (e) { next(e); }
};

export const aiLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'AI analysis limit reached (30 per hour). Please try again later.' } },
});

const r = Router();
r.get('/analyses/:id', aiAvailable, requireAuth, requirePermission('pro.ai_analysis'), async (req, res) => {
  const a = await getAnalysis(req.params.id);
  if (!a) throw notFound('Analysis not found');
  res.json({ analysis: analysisDto(a) });
});
export default r;
