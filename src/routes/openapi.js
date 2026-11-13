import { env } from '../config/env.js';

// OpenAPI 3.1 description of /api/v1 — import into Postman, Insomnia, Swagger UI,
// or generate SDKs with openapi-generator for any language.
export function openapiSpec() {
  const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
  const json = (schema) => ({ content: { 'application/json': { schema } } });
  const pdf = { description: 'PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } };
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const uploadBody = {
    required: true,
    content: {
      'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' }, placements: { type: 'string', description: 'JSON array (only for /sign)' } } } },
      'application/json': { schema: { type: 'object', required: ['fileBase64'], properties: { fileBase64: { type: 'string' }, fileName: { type: 'string' }, title: { type: 'string' }, placements: { type: 'array', items: ref('Placement') } } } },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'E1000Signer API',
      version: '1.0.0',
      description: 'Upload PDFs, stamp signatures, manage templates and collect client signatures. Authenticate with an API key from Dashboard → Developers.',
    },
    servers: [{ url: `${env.apiPublicUrl}/api/v1` }],
    security: [{ ApiKey: [] }],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      schemas: {
        Placement: {
          type: 'object',
          required: ['page', 'x', 'y', 'w', 'h'],
          description: 'A box on a page. Origin = top-left of the visible page. Provide either image or text.',
          properties: {
            page: { type: 'integer', minimum: 0, description: '0-based page index' },
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
            unit: { type: 'string', enum: ['ratio', 'pt'], default: 'ratio', description: 'ratio = 0..1 of page size; pt = PDF points' },
            image: { type: 'string', description: 'PNG/JPEG as data URL or base64' },
            text: { type: 'string', maxLength: 500 },
            color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Text colour, e.g. #1b2a8f (text placements only)' },
          },
        },
        Document: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, originalName: { type: 'string' }, pageCount: { type: 'integer' }, sizeBytes: { type: 'integer' }, status: { type: 'string', enum: ['uploaded', 'signed'] }, isSigned: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' } },
        },
        Field: {
          type: 'object',
          required: ['id', 'page', 'x', 'y', 'w', 'h'],
          properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['signature', 'initials', 'text', 'date'] }, label: { type: 'string' }, page: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, required: { type: 'boolean' } },
        },
        Template: {
          type: 'object',
          properties: { id: { type: 'string' }, documentId: { type: 'string' }, name: { type: 'string' }, message: { type: 'string' }, allowedSignTypes: { type: 'array', items: { type: 'string', enum: ['draw', 'type', 'upload'] } }, fields: { type: 'array', items: ref('Field') }, shareUrl: { type: 'string' }, isActive: { type: 'boolean' }, submissionCount: { type: 'integer' } },
        },
        Submission: {
          type: 'object',
          properties: { id: { type: 'string' }, templateId: { type: 'string' }, signerName: { type: 'string' }, signerEmail: { type: 'string' }, signTypesUsed: { type: 'array', items: { type: 'string' } }, downloadUrl: { type: 'string' }, createdAt: { type: 'string' } },
        },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
      },
    },
    paths: {
      '/me': { get: { summary: 'Current API key owner', responses: { 200: { description: 'OK' } } } },
      '/documents': {
        get: { summary: 'List documents', responses: { 200: json({ type: 'object', properties: { data: { type: 'array', items: ref('Document') } } }) } },
        post: { summary: 'Upload a PDF', requestBody: uploadBody, responses: { 201: json({ type: 'object', properties: { data: ref('Document') } }) } },
      },
      '/documents/{id}': {
        get: { summary: 'Get document', parameters: [idParam], responses: { 200: json({ type: 'object', properties: { data: ref('Document') } }) } },
        delete: { summary: 'Delete document', parameters: [idParam], responses: { 204: { description: 'Deleted' } } },
      },
      '/documents/{id}/sign': {
        post: { summary: 'Stamp signatures onto a stored document', parameters: [idParam], requestBody: { required: true, ...json({ type: 'object', required: ['placements'], properties: { placements: { type: 'array', items: ref('Placement') } } }) }, responses: { 200: json({ type: 'object', properties: { data: ref('Document') } }) } },
      },
      '/documents/{id}/download': {
        get: { summary: 'Download the signed (or original) PDF', parameters: [idParam, { name: 'version', in: 'query', schema: { type: 'string', enum: ['signed', 'original'] } }], responses: { 200: pdf } },
      },
      '/sign': { post: { summary: 'One-shot: send a PDF + placements, receive the signed PDF (nothing stored)', requestBody: uploadBody, responses: { 200: pdf } } },
      '/templates': {
        get: { summary: 'List templates', responses: { 200: json({ type: 'object', properties: { data: { type: 'array', items: ref('Template') } } }) } },
        post: { summary: 'Create a template from a document', requestBody: { required: true, ...json({ type: 'object', required: ['documentId', 'name', 'fields'], properties: { documentId: { type: 'string' }, name: { type: 'string' }, message: { type: 'string' }, allowedSignTypes: { type: 'array', items: { type: 'string' } }, fields: { type: 'array', items: ref('Field') } } }) }, responses: { 201: json({ type: 'object', properties: { data: ref('Template') } }) } },
      },
      '/templates/{id}': {
        get: { summary: 'Get template', parameters: [idParam], responses: { 200: json({ type: 'object', properties: { data: ref('Template') } }) } },
        patch: { summary: 'Update template', parameters: [idParam], responses: { 200: json({ type: 'object', properties: { data: ref('Template') } }) } },
      },
      '/templates/{id}/send': { post: { summary: 'Email the signing link to clients', parameters: [idParam], requestBody: json({ type: 'object', required: ['emails'], properties: { emails: { type: 'array', items: { type: 'string', format: 'email' } }, message: { type: 'string' } } }), responses: { 200: { description: 'OK' } } } },
      '/templates/{id}/submissions': { get: { summary: 'List client submissions', parameters: [idParam], responses: { 200: json({ type: 'object', properties: { data: { type: 'array', items: ref('Submission') } } }) } } },
    },
    webhooks: {
      'submission.created': { post: { summary: 'A client signed a template', requestBody: json({ type: 'object' }), responses: { 200: { description: 'Acknowledge' } } } },
      'document.signed': { post: { summary: 'A document was signed', requestBody: json({ type: 'object' }), responses: { 200: { description: 'Acknowledge' } } } },
    },
  };
}
