import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

test("account-deletion information page is public without a session", async () => {
  const response = await proxy(new NextRequest("https://benzene.example/account-deletion"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
});

test("store-listing privacy, terms, and support pages are public without a session", async () => {
  for (const path of ["/privacy", "/terms", "/support"]) {
    const response = await proxy(new NextRequest(`https://benzene.example${path}`));
    assert.equal(response.status, 200, `${path} should not require a session`);
    assert.equal(response.headers.get("location"), null, `${path} should not redirect to login`);
  }
});

test("account-deletion information page explains the real deletion limits", async () => {
  const { default: AccountDeletionPage } = await import("./app/account-deletion/page");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const markup = renderToStaticMarkup(AccountDeletionPage());

  for (const phrase of [
    "Settings → Delete account",
    "current web app does not have a self-service deletion control",
    "does not collect passwords",
    "up to 15 minutes",
    "If a device is offline",
    "minimal deletion request and status record",
    "Billing records and application-managed backups or logs",
  ]) {
    assert.ok(markup.includes(phrase), `page should explain: ${phrase}`);
  }
});
