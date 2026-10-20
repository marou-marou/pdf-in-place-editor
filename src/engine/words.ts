import { hasStrongRtl, joiningType } from "./arabic";
import type { PositionedGlyph } from "./textLayout";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A run of glyphs on one line that can be replaced as a unit. */
export interface TextSpan {
  id: string;
  /** Glyphs in content-stream order. */
  glyphs: PositionedGlyph[];
  /** Logical-order Unicode text. */
  text: string;
  direction: "ltr" | "rtl";
  lineDirection: "ltr" | "rtl";
  /** User-space bounding box. */
  box: Box;
  /** Every glyph of the containing line with its position along the baseline. */
  line: ReadonlyMap<PositionedGlyph, number>;
  editable: boolean;
  reason?: string;
}

export interface TextWord extends TextSpan {
  /** User-space bounding box of the containing line. */
  lineBox: Box;
}

export interface TextLine extends TextSpan {
  /** Words of the line in visual order (left to right). */
  words: TextWord[];
}

export interface TextModel {
  words: TextWord[];
  lines: TextLine[];
}

const isBlank = (s: string) => s.length > 0 && /^\s+$/u.test(s);
const isMark = (s: string) => s.length > 0 && [...s].every((ch) => joiningType(ch) === "T");

function boxOf(glyphs: readonly PositionedGlyph[]): Box {
  const xs = glyphs.flatMap((g) => g.quad.map((p) => p[0]));
  const ys = glyphs.flatMap((g) => g.quad.map((p) => p[1]));
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Logical text of a word. Base glyphs are ordered visually (reversed for RTL),
 * so it works whether the producer wrote RTL text in visual or logical order.
 * Marks attach to the base glyph they sit over (falling back to the previous
 * base in stream order), since their stream position differs by producer.
 */
export function logicalText(
  glyphs: readonly PositionedGlyph[],
  direction: "ltr" | "rtl",
  along: (g: PositionedGlyph) => number,
): string {
  const width = (g: PositionedGlyph) => Math.hypot(g.end[0] - g.origin[0], g.end[1] - g.origin[1]);
  const inkWidth = (g: PositionedGlyph) => Math.hypot(g.quad[1]![0] - g.quad[0]![0], g.quad[1]![1] - g.quad[0]![1]);
  const isAttached = (g: PositionedGlyph) => isMark(g.unicode) || g.unicode === "";

  const clusters: { text: string; pos: number; end: number }[] = [];
  for (const g of glyphs) {
    if (!isAttached(g)) clusters.push({ text: g.unicode, pos: along(g), end: along(g) + width(g) });
  }
  let previous: (typeof clusters)[number] | undefined;
  let next = 0;
  for (const g of glyphs) {
    if (!isAttached(g)) {
      previous = clusters[next];
      next += 1;
      continue;
    }
    const center = along(g) + inkWidth(g) / 2;
    const host = clusters.find((c) => center >= c.pos - 0.01 && center <= c.end + 0.01) ?? previous ?? clusters[0];
    if (host) host.text += g.unicode;
  }
  clusters.sort((a, b) => (direction === "rtl" ? b.pos - a.pos : a.pos - b.pos));
  // Composed form, as users type and search it (أ rather than ا + hamza).
  return clusters.map((c) => c.text).join("").normalize("NFC");
}

interface LineGlyph {
  glyph: PositionedGlyph;
  along: number;
  across: number;
}

/** Stream glyph indices must be consecutive for the span to be rewritten in one place. */
function contiguity(streamOrder: readonly PositionedGlyph[]): boolean {
  const first = streamOrder[0]?.index ?? 0;
  return streamOrder.every((g, k) => g.index === first + k);
}

/**
 * Logical text of a line from its words in visual order. Works per character
 * so punctuation glued to a word (e.g. "." before an LTR run in an RTL line)
 * lands where the bidi algorithm put it: neutrals between two characters of
 * the same direction take that direction, otherwise the line's. Runs are then
 * reversed on RTL lines and RTL runs are read right to left.
 */
function logicalLineText(visualWords: readonly TextWord[], lineDirection: "ltr" | "rtl"): string {
  type Dir = "ltr" | "rtl" | null;
  const visual: { ch: string; dir: Dir }[] = [];
  const classify = (ch: string): Dir =>
    hasStrongRtl(ch) ? "rtl" : /[\p{L}\p{N}]/u.test(ch) ? "ltr" : isMark(ch) ? "rtl" : null;
  visualWords.forEach((w, i) => {
    if (i > 0) visual.push({ ch: " ", dir: null });
    const chars = [...w.text];
    for (const ch of w.direction === "rtl" ? chars.reverse() : chars) visual.push({ ch, dir: classify(ch) });
  });
  // Resolve neutrals from their strong neighbours.
  for (let i = 0; i < visual.length; i += 1) {
    if (visual[i]!.dir !== null) continue;
    let j = i;
    while (j < visual.length && visual[j]!.dir === null) j += 1;
    const before = i > 0 ? visual[i - 1]!.dir : lineDirection;
    const after = j < visual.length ? visual[j]!.dir : lineDirection;
    const dir = before === after ? before : lineDirection;
    for (let k = i; k < j; k += 1) visual[k]!.dir = dir;
    i = j - 1;
  }
  const runs: { dir: Dir; chars: string[] }[] = [];
  for (const { ch, dir } of visual) {
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) last.chars.push(ch);
    else runs.push({ dir, chars: [ch] });
  }
  if (lineDirection === "rtl") runs.reverse();
  return runs
    .map((r) => (r.dir === "rtl" ? r.chars.reverse() : r.chars).join(""))
    .join("")
    .normalize("NFC");
}

