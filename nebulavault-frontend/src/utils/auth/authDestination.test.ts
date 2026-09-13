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
  assert.equal(authDestination(true, "/dashboard/files"), "/dashboard/files");
});

test("auth responses without verification metadata use the dashboard", () => {
  assert.equal(authDestination(undefined), "/dashboard");
});

test("auth redirects reject protocol-relative destinations", () => {
  assert.equal(authDestination(true, "//evil.example"), "/dashboard");
});
