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

const icon = {
  logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`,
  download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0-4-4m4 4 4-4M4 18v0a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2"/></svg>`,
  left: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  cursor: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6L5 3Z"/></svg>`,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container not found.");

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">${icon.logo}</span>
        <span class="brand-name">Inplace</span>
        <span class="brand-tag">PDF text editor</span>
      </div>
      <div class="topbar-actions">
        <label class="btn btn-ghost" for="pdf-file">${icon.upload}<span>Open PDF</span></label>
        <input id="pdf-file" class="visually-hidden" type="file" accept="application/pdf" />
        <button id="download-pdf" class="btn btn-primary" type="button" disabled>
          ${icon.download}<span>Download</span>
        </button>
      </div>
    </header>

    <main class="workspace">
      <section class="stage" aria-label="Document">
        <div class="stage-bar">
          <div class="segmented" role="radiogroup" aria-label="Selection mode">
            <label><input type="radio" name="mode" value="word" checked /><span>Word</span></label>
            <label><input type="radio" name="mode" value="line" /><span>Line</span></label>
          </div>
          <p id="status" class="status-pill" role="status">Waiting for a PDF...</p>
          <nav class="pager" hidden aria-label="Pages">
            <button id="prev-page" class="icon-btn" type="button" aria-label="Previous page">${icon.left}</button>
            <span id="page-label"></span>
            <button id="next-page" class="icon-btn" type="button" aria-label="Next page">${icon.right}</button>
          </nav>
        </div>

        <div class="canvas-area" id="drop-zone">
          <div class="empty-state" id="empty-state">
            <div class="empty-icon">${icon.upload}</div>
            <h1>Edit PDF text in place</h1>
            <p>Drop a PDF here, or open one. English, Arabic and mixed lines keep their font,
              position and spacing.</p>
            <div class="empty-actions">
              <label class="btn btn-primary" for="pdf-file">${icon.upload}<span>Choose a PDF</span></label>
              <button id="try-sample" class="btn btn-ghost" type="button">Try a sample</button>
            </div>
            <p class="empty-note">Everything runs on your device. Nothing is uploaded.</p>
          </div>
          <div id="page-wrapper" hidden>
            <canvas id="pdf-canvas"></canvas>
            <div id="text-overlay" aria-label="Editable PDF text"></div>
          </div>
        </div>
      </section>

      <aside class="inspector" aria-live="polite">
        <div class="card">
          <div class="card-head">
            <h2>Selection</h2>
            <span id="selected-dir" class="chip" hidden></span>
          </div>
          <p id="selected-text" class="selection-preview is-empty" dir="auto">
            ${icon.cursor}<span>Click a highlighted word on the page</span>
          </p>
          <form id="edit-form">
            <label class="field-label" for="replacement-text">Replace with</label>
            <input id="replacement-text" class="field" type="text" dir="auto" autocomplete="off" disabled />
            <button id="apply-replacement" class="btn btn-primary btn-block" type="submit" disabled>Replace</button>
          </form>
          <p id="edit-status" class="message" data-tone="info" role="status">Select a word to begin editing.</p>
        </div>

        <div class="card card-quiet">
          <h3>How it works</h3>
          <ul class="legend">
            <li><span class="swatch swatch-edit"></span>Editable text</li>
            <li><span class="swatch swatch-done"></span>Just edited</li>
            <li><span class="swatch swatch-locked"></span>Can't be edited</li>
          </ul>
          <p class="hint">Edits go into the PDF's own text, in the original font when it has the
            letters, so the result stays searchable. <kbd>Esc</kbd> clears the selection.</p>
        </div>
      </aside>
    </main>
  </div>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const input = $<HTMLInputElement>("#pdf-file");
const canvas = $<HTMLCanvasElement>("#pdf-canvas");
const overlay = $<HTMLDivElement>("#text-overlay");
const pageWrapper = $<HTMLDivElement>("#page-wrapper");
const emptyState = $<HTMLDivElement>("#empty-state");
const dropZone = $<HTMLDivElement>("#drop-zone");
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
let justEdited: string | null = null;

function message(text: string, tone: "info" | "success" | "error" = "info"): void {
  editStatus.textContent = text;
  editStatus.dataset.tone = tone;
}

