// Arabic joining analysis and a single-line Unicode bidi resolver (UAX #9
// without explicit embeddings, which PDF text content never carries).

export type JoiningType = "D" | "R" | "L" | "C" | "T" | "U";
export type JoiningForm = "isol" | "init" | "medi" | "fina";

const RIGHT_JOINING: ReadonlyArray<[number, number]> = [
  [0x0622, 0x0625], [0x0627, 0x0627], [0x0629, 0x0629], [0x062f, 0x0632],
  [0x0648, 0x0648], [0x0671, 0x0673], [0x0675, 0x0677], [0x0688, 0x0699],
  [0x06c0, 0x06c0], [0x06c3, 0x06cb], [0x06cd, 0x06cd], [0x06cf, 0x06cf],
  [0x06d2, 0x06d3], [0x06d5, 0x06d5], [0x06ee, 0x06ef], [0x0759, 0x075b],
  [0x076b, 0x076c], [0x0771, 0x0771], [0x0773, 0x0774], [0x0778, 0x0779],
];

const DUAL_JOINING: ReadonlyArray<[number, number]> = [
  [0x0620, 0x0620], [0x0626, 0x0626], [0x0628, 0x0628], [0x062a, 0x062e],
  [0x0633, 0x063f], [0x0641, 0x0647], [0x0649, 0x064a], [0x066e, 0x066f],
  [0x0678, 0x0687], [0x069a, 0x06bf], [0x06c1, 0x06c2], [0x06cc, 0x06cc],
  [0x06ce, 0x06ce], [0x06d0, 0x06d1], [0x06fa, 0x06fc], [0x06ff, 0x06ff],
  [0x0750, 0x0758], [0x075c, 0x076a], [0x076d, 0x0770], [0x0772, 0x0772],
  [0x0775, 0x0777], [0x077a, 0x077f],
];

const inRanges = (cp: number, ranges: ReadonlyArray<[number, number]>): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const MARK = /^\p{Mn}$/u;

export function joiningType(ch: string): JoiningType {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x0640 || cp === 0x200d) return "C";
  if (MARK.test(ch)) return "T";
  if (inRanges(cp, DUAL_JOINING)) return "D";
  if (inRanges(cp, RIGHT_JOINING)) return "R";
  return "U";
}

const joinsForward = (t: JoiningType) => t === "D" || t === "L" || t === "C";
const joinsBackward = (t: JoiningType) => t === "D" || t === "R" || t === "C";

export const isArabicLetter = (ch: string): boolean => {
  const t = joiningType(ch);
  return t === "D" || t === "R" || (t === "U" && /\p{Script=Arabic}/u.test(ch) && !/\p{Nd}/u.test(ch));
};

/** Contextual form of every character of a logical-order string. Marks get null. */
export function joiningForms(chars: readonly string[]): (JoiningForm | null)[] {
  const types = chars.map(joiningType);
  const forms: (JoiningForm | null)[] = new Array(chars.length).fill(null);
  for (let i = 0; i < chars.length; i += 1) {
    const t = types[i]!;
    if (t === "T") continue;
    let p = i - 1;
    while (p >= 0 && types[p] === "T") p -= 1;
    let n = i + 1;
    while (n < chars.length && types[n] === "T") n += 1;
    const prev = p >= 0 && joinsForward(types[p]!) && joinsBackward(t);
    const next = n < chars.length && joinsForward(t) && joinsBackward(types[n]!);
    forms[i] = prev && next ? "medi" : prev ? "fina" : next ? "init" : "isol";
  }
  return forms;
}

const LAM = "ل";
const ALEF_VARIANTS = new Set(["آ", "أ", "إ", "ا"]);

export interface ArabicCluster {
  /** Logical text of the cluster (base + marks, or lam-alef + marks). */
  text: string;
  /** Text that should map to a single glyph (base or lam-alef ligature). */
  base: string;
  form: JoiningForm | null;
  marks: string[];
}

