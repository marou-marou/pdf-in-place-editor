import fontkit from "@pdf-lib/fontkit";
import type { Font as FontkitFont, Glyph, Subset } from "@pdf-lib/fontkit";
import { PDFString, type PDFContext, type PDFRef } from "pdf-lib";
import { writeToUnicode } from "./cmap";
import type { LayoutFont } from "./fonts";

export interface EncodedGlyph {
  bytes: Uint8Array;
  code: number;
  /** Advance in glyph space thousandths (what the PDF width array says). */
  width: number;
  unicode: string;
  /** Extra TJ adjustment after the glyph (thousandths, positive moves left). */
  adjustAfter: number;
  /** Mark positioning in thousandths of an em. */
  xOffset: number;
  yOffset: number;
  /** Part of a right-to-left run (glyphs are in visual order). */
  rtl?: boolean;
  /**
   * The font's ToUnicode entry for this glyph differs from what it stands for
   * here (a glyph shared by different texts); the word needs /ActualText.
   */
  conflict?: boolean;
}

type LayoutFn = (
  text: string,
  features?: unknown,
  script?: string,
  language?: string,
  direction?: "ltr" | "rtl",
) => { glyphs: Glyph[]; positions: { xAdvance: number; xOffset: number; yOffset: number }[] };

/**
 * A bundled font embedded as a Type0/Identity-H subset. Glyphs are added as
 * text is encoded; the font program, widths and ToUnicode are written on save.
 */
export class FallbackFont implements LayoutFont {
  readonly codeBytes = 2 as const;
  readonly widthScale = 0.001;
  readonly ascent: number;
  readonly descent: number;
  readonly key: string;

  private readonly font: FontkitFont;
  private readonly subset: Subset;
  private readonly scale: number;
  private readonly widths = new Map<number, number>();
  private readonly unicodes = new Map<number, string>();
  private readonly gidMap = new Map<number, number>();

  readonly label: string;
  readonly ref: PDFRef;
  readonly isBold: boolean;

  constructor(label: string, bytes: Uint8Array, ref: PDFRef, isBold: boolean) {
    this.label = label;
    this.ref = ref;
    this.isBold = isBold;
    this.font = fontkit.create(bytes);
    this.subset = this.font.createSubset();
    this.scale = 1000 / this.font.unitsPerEm;
    this.ascent = (this.font.ascent * this.scale) / 1000;
    this.descent = (this.font.descent * this.scale) / 1000;
    this.key = ref.toString();
  }

  supports(text: string): boolean {
    return [...text].every((ch) => /\s/u.test(ch) || this.font.hasGlyphForCodePoint(ch.codePointAt(0)!));
  }

  /** Shapes one directional run and returns glyphs in visual order. */
  encode(text: string, direction: "ltr" | "rtl"): EncodedGlyph[] {
    const layout = (this.font.layout as unknown as LayoutFn).bind(this.font);
    clearGlyphCache(this.font);
    const run = layout(text, undefined, undefined, undefined, direction);
    const visualTexts = run.glyphs.map((g) => String.fromCodePoint(...g.codePoints));
    const logical = direction === "rtl" ? [...visualTexts].reverse() : visualTexts;
    const assigned = assignGlyphText(text, logical);
    const texts = direction === "rtl" ? assigned.reverse() : assigned;

    return run.glyphs.map((glyph, i) => {
      const pos = run.positions[i]!;
      let newId = this.gidMap.get(glyph.id);
      if (newId === undefined) {
        newId = this.subset.includeGlyph(glyph);
        this.gidMap.set(glyph.id, newId);
        this.widths.set(newId, Math.round(glyph.advanceWidth * this.scale));
      }
      const unicode = texts[i]!;
      // Glyphs produced by decomposition (e.g. separate Arabic dots) carry no
      // code points. Map them to U+200B: viewers drop it, whereas an empty or
      // missing entry makes pdf.js emit the raw glyph code as a character.
      // ToUnicode holds one text per glyph: the first use wins, and later uses
      // that mean something else are flagged so the word gets /ActualText.
      let known = this.unicodes.get(newId);
      if (known === ZWSP && /^\p{M}+$/u.test(unicode)) known = undefined; // placeholder -> real mark
      if (known === undefined) this.unicodes.set(newId, unicode || ZWSP);
      const conflict = known !== undefined && known.replace(ZWSP, "") !== unicode;
      const width = this.widths.get(newId)!;
      return {
        bytes: Uint8Array.of(newId >> 8, newId & 0xff),
        code: newId,
        width,
        unicode,
        adjustAfter: width - pos.xAdvance * this.scale,
        xOffset: pos.xOffset * this.scale,
        yOffset: pos.yOffset * this.scale,
        rtl: direction === "rtl",
        conflict,
      };
    });
  }

