import type { Operation } from "./contentStream";
import { decodeCodes, type LayoutFont } from "./fonts";
import { apply, IDENTITY, multiply, translate, type Matrix } from "./pdfUtil";

export interface TextState {
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling as a fraction (Tz / 100). */
  hScale: number;
  leading: number;
  rise: number;
  fontName: string;
  fontSize: number;
  font: LayoutFont | null;
}

export type ShowElement =
  | { kind: "glyph"; glyph: PositionedGlyph }
  | { kind: "adjust"; value: number };

export interface ShowOp {
  opIndex: number;
  operator: "Tj" | "TJ" | "'" | '"';
  /** For `"`: the word and character spacing operands. */
  quoteSpacing: [number, number] | null;
  elements: ShowElement[];
  state: TextState;
  ctm: Matrix;
  /** Text matrix before the first element is shown (after T* for ' and "). */
  startTm: Matrix;
  /**
   * True when no positioning operator separates this operator from the
   * previous show operator, so it starts wherever the previous one ended.
   */
  chained: boolean;
  /** Indices of enclosing BDC operators that carry an /ActualText. */
  actualTextOps: number[];
}

export interface PositionedGlyph {
  /** Index in page stream order. */
  index: number;
  showOp: ShowOp;
  code: number;
  bytes: Uint8Array;
  unicode: string;
  /** Horizontal displacement in text space units (tx in the PDF spec). */
  advance: number;
  /** Text matrix at the glyph origin. */
  tm: Matrix;
  /** User-space origin and end of the advance on the (risen) baseline. */
  origin: [number, number];
  end: [number, number];
  /** Origin on the unrisen baseline; used to group glyphs into lines. */
  baseline: [number, number];
  /** User-space corners: bottom-left, bottom-right, top-right, top-left. */
  quad: [number, number][];
  /** Rendered font size in user space. */
  size: number;
}

export type FontResolver = (resourceName: string) => LayoutFont | null;

const cloneState = (s: TextState): TextState => ({ ...s });

