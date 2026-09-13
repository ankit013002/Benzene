import assert from "node:assert/strict";
import test from "node:test";

import { authDestination } from "./authDestination";

test("unverified auth responses always route to the pending verification page", () => {
  assert.equal(
    authDestination(false, "/dashboard/files"),
    "/verify-email?status=pending",
  );
});

test("verified auth responses preserve a safe requested destination", () => {
  assert.equal(
    authDestination(true, "/dashboard/files?view=recent#top"),
    "/dashboard/files?view=recent#top",
  );
  assert.equal(
    authDestination(true, "https://benzene.invalid/dashboard/files?view=recent#top"),
    "/dashboard/files?view=recent#top",
  );
});

test("auth responses without verification metadata use the dashboard", () => {
  assert.equal(authDestination(undefined), "/dashboard");
});

test("auth redirects reject protocol-relative destinations", () => {
  assert.equal(authDestination(true, "//evil.example"), "/dashboard");
});

test("auth redirects reject backslash-based authority escapes", () => {
  assert.equal(authDestination(true, "/\\evil.example"), "/dashboard");
  assert.equal(authDestination(true, "/dashboard\\evil"), "/dashboard");
});

test("auth redirects reject control characters", () => {
  assert.equal(authDestination(true, "/dashboard\nnext"), "/dashboard");
  assert.equal(authDestination(true, "/dashboard\tadmin"), "/dashboard");
});

test("auth redirects reject malformed and cross-origin destinations", () => {
  assert.equal(authDestination(true, "http://[malformed"), "/dashboard");
  assert.equal(authDestination(true, "https://benzene.invalid.evil/dashboard"), "/dashboard");
});
