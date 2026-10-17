import { defineConfig } from "@playwright/test";
const evidence = process.env.WR_E2E_EVIDENCE;
const appPort = process.env.WR_E2E_PORT || "18767";
export default defineConfig({
  outputDir: evidence ? evidence + "/results" : "test-results",
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: evidence
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: evidence + "/report" }],
        ["json", { outputFile: evidence + "/results.json" }],
      ]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: evidence ? "on" : "retain-on-failure",
    screenshot: evidence ? "on" : "only-on-failure",
  },
  webServer: {
    command: ".venv/bin/python scripts/test_server.py",
    url: `http://127.0.0.1:${appPort}/health`,
    reuseExistingServer: false,
    timeout: 20000,
  },
});
