
import "./style.css";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { inspectPdf, type PdfTextItem } from "./pdfInspector";

const RENDER_SCALE = 1.5;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found.");
}

app.innerHTML = `
  <main class="editor">
    <h1>PDF In-Place Editor</h1>
    <p>Upload a PDF, select text, and preview a replacement.</p>

    <label for="pdf-file">Choose a PDF file</label>
    <input id="pdf-file" type="file" accept="application/pdf" />

    <p id="status" role="status">Waiting for a PDF...</p>

    <div class="pdf-container">
      <div id="page-wrapper">
        <canvas id="pdf-canvas"></canvas>
        <div id="text-overlay" aria-label="Selectable PDF text"></div>
      </div>
    </div>

    <section id="selection-panel" aria-live="polite">
      <h2>Selected Text</h2>
      <p id="selection-hint">Click a text highlight in the PDF.</p>

      <dl>
        <dt>Text</dt>
        <dd id="selected-text">None</dd>

        <dt>Position (x, y)</dt>
        <dd id="selected-position">—</dd>

        <dt>Dimensions (width × height)</dt>
        <dd id="selected-size">—</dd>
      </dl>

      <label for="replacement-text">Replacement text</label>
      <input
        id="replacement-text"
        type="text"
        placeholder="Enter replacement text"
        disabled
      />

      <button id="apply-replacement" type="button" disabled>
        Apply Replacement
      </button>

      <button id="download-pdf" type="button" disabled>
        Download Edited PDF
      </button>

      <p id="edit-status" role="status">
        Select text to begin editing.
      </p>
    </section>

    <h2>Extracted Text</h2>
    <pre id="text-output"></pre>
  </main>
`;

const input = document.querySelector<HTMLInputElement>("#pdf-file")!;
const canvas = document.querySelector<HTMLCanvasElement>("#pdf-canvas")!;
const overlay = document.querySelector<HTMLDivElement>("#text-overlay")!;
const output = document.querySelector<HTMLPreElement>("#text-output")!;
const status = document.querySelector<HTMLElement>("#status")!;
const selectedText = document.querySelector<HTMLElement>("#selected-text")!;
const selectedPosition = document.querySelector<HTMLElement>(
  "#selected-position",
)!;
const selectedSize = document.querySelector<HTMLElement>("#selected-size")!;
const selectionHint = document.querySelector<HTMLElement>("#selection-hint")!;
const replacementInput =
  document.querySelector<HTMLInputElement>("#replacement-text")!;
const applyButton =
  document.querySelector<HTMLButtonElement>("#apply-replacement")!;
const downloadButton =
  document.querySelector<HTMLButtonElement>("#download-pdf")!;
const editStatus = document.querySelector<HTMLElement>("#edit-status")!;

interface EditableTextItem extends PdfTextItem {
  originalText: string;
  replacementText?: string;
}

let originalFile: File | null = null;
let textItems: EditableTextItem[] = [];
let selectedItem: EditableTextItem | null = null;
let selectedButton: HTMLButtonElement | null = null;

function splitIntoWords(item: PdfTextItem): EditableTextItem[] {
  const matches = [...item.text.matchAll(/\S+/g)];

  if (matches.length <= 1) {
    return [{ ...item, originalText: item.text }];
  }

  const measureCanvas = document.createElement("canvas");
  const context = measureCanvas.getContext("2d");

  if (!context) {
    return [{ ...item, originalText: item.text }];
  }

  // Use PDF.js's reported item width as the total width.
  // Browser measurements estimate each word's relative boundaries.
  const fullWidth = context.measureText(item.text).width;

  if (fullWidth <= 0) {
    return [{ ...item, originalText: item.text }];
  }

  return matches.map((match) => {
    const word = match[0];
    const start = match.index;
    const end = start + word.length;

    const startRatio =
      context.measureText(item.text.slice(0, start)).width / fullWidth;
    const endRatio =
      context.measureText(item.text.slice(0, end)).width / fullWidth;

    const relativeX = item.width * startRatio;
    const wordWidth = item.width * (endRatio - startRatio);

    return {
      ...item,
      text: word,
      originalText: word,
      x: item.direction === "rtl"
        ? item.x + item.width - relativeX - wordWidth
        : item.x + relativeX,
      width: Math.max(1, wordWidth),
    };
  });
}

