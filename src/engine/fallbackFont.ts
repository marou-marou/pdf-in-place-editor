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
    const run = layout(text, undefined, undefined, undefined, direction);
    return run.glyphs.map((glyph, i) => {
      const pos = run.positions[i]!;
      let newId = this.gidMap.get(glyph.id);
      if (newId === undefined) {
        newId = this.subset.includeGlyph(glyph);
        this.gidMap.set(glyph.id, newId);
        this.widths.set(newId, Math.round(glyph.advanceWidth * this.scale));
      }
      const unicode = String.fromCodePoint(...glyph.codePoints);
      // Glyphs produced by decomposition (e.g. separate Arabic dots) carry no
      // code points. Map them to U+200B: viewers drop it, whereas an empty or
      // missing entry makes pdf.js emit the raw glyph code as a character.
      if (!this.unicodes.has(newId) || (unicode && !this.unicodes.get(newId))) this.unicodes.set(newId, unicode || "\u200B");
      const width = this.widths.get(newId)!;
      return {
        bytes: Uint8Array.of(newId >> 8, newId & 0xff),
        code: newId,
        width,
        unicode,
        adjustAfter: width - pos.xAdvance * this.scale,
        xOffset: pos.xOffset * this.scale,
        yOffset: pos.yOffset * this.scale,
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

function randomTag(): string {
  let s = "";
  for (let i = 0; i < 6; i += 1) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}
