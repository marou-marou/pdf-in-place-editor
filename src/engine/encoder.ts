import { arabicClusters, bidiRuns, hasStrongRtl, joiningType, type BidiRun } from "./arabic";
import type { EncodedGlyph } from "./fallbackFont";
import { FallbackFont } from "./fallbackFont";
import { PdfFont, type LayoutFont } from "./fonts";

export type FallbackKind = "arabic" | "latin";

export interface EncodedSegment {
  font: LayoutFont;
  /** True when the segment is drawn with a font other than the word's own font. */
  switchesFont: boolean;
  glyphs: EncodedGlyph[];
}

export interface EncodeOutcome {
  segments: EncodedSegment[];
  usedFallback: boolean;
  notes: string[];
}

export type FallbackResolver = (kind: FallbackKind, bold: boolean) => Promise<FallbackFont>;

const glyphFor = (font: PdfFont, code: number, unicode: string): EncodedGlyph => ({
  bytes: font.codeBytes === 1 ? Uint8Array.of(code) : Uint8Array.of(code >> 8, code & 0xff),
  code,
  width: font.widthOf(code),
  unicode,
  adjustAfter: 0,
  xOffset: 0,
  yOffset: 0,
});

/** No space glyph in the font: move the pen by a quarter em instead. */
const syntheticSpace = (): EncodedGlyph => ({
  bytes: new Uint8Array(0),
  code: -1,
  width: 0,
  unicode: " ",
  adjustAfter: -250,
  xOffset: 0,
  yOffset: 0,
});

/** A code that draws `text` in `font`, or null if the font cannot prove it has the glyph. */
function pickCode(font: PdfFont, text: string): number | null {
  const candidates = font.codesFor(text);
  const used = candidates.find((c) => font.usedCodes.has(c));
  if (used !== undefined) return used;
  const present = candidates.find((c) => font.hasGlyph(c) === true);
  if (present !== undefined) return present;
  // Complete (non-subset) fonts we cannot parse: trust the encoding.
  if (!font.isSubset) {
    const unknown = candidates.find((c) => font.hasGlyph(c) === null && font.widthOf(c) > 0);
    if (unknown !== undefined) return unknown;
  }
  return null;
}

/** Shapes with the embedded program itself (subset still has cmap + GSUB). */
function shapeWithProgram(font: PdfFont, run: BidiRun): EncodedGlyph[] | null {
  const program = font.program;
  if (!program || font.codeBytes !== 2) return null;
  const covers = [...run.text].every((ch) => /\s/u.test(ch) || program.hasGlyphForCodePoint(ch.codePointAt(0)!));
  if (!covers) return null;
  const features = program.availableFeatures as string[];
  if (run.direction === "rtl" && !features.includes("init") && !features.includes("fina")) return null;
  try {
    const layout = program.layout as unknown as (
      text: string, f?: unknown, s?: string, l?: string, d?: "ltr" | "rtl",
    ) => {
      glyphs: { id: number; codePoints: number[] }[];
      positions: { xAdvance: number; xOffset: number; yOffset: number }[];
    };
    const shaped = layout.call(program, run.text, undefined, undefined, undefined, run.direction);
    const scale = 1000 / program.unitsPerEm;
    const out: EncodedGlyph[] = [];
    shaped.glyphs.forEach((g, i) => {
      // Identity CIDToGIDMap only: CID == GID.
      if (font.gidFor(g.id) !== g.id || font.hasGlyph(g.id) !== true || !font.hasExplicitWidth(g.id)) {
        throw new Error("glyph missing");
      }
      const unicode = String.fromCodePoint(...g.codePoints);
      if (!font.unicodeOf(g.id) && unicode) font.toUnicodeFixes.set(g.id, unicode);
      const pos = shaped.positions[i]!;
      const glyph = glyphFor(font, g.id, unicode);
      // Keep GPOS results (kerning, mark and cursive attachment).
      glyph.adjustAfter = glyph.width - pos.xAdvance * scale;
      glyph.xOffset = pos.xOffset * scale;
      glyph.yOffset = pos.yOffset * scale;
      out.push(glyph);
    });
    return out;
  } catch {
    return null;
  }
}