function selectText(
  item: EditableTextItem,
  button: HTMLButtonElement,
): void {
  if (selectedButton) {
    selectedButton.classList.remove("selected");
    selectedButton.setAttribute("aria-pressed", "false");
  }

  selectedItem = item;
  selectedButton = button;

  button.classList.add("selected");
  button.setAttribute("aria-pressed", "true");

  selectedText.textContent = item.replacementText ?? item.text;
  selectedPosition.textContent =
    `${item.x.toFixed(1)}, ${item.y.toFixed(1)}`;
  selectedSize.textContent =
    `${item.width.toFixed(1)} × ${item.height.toFixed(1)}`;

  replacementInput.value = item.replacementText ?? item.text;
  replacementInput.disabled = false;
  applyButton.disabled = false;

  selectionHint.textContent = "Text item selected.";
  editStatus.textContent =
    "Enter replacement text and click Apply Replacement.";
}

function createTextHighlight(
  item: EditableTextItem,
): HTMLButtonElement {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "text-hitbox";
  button.title = `Select: ${item.text}`;
  button.setAttribute("aria-label", `Select text: ${item.text}`);
  button.setAttribute("aria-pressed", "false");

  button.style.left = `${(item.x / canvas.width) * 100}%`;
  button.style.top =
    `${((item.y - item.height) / canvas.height) * 100}%`;
  button.style.width = `${(item.width / canvas.width) * 100}%`;
  button.style.height = `${(item.height / canvas.height) * 100}%`;

  button.addEventListener("click", () => selectText(item, button));

  return button;
}

function renderExtractedText(): void {
  output.textContent = textItems
    .map((item) => {
      const displayText = item.replacementText ?? item.text;
      return `${displayText} | x=${item.x.toFixed(1)} | y=${item.y.toFixed(1)} | width=${item.width.toFixed(1)}`;
    })
    .join("\n");
}

function resetSelection(): void {
  selectedItem = null;
  selectedButton = null;

  selectedText.textContent = "None";
  selectedPosition.textContent = "—";
  selectedSize.textContent = "—";
  selectionHint.textContent = "Click a text highlight in the PDF.";

  replacementInput.value = "";
  replacementInput.disabled = true;
  applyButton.disabled = true;

  editStatus.textContent = "Select text to begin editing.";
}

function applyVisualReplacement(
  item: EditableTextItem,
  button: HTMLButtonElement,
  replacement: string,
): void {
  item.replacementText = replacement;

  const displayScale =
    canvas.getBoundingClientRect().height / canvas.height;
  const fontSize = Math.max(8, item.height * displayScale * 0.8);

  button.classList.remove("selected");
  button.classList.add("replaced");
  button.textContent = replacement;
  button.title = `Replacement: ${replacement}`;
  button.setAttribute("aria-label", `Replacement text: ${replacement}`);
  button.setAttribute("aria-pressed", "false");

  button.style.width = "max-content";
  button.style.minWidth = `${Math.max(1, item.width * displayScale)}px`;
  button.style.height = `${Math.max(1, item.height * displayScale)}px`;
  button.style.fontSize = `${fontSize}px`;
  button.style.lineHeight = "1";
  button.style.padding = "0";
  button.style.textAlign = "left";
  button.style.whiteSpace = "pre";
  button.style.overflow = "visible";

  selectedItem = null;
  selectedButton = null;

  selectedText.textContent = replacement;
  replacementInput.value = "";
  replacementInput.disabled = true;
  applyButton.disabled = true;

  downloadButton.disabled = !textItems.some(
    (textItem) => textItem.replacementText !== undefined,
  );

  selectionHint.textContent = "Visual replacement applied.";
  editStatus.textContent =
    "Preview updated. Download the edited PDF to save the replacement.";

  renderExtractedText();
}

