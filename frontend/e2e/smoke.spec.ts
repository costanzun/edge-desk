import { expect, test, type Page } from "@playwright/test";

// Mocked suite: NEXT_PUBLIC_MOCK=1 serves the fixtures in src/mocks, no backend needed.

async function open(page: Page, path: string, testId: string) {
  await page.goto(path);
  await expect(page.getByTestId(testId).first()).toBeVisible();
}

test.describe("shell", () => {
  test("ticker, paper badge, mode badge and footer on every page", async ({ page }) => {
    await open(page, "/", "kpis");
    await expect(page.getByTestId("ticker")).toContainText("BTC");
    await expect(page.getByTestId("ticker")).toContainText("76,904");
    await expect(page.getByTestId("ticker")).toContainText("5 of 5 feeds live");
    await expect(page.getByTestId("paper-badge")).toContainText(/paper only/i);
    await expect(page.getByTestId("mode-badge")).toHaveText(/mock/i);
    await expect(page.getByText("Paper trading research. No real orders. Public market data only.").last()).toBeVisible();
  });

  test("sidebar navigates between all pages", async ({ page }) => {
    await open(page, "/", "kpis");
    const pages: [string, string, string][] = [
      ["how-it-works", "/how-it-works", "pipeline"],
      ["positions", "/positions", "blotter"],
      ["latency", "/latency", "edge-decay"],
      ["risk", "/risk", "limits-table"],
      ["capital", "/capital", "kelly-panel"],
      ["models", "/models", "reliability-panel"],
      ["replay", "/replay", "replay-form"],
      ["settings", "/settings", "settings-strategy"],
      ["desk", "/", "curve-panel"],
    ];
    for (const [nav, url, id] of pages) {
      await page.getByTestId(`nav-${nav}`).click();
      await expect(page).toHaveURL(new RegExp(`${url === "/" ? "/$" : url}`));
      await expect(page.getByTestId(id).first()).toBeVisible();
    }
  });

  test("sidebar collapses to icons", async ({ page }) => {
    await open(page, "/", "kpis");
    const sb = page.getByTestId("sidebar");
    const wide = (await sb.boundingBox())!.width;
    await page.getByTestId("sidebar-collapse").click();
    await expect.poll(async () => (await sb.boundingBox())!.width).toBeLessThan(wide / 2);
  });

  test("theme toggle switches to dark and back", async ({ page }) => {
    await open(page, "/", "kpis");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(10, 14, 19)");
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });
});

