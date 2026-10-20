import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFPage,
} from "pdf-lib";
import { joiningForms } from "./arabic";
import { writeToUnicode } from "./cmap";
import {
  concatBytes,
  encodeLatin1,
  formatNumber,
  hexOf,
  parseOperations,
  serializeName,
  spliceOperations,
  type Operation,
} from "./contentStream";
import { encodeReplacement, type EncodedSegment, type FallbackKind } from "./encoder";
import { FallbackFont } from "./fallbackFont";
import { PdfFont, type LayoutFont } from "./fonts";
import { apply, invert, multiply, streamBytes } from "./pdfUtil";
import { layoutText, type PositionedGlyph, type ShowElement, type ShowOp, type TextState } from "./textLayout";
import { buildTextModel, type TextLine, type TextSpan, type TextWord } from "./words";

export interface FontProvider {
  /** Returns TrueType bytes for a bundled fallback font. */
  load(kind: FallbackKind, bold: boolean): Promise<Uint8Array>;
}

export interface EditResult {
  usedFallback: boolean;
  notes: string[];
  /** New width minus old width, in user-space points (positive = wider). */
  widthChange: number;
  anchor: "left" | "right";
}

interface PageModel {
  page: PDFPage;
  content: Uint8Array;
  ops: Operation[];
  glyphs: PositionedGlyph[];
  showOps: ShowOp[];
  words: TextWord[];
  lines: TextLine[];
  fonts: Map<string, LayoutFont | null>;
  fallbackNames: Map<FallbackFont, string>;
  dirty: boolean;
}

const FALLBACK_LABELS: Record<FallbackKind, [string, string]> = {
  arabic: ["Noto Naskh Arabic", "Noto Naskh Arabic Bold"],
  latin: ["DejaVu Sans", "DejaVu Sans Bold"],
};

export class PdfTextEditor {
  private readonly pages: PageModel[] = [];
  private readonly fontsByKey = new Map<string, PdfFont>();
  private readonly fallbacks = new Map<string, FallbackFont>();

  private readonly doc: PDFDocument;
  private readonly fontProvider: FontProvider;

  private constructor(doc: PDFDocument, fontProvider: FontProvider) {
    this.doc = doc;
    this.fontProvider = fontProvider;
  }

  static async load(bytes: Uint8Array | ArrayBuffer, fontProvider: FontProvider): Promise<PdfTextEditor> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const editor = new PdfTextEditor(doc, fontProvider);
    doc.getPages().forEach((page) => editor.pages.push(editor.buildPage(page)));
    for (const font of editor.fontsByKey.values()) font.seedPresentationForms();
    editor.pages.forEach((model) => editor.recordInventory(model.words));
    return editor;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  words(pageIndex: number): readonly TextWord[] {
    return this.model(pageIndex).words;
  }

  lines(pageIndex: number): readonly TextLine[] {
    return this.model(pageIndex).lines;
  }

  /** The word under a user-space point, if any. */
  wordAt(pageIndex: number, x: number, y: number): TextWord | null {
    return smallestHit(this.model(pageIndex).words, x, y);
  }

  /** The line under a user-space point, if any. */
  lineAt(pageIndex: number, x: number, y: number): TextLine | null {
    return smallestHit(this.model(pageIndex).lines, x, y);
  }

  /**
   * Replaces a word in the content stream. The word keeps its anchor (left
   * edge for LTR lines, right edge for RTL lines) and the rest of its line
   * shifts by the width change, so inter-word spacing is preserved. Other
   * lines are untouched (no reflow).
   */
  async replaceWord(pageIndex: number, wordId: string, replacement: string): Promise<EditResult> {
    const model = this.model(pageIndex);
    const word = model.words.find((w) => w.id === wordId);
    if (!word) throw new Error("Word not found; the page may have changed.");
    return this.replaceSpan(model, word, replacement);
  }

  /**
   * Replaces a whole line. The new text is laid out from the line's anchor
   * (left edge for LTR lines, right edge for RTL lines); mixed text is split
   * into bidi runs. The line is drawn in the font of its first glyph.
   */
  async replaceLine(pageIndex: number, lineId: string, replacement: string): Promise<EditResult> {
    const model = this.model(pageIndex);
    const line = model.lines.find((l) => l.id === lineId);
    if (!line) throw new Error("Line not found; the page may have changed.");
    const result = await this.replaceSpan(model, line, replacement);
    const fonts = new Set(line.glyphs.map((g) => g.showOp.state.font));
    if (fonts.size > 1) {
      result.notes.push("The line used several fonts or styles; the replacement uses the first one.");
    }
    return result;
  }

