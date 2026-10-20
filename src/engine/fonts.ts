import fontkit from "@pdf-lib/fontkit";
import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import { Encodings, Font as StandardFont, FontNames } from "@pdf-lib/standard-fonts";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFObject,
} from "pdf-lib";
import { parseToUnicode } from "./cmap";
import { decodePresentationForm, type JoiningForm } from "./arabic";
import { streamBytes } from "./pdfUtil";

/** What the layout and encoder need from any font, original or fallback. */
export interface LayoutFont {
  readonly key: string;
  readonly codeBytes: 1 | 2;
  /** Glyph space to text space factor (0.001 except for Type 3). */
  readonly widthScale: number;
  readonly ascent: number;
  readonly descent: number;
  readonly isBold: boolean;
  widthOf(code: number): number;
  unicodeOf(code: number): string;
}

const STANDARD_ALIASES: Record<string, FontNames> = {
  Arial: FontNames.Helvetica,
  "Arial,Bold": FontNames.HelveticaBold,
  "Arial-Bold": FontNames.HelveticaBold,
  "Arial-BoldMT": FontNames.HelveticaBold,
  ArialMT: FontNames.Helvetica,
  TimesNewRoman: FontNames.TimesRoman,
  "TimesNewRoman,Bold": FontNames.TimesRomanBold,
  "TimesNewRomanPS-BoldMT": FontNames.TimesRomanBold,
  "TimesNewRomanPSMT": FontNames.TimesRoman,
  CourierNew: FontNames.Courier,
};

const STANDARD_NAMES = new Set<string>(Object.values(FontNames));

let winAnsiDecode: Map<number, { unicode: string; name: string }> | null = null;
let glyphNameToUnicode: Map<string, string> | null = null;

function winAnsiTables() {
  if (!winAnsiDecode || !glyphNameToUnicode) {
    winAnsiDecode = new Map();
    glyphNameToUnicode = new Map();
    const enc = Encodings.WinAnsi;
    for (const cp of enc.supportedCodePoints) {
      const { code, name } = enc.encodeUnicodeCodePoint(cp);
      const unicode = String.fromCodePoint(cp);
      if (!winAnsiDecode.has(code)) winAnsiDecode.set(code, { unicode, name });
      glyphNameToUnicode.set(name, unicode);
    }
  }
  return { winAnsiDecode, glyphNameToUnicode };
}

function unicodeForGlyphName(name: string): string {
  const { glyphNameToUnicode: table } = winAnsiTables();
  const known = table.get(name);
  if (known) return known;
  const uni = /^uni([0-9A-F]{4})+$/i.exec(name);
  if (uni) {
    let s = "";
    for (let i = 3; i < name.length; i += 4) s += String.fromCharCode(parseInt(name.slice(i, i + 4), 16));
    return s;
  }
  const u = /^u([0-9A-F]{4,6})$/i.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
  const base = name.split(".")[0]!;
  if (base !== name) return unicodeForGlyphName(base);
  return "";
}

const num = (obj: PDFObject | undefined): number | undefined =>
  obj instanceof PDFNumber ? obj.asNumber() : undefined;

/** A font resource as used by the page, with metrics and encoding knowledge. */
export class PdfFont implements LayoutFont {
  readonly key: string;
  readonly subtype: string;
  readonly baseFont: string;
  readonly isSubset: boolean;
  readonly isBold: boolean;
  readonly codeBytes: 1 | 2;
  readonly widthScale: number;
  readonly ascent: number;
  readonly descent: number;
  /** False when we cannot safely produce new codes for this font. */
  readonly encodable: boolean;
  readonly program: FontkitFont | null;
  readonly toUnicode: Map<number, string> | null;
  /** Codes that are actually drawn somewhere in the document. */
  readonly usedCodes = new Set<number>();
  /** Arabic glyph inventory: `${base}|${form}` -> code. */
  readonly formInventory = new Map<string, number>();
  /** ToUnicode entries to add or correct when saving. */
  readonly toUnicodeFixes = new Map<number, string>();

