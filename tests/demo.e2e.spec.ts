import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { extractsText, hasQpdf, qpdfCheck } from "./helpers";

// The client's milestone-1 demo, driven through the real UI in a browser.

async function editAndDownload(page: Page, fixture: string, word: string, replacement: string) {
  const external: string[] = [];
  page.on("request", (req) => {
    if (!req.url().startsWith("http://localhost") && !req.url().startsWith("blob:") && !req.url().startsWith("data:")) {
      external.push(req.url());
    }
  });

  await page.goto("/");
  await page.setInputFiles("#pdf-file", `tests/fixtures/${fixture}`);
  await expect(page.locator("#status")).toContainText("words on page 1");

  await page.locator(`.text-hitbox[data-text="${word}"]`).first().click();
  await page.fill("#replacement-text", replacement);
  await page.click("#apply-replacement");
  await expect(page.locator("#edit-status")).toContainText("Replaced");
  for (const part of replacement.split(" ")) {
    await expect(page.locator(`.text-hitbox[data-text="${part}"]`).first()).toBeVisible();
  }

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-pdf")]);
  const path = test.info().outputPath(`edited-${fixture}`);
  await download.saveAs(path);
  expect(external, "no external requests at runtime").toEqual([]);
  if (hasQpdf()) qpdfCheck(path);
  return new Uint8Array(readFileSync(path));
}

test("Arabic sentence: change one word in place and save", async ({ page }) => {
  const bytes = await editAndDownload(page, "chrome-arabic.pdf", "بكم", "لكم");
  await expect(page.locator("#edit-status")).toContainText("original font");
  expect(await extractsText(bytes, "مرحبا لكم في التقرير السنوي")).toBe(true);
});

test("English bold heading: change one word in place and save", async ({ page }) => {
  const bytes = await editAndDownload(page, "chrome-heading.pdf", "Annual", "Rental");
  await expect(page.locator("#edit-status")).toContainText("original font");
  expect(await extractsText(bytes, "Rental Report Overview")).toBe(true);
});

test("Mixed line: replace a word with Arabic and digits", async ({ page }) => {
  const bytes = await editAndDownload(page, "chrome-mixed.pdf", "عام", "سنة 2025");
  expect(await extractsText(bytes, "2025")).toBe(true);
  expect(await extractsText(bytes, "سنة")).toBe(true);
});
