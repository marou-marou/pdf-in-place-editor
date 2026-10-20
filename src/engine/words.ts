import { hasStrongRtl, joiningType } from "./arabic";
import type { PositionedGlyph } from "./textLayout";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextWord {
  id: string;
  /** Glyphs in content-stream order. */
  glyphs: PositionedGlyph[];
  /** Logical-order Unicode text. */
  text: string;
  direction: "ltr" | "rtl";
  lineDirection: "ltr" | "rtl";
  /** User-space bounding box. */
  box: Box;
  /** User-space bounding box of the containing line. */
  lineBox: Box;
  /** Every glyph of the containing line with its position along the baseline. */
  line: ReadonlyMap<PositionedGlyph, number>;
  editable: boolean;
  reason?: string;
}

const isBlank = (s: string) => s.length > 0 && /^\s+$/u.test(s);
const isMark = (s: string) => s.length > 0 && [...s].every((ch) => joiningType(ch) === "T");

function boxOf(glyphs: readonly PositionedGlyph[]): Box {
  const xs = glyphs.flatMap((g) => g.quad.map((p) => p[0]));
  const ys = glyphs.flatMap((g) => g.quad.map((p) => p[1]));
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Logical text of a word. Marks attach to the preceding base in stream order;
 * clusters are then ordered visually (reversed for RTL), so it works whether
 * the producer wrote RTL text in visual or in logical order.
 */
export function logicalText(
  glyphs: readonly PositionedGlyph[],
  direction: "ltr" | "rtl",
  along: (g: PositionedGlyph) => number,
): string {
  const clusters: { text: string; pos: number }[] = [];
  for (const g of glyphs) {
    const last = clusters[clusters.length - 1];
    if ((isMark(g.unicode) || g.unicode === "") && last) last.text += g.unicode;
    else clusters.push({ text: g.unicode, pos: along(g) });
  }
  clusters.sort((a, b) => (direction === "rtl" ? b.pos - a.pos : a.pos - b.pos));
  return clusters.map((c) => c.text).join("");
}

interface LineGlyph {
  glyph: PositionedGlyph;
  along: number;
  across: number;
}

/** Groups glyphs into baseline-aligned lines, then splits lines into words. */
export function buildWords(glyphs: readonly PositionedGlyph[], pagePrefix: string): TextWord[] {
  const lines: { dir: [number, number]; origin: [number, number]; size: number; items: LineGlyph[] }[] = [];

  for (const glyph of glyphs) {
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
        line.items.push({ glyph, along: ox * line.dir[0] + oy * line.dir[1], across });
        placed = true;
      }
    }
    if (!placed) {
      const dir: [number, number] = len > 0 ? [dx / len, dy / len] : [1, 0];
      lines.push({ dir, origin: glyph.baseline, size: glyph.size || 1, items: [{ glyph, along: 0, across: 0 }] });
    }
  }

  const words: TextWord[] = [];
  lines.forEach((line, lineIndex) => {
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
      const first = streamOrder[0]!.index;
      const contiguous = streamOrder.every((g, k) => g.index === first + k);
      const raw = streamOrder.map((g) => g.unicode).join("");
      const direction = hasStrongRtl(raw) ? "rtl" : "ltr";
      const missingUnicode = streamOrder.every((g) => g.unicode === "");
      const alongOf = new Map(group.map((g) => [g.glyph, g.along]));
      words.push({
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
  });
  return words;
}