/** Interprets text operators of a content stream and positions every glyph. */
export function layoutText(
  ops: readonly Operation[],
  resolveFont: FontResolver,
): { glyphs: PositionedGlyph[]; showOps: ShowOp[] } {
  const glyphs: PositionedGlyph[] = [];
  const showOps: ShowOp[] = [];
  let ctm: Matrix = IDENTITY;
  let state: TextState = {
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    fontName: "",
    fontSize: 0,
    font: null,
  };
  const stack: { ctm: Matrix; state: TextState }[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  const nums = (op: Operation): number[] =>
    op.operands.map((o) => (o.kind === "num" ? o.value : 0));

  const nextLine = (tx: number, ty: number) => {
    tlm = multiply(translate(tx, ty), tlm);
    tm = tlm;
  };

  const show = (showOp: ShowOp, bytes: Uint8Array) => {
    const font = state.font;
    if (!font) return;
    const { fontSize: tfs, charSpacing: tc, wordSpacing: tw, hScale: th, rise } = state;
    for (const { code, bytes: codeBytes } of decodeCodes(font, bytes)) {
      const w0 = font.widthOf(code) * font.widthScale;
      const isSpaceCode = font.codeBytes === 1 && code === 32;
      const advance = (w0 * tfs + tc + (isSpaceCode ? tw : 0)) * th;
      const trm = multiply(tm, ctm);
      const toUser = (x: number, y: number) => apply(trm, x, y);
      const glyphWidth = w0 * tfs * th;
      const bottom = font.descent * tfs + rise;
      const top = font.ascent * tfs + rise;
      const glyph: PositionedGlyph = {
        index: glyphs.length,
        showOp,
        code,
        bytes: codeBytes,
        unicode: font.unicodeOf(code),
        advance,
        tm,
        origin: toUser(0, rise),
        end: toUser(advance, rise),
        baseline: toUser(0, 0),
        quad: [toUser(0, bottom), toUser(glyphWidth, bottom), toUser(glyphWidth, top), toUser(0, top)],
        size: Math.hypot(trm[2], trm[3]) * tfs,
      };
      glyphs.push(glyph);
      showOp.elements.push({ kind: "glyph", glyph });
      tm = multiply(translate(advance, 0), tm);
    }
  };

  const adjust = (showOp: ShowOp, value: number) => {
    showOp.elements.push({ kind: "adjust", value });
    tm = multiply(translate((-value / 1000) * state.fontSize * state.hScale, 0), tm);
  };

  // Whether the pen was explicitly positioned since the last show operator.
  let positioned = true;
  // Open marked-content sequences; ActualText replaces glyph text for extraction.
  const marked: { opIndex: number; actualText: boolean }[] = [];
  const beginShow = (opIndex: number, operator: ShowOp["operator"], quote: [number, number] | null): ShowOp => {
    const chained = !positioned && operator !== "'" && operator !== '"';
    positioned = false;
    const showOp: ShowOp = {
      opIndex,
      operator,
      quoteSpacing: quote,
      elements: [],
      state: cloneState(state),
      ctm,
      startTm: tm,
      chained,
      actualTextOps: marked.filter((m) => m.actualText).map((m) => m.opIndex),
    };
    showOps.push(showOp);
    return showOp;
  };

  ops.forEach((op, opIndex) => {
    if (op.op === "BT" || op.op === "Td" || op.op === "TD" || op.op === "Tm" || op.op === "T*") positioned = true;
    switch (op.op) {
      case "BDC": {
        const props = op.operands[1];
        marked.push({ opIndex, actualText: props?.kind === "dict" && props.entries.has("ActualText") });
        break;
      }
      case "BMC":
        marked.push({ opIndex, actualText: false });
        break;
      case "EMC":
        marked.pop();
        break;
      case "q":
        stack.push({ ctm, state: cloneState(state) });
        break;
      case "Q": {
        const saved = stack.pop();
        if (saved) {
          ctm = saved.ctm;
          state = saved.state;
        }
        break;
      }
      case "cm": {
        const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = nums(op);
        ctm = multiply([a, b, c, d, e, f], ctm);
        break;
      }
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "Tc":
        state.charSpacing = nums(op)[0] ?? 0;
        break;
      case "Tw":
        state.wordSpacing = nums(op)[0] ?? 0;
        break;
      case "Tz":
        state.hScale = (nums(op)[0] ?? 100) / 100;
        break;
      case "TL":
        state.leading = nums(op)[0] ?? 0;
        break;
      case "Ts":
        state.rise = nums(op)[0] ?? 0;
        break;
      case "Tf": {
        const name = op.operands[0];
        state.fontName = name?.kind === "name" ? name.value : "";
        state.fontSize = nums(op)[1] ?? 0;
        state.font = resolveFont(state.fontName);
        break;
      }
      case "Td": {
        const [tx = 0, ty = 0] = nums(op);
        nextLine(tx, ty);
        break;
      }
      case "TD": {
        const [tx = 0, ty = 0] = nums(op);
        state.leading = -ty;
        nextLine(tx, ty);
        break;
      }
      case "Tm": {
        const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = nums(op);
        tlm = [a, b, c, d, e, f];
        tm = tlm;
        break;
      }
      case "T*":
        nextLine(0, -state.leading);
        break;
      case "Tj":
      case "'":
      case '"': {
        let quote: [number, number] | null = null;
        if (op.op === '"') {
          const [aw = 0, ac = 0] = nums(op);
          state.wordSpacing = aw;
          state.charSpacing = ac;
          quote = [aw, ac];
        }
        if (op.op !== "Tj") nextLine(0, -state.leading);
        const showOp = beginShow(opIndex, op.op, quote);
        const str = op.operands[op.operands.length - 1];
        if (str?.kind === "str") show(showOp, str.bytes);
        break;
      }
      case "TJ": {
        const showOp = beginShow(opIndex, "TJ", null);
        const arr = op.operands[0];
        if (arr?.kind === "arr") {
          for (const item of arr.items) {
            if (item.kind === "str") show(showOp, item.bytes);
            else if (item.kind === "num") adjust(showOp, item.value);
          }
        }
        break;
      }
      default:
        break;
    }
  });

  return { glyphs, showOps };
}
