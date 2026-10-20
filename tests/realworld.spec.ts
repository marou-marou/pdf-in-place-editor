import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PdfTextEditor, type TextWord } from "../src/engine";
import { assignGlyphText } from "../src/engine/fallbackFont";
import { extractsText, fixture, hasQpdf, nodeFonts, qpdfCheck } from "./helpers";

// Producer quirks seen in real files: /ActualText spans with dots drawn as
// separate glyphs on their own baseline, Latin ligatures, punctuation next to
// an LTR run inside an RTL line, and glyphs shared by different texts.

const word = (editor: PdfTextEditor, text: string): TextWord => {
  const w = editor.words(0).find((x) => x.text === text);
  if (!w) throw new Error(`"${text}" not found; have: ${editor.words(0).map((x) => x.text).join(" | ")}`);
  return w;
};

async function save(editor: PdfTextEditor, name: string): Promise<Uint8Array> {
  const bytes = await editor.save();
  const path = test.info().outputPath(name);
  writeFileSync(path, bytes);
  if (hasQpdf()) qpdfCheck(path);
  return bytes;
}

test("reads ActualText spans, ligatures and bidi punctuation", async () => {
  const editor = await PdfTextEditor.load(fixture("chrome-realworld.pdf"), nodeFonts);
  expect(editor.lines(0).map((l) => l.text)).toEqual([
    "نمت الشركة بشكل مطرد هذا العام. زادت الإيرادات في كل منطقة.",
    "New offices opened in Dubai and Cairo.",
    "اجتماع يوم 15 مارس في Dubai Office. الحضور إلزامي.",
    "مرحبا بكم في التقرير السنوي.",
  ]);
  expect(editor.lines(0).every((l) => l.editable)).toBe(true);
});

test("replacing a word drawn with separate dot glyphs removes all of them", async () => {
  const editor = await PdfTextEditor.load(fixture("chrome-realworld.pdf"), nodeFonts);
  const before = word(editor, "الشركة");
  // The dots are drawn on their own baseline but belong to the word.
  expect(before.glyphs.some((g) => g.host)).toBe(true);
  const glyphsBefore = editor.words(0).reduce((n, w) => n + w.glyphs.length, 0) - before.glyphs.length;

  await editor.replaceWord(0, before.id, "المؤسسة");
  const reloaded = await PdfTextEditor.load(await save(editor, "dots.pdf"), nodeFonts);
  const after = word(reloaded, "المؤسسة");
  const glyphsAfter = reloaded.words(0).reduce((n, w) => n + w.glyphs.length, 0) - after.glyphs.length;
  // Every other glyph on the page is unchanged: no orphaned dots left behind.
  expect(glyphsAfter).toBe(glyphsBefore);
  expect(reloaded.lines(0)[0]!.text).toBe("نمت المؤسسة بشكل مطرد هذا العام. زادت الإيرادات في كل منطقة.");
});

test("glyphs shared by different texts stay correct across several edits", async () => {
  const editor = await PdfTextEditor.load(fixture("chrome-arabic.pdf"), nodeFonts);
  // Both edits use the fallback font; they share dot and body glyphs that
  // stand for different letters (ؤ vs و, ظ vs ط).
  await editor.replaceWord(0, word(editor, "السنوي").id, "المؤسسة");
  await editor.replaceWord(0, word(editor, "بكم").id, "موظفينا");
  const bytes = await save(editor, "shared-glyphs.pdf");
  const reloaded = await PdfTextEditor.load(bytes, nodeFonts);
  expect(reloaded.lines(0)[0]!.text).toBe("مرحبا موظفينا في التقرير المؤسسة");
  expect(await extractsText(bytes, "التقرير")).toBe(true);
});

test("characters dropped by shaping go to the letter, not to shared dot glyphs", () => {
  // alef-hamza decomposed into [alef body, hamza glyph without code points]:
  // the hamza glyph carries the combining hamza, the alef body stays plain.
  expect(assignGlyphText("أهلا", ["ا", "", "ه", "لا"])).toEqual(["ا", "\u0654", "ه", "لا"]);
  // a dot glyph between letters never receives text
  expect(assignGlyphText("ظل", ["ظ", "", "ل"])).toEqual(["ظ", "", "ل"]);
  // a stale or wrong label is dropped and its letter goes to the previous glyph
  expect(assignGlyphText("مو", ["م", "ؤ"])).toEqual(["مو", ""]);
});

test("Arabic word drawn with separate dot glyphs is re-encoded in its original font", async () => {
  const editor = await PdfTextEditor.load(fixture("chrome-realworld.pdf"), nodeFonts);
  const before = word(editor, "منطقة.");
  const original = before.glyphs[0]!.showOp.state.font;
  // Every letter form of "نمت" (with its dots) occurs elsewhere in the line.
  const result = await editor.replaceWord(0, before.id, "نمت");
  expect(result.usedFallback).toBe(false);

  const reloaded = await PdfTextEditor.load(await save(editor, "naskh-original.pdf"), nodeFonts);
  const after = word(reloaded, "نمت");
  expect((after.glyphs.find((g) => !g.host)!.showOp.state.font as { baseFont: string }).baseFont).toBe(
    (original as { baseFont: string }).baseFont,
  );
  // The dots were copied with the letters, not left out.
  expect(after.glyphs.length).toBe(word(editor, "نمت").glyphs.length);
  expect(reloaded.lines(0)[0]!.text).toBe("نمت الشركة بشكل مطرد هذا العام. زادت الإيرادات في كل نمت");
});

test("a glyph shared by initial and medial forms (Arial beh) is reused", async () => {
  const editor = await PdfTextEditor.load(fixture("chrome-realworld.pdf"), nodeFonts);
  // "مرحبا" needs medial beh; Arial draws it with the same glyph as initial beh
  // and Chrome's ToUnicode labels that glyph as the initial presentation form.
  const result = await editor.replaceWord(0, word(editor, "السنوي.").id, "مرحبا");
  expect(result.usedFallback).toBe(false);
  const reloaded = await PdfTextEditor.load(await save(editor, "arial-medial.pdf"), nodeFonts);
  expect(reloaded.lines(0)[3]!.text).toBe("مرحبا بكم في التقرير مرحبا");
});
