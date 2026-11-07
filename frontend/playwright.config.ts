import { defineConfig, devices } from "@playwright/test";

// The mocked suite runs on its own port and build dir (PW_PORT, default 3124) so it never
// collides with the live app on 3104. PW_BASE_URL points it at an already running mock server.
const external = process.env.PW_BASE_URL;
const port = process.env.PW_PORT ?? "3124";
const base = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: external ?? base, colorScheme: "light", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: external
    ? undefined
    : {
        command: `NEXT_PUBLIC_MOCK=1 NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-mock pnpm exec next dev -p ${port}`,
        url: base,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