/** Groups glyphs into baseline-aligned lines, then splits lines into words. */
export function buildTextModel(glyphs: readonly PositionedGlyph[], pagePrefix: string): TextModel {
  const lines: { dir: [number, number]; origin: [number, number]; size: number; items: LineGlyph[] }[] = [];

  type Line = (typeof lines)[number];
  const placedIn = new Map<PositionedGlyph, { line: Line; along: number }>();
  for (const glyph of glyphs) {
    // Glyphs drawn for another glyph's text (e.g. Arabic dots positioned with
    // Td) join their host's line below, whatever their own baseline.
    if (glyph.host) continue;
    const dx = glyph.end[0] - glyph.origin[0];
    const dy = glyph.end[1] - glyph.origin[1];
    const len = Math.hypot(dx, dy);
    let placed = false;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3) && !placed; i -= 1) {
      const line = lines[i]!;
      const ox = glyph.baseline[0] - line.origin[0];
      const oy = glyph.baseline[1] - line.origin[1];
      const across = -ox * line.dir[1] + oy * line.dir[0];
      const sameDir = len === 0 || Math.abs((dx * line.dir[0] + dy * line.dir[1]) / len - 1) < 0.01;
      if (sameDir && Math.abs(across) < line.size * 0.3) {
        const along = ox * line.dir[0] + oy * line.dir[1];
        line.items.push({ glyph, along, across });
        placedIn.set(glyph, { line, along });
        placed = true;
      }
    }
    if (!placed) {
      const dir: [number, number] = len > 0 ? [dx / len, dy / len] : [1, 0];
      const line: Line = { dir, origin: glyph.baseline, size: glyph.size || 1, items: [{ glyph, along: 0, across: 0 }] };
      lines.push(line);
      placedIn.set(glyph, { line, along: 0 });
    }
  }
  for (const glyph of glyphs) {
    const home = glyph.host && placedIn.get(glyph.host);
    if (home) home.line.items.push({ glyph, along: home.along, across: 0 });
  }

  const words: TextWord[] = [];
  const textLines: TextLine[] = [];
  lines.forEach((line, lineIndex) => {
    const lineWords: TextWord[] = [];
    const visual = [...line.items].sort((a, b) => a.along - b.along);
    const lineText = visual.map((v) => v.glyph.unicode).join("");
    const rtlCount = [...lineText].filter((ch) => hasStrongRtl(ch)).length;
    const ltrCount = [...lineText].filter((ch) => /\p{L}/u.test(ch) && !hasStrongRtl(ch)).length;
    const lineDirection = rtlCount > 0 && rtlCount >= ltrCount ? "rtl" : "ltr";
    const lineBox = boxOf(visual.map((v) => v.glyph));
    const lineAlong = new Map(visual.map((v) => [v.glyph, v.along]));

    const groups: LineGlyph[][] = [];
    let current: LineGlyph[] = [];
    let prevEnd = -Infinity;
    for (const item of visual) {
      const g = item.glyph;
      const width = Math.hypot(g.end[0] - g.origin[0], g.end[1] - g.origin[1]);
      if (isBlank(g.unicode)) {
        if (current.length) groups.push(current);
        current = [];
        prevEnd = item.along + width;
        continue;
      }
      const gap = item.along - prevEnd;
      // Marks and Unicode-less glyphs (e.g. decomposed Arabic dots) never start a word.
      const attaches = isMark(g.unicode) || g.unicode === "";
      if (current.length && gap > line.size * 0.2 && !attaches) {
        groups.push(current);
        current = [];
      }
      current.push(item);
      prevEnd = Math.max(prevEnd, item.along + width);
    }
    if (current.length) groups.push(current);

    groups.forEach((group, wordIndex) => {
      // Groups of only Unicode-less glyphs (stray dots) are not words.
      if (group.every((g) => g.glyph.unicode === "")) return;
      const streamOrder = group.map((g) => g.glyph).sort((a, b) => a.index - b.index);
      const contiguous = contiguity(streamOrder);
      const raw = streamOrder.map((g) => g.unicode).join("");
      const direction = hasStrongRtl(raw) ? "rtl" : "ltr";
      const missingUnicode = streamOrder.every((g) => g.unicode === "");
      const alongOf = new Map(group.map((g) => [g.glyph, g.along]));
      lineWords.push({
        id: `${pagePrefix}-${lineIndex}-${wordIndex}`,
        glyphs: streamOrder,
        text: logicalText(streamOrder, direction, (g) => alongOf.get(g) ?? 0),
        direction,
        lineDirection,
        box: boxOf(streamOrder),
        lineBox,
        line: lineAlong,
        editable: contiguous && !missingUnicode,
        reason: !contiguous
          ? "Word glyphs are not contiguous in the content stream."
          : missingUnicode
            ? "Font has no Unicode mapping for some glyphs."
            : undefined,
      });
    });
    if (lineWords.length === 0) return;
    words.push(...lineWords);

    const streamOrder = visual.map((v) => v.glyph).sort((a, b) => a.index - b.index);
    const contiguous = contiguity(streamOrder);
    const readOnly = lineWords.find((w) => !w.editable);
    textLines.push({
      id: `${pagePrefix}-line-${lineIndex}`,
      glyphs: streamOrder,
      text: logicalLineText(lineWords, lineDirection),
      direction: lineDirection,
      lineDirection,
      box: lineBox,
      line: lineAlong,
      words: lineWords,
      editable: contiguous && !readOnly,
      reason: !contiguous
        ? "The line is drawn in several separate places in the content stream."
        : readOnly?.reason,
    });
  });
  return { words, lines: textLines };
}
