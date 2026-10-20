import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FontProvider } from "../src/engine";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(root, "tests", "fixtures", name)));

export const nodeFonts: FontProvider = {
  async load(kind, bold) {
    const file =
      kind === "arabic"
        ? bold ? "NotoNaskhArabic-Bold.ttf" : "NotoNaskhArabic-Regular.ttf"
        : bold ? "DejaVuSans-Bold.ttf" : "DejaVuSans.ttf";
    return new Uint8Array(readFileSync(join(root, "public", "fonts", file)));
  },
};

interface Item {
  str: string;
  x: number;
  y: number;
  h: number;
}

/**
 * Text lines as pdf.js extracts them (what search and copy see), in reading
 * order: items are grouped by baseline and ordered right-to-left on Arabic
 * lines. Presentation forms are folded with NFKC.
 */
export async function extractLines(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: join(root, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  });
  const doc = await task.promise;
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    const items: Item[] = content.items.flatMap((item) =>
      "str" in item
        ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number, h: item.height }]
        : [],
    );
    const groups: Item[][] = [];
    for (const item of items) {
      // Same line if baselines are within half a line height (cursive Arabic uses text rise).
      const group = groups.find((g) => Math.abs(g[0]!.y - item.y) < 0.5 * Math.max(g[0]!.h, item.h, 4));
      if (group) group.push(item);
      else groups.push([item]);
    }
    groups.sort((a, b) => b[0]!.y - a[0]!.y);
    for (const group of groups) {
      const rtl = group.some((it) => /\p{Script=Arabic}/u.test(it.str));
      group.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
      lines.push(group.map((it) => it.str).join("").normalize("NFKC"));
    }
  }
  await task.destroy();
  return lines;
}

/** True if some extracted line contains `text`, ignoring whitespace. */
export async function extractsText(bytes: Uint8Array, text: string): Promise<boolean> {
  const squash = (s: string) => s.normalize("NFKC").replace(/\s+/gu, "");
  return (await extractLines(bytes)).some((line) => squash(line).includes(squash(text)));
}

export function hasQpdf(): boolean {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Runs `qpdf --check`; throws with qpdf's output if the file has errors or warnings. */
export function qpdfCheck(path: string): string {
  try {
    return execFileSync("qpdf", ["--check", path], { encoding: "utf8" });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`qpdf --check failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}