async function downloadEditedPdf(): Promise<void> {
  if (!originalFile) {
    editStatus.textContent = "Please upload a PDF first.";
    return;
  }

  const replacements = textItems.filter(
    (item) => item.replacementText !== undefined,
  );

  if (replacements.length === 0) {
    editStatus.textContent = "Apply a replacement before downloading.";
    return;
  }

  try {
    downloadButton.disabled = true;
    editStatus.textContent = "Preparing the edited PDF...";

    const pdfDoc = await PDFDocument.load(await originalFile.arrayBuffer());
    const page = pdfDoc.getPages()[0];

    if (!page) {
      throw new Error("The PDF has no pages.");
    }

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pageHeight = page.getHeight();
    const pageWidth = page.getWidth();

    for (const item of replacements) {
      const replacement = item.replacementText!;

      if (!/^[\x20-\x7E]*$/.test(replacement)) {
        throw new Error(
          "This export version supports basic English ASCII text only. " +
          "Arabic and other Unicode text require custom font embedding.",
        );
      }

      const x = item.x / RENDER_SCALE;
      const baselineY = pageHeight - item.y / RENDER_SCALE;
      const height = Math.max(item.height / RENDER_SCALE, 1);
      const originalWidth = Math.max(item.width / RENDER_SCALE, 1);
      const padding = 1;

      const coverX = Math.max(0, x - padding);
      const coverWidth = Math.min(
        originalWidth + padding * 2,
        pageWidth - coverX,
      );
      const coverBottom = Math.max(0, baselineY - height * 0.3);
      const coverHeight = Math.min(
        height * 1.35,
        pageHeight - coverBottom,
      );

      page.drawRectangle({
        x: coverX,
        y: coverBottom,
        width: coverWidth,
        height: coverHeight,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });

      const fontSize = Math.max(6, height * 0.8);

      page.drawText(replacement, {
        x: coverX + padding,
        y: baselineY - fontSize * 0.2,
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }

    const editedBytes = await pdfDoc.save();
    const blob = new Blob([editedBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `edited-${originalFile.name}`;
    document.body.append(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    editStatus.textContent =
      "Download started. Open the exported PDF to verify the replacement.";
  } catch (error) {
    editStatus.textContent =
      error instanceof Error
        ? error.message
        : "Could not export the PDF.";
  } finally {
    downloadButton.disabled = !textItems.some(
      (item) => item.replacementText !== undefined,
    );
  }
}

input.addEventListener("change", async () => {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  originalFile = file;
  overlay.replaceChildren();
  output.textContent = "";
  textItems = [];
  resetSelection();
  downloadButton.disabled = true;
  status.textContent = "Inspecting PDF...";

  try {
    const items = await inspectPdf(file, canvas);
    textItems = items.flatMap(splitIntoWords);

    for (const item of textItems) {
      overlay.append(createTextHighlight(item));
    }

    renderExtractedText();

    status.textContent =
      `Found ${items.length} text items on page 1. ` +
      `Created ${textItems.length} selectable text regions.`;
  } catch (error) {
    originalFile = null;
    status.textContent =
      error instanceof Error
        ? `Error: ${error.message}`
        : "PDF inspection failed.";
  }
});

applyButton.addEventListener("click", () => {
  if (!selectedItem || !selectedButton) {
    editStatus.textContent = "Select a text item first.";
    return;
  }

  const replacement = replacementInput.value;

  if (!replacement.trim()) {
    editStatus.textContent = "Replacement text cannot be empty.";
    return;
  }

  applyVisualReplacement(selectedItem, selectedButton, replacement);
});

downloadButton.addEventListener("click", () => {
  void downloadEditedPdf();
});
