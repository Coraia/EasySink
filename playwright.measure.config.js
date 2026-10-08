import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  testDir: "./tests/measurement",
  timeout: 300000,
  use: {
    ...base.use,
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
    deviceScaleFactor: 2,
    launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
  },
});
