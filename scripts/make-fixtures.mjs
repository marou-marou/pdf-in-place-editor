// Generates test PDFs in tests/fixtures.
//  - pdflib-*.pdf: hand-built content streams exercising Tc, Tw, Tz, TJ kerning
//    and a non-embedded standard-14 bold heading.
//  - chrome-*.pdf: printed by Chromium (Skia), i.e. realistic producer output
//    with subset-embedded TrueType fonts and shaped Arabic.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFNumber,
  PDFOperator,
  StandardFonts,
  beginText,
  endText,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setWordSpacing,
  showText,
} from "pdf-lib";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tests", "fixtures");
await mkdir(out, { recursive: true });
const font = (name) => readFile(join(root, "public", "fonts", name));

// --- pdf-lib fixtures ---------------------------------------------------

async function pdflibSpacing() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const dejavu = await doc.embedFont(await font("DejaVuSans.ttf"), { subset: true });

  page.drawText("Annual Report 2024", { x: 60, y: 760, size: 28, font: helvBold });

  const helvKey = page.node.newFontDictionary("H", helvBold.ref);
  const dvKey = page.node.newFontDictionary("D", dejavu.ref);
  const tj = (items) => PDFOperator.of("TJ", [doc.context.obj(items)]);

  page.pushOperators(
    beginText(),
    setFontAndSize(helvKey, 14),
    setCharacterSpacing(1.5),
    setWordSpacing(4),
    setCharacterSqueeze(85),
    setTextMatrix(1, 0, 0, 1, 60, 700),
    showText(helvBold.encodeText("Spacing test line here")),
    setCharacterSpacing(0),
    setWordSpacing(0),
    setCharacterSqueeze(100),
    setTextMatrix(1, 0, 0, 1, 60, 660),
    tj([helvBold.encodeText("Kerned"), PDFNumber.of(-250), helvBold.encodeText("Wo"), PDFNumber.of(80), helvBold.encodeText("rds here")]),
    setFontAndSize(dvKey, 16),
    setCharacterSpacing(0.8),
    setTextMatrix(1, 0, 0, 1, 60, 620),
    showText(dejavu.encodeText("Embedded subset sample")),
    endText(),
  );
  await writeFile(join(out, "pdflib-spacing.pdf"), await doc.save({ useObjectStreams: false }));
}

// --- Chromium fixtures ---------------------------------------------------

async function chromeFixtures() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const b64 = async (name) => (await font(name)).toString("base64");
  const css = `
    @font-face { font-family: DV; src: url(data:font/ttf;base64,${await b64("DejaVuSans.ttf")}); }
    @font-face { font-family: Naskh; src: url(data:font/ttf;base64,${await b64("NotoNaskhArabic-Regular.ttf")}); }
    @font-face { font-family: DV; font-weight: bold; src: url(data:font/ttf;base64,${await b64("DejaVuSans-Bold.ttf")}); }
    body { font-family: DV; margin: 48px; }
    h1 { font-size: 30px; font-weight: bold; }
    p { font-size: 20px; }
  `;
  const docs = {
    "chrome-arabic.pdf": `<p dir="rtl">مرحبا بكم في التقرير السنوي</p>`,
    "chrome-heading.pdf": `<h1>Annual Report Overview</h1><p>Regular body text follows the heading.</p>`,
    "chrome-mixed.pdf": `<p dir="rtl">تقرير عام 2024 Annual للشركة</p>`,
    // Noto Naskh makes Chrome emit /ActualText spans and dots positioned with
    // Td; Helvetica gets the "fi" ligature; "." sits next to an LTR run.
    "chrome-realworld.pdf": `
      <p dir="rtl" style="font-family: Naskh; font-size: 22px">نمت الشركة بشكل مطرد هذا العام. زادت الإيرادات في كل منطقة.</p>
      <p style="font-family: Helvetica; font-size: 16px">New offices opened in Dubai and Cairo.</p>
      <p dir="rtl" style="font-family: DV; font-size: 19px">اجتماع يوم 15 مارس في Dubai Office. الحضور إلزامي.</p>
      <p dir="rtl" style="font-family: Arial; font-size: 19px">مرحبا بكم في التقرير السنوي.</p>`,
  };
  for (const [name, body] of Object.entries(docs)) {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
    await page.evaluate(() => document.fonts.ready);
    await writeFile(join(out, name), await page.pdf({ format: "A4", printBackground: false }));
  }
  await browser.close();
}

await pdflibSpacing();
await chromeFixtures();
console.log("fixtures written to tests/fixtures");
