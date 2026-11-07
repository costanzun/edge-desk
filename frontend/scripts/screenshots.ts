// Run with: pnpm screenshots   (writes ../docs/screenshots/*.png)
//
// Point BASE_URL at a mock-mode server (default http://localhost:3124):
//   NEXT_PUBLIC_MOCK=1 NEXT_DIST_DIR=.next-mock pnpm exec next dev -p 3124
// or at the live app (BASE_URL=http://localhost:3104) for screenshots of real data.
// The kill switch shot presses the switch and resumes afterwards, so against a live desk it
// writes one halt + one resume into the control log.
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(__dirname, "../../docs/screenshots");
const BASE = (process.env.BASE_URL ?? "http://localhost:3124").replace(/\/$/, "");

async function ctxFor(browser: import("@playwright/test").Browser, opts: { theme: "light" | "dark"; mobile?: boolean }): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: opts.mobile ? 3 : 2,
    isMobile: !!opts.mobile,
    hasTouch: !!opts.mobile,
    colorScheme: opts.theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
  }, opts.theme);
  return ctx;
}

async function go(page: Page, route: string, testId: string) {
  await page.goto(BASE + route);
  await page.getByTestId(testId).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(700);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("wrote", `${name}.png`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  const light = await ctxFor(browser, { theme: "light" });
  const p = await light.newPage();

  await go(p, "/", "curve-chart");
  await p.getByTestId("curve-point").nth(3).hover();
  await p.waitForTimeout(300);
  await shot(p, "desk-light");

  await go(p, "/positions", "equity-chart");
  await shot(p, "positions");

  await go(p, "/latency", "edge-decay-chart");
  await p.getByTestId("decay-point").nth(5).hover();
  await p.waitForTimeout(300);
  await shot(p, "latency");

  await go(p, "/risk", "kill-switch");
  await shot(p, "risk");
  await p.getByTestId("kill-switch").click();
  await p.getByTestId("kill-reason").fill("Polymarket book looks stale");
  await p.getByTestId("kill-confirm").click();
  await p.getByTestId("halt-banner").waitFor();
  await p.waitForTimeout(600);
  await shot(p, "risk-halted");
  await p.getByTestId("resume-button").click();
  await p.getByTestId("resume-reason").fill("feed recovered");
  await p.getByTestId("resume-confirm").click();
  await p.getByTestId("kill-switch").waitFor();

  await go(p, "/capital", "kelly-output");
  await shot(p, "capital");

  await go(p, "/models", "reliability-chart");
  await shot(p, "models");

  await go(p, "/replay", "replay-form");
  await p.getByTestId("replay-mode-synthetic").click();
  await p.getByTestId("replay-decay").check();
  await p.getByTestId("replay-run").click();
  await p.getByTestId("replay-digest").waitFor({ timeout: 600_000 });
  await p.waitForTimeout(500);
  await p.getByTestId("replay-digest").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120));
  await p.waitForTimeout(300);
  await shot(p, "replay");

  await go(p, "/settings", "settings-strategy");
  await shot(p, "settings");
  await light.close();

  const dark = await ctxFor(browser, { theme: "dark" });
  const d = await dark.newPage();
  await go(d, "/", "curve-chart");
  await d.getByTestId("curve-point").nth(3).hover();
  await d.waitForTimeout(300);
  await shot(d, "desk-dark");
  await go(d, "/latency", "edge-decay-chart");
  await shot(d, "latency-dark");
  await dark.close();

  const mob = await ctxFor(browser, { theme: "light", mobile: true });
  const m = await mob.newPage();
  await go(m, "/", "curve-chart");
  await shot(m, "mobile-desk");
  await m.getByTestId("nav-open").click();
  await m.getByTestId("nav-drawer").waitFor();
  await m.waitForTimeout(300);
  await shot(m, "mobile-nav");
  await mob.close();

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