/** Re-encodes an RTL run using glyph forms already present in the font. */
function encodeArabicFromInventory(font: PdfFont, text: string): EncodedGlyph[] | null {
  const clusters = arabicClusters(text);
  const logical: EncodedGlyph[][] = [];
  for (const cluster of clusters) {
    const type = cluster.base.length === 1 ? joiningType(cluster.base) : "D";
    let code: number | null | undefined = cluster.form
      ? font.formInventory.get(`${cluster.base}|${cluster.form}`)
      : undefined;
    if (code === undefined && (type === "U" || !cluster.form)) code = pickCode(font, cluster.base);
    if ((code === undefined || code === null) && /^\s$/u.test(cluster.base)) {
      logical.push([syntheticSpace()]);
      continue;
    }
    if (code === undefined || code === null) return null;
    const glyphs = [glyphFor(font, code, cluster.base)];
    for (const mark of cluster.marks) {
      const markCode = pickCode(font, mark);
      // Only zero-advance marks can be overlaid without GPOS data.
      if (markCode === null || font.widthOf(markCode) !== 0) return null;
      glyphs.push(glyphFor(font, markCode, mark));
    }
    logical.push(glyphs);
  }
  return logical.reverse().flat();
}

function encodeLtrRun(font: PdfFont, text: string): EncodedGlyph[] | null {
  const out: EncodedGlyph[] = [];
  for (const ch of text) {
    const code = pickCode(font, ch);
    if (code !== null) {
      out.push(glyphFor(font, code, ch));
    } else if (/\s/u.test(ch)) {
      out.push(syntheticSpace());
    } else {
      return null;
    }
  }
  return out;
}

function encodeInOriginal(font: PdfFont, run: BidiRun): EncodedGlyph[] | null {
  if (!font.encodable) return null;
  const rtl = run.direction === "rtl" && hasStrongRtl(run.text);
  if (rtl) return shapeWithProgram(font, run) ?? encodeArabicFromInventory(font, run.text);
  return encodeLtrRun(font, run.text);
}

/**
 * Encodes replacement text for a word. Each bidi run is drawn in the word's
 * own font when every glyph is provably available, otherwise the whole run
 * switches to a bundled fallback font (never glyph-by-glyph, so a word never
 * mixes two designs).
 */
export async function encodeReplacement(
  text: string,
  baseDirection: "ltr" | "rtl",
  font: LayoutFont,
  getFallback: FallbackResolver,
): Promise<EncodeOutcome> {
  const runs = bidiRuns(text, baseDirection);
  const segments: EncodedSegment[] = [];
  const notes: string[] = [];
  let usedFallback = false;

  for (const run of runs) {
    let glyphs: EncodedGlyph[] | null = null;
    let segFont: LayoutFont = font;
    if (font instanceof PdfFont) {
      glyphs = encodeInOriginal(font, run);
    } else if (font instanceof FallbackFont && font.supports(run.text)) {
      glyphs = font.encode(run.text, run.direction);
    }

    if (!glyphs) {
      const kind: FallbackKind = hasStrongRtl(run.text) ? "arabic" : "latin";
      let fallback = await getFallback(kind, font.isBold);
      if (!fallback.supports(run.text)) {
        fallback = await getFallback(kind === "arabic" ? "latin" : "arabic", font.isBold);
      }
      if (!fallback.supports(run.text)) {
        throw new Error(`No bundled font can draw "${run.text}".`);
      }
      glyphs = fallback.encode(run.text, run.direction);
      segFont = fallback;
      usedFallback = true;
      notes.push(`"${run.text}" is not available in the embedded font; using ${fallback.label}.`);
    }

    const last = segments[segments.length - 1];
    if (last && last.font === segFont) last.glyphs.push(...glyphs);
    else segments.push({ font: segFont, switchesFont: segFont !== font, glyphs });
  }
  return { segments, usedFallback, notes };
}