test.describe("desk", () => {
  test("live trade signals are highlighted on the probability curve", async ({ page }) => {
    await open(page, "/", "curve-chart");
    const tabs = page.locator('[data-testid^="curve-tab-"]');
    const n = Math.max(1, await tabs.count());
    let found = false;
    for (let i = 0; i < n && !found; i++) {
      if (await tabs.count()) await tabs.nth(i).click();
      found = await page.getByTestId("signal-annotation").first().waitFor({ timeout: 4000 }).then(() => true, () => false);
    }
    expect(found).toBe(true);
    await expect(page.getByTestId("signal-band").first()).toBeAttached();
    await expect(page.getByTestId("signal-annotation").first()).toContainText("%");
  });

  test("probability curve renders model points, venue quotes and spot", async ({ page }) => {
    await open(page, "/", "curve-chart");
    const chart = page.getByTestId("curve-chart");
    await expect(chart.locator("svg")).toBeVisible();
    expect(await chart.getByTestId("curve-point").count()).toBeGreaterThan(3);
    expect(await chart.getByTestId("venue-quote").count()).toBeGreaterThan(3);
    await expect(chart.getByTestId("spot-marker")).toContainText("76,904");
    // the other expiry tab redraws the chart
    const before = await chart.getByTestId("curve-point").count();
    await page.getByTestId("curve-tab-0").click();
    await expect.poll(() => chart.getByTestId("curve-point").count()).not.toBe(before);
  });

  test("hovering the curve shows a tooltip with model and venue quotes", async ({ page }) => {
    await open(page, "/", "curve-chart");
    const pt = page.getByTestId("curve-point").nth(2);
    await pt.hover();
    const tip = page.getByTestId("chart-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Model chance");
    await expect(tip).toContainText("buy / sell YES");
  });

  test("KPI tiles, feeds, signals and orders", async ({ page }) => {
    await open(page, "/", "kpis");
    await expect(page.getByTestId("kpis")).toContainText("+$2,942.87");
    await expect(page.getByTestId("kpis")).toContainText("64.3%");
    await expect(page.getByTestId("feed-health")).toContainText(/polymarket/i);
    await expect(page.getByTestId("signals-feed")).toContainText("BUY YES");
    await expect(page.getByTestId("orders-feed")).toContainText("filled");
  });

  test("opportunities table sorts and filters", async ({ page }) => {
    await open(page, "/", "opps-table");
    const rows = page.getByTestId("opp-row");
    await expect(rows).toHaveCount(15);
    await page.getByTestId("opps-toggle").click();
    await expect(rows).toHaveCount(18);
    const edges = async () => (await page.getByTestId("best-edge").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-value")))));
    const desc = await edges();
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await page.getByTestId("sort-best_edge").click();
    const asc = await edges();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect(asc[0]).toBeLessThan(desc[0]);
    await page.getByTestId("opps-venue-polymarket").click();
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText("PM");
  });
});

test.describe("explainer and how it works", () => {
  test("explainer is visible, dismisses, and stays dismissed after reload", async ({ page }) => {
    await open(page, "/", "explainer");
    await expect(page.getByTestId("explainer")).toContainText("Prediction markets");
    await expect(page.getByTestId("explainer")).toContainText("options market");
    await expect(page.getByTestId("explainer-finding")).toContainText("Kalshi is usually right");
    await page.getByTestId("explainer-dismiss").click();
    await expect(page.getByTestId("explainer")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("kpis")).toBeVisible();
    await expect(page.getByTestId("explainer-show")).toBeVisible();
    await expect(page.getByTestId("explainer")).toHaveCount(0);
    await page.getByTestId("explainer-show").click();
    await expect(page.getByTestId("explainer")).toBeVisible();
  });

  test("explainer links to How it works", async ({ page }) => {
    await open(page, "/", "explainer");
    await page.getByTestId("explainer-link").click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await expect(page.getByTestId("how-it-works")).toBeVisible();
  });

  test("How it works: pipeline diagram, page list, glossary, paper note", async ({ page }) => {
    await open(page, "/how-it-works", "how-it-works");
    await expect(page.getByTestId("pipeline-diagram")).toContainText("Public market feeds");
    await expect(page.getByTestId("pipeline-diagram")).toContainText("Event log / replay");
    await expect(page.getByTestId("pipeline-stage")).toHaveCount(7);
    await expect(page.getByTestId("glossary")).toContainText("Kelly sizing");
    await expect(page.getByTestId("glossary")).toContainText("Brier");
    await expect(page.getByTestId("pages-list")).toContainText("Replay");
    await expect(page.getByTestId("paper-note")).toContainText("not investment advice");
  });

  test("KPI and chart captions explain themselves", async ({ page }) => {
    await open(page, "/", "kpis");
    await expect(page.getByRole("button", { name: /share of settled paper trades that made money/i })).toBeVisible();
    await expect(page.getByTestId("curve-panel")).toContainText("Chance Bitcoin ends above each price");
    await expect(page.getByTestId("feed-status")).toHaveCount(5);
    await expect(page.getByTestId("config-panel")).toContainText("Take the best available price (taker)");
  });
});

test.describe("risk", () => {
  test("kill switch: confirm with reason -> halted banner everywhere -> resume", async ({ page }) => {
    await open(page, "/risk", "kill-switch");
    await expect(page.getByTestId("halt-banner")).toHaveCount(0);
    await page.getByTestId("kill-switch").click();
    await expect(page.getByTestId("kill-dialog")).toBeVisible();
    await page.getByTestId("kill-reason").fill("e2e: feed check");
    await page.getByTestId("kill-confirm").click();
    await expect(page.getByTestId("halt-banner")).toContainText("e2e: feed check");
    await expect(page.getByTestId("trading-state")).toHaveText("Trading halted");
    await expect(page.getByTestId("halts-panel")).toContainText("e2e: feed check");
    // banner persists on other pages
    await page.getByTestId("nav-positions").click();
    await expect(page.getByTestId("halt-banner")).toBeVisible();
    // resume from the header
    await page.getByTestId("resume-header").click();
    await page.getByTestId("resume-confirm").click();
    await expect(page.getByTestId("halt-banner")).toHaveCount(0);
    await expect(page.getByTestId("kill-switch-header")).toBeVisible();
  });

  test("cancelling the kill dialog leaves trading enabled", async ({ page }) => {
    await open(page, "/", "kpis");
    await page.getByTestId("kill-switch-header").click();
    await expect(page.getByTestId("kill-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("kill-dialog")).toHaveCount(0);
    await expect(page.getByTestId("halt-banner")).toHaveCount(0);
  });

  test("limits with usage bars, decisions and reconciliation", async ({ page }) => {
    await open(page, "/risk", "limits-table");
    expect(await page.getByTestId("usage-bar").count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId("limits-table")).toContainText("$3,000.00");
    await expect(page.getByTestId("failed-checks")).toContainText("qty_positive");
    await expect(page.getByTestId("recon-panel")).toContainText("Books agree");
  });
});

test.describe("analytics pages", () => {
  test("positions: equity curve, waterfall, attribution, blotter", async ({ page }) => {
    await open(page, "/positions", "equity-chart");
    await expect(page.getByTestId("equity-chart").locator("svg")).toBeVisible();
    await expect(page.getByTestId("waterfall-bar")).toHaveCount(6);
    await expect(page.getByTestId("attribution-breakdown")).toContainText(/kalshi/i);
    await page.getByTestId("attr-dim-tte_bucket").click();
    await expect(page.getByTestId("attr-table")).toContainText("15-60 min");
    await expect(page.getByTestId("trade-row")).toHaveCount(25);
    await page.getByTestId("blotter-toggle").click();
    await expect(page.getByTestId("trade-row")).toHaveCount(113);
    await expect(page.getByTestId("positions-table")).toContainText("BUY YES");
  });

  test("latency: edge-decay curve with takeaway, histograms, hops", async ({ page }) => {
    await open(page, "/latency", "edge-decay-chart");
    await expect(page.getByTestId("decay-point")).toHaveCount(9);
    await expect(page.getByTestId("decay-takeaway")).toContainText("survives 1 s");
    await expect(page.getByTestId("decay-takeaway")).toContainText("negative by 20 s");
    await expect(page.getByTestId("rtt-card")).toHaveCount(4);
    expect(await page.getByTestId("hop-row").count()).toBe(5);
  });

  test("capital: Kelly calculator updates its output", async ({ page }) => {
    await open(page, "/capital", "kelly-output");
    await expect(page.getByTestId("kelly-contracts")).toHaveText("332");
    await expect(page.getByTestId("kelly-stake")).toHaveText("$188.35");
    await page.getByTestId("kelly-p").fill("70");
    await expect(page.getByTestId("kelly-contracts")).not.toHaveText("332");
    const big = Number((await page.getByTestId("kelly-contracts").textContent())!.replace(/,/g, ""));
    expect(big).toBeGreaterThan(332);
    await page.getByTestId("kelly-price").fill("75");
    await expect(page.getByTestId("kelly-contracts")).toHaveText("0");
    await expect(page.getByTestId("allocation-row").first()).toBeVisible();
    await expect(page.getByTestId("stats-caveat")).toContainText("Per-trade, not annualised");
    await expect(page.getByTestId("p-ruin")).toHaveText("0.0%");
  });

  test("models: reliability diagram, scores, scope toggle, Kumo disabled", async ({ page }) => {
    await open(page, "/models", "reliability-chart");
    await expect(page.getByTestId("reliability-series")).toHaveCount(5);
    await expect(page.getByTestId("score-row")).toHaveCount(5);
    await expect(page.getByTestId("sample-panel")).toContainText("23,036");
    await page.getByTestId("scope-venue:polymarket").click();
    await expect(page.getByTestId("sample-panel")).toContainText("7,736");
    await page.getByTestId("legend-mid").click();
    await expect(page.getByTestId("reliability-series")).toHaveCount(4);
    await expect(page.getByTestId("kumo-toggle")).toBeDisabled();
    await expect(page.getByTestId("kumo-message")).toContainText("KUMO_API_KEY");
  });

  test("replay: run a synthetic replay and get a digest", async ({ page }) => {
    await open(page, "/replay", "replay-form");
    await expect(page.getByTestId("periods")).toContainText("2026-11-07 12:00 UTC");
    await page.getByTestId("replay-mode-synthetic").click();
    await page.getByTestId("replay-decay").check();
    await page.getByTestId("replay-run").click();
    await expect(page.getByTestId("replay-run")).toContainText(/running/i);
    await expect(page.getByTestId("replay-digest")).toContainText("deterministic: same digest every run", { timeout: 20_000 });
    await expect(page.getByTestId("digest-value")).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.getByTestId("replay-result")).toContainText("+$3,174.70");
    await expect(page.getByTestId("replay-decay-chart")).toBeVisible();
  });

  test("settings: edit and save re-folds", async ({ page }) => {
    await open(page, "/settings", "settings-strategy");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await page.getByTestId("settings-min_edge").fill("3");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-msg")).toContainText("re-folding");
    await expect(page.getByTestId("settings-min_edge")).toHaveValue("3");
    await expect(page.getByTestId("settings-kumo")).toContainText("KUMO_API_KEY");
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("top bar + nav drawer", async ({ page }) => {
    await open(page, "/", "kpis");
    await expect(page.getByTestId("sidebar")).toBeHidden();
    await expect(page.getByTestId("ticker-mobile")).toContainText("BTC");
    await page.getByTestId("nav-open").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("nav-latency").click();
    await expect(page).toHaveURL(/\/latency$/);
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("edge-decay")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