  private readonly widths = new Map<number, number>();
  private readonly defaultWidth: number;
  private readonly simpleEncoding = new Map<number, string>();
  private readonly standard: StandardFont | null;
  private readonly standardNames = new Map<number, string>();
  private readonly cidToGid: Uint8Array | null;
  private reverse: Map<string, number[]> | null = null;

  readonly dict: PDFDict;
  readonly ref: PDFRef | null;

  constructor(dict: PDFDict, ref: PDFRef | null) {
    this.dict = dict;
    this.ref = ref;
    this.key = ref ? ref.toString() : `inline-${Math.random().toString(36).slice(2)}`;
    this.subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "Type1";
    this.baseFont = dict.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText() ?? "";
    this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
    const plainName = this.baseFont.replace(/^[A-Z]{6}\+/, "");

    let descriptorDict = dict.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    let descendant: PDFDict | undefined;
    if (this.subtype === "Type0") {
      descendant = dict.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)?.lookupMaybe(0, PDFDict);
      descriptorDict = descendant?.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    }

    const flags = num(descriptorDict?.lookup(PDFName.of("Flags"))) ?? 0;
    const weight = num(descriptorDict?.lookup(PDFName.of("FontWeight"))) ?? 400;
    this.isBold = /bold|black|heavy|semibold|demi/i.test(plainName) || (flags & (1 << 18)) !== 0 || weight >= 600;

    const ascent = num(descriptorDict?.lookup(PDFName.of("Ascent")));
    const descent = num(descriptorDict?.lookup(PDFName.of("Descent")));
    this.ascent = ascent && ascent > 0 ? ascent / 1000 : 0.8;
    this.descent = descent && descent < 0 ? descent / 1000 : -0.2;

    if (this.subtype === "Type3") {
      const matrix = dict.lookupMaybe(PDFName.of("FontMatrix"), PDFArray);
      this.widthScale = num(matrix?.lookup(0)) ?? 0.001;
    } else {
      this.widthScale = 0.001;
    }

    // Embedded program (TrueType / OpenType only; bare CFF and Type 1 are not parseable by fontkit).
    let program: FontkitFont | null = null;
    const fontFile2 = descriptorDict?.lookupMaybe(PDFName.of("FontFile2"), PDFStream);
    const fontFile3 = descriptorDict?.lookupMaybe(PDFName.of("FontFile3"), PDFStream);
    const programStream =
      fontFile2 ??
      (fontFile3 && fontFile3.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() === "OpenType"
        ? fontFile3
        : undefined);
    if (programStream) {
      try {
        program = fontkit.create(streamBytes(programStream));
      } catch {
        program = null;
      }
    }
    this.program = program;

    const toUnicodeStream = dict.lookup(PDFName.of("ToUnicode"));
    this.toUnicode =
      toUnicodeStream instanceof PDFStream ? parseToUnicode(streamBytes(toUnicodeStream)).map : null;

