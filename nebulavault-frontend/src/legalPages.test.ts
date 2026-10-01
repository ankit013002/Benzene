import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage, { metadata as privacyMetadata } from "./app/privacy/page";
import TermsPage, { metadata as termsMetadata } from "./app/terms/page";
import SupportPage, { metadata as supportMetadata } from "./app/support/page";

test("public legal and support pages state current behavior and deployment limits", () => {
  const pages = [
    { path: "/privacy", Page: PrivacyPage, metadata: privacyMetadata },
    { path: "/terms", Page: TermsPage, metadata: termsMetadata },
    { path: "/support", Page: SupportPage, metadata: supportMetadata },
  ];

  for (const { path, Page, metadata } of pages) {
    const markup = renderToStaticMarkup(Page());
    assert.equal(typeof metadata.title, "string", `${path} should have a title`);
    assert.equal(typeof metadata.description, "string", `${path} should have a description`);
    assert.ok(markup.includes("/privacy") && markup.includes("/terms") && markup.includes("/support"), `${path} should link to all public information pages`);
    assert.ok(markup.includes("/account-deletion"), `${path} should retain the separate account deletion page`);
    assert.ok(markup.includes("not production-ready"), `${path} should not imply production readiness`);
  }
});

test("privacy page describes encrypted mobile and web transfers and plaintext-era compatibility", () => {
  const markup = renderToStaticMarkup(PrivacyPage());
  assert.ok(markup.includes("native iOS and Android app encrypts file contents"));
  assert.ok(markup.includes("the web app now encrypts file contents"));
  assert.ok(markup.includes("limited to 25 MiB per file"));
  assert.ok(markup.includes("Earlier files remain in their original plaintext-era format"));
  assert.ok(markup.includes("There is no single retention schedule"));
  assert.ok(markup.includes("does not publish an email address or mailing address"));
});

test("terms and support explain current limits without inventing a contact or service commitment", () => {
  const terms = renderToStaticMarkup(TermsPage());
  const support = renderToStaticMarkup(SupportPage());
  for (const phrase of ["not production-ready", "key lifecycle and recovery design is not complete", "No availability, durability, recovery, or response-time commitment"]) {
    assert.ok(terms.includes(phrase), `terms should state: ${phrase}`);
  }
  assert.ok(support.includes("No support email, web form, or mailing address is configured"));
  assert.ok(support.includes("Use the support contact supplied by the service operator"));
});
