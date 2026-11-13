import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || httpCode(status);
    this.details = details;
  }
}

function httpCode(status) {
  return (
    { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'TOO_MANY_REQUESTS' }[status] ||
    'ERROR'
  );
}

export const badRequest = (m, code, details) => new HttpError(400, m, code, details);
export const unauthorized = (m = 'Authentication required', code) => new HttpError(401, m, code);
export const forbidden = (m = 'You do not have permission to do this', code) => new HttpError(403, m, code);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m, code) => new HttpError(409, m, code);

/** Validate `data` with a zod schema; throws a 400 HttpError listing the issues. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(details[0] ? `${details[0].path || 'body'}: ${details[0].message}` : 'Invalid request', 'VALIDATION_ERROR', details);
  }
  return r.data;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '').trim();

export function pagination(q, max = 100) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), max);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}