    if (this.subtype === "Type0") {
      const encoding = dict.lookup(PDFName.of("Encoding"));
      const identity = encoding instanceof PDFName && /^Identity-[HV]$/.test(encoding.decodeText());
      this.codeBytes = 2;
      this.encodable = identity && encoding instanceof PDFName && encoding.decodeText() === "Identity-H";
      this.defaultWidth = num(descendant?.lookup(PDFName.of("DW"))) ?? 1000;
      const w = descendant?.lookupMaybe(PDFName.of("W"), PDFArray);
      if (w) this.parseCidWidths(w);
      const map = descendant?.lookup(PDFName.of("CIDToGIDMap"));
      this.cidToGid = map instanceof PDFStream ? streamBytes(map) : null;
      this.standard = null;
    } else {
      this.codeBytes = 1;
      this.cidToGid = null;
      this.encodable = this.subtype !== "Type3";
      const missing = num(descriptorDict?.lookup(PDFName.of("MissingWidth"))) ?? 0;
      this.defaultWidth = missing;
      const firstChar = num(dict.lookup(PDFName.of("FirstChar"))) ?? 0;
      const widths = dict.lookupMaybe(PDFName.of("Widths"), PDFArray);
      if (widths) {
        for (let i = 0; i < widths.size(); i += 1) {
          const value = num(widths.lookup(i));
          if (value !== undefined) this.widths.set(firstChar + i, value);
        }
      }
      const stdName = STANDARD_NAMES.has(plainName)
        ? (plainName as FontNames)
        : STANDARD_ALIASES[plainName];
      this.standard = !programStream && !fontFile3 && stdName ? StandardFont.load(stdName) : null;
      this.buildSimpleEncoding(dict);
    }
  }

  private parseCidWidths(w: PDFArray): void {
    let i = 0;
    while (i < w.size()) {
      const first = num(w.lookup(i));
      const next = w.lookup(i + 1);
      if (first === undefined) break;
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k += 1) {
          const value = num(next.lookup(k));
          if (value !== undefined) this.widths.set(first + k, value);
        }
        i += 2;
      } else {
        const last = num(next);
        const value = num(w.lookup(i + 2));
        if (last === undefined || value === undefined) break;
        for (let c = first; c <= last; c += 1) this.widths.set(c, value);
        i += 3;
      }
    }
  }

  private buildSimpleEncoding(dict: PDFDict): void {
    const { winAnsiDecode: table } = winAnsiTables();
    // WinAnsi is the practical default for non-symbolic simple fonts.
    for (const [code, { unicode, name }] of table) {
      this.simpleEncoding.set(code, unicode);
      this.standardNames.set(code, name);
    }
    const encoding = dict.lookup(PDFName.of("Encoding"));
    if (!(encoding instanceof PDFDict)) return;
    const differences = encoding.lookupMaybe(PDFName.of("Differences"), PDFArray);
    if (!differences) return;
    let code = 0;
    for (let i = 0; i < differences.size(); i += 1) {
      const item = differences.lookup(i);
      if (item instanceof PDFNumber) {
        code = item.asNumber();
      } else if (item instanceof PDFName) {
        const name = item.decodeText();
        this.standardNames.set(code, name);
        this.simpleEncoding.set(code, unicodeForGlyphName(name));
        code += 1;
      }
    }
  }

  widthOf(code: number): number {
    const explicit = this.widths.get(code);
    if (explicit !== undefined) return explicit;
    if (this.standard) {
      const name = this.standardNames.get(code);
      const w = name ? this.standard.getWidthOfGlyph(name) : undefined;
      if (typeof w === "number") return w;
    }
    return this.defaultWidth;
  }

  hasExplicitWidth(code: number): boolean {
    return this.widths.has(code) || (this.standard !== null && this.standardNames.has(code));
  }

  /** Unicode as the file maps it (may be an Arabic presentation form). */
  rawUnicodeOf(code: number): string {
    const fixed = this.toUnicodeFixes.get(code);
    if (fixed !== undefined) return fixed;
    const mapped = this.toUnicode?.get(code);
    if (mapped !== undefined) return mapped;
    if (this.codeBytes === 1) return this.simpleEncoding.get(code) ?? "";
    return "";
  }

  /**
   * Unicode with presentation forms folded to base letters. Zero-width spaces
   * (our mapping for decomposed Arabic dots) count as no text.
   */
  unicodeOf(code: number): string {
    const raw = this.rawUnicodeOf(code);
    // Latin ligatures (ﬁ, ﬂ, ...) read as their letters so text stays searchable.
    const unligated = /^[\uFB00-\uFB06]$/u.test(raw) ? raw.normalize("NFKC") : raw;
    // U+0000 and U+200B are producers' placeholders for glyphs with no text.
    return decodePresentationForm(unligated).base.replace(/[\u0000\u200B]/g, "");
  }

  /** Joining form implied by a presentation-form mapping, if any. */
  presentationFormOf(code: number): JoiningForm | null {
    return decodePresentationForm(this.rawUnicodeOf(code)).form;
  }

  gidFor(code: number): number {
    if (this.codeBytes === 2) {
      if (this.cidToGid && this.cidToGid.length >= code * 2 + 2) {
        return (this.cidToGid[code * 2]! << 8) | this.cidToGid[code * 2 + 1]!;
      }
      return code;
    }
    return -1;
  }

  /**
   * Whether the font can draw `code`. `null` means unknown (no parseable
   * program); callers then rely on the document inventory.
   */
  hasGlyph(code: number): boolean | null {
    if (this.usedCodes.has(code)) return true;
    if (this.standard) return this.hasExplicitWidth(code);
    const program = this.program;
    if (!program) return null;
    try {
      let gid = -1;
      if (this.codeBytes === 2) {
        gid = this.gidFor(code);
      } else {
        const unicode = this.unicodeOf(code);
        const cp = unicode.codePointAt(0);
        if (cp !== undefined && program.hasGlyphForCodePoint(cp)) gid = program.glyphForCodePoint(cp).id;
        else if (program.hasGlyphForCodePoint(0xf000 + code)) gid = program.glyphForCodePoint(0xf000 + code).id;
      }
      if (gid <= 0 || gid >= program.numGlyphs) return false;
      const glyph = program.getGlyph(gid);
      const isBlank = /^\s$/u.test(this.unicodeOf(code));
      // fontkit's Path has `commands` at runtime; the bundled typings omit it.
      const path = glyph.path as unknown as { commands: unknown[] };
      return isBlank || path.commands.length > 0;
    } catch {
      return false;
    }
  }

  /** Codes whose ToUnicode (or encoding) value is exactly `text`. */
  codesFor(text: string): number[] {
    if (!this.reverse) {
      this.reverse = new Map();
      const add = (code: number, value: string) => {
        if (!value) return;
        const list = this.reverse!.get(value) ?? [];
        if (!list.includes(code)) list.push(code);
        this.reverse!.set(value, list);
      };
      if (this.toUnicode) for (const [code, value] of this.toUnicode) add(code, value);
      if (this.codeBytes === 1) for (const [code, value] of this.simpleEncoding) add(code, value);
    }
    return this.reverse.get(text) ?? [];
  }

  /** Full ToUnicode table to write back, including fixes made by edits. */
  toUnicodeEntries(): Map<number, string> {
    const merged = new Map<number, string>(
      this.toUnicode ?? (this.codeBytes === 1 ? this.simpleEncoding : []),
    );
    for (const [code, value] of this.toUnicodeFixes) merged.set(code, value);
    return merged;
  }

  /** Records a drawn glyph and, for Arabic, the form it was drawn in. */
  recordUsage(code: number, base: string, form: JoiningForm | null): void {
    this.usedCodes.add(code);
    if (form) {
      const key = `${base}|${form}`;
      if (!this.formInventory.has(key)) this.formInventory.set(key, code);
    }
  }

  /** Seeds the form inventory from ToUnicode values that are presentation forms. */
  seedPresentationForms(): void {
    if (!this.toUnicode) return;
    for (const [code, value] of this.toUnicode) {
      const { base, form } = decodePresentationForm(value);
      if (form && this.hasGlyph(code) !== false) {
        const key = `${base}|${form}`;
        if (!this.formInventory.has(key)) this.formInventory.set(key, code);
      }
    }
  }
}

export function decodeCodes(font: LayoutFont, bytes: Uint8Array): { code: number; bytes: Uint8Array }[] {
  const out: { code: number; bytes: Uint8Array }[] = [];
  const step = font.codeBytes;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    out.push({ code: step === 1 ? slice[0]! : (slice[0]! << 8) | slice[1]!, bytes: slice });
  }
  return out;
}