  private async replaceSpan(model: PageModel, word: TextSpan, replacement: string): Promise<EditResult> {
    if (!word.editable) throw new Error(word.reason ?? "This text cannot be edited.");
    if (!replacement.trim()) throw new Error("Replacement text cannot be empty.");

    const first = word.glyphs[0]!;
    const firstOp = first.showOp;
    const state = firstOp.state;
    const font = state.font;
    if (!font || !state.fontName) throw new Error("No font is selected for this text.");
    const scale = state.fontSize * state.hScale;
    if (scale === 0) throw new Error("Text has zero size or scaling.");

    const encoded = await encodeReplacement(
      replacement,
      word.lineDirection,
      font,
      (kind, bold) => this.fallbackFont(kind, bold),
    );

    // Geometry in the text space of the first glyph (origin = word start in stream).
    const toText = invert(multiply(first.tm, firstOp.ctm));
    // Leading/trailing spaces of a line don't define its visible edges.
    const inked = word.glyphs.filter((g) => !/^\s*$/u.test(g.unicode) || g.unicode === "");
    const xs = (inked.length ? inked : word.glyphs).flatMap((g) => [
      apply(toText, ...g.origin)[0],
      apply(toText, ...g.end)[0],
    ]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);

    const emitted = encoded.segments.map((seg) => this.emitSegment(model, seg, state));
    const newAdvance = emitted.reduce((sum, e) => sum + e.advance, 0);
    const anchor = word.lineDirection === "rtl" ? "right" : "left";
    const start = anchor === "right" ? right - newAdvance : left;

    // The rest of the line moves by the width change: rightwards after an
    // LTR word, leftwards before an RTL word (whose right edge stays put).
    const delta = newAdvance - (right - left);
    const shift = anchor === "left" ? delta : -delta;
    const wordGlyphs = new Set(word.glyphs);
    const alongs = word.glyphs.map((g) => word.line.get(g) ?? 0);
    const wordMin = Math.min(...alongs);
    const wordMax = Math.max(...alongs);
    const desiredFor = (elements: readonly ShowElement[]): number | null => {
      for (const e of elements) {
        if (e.kind !== "glyph" || wordGlyphs.has(e.glyph)) continue;
        const along = word.line.get(e.glyph);
        if (along === undefined) return 0;
        const onShiftedSide = anchor === "left" ? along > wordMax - 1e-3 : along < wordMin + 1e-3;
        return onShiftedSide ? shift : 0;
      }
      return null;
    };

    const affected = new Set(word.glyphs.map((g) => g.showOp));
    const replacements = new Map<number, string>();
    // Pen offset from its original position along the baseline, in text space units.
    let drift = 0;

    for (const op of model.showOps) {
      const inherited = op.chained ? drift : 0;
      const k = 1000 / (op.state.fontSize * op.state.hScale);
      const move = (d: number) => (Math.abs(d) > 1e-6 ? formatNumber(-d * k) : "");
      const header = opHeader(op);

      if (!affected.has(op)) {
        const desired = desiredFor(op.elements) ?? inherited;
        if (Math.abs(desired - inherited) > 1e-6) {
          replacements.set(op.opIndex, `${header}[${move(desired - inherited)} ${serialize(op.elements)}] TJ`);
        }
        drift = desired;
        continue;
      }

      const els = op.elements;
      const firstIdx = els.findIndex((e) => e.kind === "glyph" && wordGlyphs.has(e.glyph));
      let lastIdx = firstIdx;
      els.forEach((e, i) => {
        if (e.kind === "glyph" && wordGlyphs.has(e.glyph)) lastIdx = i;
      });
      const prefix = els.slice(0, firstIdx);
      const suffix = els.slice(lastIdx + 1);
      const spanAdvance = displacement(els.slice(firstIdx, lastIdx + 1), op.state);
      const dp = desiredFor(prefix) ?? inherited;

      if (op !== firstOp) {
        // Remaining glyphs of a word that spans operators: drop the word part.
        const ds = desiredFor(suffix) ?? dp;
        replacements.set(
          op.opIndex,
          `${header}[${move(dp - inherited)} ${serialize(prefix)} ${move(spanAdvance + ds - dp)} ${serialize(suffix)}] TJ`,
        );
        drift = ds;
        continue;
      }

      const ds = desiredFor(suffix) ?? start + newAdvance - spanAdvance;
      const parts: string[] = [];
      if (header) parts.push(header.trim());
      const lead = `${move(dp - inherited)} ${serialize(prefix)} ${move(start - dp)}`.trim();
      if (lead) parts.push(`[${lead}] TJ`);
      let switched = false;
      encoded.segments.forEach((seg, i) => {
        if (seg.switchesFont) {
          parts.push(`${serializeName(this.resourceNameFor(model, seg.font))} ${formatNumber(state.fontSize)} Tf`);
          switched = true;
        } else if (switched) {
          parts.push(`${serializeName(state.fontName)} ${formatNumber(state.fontSize)} Tf`);
          switched = false;
        }
        parts.push(emitted[i]!.text);
      });
      if (switched) parts.push(`${serializeName(state.fontName)} ${formatNumber(state.fontSize)} Tf`);
      const tail = `${move(spanAdvance + ds - start - newAdvance)} ${serialize(suffix)}`.trim();
      if (tail) parts.push(`[${tail}] TJ`);
      replacements.set(op.opIndex, parts.join("\n"));
      drift = ds;
    }

    // ActualText around replaced glyphs would make extractors report the old
    // word; downgrade those spans to plain marked content (BDC -> BMC).
    for (const op of affected) {
      for (const bdc of op.actualTextOps) {
        const tag = model.ops[bdc]!.operands[0];
        replacements.set(bdc, `${serializeName(tag?.kind === "name" ? tag.value : "Span")} BMC`);
      }
    }

    // Emitted Arabic codes must extract as base letters, not presentation forms.
    for (const seg of encoded.segments) {
      if (!(seg.font instanceof PdfFont)) continue;
      for (const g of seg.glyphs) {
        if (g.code < 0 || !g.unicode) continue;
        const raw = seg.font.rawUnicodeOf(g.code);
        // Only fill gaps or fold presentation forms; never remap a glyph other text relies on.
        if (raw !== g.unicode && (!raw || seg.font.unicodeOf(g.code) === g.unicode)) {
          seg.font.toUnicodeFixes.set(g.code, g.unicode);
        }
      }
    }

    const oldWidth = right - left;
    const toUser = multiply(first.tm, firstOp.ctm);
    const userScale = Math.hypot(toUser[0], toUser[1]);
    this.applyContent(model, spliceOperations(model.content, model.ops, replacements));
    return {
      usedFallback: encoded.usedFallback,
      notes: encoded.notes,
      widthChange: (newAdvance - oldWidth) * userScale,
      anchor,
    };
  }

