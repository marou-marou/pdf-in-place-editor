import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export const RENDER_SCALE = 1.5;

export interface RenderedPage {
  pageCount: number;
  /** Converts a user-space rectangle to canvas pixels: [left, top, width, height]. */
  toCanvasRect(x0: number, y0: number, x1: number, y1: number): [number, number, number, number];
}

/** Renders one page with pdf.js; pdf.js is used for display only, never for editing. */
export async function renderPage(
  bytes: Uint8Array,
  pageIndex: number,
  canvas: HTMLCanvasElement,
): Promise<RenderedPage> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context is unavailable.");

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  const pageCount = pdf.numPages;
  await task.destroy();
  return {
    pageCount,
    toCanvasRect(x0, y0, x1, y1) {
      const [a, b] = viewport.convertToViewportPoint(x0, y0) as [number, number];
      const [c, d] = viewport.convertToViewportPoint(x1, y1) as [number, number];
      return [Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)];
    },
  };
}
