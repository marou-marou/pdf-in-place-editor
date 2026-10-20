import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { Encodings, Font as StandardFont, FontNames } from "@pdf-lib/standard-fonts";
import { PdfTextEditor, type TextLine } from "../src/engine";
import { extractsText, fixture, hasQpdf, nodeFonts, qpdfCheck } from "./helpers";

const findLine = (editor: PdfTextEditor, text: string, page = 0): TextLine => {
  const line = editor.lines(page).find((l) => l.text === text);
  if (!line) throw new Error(`Line "${text}" not found; have: ${editor.lines(page).map((l) => l.text).join(" | ")}`);
  return line;
};

async function save(editor: PdfTextEditor, name: string): Promise<Uint8Array> {
  const bytes = await editor.save();
  const path = test.info().outputPath(name);
  writeFileSync(path, bytes);
  if (hasQpdf()) qpdfCheck(path);
  else if (process.env.CI) throw new Error("qpdf is required in CI");
  return bytes;
}

test.describe("Line text model", () => {
  test("lines read in logical order, including mixed RTL lines", async () => {
    const arabic = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
    expect(arabic.lines(0).map((l) => l.text)).toEqual(["مرحبا بكم في التقرير السنوي"]);

    const mixed = await PdfTextEditor.load(fixture("chrome-mixed.pdf"), nodeFonts);
    // The LTR run keeps its visual order inside the RTL line.
    expect(mixed.lines(0).map((l) => l.text)).toEqual(["تقرير عام Annual 2024 للشركة"]);

    const heading = await PdfTextEditor.load(fixture("chrome-heading.pdf"), nodeFonts);
    expect(heading.lines(0).map((l) => l.text)).toEqual([
      "Annual Report Overview",
      "Regular body text follows the heading.",
    ]);
  });
});

test.describe("Line replacement", () => {
  test("English bold heading line, left-anchored, other lines untouched", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-heading.pdf"), nodeFonts);
    const before = findLine(editor, "Annual Report Overview");
    const body = findLine(editor, "Regular body text follows the heading.");

    await editor.replaceLine(0, before.id, "Quarterly Business Review");
    const bytes = await save(editor, "heading-line.pdf");
    expect(await extractsText(bytes, "Quarterly Business Review")).toBe(true);

    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const after = findLine(reloaded, "Quarterly Business Review");
    expect(after.box.x0).toBeCloseTo(before.box.x0, 0);
    expect(after.words.every((w) => w.glyphs[0]!.showOp.state.font?.isBold)).toBe(true);
    const bodyAfter = findLine(reloaded, "Regular body text follows the heading.");
    expect(bodyAfter.box).toEqual(body.box);
  });

  test("word spacing (Tw) is applied to spaces of the new line", async () => {
    const editor = await PdfTextEditor.load(fixture("pdflib-spacing.pdf"), nodeFonts);
    const before = findLine(editor, "Spacing test line here");
    await editor.replaceLine(0, before.id, "New spacing line");
    const bytes = await save(editor, "spacing-line.pdf");

    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    const after = findLine(reloaded, "New spacing line");
    // Fixture state: 14pt Helvetica-Bold, Tc 1.5, Tw 4, Tz 85.
    const metrics = StandardFont.load(FontNames.HelveticaBold);
    const expected = [..."New spacing line"].reduce((sum, ch) => {
      const name = Encodings.WinAnsi.encodeUnicodeCodePoint(ch.codePointAt(0)!).name;
      const w = metrics.getWidthOfGlyph(name) as number;
      return sum + ((w / 1000) * 14 + 1.5 + (ch === " " ? 4 : 0)) * 0.85;
    }, 0);
    expect(after.glyphs.reduce((sum, g) => sum + g.advance, 0)).toBeCloseTo(expected, 3);
    expect(after.box.x0).toBeCloseTo(before.box.x0, 2);
  });

  test("Arabic line, right-anchored, shaped in the original font where possible", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
    const before = findLine(editor, "مرحبا بكم في التقرير السنوي");
    // Every letter form here already occurs in the sentence.
    const result = await editor.replaceLine(0, before.id, "مرحبا لكم في التقرير");
    expect(result.usedFallback).toBe(false);
    expect(result.anchor).toBe("right");

    const bytes = await save(editor, "arabic-line.pdf");
    expect(await extractsText(bytes, "مرحبا لكم في التقرير")).toBe(true);
    const after = findLine(await PdfTextEditor.load(bytes, nodeFonts), "مرحبا لكم في التقرير");
    expect(after.box.x1).toBeCloseTo(before.box.x1, 0);
  });

  test("Arabic line with new letters falls back to Noto Naskh", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
    const before = findLine(editor, "مرحبا بكم في التقرير السنوي");
    const result = await editor.replaceLine(0, before.id, "أهلا وسهلا بكم");
    expect(result.usedFallback).toBe(true);
    const bytes = await save(editor, "arabic-line-fallback.pdf");
    expect(await extractsText(bytes, "أهلا وسهلا بكم")).toBe(true);
    const after = findLine(await PdfTextEditor.load(bytes, nodeFonts), "أهلا وسهلا بكم");
    expect(after.box.x1).toBeCloseTo(before.box.x1, 0);
    // Every word of the new line can be edited again.
    expect(after.words.map((w) => [w.text, w.editable])).toEqual([
      ["بكم", true],
      ["وسهلا", true],
      ["أهلا", true],
    ]);
  });

  test("mixed Arabic, English and digits line", async () => {
    const editor = await PdfTextEditor.load(fixture("chrome-mixed.pdf"), nodeFonts);
    const before = findLine(editor, "تقرير عام Annual 2024 للشركة");
    await editor.replaceLine(0, before.id, "تقرير عام 2042 للشركة");
    const bytes = await save(editor, "mixed-line.pdf");
    const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
    expect(reloaded.lines(0).map((l) => l.text)).toEqual(["تقرير عام 2042 للشركة"]);
    expect(await extractsText(bytes, "2042")).toBe(true);
    expect(findLine(reloaded, "تقرير عام 2042 للشركة").box.x1).toBeCloseTo(before.box.x1, 0);
  });
});
