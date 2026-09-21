import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, tunnel: boolean) {
  const state = { authenticated: false, logins: 0, tunnel };
  await page.addInitScript(() => {
    class AuthEvents extends EventTarget { close() {} }
    Object.defineProperty(window, "EventSource", { value: AuthEvents });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop();
    if (command === "login") state.logins++;
    if (state.tunnel || (!state.authenticated && command !== "login")) {
      return route.fulfill({ status: 401, headers: state.tunnel ? { "WWW-Authenticate": "tunnel" } : {}, body: "Unauthorized" });
    }
    if (command === "login") {
      state.authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (command === "list_sessions") return route.fulfill({ json: [] });
    if (command === "runtime_status") return route.fulfill({ json: { connected: true, acceptingWork: true } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  return state;
}

test("a tunnel 401 offers provider reauthentication, never a daemon token field", async ({ page }) => {
  const state = await setup(page, true);
  await expect(page.getByRole("heading", { name: "Sign in to your tunnel" })).toBeVisible();
  await expect(page.getByLabel("Access token", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
  state.tunnel = false;
  state.authenticated = true;
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(state.logins).toBe(0);
});

test("ordinary daemon token authentication still works, including unmarked legacy 401 responses", async ({ page }) => {
  const state = await setup(page, false);
  await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to your tunnel" })).toHaveCount(0);
  await page.getByLabel("Access token", { exact: true }).fill("fixture-token-not-a-real-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(state.logins).toBe(1);
});

test("tunnel expiry during daemon login switches recovery to the provider sign-in screen", async ({ page }) => {
  const state = await setup(page, false);
  await page.getByLabel("Access token", { exact: true }).fill("fixture-token-not-a-real-secret");
  state.tunnel = true;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your tunnel" })).toBeVisible();
  await expect(page.getByLabel("Access token", { exact: true })).toHaveCount(0);
  expect(state.logins).toBe(1);
});
