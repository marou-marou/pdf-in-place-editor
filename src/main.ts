
import "./style.css";
import { inspectPdf, type PdfTextItem } from "./pdfInspector";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App container not found.");
}

app.innerHTML = `
  <main class="editor">
    <h1>PDF In-Place Editor</h1>
    <p>Upload a PDF, select a word, and prepare a replacement.</p>

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

      <p id="edit-status" role="status">
        Select a word to begin editing.
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
const applyReplacementButton =
  document.querySelector<HTMLButtonElement>("#apply-replacement")!;
const editStatus = document.querySelector<HTMLElement>("#edit-status")!;

interface EditableTextItem extends PdfTextItem {
  originalText: string;
  replacementText?: string;
}

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

  const words = matches.map((match) => match[0]);
  const measuredWidths = words.map((word) =>
    context.measureText(word).width,
  );
  const totalWidth = measuredWidths.reduce(
    (sum, width) => sum + width,
    0,
  );

  if (totalWidth <= 0) {
    return [{ ...item, originalText: item.text }];
  }

  let consumedWidth = 0;

  return words.map((word, index) => {
    const width =
      index === words.length - 1
        ? item.width - consumedWidth
        : item.width * (measuredWidths[index] / totalWidth);

    const wordItem: EditableTextItem = {
      ...item,
      text: word,
      originalText: word,
      x: item.x + consumedWidth,
      width: Math.max(0, width),
    };

    consumedWidth += width;
    return wordItem;
  });
}

function selectText(
  item: EditableTextItem,
  button: HTMLButtonElement,
): void {
  if (selectedButton && selectedButton !== button) {
    selectedButton.classList.remove("selected");
    selectedButton.setAttribute("aria-pressed", "false");
  }

  selectedItem = item;
  selectedButton = button;

  button.classList.add("selected");
  button.setAttribute("aria-pressed", "true");

  selectedText.textContent = item.text || "(Empty text item)";
  selectedPosition.textContent =
    `${item.x.toFixed(1)}, ${item.y.toFixed(1)}`;
  selectedSize.textContent =
    `${item.width.toFixed(1)} × ${item.height.toFixed(1)}`;

  replacementInput.value = item.replacementText ?? item.text;
  replacementInput.disabled = false;
  applyReplacementButton.disabled = false;

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
  applyReplacementButton.disabled = true;

  editStatus.textContent = "Select a text item to begin editing.";
}

function applyVisualReplacement(
  item: EditableTextItem,
  button: HTMLButtonElement,
  replacement: string,
): void {
  item.replacementText = replacement;

  // Convert the measured PDF height into the displayed canvas size.
  const displayedCanvas = canvas.getBoundingClientRect();
  const displayScale = displayedCanvas.height / canvas.height;
  const fontSize = Math.max(8, item.height * displayScale * 0.8);

  // Turn the selection button into a visual cover and replacement label.
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

  // The selection is no longer active after applying the replacement.
  selectedItem = null;
  selectedButton = null;

  selectedText.textContent = replacement;
  selectedPosition.textContent =
    `${item.x.toFixed(1)}, ${item.y.toFixed(1)}`;
  selectedSize.textContent =
    `${item.width.toFixed(1)} × ${item.height.toFixed(1)}`;

  replacementInput.value = "";
  replacementInput.disabled = true;
  applyReplacementButton.disabled = true;

  selectionHint.textContent = "Visual replacement applied.";
  editStatus.textContent =
    "The replacement is visible in the preview. " +
    "The original PDF file has not been modified.";

  renderExtractedText();
}

input.addEventListener("change", async () => {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  overlay.replaceChildren();
  output.textContent = "";
  textItems = [];
  resetSelection();
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
    status.textContent =
      error instanceof Error
        ? `Error: ${error.message}`
        : "PDF inspection failed.";
  }
});

applyReplacementButton.addEventListener("click", () => {
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
