// PDF engine: validation + stamping signatures / text onto the ORIGINAL pdf.
//
// Coordinates arrive in the "viewed" space the browser renders (pdf.js viewport):
// origin top-left, x/y/w/h normalized to 0..1 of the visible (crop box, rotated)
// page. We map that back to unrotated PDF user space here, so output matches
// exactly what the signer saw in the HTML viewer.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { badRequest } from '../utils/http.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export async function inspectPdf(buffer) {
  if (!buffer || buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw badRequest('The file is not a valid PDF', 'INVALID_PDF');
  }
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    return { pageCount: doc.getPageCount() };
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw badRequest('Password-protected PDFs are not supported', 'ENCRYPTED_PDF');
    throw badRequest('Could not read this PDF', 'INVALID_PDF');
  }
}

export function decodeImage(dataUrlOrBase64) {
  if (typeof dataUrlOrBase64 !== 'string') throw badRequest('image must be a data URL or base64 string');
  const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(dataUrlOrBase64);
  const b64 = m ? m[3] : dataUrlOrBase64;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('Signature image is too large (max 3 MB)', 'IMAGE_TOO_LARGE');
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpg) throw badRequest('Signature image must be PNG or JPEG', 'INVALID_IMAGE');
  return { bytes, kind: isPng ? 'png' : 'jpg' };
}

function viewInfo(page) {
  const box = page.getCropBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return { box, rot, viewW: swap ? box.height : box.width, viewH: swap ? box.width : box.height };
}

/** Map a normalized viewed point (U,V; V down) to PDF user space. */
function mapPoint({ box, rot }, U, V) {
  const { x: bx, y: by, width: W, height: H } = box;
  switch (rot) {
    case 90: return { x: bx + V * W, y: by + U * H };
    case 180: return { x: bx + (1 - U) * W, y: by + V * H };
    case 270: return { x: bx + (1 - V) * W, y: by + (1 - U) * H };
    default: return { x: bx + U * W, y: by + (1 - V) * H };
  }
}

/** Convert a placement into pdf-lib draw params (anchor = viewed bottom-left corner). */
function rectToPdf(info, { x, y, w, h }) {
  const anchor = mapPoint(info, x, y + h);
  return { ...anchor, width: w * info.viewW, height: h * info.viewH, rotate: degrees(info.rot) };
}

/**
 * placements: [{ page (0-based), x, y, w, h, unit?: 'ratio'|'pt', image?: dataURL, text?: string }]
 * With unit 'pt', x/y/w/h are PDF points measured from the visible top-left corner.
 */
export async function stampPdf(buffer, placements) {
  if (!Array.isArray(placements) || placements.length === 0) throw badRequest('At least one placement is required', 'NO_PLACEMENTS');
  if (placements.length > 200) throw badRequest('Too many placements (max 200)');

  const doc = await PDFDocument.load(buffer);
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const imageCache = new Map();

  for (const [i, p] of placements.entries()) {
    const page = pages[p.page];
    if (!page) throw badRequest(`placements[${i}].page ${p.page} does not exist (document has ${pages.length} pages)`);
    const info = viewInfo(page);
    let rect = { x: +p.x, y: +p.y, w: +p.w, h: +p.h };
    if (p.unit === 'pt') rect = { x: rect.x / info.viewW, y: rect.y / info.viewH, w: rect.w / info.viewW, h: rect.h / info.viewH };
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0 || rect.x < -0.01 || rect.y < -0.01 || rect.x + rect.w > 1.01 || rect.y + rect.h > 1.01) {
      throw badRequest(`placements[${i}] is outside the page bounds`, 'INVALID_PLACEMENT');
    }
    const d = rectToPdf(info, rect);

    if (p.image) {
      let img = imageCache.get(p.image);
      if (!img) {
        const { bytes, kind } = decodeImage(p.image);
        img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        imageCache.set(p.image, img);
      }
      // Fit image inside the box while preserving aspect ratio (centered).
      const scale = Math.min(d.width / img.width, d.height / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const off = offsetInRotated(info.rot, (d.width - iw) / 2, (d.height - ih) / 2);
      page.drawImage(img, { x: d.x + off.x, y: d.y + off.y, width: iw, height: ih, rotate: d.rotate });
    } else if (typeof p.text === 'string' && p.text.trim()) {
      const text = p.text.trim().slice(0, 500);
      try {
        font.encodeText(text);
      } catch {
        throw badRequest(`placements[${i}].text contains characters the built-in font cannot encode; send it as an image instead`, 'UNSUPPORTED_TEXT');
      }
      let size = Math.min(d.height * 0.7, 28);
      while (size > 5 && font.widthOfTextAtSize(text, size) > d.width) size -= 0.5;
      const off = offsetInRotated(info.rot, 2, (d.height - size) / 2 + size * 0.2);
      page.drawText(text, { x: d.x + off.x, y: d.y + off.y, size, font, color: hexToRgb(p.color), rotate: d.rotate });
    } else {
      throw badRequest(`placements[${i}] needs an "image" or "text"`, 'INVALID_PLACEMENT');
    }
  }

  doc.setModificationDate(new Date());
  doc.setProducer('E1000Signer');
  return Buffer.from(await doc.save());
}

/** "#rrggbb" → pdf-lib rgb(); defaults to dark navy ink. */
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '')
  if (!m) return rgb(0.05, 0.07, 0.2);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Rotate an (dx along width, dy along height) offset into PDF space for a rotated draw. */
function offsetInRotated(rot, dx, dy) {
  switch (rot) {
    case 90: return { x: -dy, y: dx };
    case 180: return { x: -dx, y: -dy };
    case 270: return { x: dy, y: -dx };
    default: return { x: dx, y: dy };
  }
}
