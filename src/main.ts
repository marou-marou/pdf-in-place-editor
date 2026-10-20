import "./style.css";
import { PdfTextEditor, type FallbackKind, type FontProvider, type TextSpan } from "./engine";
import { renderPage } from "./pdfRenderer";

const FONT_FILES: Record<FallbackKind, [string, string]> = {
  arabic: ["NotoNaskhArabic-Regular.ttf", "NotoNaskhArabic-Bold.ttf"],
  latin: ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"],
};

// Fonts are served by this app (public/fonts); no third-party requests.
const fonts: FontProvider = {
  async load(kind, bold) {
    const file = FONT_FILES[kind][bold ? 1 : 0];
    const res = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`);
    if (!res.ok) throw new Error(`Bundled font ${file} is missing (run npm run fonts).`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container not found.");

app.innerHTML = `
  <main class="editor">
    <h1>PDF In-Place Editor</h1>
    <p>Open a PDF, click a word or a line, type its replacement and save. Text is edited in the
      page content stream, not drawn over.</p>

    <label for="pdf-file">Choose a PDF file</label>
    <input id="pdf-file" type="file" accept="application/pdf" />
    <p id="status" role="status">Waiting for a PDF...</p>

    <fieldset class="mode">
      <legend>Select</legend>
      <label><input type="radio" name="mode" value="word" checked /> Word</label>
      <label><input type="radio" name="mode" value="line" /> Line</label>
    </fieldset>

    <nav class="pager" hidden>
      <button id="prev-page" type="button">Previous page</button>
      <span id="page-label"></span>
      <button id="next-page" type="button">Next page</button>
    </nav>

    <div class="pdf-container">
      <div id="page-wrapper">
        <canvas id="pdf-canvas"></canvas>
        <div id="text-overlay" aria-label="Editable PDF words"></div>
      </div>
    </div>

    <section id="selection-panel" aria-live="polite">
      <h2>Selection</h2>
      <dl>
        <dt>Text</dt>
        <dd id="selected-text" dir="auto">None</dd>
        <dt>Direction</dt>
        <dd id="selected-dir">—</dd>
      </dl>
      <form id="edit-form">
        <label for="replacement-text">Replacement text</label>
        <input id="replacement-text" type="text" dir="auto" disabled />
        <button id="apply-replacement" type="submit" disabled>Replace</button>
        <button id="download-pdf" type="button" disabled>Download edited PDF</button>
      </form>
      <p id="edit-status" role="status">Select a word to begin editing.</p>
    </section>
  </main>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const input = $<HTMLInputElement>("#pdf-file");
const canvas = $<HTMLCanvasElement>("#pdf-canvas");
const overlay = $<HTMLDivElement>("#text-overlay");
const status = $<HTMLElement>("#status");
const pager = $<HTMLElement>(".pager");
const pageLabel = $<HTMLElement>("#page-label");
const prevButton = $<HTMLButtonElement>("#prev-page");
const nextButton = $<HTMLButtonElement>("#next-page");
const selectedText = $<HTMLElement>("#selected-text");
const selectedDir = $<HTMLElement>("#selected-dir");
const form = $<HTMLFormElement>("#edit-form");
const replacementInput = $<HTMLInputElement>("#replacement-text");
const applyButton = $<HTMLButtonElement>("#apply-replacement");
const downloadButton = $<HTMLButtonElement>("#download-pdf");
const editStatus = $<HTMLElement>("#edit-status");

let editor: PdfTextEditor | null = null;
let fileName = "document.pdf";
let currentBytes: Uint8Array | null = null;
let pageIndex = 0;
let selected: TextSpan | null = null;
let mode: "word" | "line" = "word";

function select(word: TextSpan | null, button?: HTMLButtonElement): void {
  overlay.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
  selected = word;
  button?.classList.add("selected");
  selectedText.textContent = word?.text ?? "None";
  selectedDir.textContent = word ? word.direction.toUpperCase() : "—";
  replacementInput.value = word?.text ?? "";
  replacementInput.disabled = !word;
  applyButton.disabled = !word;
  if (word) {
    replacementInput.focus();
    replacementInput.select();
    editStatus.textContent = word.editable ? "Type the replacement and press Replace." : word.reason ?? "";
  }
}

async function showPage(): Promise<void> {
  if (!editor || !currentBytes) return;
  const rendered = await renderPage(currentBytes, pageIndex, canvas);
  overlay.replaceChildren();
  const spans = mode === "line" ? editor.lines(pageIndex) : editor.words(pageIndex);
  for (const word of spans) {
    const [left, top, width, height] = rendered.toCanvasRect(word.box.x0, word.box.y0, word.box.x1, word.box.y1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-hitbox";
    button.dataset.text = word.text;
    button.setAttribute("aria-label", `Edit ${mode}: ${word.text}`);
    button.disabled = !word.editable;
    button.style.left = `${(left / canvas.width) * 100}%`;
    button.style.top = `${(top / canvas.height) * 100}%`;
    button.style.width = `${(width / canvas.width) * 100}%`;
    button.style.height = `${(height / canvas.height) * 100}%`;
    button.addEventListener("click", () => select(word, button));
    overlay.append(button);
  }
  pager.hidden = editor.pageCount < 2;
  pageLabel.textContent = `Page ${pageIndex + 1} of ${editor.pageCount}`;
  prevButton.disabled = pageIndex === 0;
  nextButton.disabled = pageIndex >= editor.pageCount - 1;
}

input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  status.textContent = "Reading PDF...";
  select(null);
  try {
    currentBytes = new Uint8Array(await file.arrayBuffer());
    editor = await PdfTextEditor.load(currentBytes, fonts);
    fileName = file.name;
    pageIndex = 0;
    downloadButton.disabled = true;
    await showPage();
    const count = editor.words(0).length;
    status.textContent = `${editor.pageCount} page(s); ${count} words on page 1.`;
  } catch (error) {
    editor = null;
    status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editor || !selected) return;
  applyButton.disabled = true;
  try {
    const result =
      mode === "line"
        ? await editor.replaceLine(pageIndex, selected.id, replacementInput.value)
        : await editor.replaceWord(pageIndex, selected.id, replacementInput.value);
    // Re-render from the saved bytes so the preview is exactly the output file.
    currentBytes = await editor.save();
    select(null);
    await showPage();
    downloadButton.disabled = false;
    editStatus.textContent = [
      result.usedFallback ? "Replaced using a bundled font." : "Replaced in the original font.",
      ...result.notes,
    ].join(" ");
  } catch (error) {
    applyButton.disabled = false;
    editStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

downloadButton.addEventListener("click", () => {
  if (!currentBytes) return;
  const url = URL.createObjectURL(new Blob([currentBytes.slice()], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `edited-${fileName}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    mode = radio.value === "line" ? "line" : "word";
    select(null);
    editStatus.textContent = `Select a ${mode} to begin editing.`;
    void showPage();
  });
});

prevButton.addEventListener("click", () => {
  pageIndex = Math.max(0, pageIndex - 1);
  select(null);
  void showPage();
});
nextButton.addEventListener("click", () => {
  if (!editor) return;
  pageIndex = Math.min(editor.pageCount - 1, pageIndex + 1);
  select(null);
  void showPage();
});
