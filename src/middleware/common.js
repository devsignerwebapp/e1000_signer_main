import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { badRequest, HttpError } from '../utils/http.js';

export const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : badRequest('Only PDF files are accepted', 'INVALID_FILE_TYPE'), ok);
  },
}).single('file');

const limiter = (windowMs, limit, message) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'TOO_MANY_REQUESTS', message } } });

export const authLimiter = limiter(15 * 60_000, 40, 'Too many authentication attempts, please try again later');
export const demoLimiter = limiter(60 * 60_000, 30, 'Demo limit reached, please create a free account to keep signing');
export const apiLimiter = limiter(60_000, 120, 'API rate limit exceeded (120 requests/minute)');
export const publicLimiter = limiter(15 * 60_000, 200, 'Too many requests');

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof multer.MulterError) {
    err = new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${env.maxUploadBytes / 1024 / 1024} MB` : err.message);
  }
  if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body too large');
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body');
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 && env.nodeEnv === 'production' ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
