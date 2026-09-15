import { defineConfig } from "@playwright/test";

const baseURL = process.env.PARITY_TEST_URL ?? "http://127.0.0.1:3848";
const target = new URL(baseURL);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "3848") {
  throw new Error("Browser regressions must target the isolated local daemon on port 3848.");
}

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    channel: "msedge",
    headless: true,
    actionTimeout: 15_000,
    viewport: { width: 1440, height: 1000 },
  },
  reporter: "list",
});