function select(span: TextSpan | null, button?: HTMLButtonElement): void {
  overlay.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
  selected = span;
  button?.classList.add("selected");
  if (span) {
    selectedText.textContent = span.text;
    selectedText.classList.remove("is-empty");
  } else {
    selectedText.innerHTML = `${icon.cursor}<span>Click a highlighted ${mode} on the page</span>`;
    selectedText.classList.add("is-empty");
  }
  selectedDir.textContent = span ? (span.direction === "rtl" ? "RTL · Arabic" : "LTR") : "";
  selectedDir.hidden = !span;
  replacementInput.value = span?.text ?? "";
  replacementInput.disabled = !span;
  applyButton.disabled = !span;
  if (span) {
    replacementInput.focus();
    replacementInput.select();
    message(span.editable ? "Type the replacement and press Replace." : span.reason ?? "", span.editable ? "info" : "error");
  }
}

async function showPage(): Promise<void> {
  if (!editor || !currentBytes) return;
  const rendered = await renderPage(currentBytes, pageIndex, canvas);
  emptyState.hidden = true;
  pageWrapper.hidden = false;
  overlay.replaceChildren();
  const spans = mode === "line" ? editor.lines(pageIndex) : editor.words(pageIndex);
  for (const span of spans) {
    const [left, top, width, height] = rendered.toCanvasRect(span.box.x0, span.box.y0, span.box.x1, span.box.y1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-hitbox";
    if (justEdited && (span.text === justEdited || justEdited.split(" ").includes(span.text))) {
      button.classList.add("just-edited");
    }
    button.dataset.text = span.text;
    button.setAttribute("aria-label", `Edit ${mode}: ${span.text}`);
    button.disabled = !span.editable;
    button.title = span.editable ? span.text : span.reason ?? "";
    // Small padding so thin glyph boxes stay easy to hit.
    button.style.left = `calc(${(left / canvas.width) * 100}% - 2px)`;
    button.style.top = `calc(${(top / canvas.height) * 100}% - 2px)`;
    button.style.width = `calc(${(width / canvas.width) * 100}% + 4px)`;
    button.style.height = `calc(${(height / canvas.height) * 100}% + 4px)`;
    button.addEventListener("click", () => select(span, button));
    overlay.append(button);
  }
  pager.hidden = editor.pageCount < 2;
  pageLabel.textContent = `${pageIndex + 1} / ${editor.pageCount}`;
  prevButton.disabled = pageIndex === 0;
  nextButton.disabled = pageIndex >= editor.pageCount - 1;
}

async function openFile(file: File): Promise<void> {
  status.textContent = "Reading PDF...";
  status.dataset.tone = "busy";
  select(null);
  try {
    currentBytes = new Uint8Array(await file.arrayBuffer());
    editor = await PdfTextEditor.load(currentBytes, fonts);
    fileName = file.name;
    pageIndex = 0;
    justEdited = null;
    downloadButton.disabled = true;
    await showPage();
    status.textContent = `${editor.pageCount} page(s) · ${editor.words(0).length} words on page 1`;
    status.dataset.tone = "ready";
    message(`Select a ${mode} to begin editing.`);
  } catch (error) {
    editor = null;
    status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    status.dataset.tone = "error";
  }
}

// Bundled sample (Arabic in two fonts, English, a mixed line) for first-time visitors.
$<HTMLButtonElement>("#try-sample").addEventListener("click", async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/sample-arabic-english.pdf`);
  if (!res.ok) {
    status.textContent = "The sample PDF is missing.";
    status.dataset.tone = "error";
    return;
  }
  const blob = await res.blob();
  void openFile(new File([blob], "sample-arabic-english.pdf", { type: "application/pdf" }));
});

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void openFile(file);
});

// Drag and drop onto the stage.
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files[0];
  if (file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) void openFile(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editor || !selected) return;
  applyButton.disabled = true;
  applyButton.classList.add("is-busy");
  const replacement = replacementInput.value;
  try {
    const result =
      mode === "line"
        ? await editor.replaceLine(pageIndex, selected.id, replacement)
        : await editor.replaceWord(pageIndex, selected.id, replacement);
    // Re-render from the saved bytes so the preview is exactly the output file.
    currentBytes = await editor.save();
    justEdited = replacement.trim();
    select(null);
    await showPage();
    downloadButton.disabled = false;
    message(
      [result.usedFallback ? "Replaced using a bundled font." : "Replaced in the original font.", ...result.notes].join(" "),
      "success",
    );
  } catch (error) {
    applyButton.disabled = false;
    message(error instanceof Error ? error.message : String(error), "error");
  } finally {
    applyButton.classList.remove("is-busy");
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
    message(`Select a ${mode} to begin editing.`);
    void showPage();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selected) select(null);
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