  widthOf(code: number): number {
    return this.widths.get(code) ?? 0;
  }

  unicodeOf(code: number): string {
    // Decomposed glyphs are written as U+200B in ToUnicode but carry no text.
    return (this.unicodes.get(code) ?? "").replace(/\u200B/g, "");
  }

  /** Writes the subset program and font dictionaries to `this.ref`. */
  async finalize(context: PDFContext): Promise<void> {
    const program = await new Promise<Uint8Array>((resolve, reject) => {
      const parts: Uint8Array[] = [];
      const stream = this.subset.encodeStream() as unknown as {
        on(event: string, cb: (data?: Uint8Array) => void): unknown;
      };
      stream.on("data", (d) => d && parts.push(d));
      stream.on("end", () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const p of parts) {
          out.set(p, offset);
          offset += p.length;
        }
        resolve(out);
      });
      stream.on("error", () => reject(new Error(`Could not subset ${this.label}`)));
    });

    const tag = randomTag();
    const baseFont = `${tag}+${(this.font.postscriptName ?? this.label).replace(/[^A-Za-z0-9-]/g, "")}`;
    const fontFile = context.register(context.flateStream(program, { Length1: program.length }));
    const bbox = this.font.bbox;
    const descriptor = context.register(
      context.obj({
        Type: "FontDescriptor",
        FontName: baseFont,
        Flags: 4 | (this.isBold ? 1 << 18 : 0),
        FontBBox: [bbox.minX * this.scale, bbox.minY * this.scale, bbox.maxX * this.scale, bbox.maxY * this.scale],
        ItalicAngle: this.font.italicAngle,
        Ascent: this.font.ascent * this.scale,
        Descent: this.font.descent * this.scale,
        CapHeight: (this.font.capHeight || this.font.ascent) * this.scale,
        StemV: this.isBold ? 120 : 80,
        FontFile2: fontFile,
      }),
    );

    const codes = [...this.widths.keys()].sort((a, b) => a - b);
    const w: (number | number[])[] = [];
    for (const code of codes) w.push(code, [this.widths.get(code)!]);
    const cidFont = context.register(
      context.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        BaseFont: baseFont,
        CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
        FontDescriptor: descriptor,
        W: w,
        DW: 0,
        CIDToGIDMap: "Identity",
      }),
    );
    const toUnicode = context.register(context.flateStream(writeToUnicode(this.unicodes, 2)));
    context.assign(
      this.ref,
      context.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: baseFont,
        Encoding: "Identity-H",
        DescendantFonts: [cidFont],
        ToUnicode: toUnicode,
      }),
    );
  }
}

const ZWSP = "\u200B";

/**
 * fontkit caches Glyph objects with the code points of their first use, so a
 * glyph shared by two letters (e.g. the waw body in و and ؤ) would report
 * stale code points. Clearing the cache before shaping keeps them accurate.
 */
export function clearGlyphCache(font: FontkitFont): void {
  (font as unknown as { _glyphs?: Record<number, unknown> })._glyphs = {};
}

/**
 * Text for each glyph (logical order) such that together they spell `text`.
 * Shapers drop code points when they decompose a character (e.g. alef with
 * hamza becomes an alef body + a hamza glyph with no code points). Missing
 * characters are restored in canonical decomposed form: a missing combining
 * mark goes to the code-point-less glyph right after its letter (the hamza
 * glyph), so the shared alef body keeps plain "ا" and every word extracts
 * correctly from ToUnicode alone; anything else goes to the preceding letter.
 */
export function assignGlyphText(text: string, glyphTexts: readonly string[]): string[] {
  const source = text.normalize("NFD");
  const out = glyphTexts.map((t) => t.normalize("NFD"));
  let pos = 0;
  let lastFilled = -1;
  const restore = (missing: string, next: number) => {
    if (!missing) return;
    const slot = lastFilled + 1;
    if (/^\p{M}+$/u.test(missing) && slot < next && out[slot] === "") out[slot] = missing;
    else if (lastFilled >= 0) out[lastFilled] += missing;
    else if (next < out.length) out[next] = missing + out[next]!;
  };
  out.forEach((t, i) => {
    if (!t) return;
    const found = source.indexOf(t, pos);
    if (found < 0) {
      // Label doesn't match the input: treat the glyph as carrying no text.
      out[i] = "";
      return;
    }
    if (found > pos) restore(source.slice(pos, found), i);
    pos = found + t.length;
    lastFilled = i;
  });
  restore(source.slice(pos), out.length);
  return out.map((t) => t.normalize("NFC"));
}

function randomTag(): string {
  let s = "";
  for (let i = 0; i < 6; i += 1) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}
