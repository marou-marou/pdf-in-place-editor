
import "./style.css";
import { inspectPdf, type PdfTextItem } from "./pdfInspector";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found.");
}

app.innerHTML = `
  <main class="editor">
    <h1>PDF In-Place Editor</h1>
    <p>Upload a PDF to inspect its existing text.</p>

    <input id="pdf-file" type="file" accept="application/pdf" />

    <p id="status" role="status">Waiting for a PDF...</p>

    <div class="pdf-container">
      <canvas id="pdf-canvas"></canvas>
    </div>

    <h2>Extracted text</h2>
    <pre id="text-output"></pre>
  </main>
`;

const input = document.querySelector<HTMLInputElement>("#pdf-file")!;
const canvas = document.querySelector<HTMLCanvasElement>("#pdf-canvas")!;
const output = document.querySelector<HTMLPreElement>("#text-output")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

input.addEventListener("change", async () => {
  const file = input.files?.[0];

  if (!file) return;

  status.textContent = "Inspecting PDF...";
  output.textContent = "";

  try {
    const items: PdfTextItem[] = await inspectPdf(file, canvas);

    output.textContent = items
      .map(
        (item) =>
          `${item.text} | x=${item.x.toFixed(1)} | y=${item.y.toFixed(1)} | width=${item.width.toFixed(1)}`,
      )
      .join("\n");

    status.textContent = `Found ${items.length} text items on page 1.`;
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? `Error: ${error.message}`
        : "PDF inspection failed.";
  }
});
