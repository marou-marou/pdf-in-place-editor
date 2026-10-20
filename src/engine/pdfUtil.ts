import { decodePDFRawStream, PDFRawStream, type PDFStream } from "pdf-lib";

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2: apply m1 first, then m2 (PDF row-vector convention). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty];

/** Decoded bytes of any pdf-lib stream object. */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  // pdf-lib's own flate streams (e.g. created earlier in this session).
  const flate = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
  return flate.getUnencodedContents ? flate.getUnencodedContents() : stream.getContents();
}
