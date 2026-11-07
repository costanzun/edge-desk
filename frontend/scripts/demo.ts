// Run with: pnpm demo   (records a ~50 s walkthrough into ../docs/media/raw/*.webm)
//
// BASE_URL defaults to a mock-mode server on http://localhost:3124. Against the live app the
// kill switch press and resume are written to the control log (one halt + one resume).
// Convert afterwards, e.g. ffmpeg -i raw/<file>.webm -c:v libx264 -crf 22 -pix_fmt yuv420p demo.mp4
import { chromium, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(__dirname, "../../docs/media/raw");
const BASE = (process.env.BASE_URL ?? "http://localhost:3124").replace(/\/$/, "");
const SIZE = { width: 1440, height: 900 };

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Move the mouse in small steps so the cursor path is visible in the recording. */
async function glide(page: Page, sel: ReturnType<Page["getByTestId"]>, steps = 18) {
  const box = await sel.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}

async function scrollTo(page: Page, testId: string, offset = 90) {
  await page.getByTestId(testId).first().evaluate((el, off) => {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: "smooth" });
  }, offset);
  await pause(page, 900);
}

async function nav(page: Page, name: string, ready: string) {
  await glide(page, page.getByTestId(`nav-${name}`));
  await page.getByTestId(`nav-${name}`).click();
  await page.getByTestId(ready).first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(page, 1200);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    recordVideo: { dir: OUT, size: SIZE },
  });
  const page = await ctx.newPage();

  // 1. desk: curve, hover across strikes
  await page.goto(BASE + "/");
  await page.getByTestId("curve-chart").waitFor({ timeout: 60_000 });
  await pause(page, 1800);
  const points = page.getByTestId("curve-point");
  const n = await points.count();
  for (let i = 0; i < n; i += 1) {
    await glide(page, points.nth(i), 10);
    await pause(page, 450);
  }
  await pause(page, 600);
  await page.getByTestId("curve-tab-0").click();
  await pause(page, 1400);

  // 2. opportunities: sort by edge
  await scrollTo(page, "opportunities");
  await glide(page, page.getByTestId("sort-best_edge"));
  await page.getByTestId("sort-best_edge").click();
  await pause(page, 900);
  await page.getByTestId("sort-best_edge").click();
  await pause(page, 900);
  await scrollTo(page, "signals-feed", 200);
  await pause(page, 1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(page, 700);

  // 3. positions
  await nav(page, "positions", "equity-chart");
  await glide(page, page.getByTestId("waterfall-bar").nth(4));
  await pause(page, 1500);

  // 4. latency: edge decay
  await nav(page, "latency", "edge-decay-chart");
  const dp = page.getByTestId("decay-point");
  for (const i of [0, 2, 5, 6, 8]) {
    await glide(page, dp.nth(i), 12);
    await pause(page, 650);
  }

  // 5. risk: kill switch + resume
  await nav(page, "risk", "kill-switch");
  await glide(page, page.getByTestId("kill-switch"));
  await page.getByTestId("kill-switch").click();
  await pause(page, 600);
  await page.getByTestId("kill-reason").pressSequentially("Polymarket book looks stale", { delay: 35 });
  await pause(page, 400);
  await page.getByTestId("kill-confirm").click();
  await page.getByTestId("halt-banner").waitFor();
  await pause(page, 2200);
  await glide(page, page.getByTestId("resume-button"));
  await page.getByTestId("resume-button").click();
  await page.getByTestId("resume-reason").pressSequentially("feed recovered", { delay: 35 });
  await page.getByTestId("resume-confirm").click();
  await page.getByTestId("kill-switch").waitFor();
  await pause(page, 1200);

  // 6. capital: Kelly
  await nav(page, "capital", "kelly-output");
  const p = page.getByTestId("kelly-p");
  await glide(page, p);
  for (const v of ["64", "66", "68", "70"]) {
    await p.fill(v);
    await pause(page, 550);
  }
  await glide(page, page.getByTestId("allocation-chart"));
  await pause(page, 1800);

  // 7. models
  await nav(page, "models", "reliability-chart");
  await page.getByTestId("scope-venue:kalshi").click();
  await pause(page, 1000);
  await page.getByTestId("scope-all").click();
  await pause(page, 1200);

  // 8. replay
  await nav(page, "replay", "replay-form");
  await page.getByTestId("replay-mode-synthetic").click();
  await pause(page, 500);
  await glide(page, page.getByTestId("replay-run"));
  await page.getByTestId("replay-run").click();
  await page.getByTestId("replay-digest").waitFor({ timeout: 600_000 });
  await scrollTo(page, "replay-digest", 100);
  await pause(page, 3000);

  await ctx.close(); // flushes the video
  await browser.close();
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
  console.log("wrote", files.map((f) => path.join(OUT, f)).join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
