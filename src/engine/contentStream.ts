// Content stream lexer/parser that keeps the byte range of every operator so
// edits can be spliced into the original bytes without re-serialising the rest
// of the page.

export type Operand =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "str"; bytes: Uint8Array; hex: boolean }
  | { kind: "arr"; items: Operand[] }
  | { kind: "dict"; entries: Map<string, Operand> }
  | { kind: "bool"; value: boolean }
  | { kind: "null" };

export interface Operation {
  op: string;
  operands: Operand[];
  /** Byte offset of the first operand (or of the operator if it has none). */
  start: number;
  /** Byte offset just past the operator keyword (or past EI for inline images). */
  end: number;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

const isWhite = (b: number): boolean => WHITESPACE.has(b);
const isDelimiter = (b: number): boolean => DELIMITERS.has(b);
const isRegular = (b: number): boolean => !isWhite(b) && !isDelimiter(b);

type Token =
  | { type: "operand"; value: Operand; start: number }
  | { type: "arrayStart"; start: number }
  | { type: "arrayEnd" }
  | { type: "dictStart"; start: number }
  | { type: "dictEnd" }
  | { type: "keyword"; value: string; start: number; end: number };

class Lexer {
  pos = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private skipWhitespaceAndComments(): void {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos]!;
      if (isWhite(b)) {
        this.pos += 1;
      } else if (b === 0x25) {
        while (
          this.pos < bytes.length &&
          bytes[this.pos] !== 0x0a &&
          bytes[this.pos] !== 0x0d
        ) {
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  next(): Token | null {
    this.skipWhitespaceAndComments();
    const { bytes } = this;
    if (this.pos >= bytes.length) return null;

    const start = this.pos;
    const b = bytes[start]!;

    if (b === 0x5b) {
      this.pos += 1;
      return { type: "arrayStart", start };
    }
    if (b === 0x5d) {
      this.pos += 1;
      return { type: "arrayEnd" };
    }
    if (b === 0x3c && bytes[start + 1] === 0x3c) {
      this.pos += 2;
      return { type: "dictStart", start };
    }
    if (b === 0x3e && bytes[start + 1] === 0x3e) {
      this.pos += 2;
      return { type: "dictEnd" };
    }
    if (b === 0x28) return { type: "operand", value: this.literalString(), start };
    if (b === 0x3c) return { type: "operand", value: this.hexString(), start };
    if (b === 0x2f) return { type: "operand", value: this.name(), start };

    if (b === 0x7b || b === 0x7d || b === 0x29 || b === 0x3e) {
      // Stray delimiters (PostScript procedures in CMaps); treat as keywords.
      this.pos += 1;
      return { type: "keyword", value: String.fromCharCode(b), start, end: this.pos };
    }

    while (this.pos < bytes.length && isRegular(bytes[this.pos]!)) this.pos += 1;
    const word = latin1(bytes.subarray(start, this.pos));

    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      return { type: "operand", value: { kind: "num", value: Number(word) }, start };
    }
    if (word === "true" || word === "false") {
      return { type: "operand", value: { kind: "bool", value: word === "true" }, start };
    }
    if (word === "null") return { type: "operand", value: { kind: "null" }, start };

    return { type: "keyword", value: word, start, end: this.pos };
  }

  private name(): Operand {
    const { bytes } = this;
    this.pos += 1;
    let value = "";
    while (this.pos < bytes.length && isRegular(bytes[this.pos]!)) {
      const b = bytes[this.pos]!;
      if (b === 0x23 && this.pos + 2 < bytes.length) {
        const hex = latin1(bytes.subarray(this.pos + 1, this.pos + 3));
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      value += String.fromCharCode(b);
      this.pos += 1;
    }
    return { kind: "name", value };
  }

  private hexString(): Operand {
    const { bytes } = this;
    this.pos += 1;
    const out: number[] = [];
    let high = -1;
    while (this.pos < bytes.length && bytes[this.pos] !== 0x3e) {
      const digit = hexValue(bytes[this.pos]!);
      this.pos += 1;
      if (digit < 0) continue;
      if (high < 0) {
        high = digit;
      } else {
        out.push((high << 4) | digit);
        high = -1;
      }
    }
    if (high >= 0) out.push(high << 4);
    this.pos += 1;
    return { kind: "str", bytes: Uint8Array.from(out), hex: true };
  }

  private literalString(): Operand {
    const { bytes } = this;
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos]!;
      this.pos += 1;
      if (b === 0x5c) {
        const e = bytes[this.pos]!;
        this.pos += 1;
        switch (e) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0d:
            if (bytes[this.pos] === 0x0a) this.pos += 1;
            break;
          case 0x0a:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let value = e - 0x30;
              for (let i = 0; i < 2; i += 1) {
                const d = bytes[this.pos]!;
                if (d < 0x30 || d > 0x37) break;
                value = value * 8 + (d - 0x30);
                this.pos += 1;
              }
              out.push(value & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }
      if (b === 0x28) depth += 1;
      if (b === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(b);
    }
    return { kind: "str", bytes: Uint8Array.from(out), hex: false };
  }

  /** Skips inline image data after the ID keyword; returns the offset past EI. */
  skipInlineImageData(): number {
    const { bytes } = this;
    // A single whitespace byte follows ID.
    this.pos += 1;
    while (this.pos < bytes.length - 1) {
      if (
        bytes[this.pos] === 0x45 &&
        bytes[this.pos + 1] === 0x49 &&
        isWhite(bytes[this.pos - 1]!) &&
        (this.pos + 2 >= bytes.length || isWhite(bytes[this.pos + 2]!) || isDelimiter(bytes[this.pos + 2]!))
      ) {
        this.pos += 2;
        return this.pos;
      }
      this.pos += 1;
    }
    this.pos = bytes.length;
    return this.pos;
  }
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

export function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Parses a content stream (or CMap) into operations with byte ranges. */
export function parseOperations(bytes: Uint8Array): Operation[] {
  const lexer = new Lexer(bytes);
  const ops: Operation[] = [];
  // Stack of open containers; the bottom frame collects operands.
  type Frame =
    | { kind: "root"; items: Operand[]; start: number }
    | { kind: "arr"; items: Operand[] }
    | { kind: "dict"; items: Operand[] };
  let root: Frame = { kind: "root", items: [], start: -1 };
  const stack: Frame[] = [root];

  const push = (value: Operand, start: number) => {
    const top = stack[stack.length - 1]!;
    // Arrays and dicts record their start when opened; closing passes -1.
    if (top.kind === "root" && top.items.length === 0 && start >= 0) top.start = start;
    top.items.push(value);
  };

  for (let token = lexer.next(); token; token = lexer.next()) {
    switch (token.type) {
      case "operand":
        push(token.value, token.start);
        break;
      case "arrayStart":
        if (stack.length === 1 && root.items.length === 0) root.start = token.start;
        stack.push({ kind: "arr", items: [] });
        break;
      case "dictStart":
        if (stack.length === 1 && root.items.length === 0) root.start = token.start;
        stack.push({ kind: "dict", items: [] });
        break;
      case "arrayEnd": {
        const frame = stack.length > 1 ? stack.pop()! : null;
        if (frame) push({ kind: "arr", items: frame.items }, -1);
        break;
      }
      case "dictEnd": {
        const frame = stack.length > 1 ? stack.pop()! : null;
        if (frame) push(toDict(frame.items), -1);
        break;
      }
      case "keyword": {
        if (stack.length > 1) {
          // Keywords inside arrays (e.g. CMap procedures); ignore.
          break;
        }
        const start = root.items.length > 0 ? root.start : token.start;
        let end = token.end;
        if (token.value === "ID") {
          end = lexer.skipInlineImageData();
          // Fold BI ... ID ... EI into a single opaque operation.
          const bi = ops.length > 0 && ops[ops.length - 1]!.op === "BI" ? ops.pop()! : null;
          ops.push({ op: "INLINE_IMAGE", operands: [], start: bi ? bi.start : start, end });
        } else {
          ops.push({ op: token.value, operands: root.items, start, end });
        }
        root = { kind: "root", items: [], start: -1 };
        stack[0] = root;
        break;
      }
    }
  }
  return ops;
}

function toDict(items: Operand[]): Operand {
  const entries = new Map<string, Operand>();
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = items[i]!;
    if (key.kind === "name") entries.set(key.value, items[i + 1]!);
  }
  return { kind: "dict", entries };
}

/** Replaces byte ranges of operations with new text; ranges must not overlap. */
export function spliceOperations(
  bytes: Uint8Array,
  ops: readonly Operation[],
  replacements: ReadonlyMap<number, string>,
): Uint8Array {
  const indices = [...replacements.keys()].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const index of indices) {
    const op = ops[index]!;
    parts.push(bytes.subarray(cursor, op.start));
    parts.push(encodeLatin1(` ${replacements.get(index)!} `));
    cursor = op.end;
  }
  parts.push(bytes.subarray(cursor));
  return concatBytes(parts);
}

export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10000) / 10000;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  return String(rounded);
}

export function hexOf(bytes: Uint8Array): string {
  let s = "<";
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i]!.toString(16).padStart(2, "0");
  return `${s}>`;
}

export function serializeName(name: string): string {
  let s = "/";
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x23 || isDelimiter(c)) {
      s += `#${c.toString(16).padStart(2, "0")}`;
    } else {
      s += name[i];
    }
  }
  return s;
}