/** Splits logical Arabic text into shaping clusters with their joining form. */
export function arabicClusters(text: string): ArabicCluster[] {
  const chars = [...text];
  const forms = joiningForms(chars);
  const clusters: ArabicCluster[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (joiningType(ch) === "T" && clusters.length > 0) {
      const last = clusters[clusters.length - 1]!;
      last.marks.push(ch);
      last.text += ch;
      continue;
    }
    // Mandatory lam-alef ligature; marks between lam and alef block it.
    if (ch === LAM && ALEF_VARIANTS.has(chars[i + 1] ?? "")) {
      const lamForm = forms[i]!;
      const form: JoiningForm = lamForm === "medi" || lamForm === "fina" ? "fina" : "isol";
      clusters.push({ text: ch + chars[i + 1]!, base: ch + chars[i + 1]!, form, marks: [] });
      i += 1;
      continue;
    }
    clusters.push({ text: ch, base: ch, form: forms[i] ?? null, marks: [] });
  }
  return clusters;
}

// --- Presentation forms -------------------------------------------------

let presentationTable: Map<string, { base: string; form: JoiningForm }> | null = null;

/**
 * Maps Arabic Presentation Forms-B code points (U+FE80..U+FEFC) to their base
 * letters and forms. Each base letter occupies consecutive slots in the order
 * isol, fina, init, medi, so the table is derived from NFKC at runtime.
 */
function getPresentationTable(): Map<string, { base: string; form: JoiningForm }> {
  if (presentationTable) return presentationTable;
  presentationTable = new Map();
  const order: JoiningForm[] = ["isol", "fina", "init", "medi"];
  let groupBase = "";
  let slot = 0;
  for (let cp = 0xfe80; cp <= 0xfefc; cp += 1) {
    const ch = String.fromCodePoint(cp);
    const base = ch.normalize("NFKC");
    if (base === ch) continue;
    if (base !== groupBase) {
      groupBase = base;
      slot = 0;
    }
    presentationTable.set(ch, { base, form: order[slot] ?? "isol" });
    slot += 1;
  }
  return presentationTable;
}

/** Decodes a ToUnicode value that may be a presentation form. */
export function decodePresentationForm(text: string): { base: string; form: JoiningForm | null } {
  const entry = text.length === 1 ? getPresentationTable().get(text) : undefined;
  if (entry) return entry;
  const cp = text.codePointAt(0) ?? 0;
  if (cp >= 0xfb50 && cp <= 0xfdff) return { base: text.normalize("NFKC"), form: null };
  return { base: text, form: null };
}

// --- Bidi ----------------------------------------------------------------

type BidiClass = "L" | "R" | "AL" | "EN" | "AN" | "ES" | "ET" | "CS" | "NSM" | "WS" | "ON";