  async save(): Promise<Uint8Array> {
    for (const fallback of this.fallbacks.values()) await fallback.finalize(this.doc.context);
    for (const font of this.fontsByKey.values()) {
      if (font.toUnicodeFixes.size === 0) continue;
      const cmap = writeToUnicode(font.toUnicodeEntries(), font.codeBytes);
      font.dict.set(PDFName.of("ToUnicode"), this.doc.context.register(this.doc.context.flateStream(cmap)));
    }
    for (const model of this.pages) {
      if (!model.dirty) continue;
      const ref = this.doc.context.register(this.doc.context.flateStream(model.content));
      model.page.node.set(PDFName.of("Contents"), ref);
    }
    return this.doc.save({ useObjectStreams: false });
  }

  // --- internals -----------------------------------------------------------

  private model(pageIndex: number): PageModel {
    const model = this.pages[pageIndex];
    if (!model) throw new Error(`Page ${pageIndex + 1} does not exist.`);
    return model;
  }

  private buildPage(page: PDFPage): PageModel {
    const contents = page.node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFStream) streams.push(contents);
    else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const s = contents.lookup(i);
        if (s instanceof PDFStream) streams.push(s);
      }
    }
    const parts: Uint8Array[] = [];
    streams.forEach((s) => parts.push(streamBytes(s), encodeLatin1("\n")));
    const model: PageModel = {
      page,
      content: concatBytes(parts),
      ops: [],
      glyphs: [],
      showOps: [],
      words: [],
      lines: [],
      fonts: new Map(),
      fallbackNames: new Map(),
      dirty: false,
    };
    this.relayout(model);
    return model;
  }

  private applyContent(model: PageModel, content: Uint8Array): void {
    model.content = content;
    model.dirty = true;
    this.relayout(model);
  }

  private relayout(model: PageModel): void {
    model.ops = parseOperations(model.content);
    const layout = layoutText(model.ops, (name) => this.resolveFont(model, name));
    model.glyphs = layout.glyphs;
    model.showOps = layout.showOps;
    const pageIndex = this.pages.indexOf(model);
    const text = buildTextModel(model.glyphs, `p${pageIndex < 0 ? this.pages.length : pageIndex}`);
    model.words = text.words;
    model.lines = text.lines;
  }

  private resolveFont(model: PageModel, name: string): LayoutFont | null {
    if (model.fonts.has(name)) return model.fonts.get(name)!;
    for (const [fallback, resName] of model.fallbackNames) {
      if (resName === name) {
        model.fonts.set(name, fallback);
        return fallback;
      }
    }
    const fontDict = model.page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    const raw = fontDict?.get(PDFName.of(name));
    const dict = raw ? this.doc.context.lookup(raw) : undefined;
    let font: LayoutFont | null = null;
    if (dict instanceof PDFDict) {
      const ref = raw instanceof PDFRef ? raw : null;
      const key = ref?.toString();
      font = (key && this.fontsByKey.get(key)) || null;
      if (!font) {
        const created = new PdfFont(dict, ref);
        this.fontsByKey.set(created.key, created);
        font = created;
      }
    }
    model.fonts.set(name, font);
    return font;
  }

  private async fallbackFont(kind: FallbackKind, bold: boolean): Promise<FallbackFont> {
    const id = `${kind}-${bold ? "bold" : "regular"}`;
    const existing = this.fallbacks.get(id);
    if (existing) return existing;
    const bytes = await this.fontProvider.load(kind, bold);
    const font = new FallbackFont(FALLBACK_LABELS[kind][bold ? 1 : 0], bytes, this.doc.context.nextRef(), bold);
    this.fallbacks.set(id, font);
    return font;
  }

  private resourceNameFor(model: PageModel, font: LayoutFont): string {
    if (!(font instanceof FallbackFont)) throw new Error("Only fallback fonts are added to resources.");
    const known = model.fallbackNames.get(font);
    if (known) return known;
    const node = model.page.node;
    let resources = node.Resources();
    if (!resources) {
      resources = this.doc.context.obj({});
      node.set(PDFName.of("Resources"), resources);
    }
    let fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) {
      fonts = this.doc.context.obj({});
      resources.set(PDFName.of("Font"), fonts);
    }
    const key = fonts.uniqueKey("FEd");
    fonts.set(key, font.ref);
    const name = key.decodeText();
    model.fallbackNames.set(font, name);
    model.fonts.set(name, font);
    return name;
  }

  /** Writes TJ operators for one encoded segment and returns its advance in text space. */
  private emitSegment(_model: PageModel, seg: EncodedSegment, state: TextState): { text: string; advance: number } {
    const { fontSize: tfs, hScale: th, charSpacing: tc, wordSpacing: tw } = state;
    const out: string[] = [];
    let items: string[] = [];
    let pending: Uint8Array[] = [];
    let advance = 0;
    let rise = state.rise;
    const flushGlyphs = () => {
      if (pending.length) items.push(hexOf(concatBytes(pending)));
      pending = [];
    };
    const flush = () => {
      flushGlyphs();
      if (items.length) out.push(`[${items.join(" ")}] TJ`);
      items = [];
    };
    const push = (n: number) => {
      if (Math.abs(n) < 1e-6) return;
      flushGlyphs();
      items.push(formatNumber(n));
      advance += (-n / 1000) * tfs * th;
    };

    // Zero-advance glyphs without Unicode (decomposed dots) are drawn after the
    // run so text rise changes don't split the word for text extraction.
    // Flushed at every word boundary so each word's glyphs stay contiguous.
    const deferred: { glyph: (typeof seg.glyphs)[number]; at: number }[] = [];
    const drawDeferred = () => {
      if (!deferred.length) return;
      const runEnd = advance;
      for (const { glyph: g, at } of deferred) {
        // Move the pen back to where the glyph belongs, then draw it raised.
        push((-(at - advance) * 1000) / (tfs * th) - g.xOffset);
        flush();
        out.push(`${formatNumber(state.rise + (g.yOffset / 1000) * tfs)} Ts`);
        rise = Number.NaN;
        pending.push(g.bytes);
        advance += ((g.width / 1000) * tfs + tc) * th;
        push(g.xOffset + g.adjustAfter + (g.width === 0 && tc ? (tc * 1000) / tfs : 0));
      }
      push((-(runEnd - advance) * 1000) / (tfs * th));
      deferred.length = 0;
    };

    for (const g of seg.glyphs) {
      if (g.bytes.length > 0 && !g.unicode && g.yOffset !== 0 && Math.abs(g.width - g.adjustAfter) < 1e-6) {
        deferred.push({ glyph: g, at: advance });
        continue;
      }
      if (/^\s$/u.test(g.unicode)) drawDeferred();
      if (g.bytes.length === 0) {
        push(g.adjustAfter);
        continue;
      }
      const wantRise = state.rise + (g.yOffset / 1000) * tfs;
      if (Math.abs(wantRise - rise) > 1e-6) {
        flush();
        out.push(`${formatNumber(wantRise)} Ts`);
        rise = wantRise;
      }
      push(-g.xOffset);
      pending.push(g.bytes);
      const appliesTw = seg.font.codeBytes === 1 && g.code === 32;
      advance += ((g.width / 1000) * tfs + tc + (appliesTw ? tw : 0)) * th;
      let after = g.xOffset + g.adjustAfter;
      // Word spacing only applies to single-byte code 32; emulate it for CID fonts.
      if (!appliesTw && /^\s$/u.test(g.unicode) && tw) after += (-tw * 1000) / tfs;
      // Zero-width marks must not pick up character spacing.
      if (g.width === 0 && tc) after += (tc * 1000) / tfs;
      push(after);
    }
    drawDeferred();
    flush();
    if (!(Math.abs(rise - state.rise) < 1e-6)) out.push(`${formatNumber(state.rise)} Ts`);
    return { text: out.join("\n"), advance };
  }

  /** Records which codes the document already draws and in which Arabic form. */
  private recordInventory(words: readonly TextWord[]): void {
    for (const word of words) {
      if (word.direction === "ltr") {
        for (const g of word.glyphs) {
          const font = g.showOp.state.font;
          if (font instanceof PdfFont) font.recordUsage(g.code, g.unicode, null);
        }
        continue;
      }
      // Glyphs without Unicode (decomposed dots, positioned parts) mean a cluster
      // is drawn with several glyphs; don't learn forms from such words.
      if (word.glyphs.some((g) => g.unicode === "")) continue;
      // Rebuild logical order: clusters by stream order, ordered right to left.
      const clusters: { glyphs: PositionedGlyph[]; x: number }[] = [];
      for (const g of word.glyphs) {
        const last = clusters[clusters.length - 1];
        if (last && /^\p{Mn}+$/u.test(g.unicode)) last.glyphs.push(g);
        else clusters.push({ glyphs: [g], x: (g.origin[0] + g.end[0]) / 2 });
      }
      clusters.sort((a, b) => b.x - a.x);
      const chars: string[] = [];
      const starts: number[] = [];
      for (const c of clusters) {
        starts.push(chars.length);
        for (const g of c.glyphs) chars.push(...g.unicode);
      }
      const forms = joiningForms(chars);
      clusters.forEach((c, i) => {
        const base = c.glyphs[0]!;
        const font = base.showOp.state.font;
        if (!(font instanceof PdfFont)) return;
        let form = font.presentationFormOf(base.code) ?? forms[starts[i]!] ?? null;
        if (base.unicode.length === 2 && base.unicode.startsWith("ل")) {
          form = form === "medi" || form === "fina" ? "fina" : "isol";
        }
        font.recordUsage(base.code, base.unicode, form);
        for (const mark of c.glyphs.slice(1)) font.recordUsage(mark.code, mark.unicode, null);
      });
    }
  }
}

