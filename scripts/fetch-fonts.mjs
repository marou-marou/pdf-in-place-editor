// Copies the bundled fallback fonts into public/fonts. Run once after install.
// Network is only used here, at development time; the app itself loads fonts
// from its own origin and makes no external requests.
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "fonts");
await mkdir(out, { recursive: true });

const NOTO = "https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoNaskhArabic/hinted/ttf";
const downloads = {
  "NotoNaskhArabic-Regular.ttf": `${NOTO}/NotoNaskhArabic-Regular.ttf`,
  "NotoNaskhArabic-Bold.ttf": `${NOTO}/NotoNaskhArabic-Bold.ttf`,
};
const copies = {
  "DejaVuSans.ttf": "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf",
  "DejaVuSans-Bold.ttf": "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf",
};

const exists = (p) => stat(p).then(() => true, () => false);

for (const [name, url] of Object.entries(downloads)) {
  const target = join(out, name);
  if (await exists(target)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${name}: ${res.status}`);
  await writeFile(target, new Uint8Array(await res.arrayBuffer()));
  console.log(`downloaded ${name}`);
}
for (const [name, from] of Object.entries(copies)) {
  await copyFile(join(root, from), join(out, name));
  console.log(`copied ${name}`);
}
