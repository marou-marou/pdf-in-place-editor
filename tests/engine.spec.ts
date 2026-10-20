import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import fontkit from "@pdf-lib/fontkit";
import { Font as StandardFont, FontNames } from "@pdf-lib/standard-fonts";
import { PdfTextEditor, type TextWord } from "../src/engine";
import { PdfFont } from "../src/engine/fonts";
import { extractLines, extractsText, fixture, hasQpdf, nodeFonts, qpdfCheck } from "./helpers";

const findWord = (editor: PdfTextEditor, text: string, page = 0): TextWord => {
  const word = editor.words(page).find((w) => w.text === text);
  if (!word) throw new Error(`"${text}" not found; have: ${editor.words(page).map((w) => w.text).join(" | ")}`);
  return word;
};

const fontOf = (word: TextWord) => word.glyphs[0]!.showOp.state.font;

async function saveAndCheck(editor: PdfTextEditor, name: string): Promise<Uint8Array> {
  const bytes = await editor.save();
  const path = test.info().outputPath(name);
  writeFileSync(path, bytes);
  if (hasQpdf()) qpdfCheck(path);
  else if (process.env.CI) throw new Error("qpdf is required in CI");
  else test.info().annotations.push({ type: "warning", description: "qpdf not installed; check skipped" });
  return bytes;
}

test.describe("English", () => {
  test("bold heading word re-encoded in the original subset font", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-heading.pdf"), nodeFonts);
    const before = findWord(editor, "Annual");
    const originalFont = fontOf(before) as PdfFont;
    expect(originalFont.isBold).toBe(true);

    const result = await editor.replaceWord(0, before.id, "Rental");
    expect(result.usedFallback).toBe(false);

    const bytes = await saveAndCheck(editor, "heading-rental.pdf");
    expect(await extractsText(bytes, "Rental Report Overview")).toBe(true);

    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const after = findWord(reloaded, "Rental");
    expect((fontOf(after) as PdfFont).baseFont).toBe(originalFont.baseFont);
    expect(after.box.x0).toBeCloseTo(before.box.x0, 1);
    // Following words do not move.
    expect(findWord(reloaded, "Report").box.x0).toBeCloseTo(findWord(editor, "Report").box.x0, 3);
  });

  test("missing glyphs fall back to bundled bold font for the whole word", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-heading.pdf"), nodeFonts);
    const result = await editor.replaceWord(0, findWord(editor, "Annual").id, "Quarterly");
    expect(result.usedFallback).toBe(true);
    expect(result.notes.join()).toContain("DejaVu Sans Bold");

    const bytes = await saveAndCheck(editor, "heading-fallback.pdf");
    expect(await extractsText(bytes, "Quarterly Report Overview")).toBe(true);
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const word = findWord(reloaded, "Quarterly");
    expect(new Set(word.glyphs.map((g) => g.showOp.state.font)).size).toBe(1);
  });

  test("Tc, Tw and Tz are honoured when recomputing widths", async () => {
    const editor = await PdfTextEditor.load(fixture("pdflib-spacing.pdf"), nodeFonts);
    const before = findWord(editor, "test");
    const lineBefore = findWord(editor, "line").box.x0;

    const result = await editor.replaceWord(0, before.id, "demo");
    const bytes = await saveAndCheck(editor, "spacing.pdf");
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const after = findWord(reloaded, "demo");

    // Fixture state: 14pt Helvetica-Bold, Tc 1.5, Tz 85.
    const metrics = StandardFont.load(FontNames.HelveticaBold);
    const names: Record<string, string> = { d: "d", e: "e", m: "m", o: "o" };
    const expected = [..."demo"].reduce(
      (sum, ch) => sum + ((metrics.getWidthOfGlyph(names[ch]!) as number) / 1000 * 14 + 1.5) * 0.85,
      0,
    );
    const advance = after.glyphs.reduce((sum, g) => sum + g.advance, 0);
    expect(advance).toBeCloseTo(expected, 3);
    expect(after.box.x0).toBeCloseTo(before.box.x0, 2);
    // The rest of the line moves by exactly the width change, keeping the word gap.
    expect(findWord(reloaded, "line").box.x0).toBeCloseTo(lineBefore + result.widthChange, 3);
    expect(await extractsText(bytes, "Spacing demo line here")).toBe(true);
  });

  test("word inside a kerned TJ array; rest of the line shifts, other lines do not", async () => {
    const editor = await PdfTextEditor.load(fixture("pdflib-spacing.pdf"), nodeFonts);
    const hereBefore = editor.words(0).filter((w) => w.text === "here")[1]!.box.x0;
    const result = await editor.replaceWord(0, findWord(editor, "Words").id, "Items");
    const bytes = await saveAndCheck(editor, "kerned.pdf");
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    expect(reloaded.words(0).filter((w) => w.text === "here")[1]!.box.x0).toBeCloseTo(hereBefore + result.widthChange, 3);
    // Lines below are untouched.
    expect(findWord(reloaded, "Embedded").box.x0).toBeCloseTo(findWord(editor, "Embedded").box.x0, 6);
    expect(await extractsText(bytes, "Kerned Items here")).toBe(true);
  });
});

