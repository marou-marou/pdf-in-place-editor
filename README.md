# PDF In-Place Editor

[![CI](https://github.com/marou-marou/pdf-in-place-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/marou-marou/pdf-in-place-editor/actions/workflows/ci.yml)

**Live demo:** https://marou-marou.github.io/pdf-in-place-editor/ (open a PDF or click *Try a sample*)

Browser-only engine for editing existing PDF text in place, in English, Arabic and mixed lines.
You can replace a single word or a whole line (switch between **Word** and **Line** in the UI).
Edits are written into the page content stream with the original operators and font. Nothing is
painted over the old text and nothing is rasterised. The app makes no server calls and no external requests.

```
npm install
npm run fonts      # copies/downloads the bundled fallback fonts into public/fonts (dev time only)
npm run dev        # http://localhost:5173
npm test           # Playwright: engine tests + browser demo tests, qpdf --check on every output
npm run fixtures   # regenerates tests/fixtures (pdf-lib + Chromium-printed PDFs)
```

Every push runs the typecheck and the Playwright suite (with `qpdf --check`) on GitHub Actions. On `main`, once the
tests pass, the app is built and published to GitHub Pages (`.github/workflows/ci.yml`).

`qpdf` must be on the PATH for the output checks (`brew install qpdf`). Locally they are skipped with a
warning if it is missing; in CI the tests fail.

## How an edit works

| Step | Module |
| --- | --- |
| Parse the content stream, keeping each operator's byte range | `src/engine/contentStream.ts` |
| Interpret text state (`Tf Tc Tw Tz TL Ts Td TD Tm T* Tj TJ ' "`, `q/Q`, `cm`) and position every glyph | `src/engine/textLayout.ts` |
| Read fonts: `/Widths`, CID `/W`, ToUnicode, encodings, standard-14 metrics, embedded TrueType program | `src/engine/fonts.ts`, `cmap.ts` |
| Group glyphs into lines and words; rebuild logical order for RTL and mixed lines | `src/engine/words.ts` |
| Bidi runs, Arabic joining forms, presentation-form decoding | `src/engine/arabic.ts` |
| Re-encode the replacement in the original font, or a bundled one | `src/engine/encoder.ts`, `fallbackFont.ts` |
| Rewrite only the affected operators and save | `src/engine/editor.ts` |

API: `PdfTextEditor.load(bytes, fonts)`, then `words(page)` / `lines(page)`, `wordAt` / `lineAt(page, x, y)`,
`replaceWord` / `replaceLine(page, id, text)`, and `save()`.

Geometry rules:

- The new word or line keeps its anchor: the left edge on LTR lines, the right edge on RTL lines.
- The rest of the same line shifts by the width change, so word spacing is preserved. Other lines are untouched (no reflow).
- Widths are recomputed from the font's own width tables with `Tc`, `Tw` and `Tz` applied:
  `tx = (w0/1000·Tfs + Tc + Tw[code 32 only])·Th`. `Tw` is emulated with TJ adjustments for 2-byte CID fonts, where the PDF spec does not apply it.
- `ActualText` spans that enclose replaced glyphs are downgraded to plain marked content. Otherwise extractors would keep reporting the old word.

pdf.js is used only to render the page. Rewriting needs the byte offset of each operator in the stream, and pdf.js operator lists don't keep those.

## Glyphs missing from the embedded subset

For each bidi run of the replacement, in this order:

1. **Original font, glyphs proven present.** A code is used only if the document already draws it, or the
   embedded program has a non-empty outline for it. For Arabic, the engine learns which glyph the document uses for
   each letter in each contextual form (isolated, initial, medial, final, plus lam-alef). It reads this from the
   document's own existing words (the letter's real position decides the form, since one glyph can serve two forms),
   or from presentation-form ToUnicode entries. When the producer draws a letter as a body plus separate dot glyphs,
   the whole cluster is learned and redrawn with the same offsets. Glyphs whose existing ToUnicode entry doesn't
   match the letter they draw get an `/ActualText` span, so the edited word still extracts correctly. If the subset still has GSUB and cmap,
   it shapes with the embedded program itself, GPOS included.
2. **Otherwise the whole run switches to a bundled font** (Noto Naskh Arabic for Arabic, DejaVu Sans for Latin, with the
   bold weight chosen to match). It is shaped with fontkit's OpenType shaper, then subset-embedded as Type0/Identity-H
   with its own `/W` and ToUnicode. The engine never mixes fonts glyph-by-glyph inside a word.

ToUnicode is fixed for every emitted code (presentation forms are folded to base letters, and gaps are filled), so the edited
text extracts and searches as typed.

## Known limits (phase 1)

- A replaced line is drawn in the font of its first glyph. If the line mixed styles (e.g. one bold word), the styling is not carried over
  word by word. The edit result reports this in its notes.
- A line counts as one line only if its glyphs are drawn consecutively in the content stream. Lines drawn in several separate places
  are shown but can't be replaced as a whole; replace them word by word.
- Text inside Form XObjects, Type 3 fonts, and Type0 fonts with non-Identity CMaps can be located but not re-encoded.
- Bare CFF / Type 1 subsets can't be parsed. For those, only glyphs the document already uses are reused.
- A fallback font is drawn at the original point size. Noto Naskh looks smaller than many Arabic UI fonts at the same size,
  so size matching by x-height is a planned refinement.
- Shaping uses fontkit, which is pure JS. A HarfBuzz-wasm shaper can be plugged in behind the same `encode()` call.
