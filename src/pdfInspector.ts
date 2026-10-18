
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  direction: "ltr" | "rtl";
}

export async function inspectPdf(
  file: File,
  canvas: HTMLCanvasElement,
): Promise<PdfTextItem[]> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  if (pdf.numPages === 0) {
    throw new Error("The PDF has no pages.");
  }

  const page = await pdf.getPage(1);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas context is unavailable.");
  }

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
  }).promise;

  const content = await page.getTextContent();

  return content.items.flatMap((item) => {
    if (!("str" in item) || !("transform" in item)) {
      return [];
    }

    const transform = pdfjsLib.Util.transform(
      viewport.transform,
      item.transform,
    );

    const fontSize = Math.hypot(transform[2], transform[3]);
    const height = fontSize || item.height * scale;

    return [{
      text: item.str,
      x: transform[4],
      y: transform[5],
      width: item.width * scale,
      height,
      fontName: item.fontName,
      fontSize,
      direction: item.dir === "rtl" ? "rtl" : "ltr",
    }];
  });
}