function smallestHit<T extends TextSpan>(spans: readonly T[], x: number, y: number): T | null {
  const area = (s: T) => (s.box.x1 - s.box.x0) * (s.box.y1 - s.box.y0);
  const hits = spans.filter((s) => x >= s.box.x0 && x <= s.box.x1 && y >= s.box.y0 && y <= s.box.y1);
  return hits.sort((a, b) => area(a) - area(b))[0] ?? null;
}

function displacement(elements: readonly ShowElement[], state: TextState): number {
  return elements.reduce(
    (sum, e) => sum + (e.kind === "glyph" ? e.glyph.advance : (-e.value / 1000) * state.fontSize * state.hScale),
    0,
  );
}

function serialize(elements: readonly ShowElement[]): string {
  const out: string[] = [];
  let pending: Uint8Array[] = [];
  const flush = () => {
    if (pending.length) out.push(hexOf(concatBytes(pending)));
    pending = [];
  };
  for (const e of elements) {
    if (e.kind === "glyph") {
      pending.push(e.glyph.bytes);
    } else {
      flush();
      out.push(formatNumber(e.value));
    }
  }
  flush();
  return out.join(" ");
}

/** Operators that ' and " perform before showing text. */
function opHeader(op: ShowOp): string {
  if (op.operator === "'") return "T* ";
  if (op.operator === '"' && op.quoteSpacing) {
    return `${formatNumber(op.quoteSpacing[0])} Tw ${formatNumber(op.quoteSpacing[1])} Tc T* `;
  }
  return "";
}
