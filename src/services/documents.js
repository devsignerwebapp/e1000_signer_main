import { query } from '../db/pool.js';
import { notFound } from '../utils/http.js';
import { inspectPdf, stampPdf } from './pdf.js';
import { readFile, removeFile, saveFile } from './storage.js';
import { logEvent } from './events.js';
import { fireWebhook } from './webhooks.js';

export const documentDto = (d) => ({
  id: d.id,
  title: d.title,
  originalName: d.original_name,
  pageCount: d.page_count,
  sizeBytes: Number(d.size_bytes),
  status: d.status,
  source: d.source,
  isSigned: !!d.signed_path,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

export async function createDocument({ req, buffer, originalName, title, source = 'web' }) {
  const { pageCount } = await inspectPdf(buffer);
  const rel = await saveFile('uploads', buffer);
  const name = (originalName || 'document.pdf').slice(0, 255);
  const { rows } = await query(
    `INSERT INTO documents(owner_id,title,original_name,file_path,page_count,size_bytes,source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id, (title || name.replace(/\.pdf$/i, '')).slice(0, 200), name, rel, pageCount, buffer.length, source],
  );
  await logEvent({ req, type: 'document.uploaded', entityId: rows[0].id, meta: { pages: pageCount, source } });
  return rows[0];
}

export async function listDocuments(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(`SELECT * FROM documents WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
  return rows;
}

export async function getOwnedDocument(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Document not found');
  const { rows } = await query(`SELECT * FROM documents WHERE id=$1 AND owner_id=$2`, [id, userId]);
  if (!rows[0]) throw notFound('Document not found');
  return rows[0];
}

/** Stamps placements on the ORIGINAL file (re-signing replaces the previous signed version). */
export async function signDocument({ req, doc, placements, source = 'web' }) {
  const signed = await stampPdf(await readFile(doc.file_path), placements);
  const rel = await saveFile('signed', signed);
  const old = doc.signed_path;
  const { rows } = await query(
    `UPDATE documents SET signed_path=$1, status='signed', updated_at=now() WHERE id=$2 RETURNING *`,
    [rel, doc.id],
  );
  await removeFile(old);
  await logEvent({ req, type: 'document.signed', entityId: doc.id, meta: { placements: placements.length, source } });
  fireWebhook(req.user.id, 'document.signed', { document: documentDto(rows[0]) });
  return rows[0];
}

export async function deleteDocument({ req, doc }) {
  await query(`DELETE FROM documents WHERE id=$1`, [doc.id]);
  await Promise.all([removeFile(doc.file_path), removeFile(doc.signed_path)]);
  await logEvent({ req, type: 'document.deleted', entityId: doc.id });
}

export function sendPdf(res, buffer, filename, inline = false) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
}

export const signedName = (doc) => `${doc.title.replace(/[^\w\- ]+/g, '').trim() || 'document'}-signed.pdf`;