test.describe("Arabic", () => {
  test("word re-encoded in the original font from the document's own glyph forms", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
    const before = findWord(editor, "بكم");
    const result = await editor.replaceWord(0, before.id, "لكم");
    expect(result.usedFallback).toBe(false);
    expect(result.anchor).toBe("right");

    const bytes = await saveAndCheck(editor, "arabic-original.pdf");
    expect(await extractsText(bytes, "مرحبا لكم في التقرير السنوي")).toBe(true);

    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const after = findWord(reloaded, "لكم");
    expect((fontOf(after) as PdfFont).baseFont).toBe((fontOf(before) as PdfFont).baseFont);
    // Anchored to the right edge.
    expect(after.box.x1).toBeCloseTo(before.box.x1, 0);
    expect(findWord(reloaded, "مرحبا").box.x0).toBeCloseTo(findWord(editor, "مرحبا").box.x0, 3);
  });

  test("missing glyphs use Noto Naskh Arabic with real contextual shaping", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
    const result = await editor.replaceWord(0, findWord(editor, "السنوي").id, "الشهري");
    expect(result.usedFallback).toBe(true);

    const bytes = await saveAndCheck(editor, "arabic-fallback.pdf");
    expect(await extractsText(bytes, "مرحبا بكم في التقرير الشهري")).toBe(true);

    // The embedded subset glyphs must be the shaped (joined) forms, in visual order.
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const word = findWord(reloaded, "الشهري");
    const font = fontOf(word) as PdfFont;
    expect(font.baseFont).toContain("NotoNaskhArabic");
    const noto = fontkit.create(readFileSync("public/fonts/NotoNaskhArabic-Regular.ttf"));
    const layout = noto.layout as unknown as (t: string, f?: unknown, s?: string, l?: string, d?: string) => {
      glyphs: { codePoints: number[]; path: { toSVG(): string } }[];
    };
    const shaped = layout.call(noto, "الشهري", undefined, undefined, undefined, "rtl").glyphs;
    const svg = (code: number) => font.program!.getGlyph(code).path.toSVG();
    // Same glyphs as HarfBuzz-style shaping produces (decomposed dots included)...
    expect(word.glyphs.map((g) => svg(g.code)).sort()).toEqual(shaped.map((g) => g.path.toSVG()).sort());
    // ...with the letter bodies in visual (right-to-left reversed) order.
    const bodies = word.glyphs.filter((g) => g.unicode !== "").map((g) => svg(g.code));
    expect(bodies).toEqual(shaped.filter((g) => g.codePoints.length > 0).map((g) => g.path.toSVG()));
    // And not the unjoined isolated forms.
    const isolated = noto.glyphsForString("الشهري").map((g) => g.path.toSVG()).reverse();
    expect(bodies).not.toEqual(isolated);
  });
});

test.describe("Mixed Arabic, English and digits", () => {
  test("digits inside an Arabic line", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-mixed.pdf"), nodeFonts);
    const before = findWord(editor, "2024");
    const result = await editor.replaceWord(0, before.id, "2042");
    expect(result.usedFallback).toBe(false);
    const bytes = await saveAndCheck(editor, "mixed-digits.pdf");
    expect(await extractLines(bytes)).toEqual(
      (await extractLines(fixture("chrome-mixed.pdf"))).map((l) => l.replace("2024", "2042")),
    );
  });

  test("mixed replacement text is split into bidi runs", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-mixed.pdf"), nodeFonts);
    await editor.replaceWord(0, findWord(editor, "عام").id, "سنة 2025");
    const bytes = await saveAndCheck(editor, "mixed-runs.pdf");
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    // Logical order of the line, as the engine reads it back right to left.
    expect(reloaded.words(0).map((w) => w.text).reverse().join(" ")).toBe("تقرير سنة 2025 2024 Annual للشركة");
    expect(await extractsText(bytes, "سنة")).toBe(true);
    expect(await extractsText(bytes, "2025")).toBe(true);
  });

  test("English word inside an Arabic line keeps the right anchor", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-mixed.pdf"), nodeFonts);
    const before = findWord(editor, "Annual");
    const result = await editor.replaceWord(0, before.id, "Final");
    expect(result.anchor).toBe("right");
    const bytes = await saveAndCheck(editor, "mixed-english.pdf");
    const after = findWord(await PdfTextEditor.load(bytes, nodeFonts), "Final");
    expect(after.box.x1).toBeCloseTo(before.box.x1, 0);
  });
});
