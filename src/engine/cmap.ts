import { parseOperations, type Operand } from "./contentStream";

export interface CodespaceRange {
  low: number;
  high: number;
  bytes: number;
}

export interface ToUnicodeMap {
  codespace: CodespaceRange[];
  map: Map<number, string>;
}

function bytesToInt(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function utf16beToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return s;
}

function incrementLastUnit(s: string, by: number): string {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1) + by;
  return s.slice(0, -1) + String.fromCharCode(last);
}

const isStr = (o: Operand | undefined): o is Extract<Operand, { kind: "str" }> =>
  o?.kind === "str";

/** Parses a ToUnicode CMap (bfchar / bfrange, codespace ranges). */
export function parseToUnicode(bytes: Uint8Array): ToUnicodeMap {
  const ops = parseOperations(bytes);
  const codespace: CodespaceRange[] = [];
  const map = new Map<number, string>();

  for (const { op, operands } of ops) {
    if (op === "endcodespacerange") {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const lo = operands[i];
        const hi = operands[i + 1];
        if (isStr(lo) && isStr(hi)) {
          codespace.push({ low: bytesToInt(lo.bytes), high: bytesToInt(hi.bytes), bytes: lo.bytes.length });
        }
      }
    } else if (op === "endbfchar") {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const src = operands[i];
        const dst = operands[i + 1];
        if (isStr(src) && isStr(dst)) map.set(bytesToInt(src.bytes), utf16beToString(dst.bytes));
      }
    } else if (op === "endbfrange") {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const lo = operands[i];
        const hi = operands[i + 1];
        const dst = operands[i + 2];
        if (!isStr(lo) || !isStr(hi) || !dst) continue;
        const low = bytesToInt(lo.bytes);
        const high = Math.min(bytesToInt(hi.bytes), low + 0xffff);
        if (dst.kind === "str") {
          const base = utf16beToString(dst.bytes);
          for (let code = low; code <= high; code += 1) map.set(code, incrementLastUnit(base, code - low));
        } else if (dst.kind === "arr") {
          dst.items.forEach((item, k) => {
            if (item.kind === "str" && low + k <= high) map.set(low + k, utf16beToString(item.bytes));
          });
        }
      }
    }
  }
  return { codespace, map };
}

function hex(n: number, bytes: number): string {
  return n.toString(16).toUpperCase().padStart(bytes * 2, "0");
}

function utf16beHex(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) out += hex(s.charCodeAt(i), 2);
  return out;
}

/** Writes a ToUnicode CMap with one bfchar entry per code. */
export function writeToUnicode(map: ReadonlyMap<number, string>, codeBytes: 1 | 2): string {
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const lines: string[] = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    codeBytes === 1 ? "<00> <FF>" : "<0000> <FFFF>",
    "endcodespacerange",
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [code, text] of chunk) lines.push(`<${hex(code, codeBytes)}> <${utf16beHex(text)}>`);
    lines.push("endbfchar");
  }
  lines.push(
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  );
  return lines.join("\n");
}