function bidiClass(ch: string): BidiClass {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x0660 && cp <= 0x0669) return "AN";
  if (cp === 0x066b || cp === 0x066c) return "AN";
  if (cp >= 0x06f0 && cp <= 0x06f9) return "EN";
  if (cp >= 0x30 && cp <= 0x39) return "EN";
  if (MARK.test(ch)) return "NSM";
  if (
    (cp >= 0x0600 && cp <= 0x07bf) || (cp >= 0x0860 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)
  ) return "AL";
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return "R";
  if (ch === "+" || ch === "-") return "ES";
  if (/[#$%¢-¥°±٪₠-⃏]/u.test(ch)) return "ET";
  if (/[,.:/ ،]/u.test(ch)) return "CS";
  if (/\s/u.test(ch)) return "WS";
  if (/[\p{L}\p{M}\p{N}]/u.test(ch)) return "L";
  return "ON";
}

export interface BidiRun {
  /** Logical text of the run. */
  text: string;
  direction: "ltr" | "rtl";
}

/**
 * Resolves embedding levels for one line and returns level runs in visual
 * order (left to right). Text inside each run stays in logical order; RTL runs
 * are reversed by the shaper.
 */
export function bidiRuns(text: string, base: "ltr" | "rtl"): BidiRun[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const baseLevel = base === "rtl" ? 1 : 0;
  const sos: BidiClass = base === "rtl" ? "R" : "L";
  const t = chars.map(bidiClass);

  // W1: NSM takes the type of the previous character.
  for (let i = 0; i < t.length; i += 1) if (t[i] === "NSM") t[i] = i === 0 ? sos : t[i - 1]!;
  // W2: EN after AL becomes AN.
  let lastStrong: BidiClass = sos;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i]!;
    if (c === "L" || c === "R" || c === "AL") lastStrong = c;
    else if (c === "EN" && lastStrong === "AL") t[i] = "AN";
  }
  // W3
  for (let i = 0; i < t.length; i += 1) if (t[i] === "AL") t[i] = "R";
  // W4
  for (let i = 1; i + 1 < t.length; i += 1) {
    const [a, c, b] = [t[i - 1], t[i], t[i + 1]];
    if (c === "ES" && a === "EN" && b === "EN") t[i] = "EN";
    else if (c === "CS" && a === b && (a === "EN" || a === "AN")) t[i] = a!;
  }
  // W5: ET sequences adjacent to EN become EN.
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== "ET") continue;
    let j = i;
    while (j < t.length && t[j] === "ET") j += 1;
    if (t[i - 1] === "EN" || t[j] === "EN") for (let k = i; k < j; k += 1) t[k] = "EN";
    i = j - 1;
  }
  // W6
  for (let i = 0; i < t.length; i += 1) if (t[i] === "ES" || t[i] === "ET" || t[i] === "CS") t[i] = "ON";
  // W7
  lastStrong = sos;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i]!;
    if (c === "L" || c === "R") lastStrong = c;
    else if (c === "EN" && lastStrong === "L") t[i] = "L";
  }
  // N1/N2: neutrals between same-direction strong types take that direction.
  const strongDir = (c: BidiClass | undefined): "L" | "R" | null =>
    c === "L" ? "L" : c === "R" || c === "EN" || c === "AN" ? "R" : null;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== "ON" && t[i] !== "WS") continue;
    let j = i;
    while (j < t.length && (t[j] === "ON" || t[j] === "WS")) j += 1;
    const before = i === 0 ? strongDir(sos) : strongDir(t[i - 1]);
    const after = j === t.length ? strongDir(sos) : strongDir(t[j]);
    const resolved: BidiClass = before && before === after ? before : sos;
    for (let k = i; k < j; k += 1) t[k] = resolved;
    i = j - 1;
  }
  // I1/I2
  const levels = t.map((c) => {
    if (baseLevel === 0) return c === "R" ? 1 : c === "AN" || c === "EN" ? 2 : 0;
    return c === "L" || c === "EN" || c === "AN" ? 2 : 1;
  });

  // Level runs in logical order.
  const runs: { text: string; level: number }[] = [];
  chars.forEach((ch, i) => {
    const last = runs[runs.length - 1];
    if (last && last.level === levels[i]) last.text += ch;
    else runs.push({ text: ch, level: levels[i]! });
  });

  // L2 applied to whole runs.
  const maxLevel = Math.max(...runs.map((r) => r.level));
  const minOdd = Math.min(...runs.map((r) => r.level).filter((l) => l % 2 === 1), maxLevel + 1);
  for (let level = maxLevel; level >= minOdd && level > 0; level -= 1) {
    for (let i = 0; i < runs.length; i += 1) {
      if (runs[i]!.level < level) continue;
      let j = i;
      while (j < runs.length && runs[j]!.level >= level) j += 1;
      const reversed = runs.slice(i, j).reverse();
      runs.splice(i, j - i, ...reversed);
      i = j - 1;
    }
  }
  return runs.map((r) => ({ text: r.text, direction: r.level % 2 === 1 ? "rtl" : "ltr" }));
}

export function hasStrongRtl(text: string): boolean {
  return [...text].some((ch) => {
    const c = bidiClass(ch);
    return c === "AL" || c === "R";
  });
}
