import assert from "node:assert/strict";
import test from "node:test";

import { verificationResendErrorMessage } from "./verificationResendMessage";

test("preserves the consumer message for an already verified account", () => {
  assert.equal(
    verificationResendErrorMessage(400, "Email is already verified"),
    "This email is already verified. You can sign in to your Vault.",
  );
});

test("maps expired or invalid sessions to sign-in guidance", () => {
  const message = "Your sign-in expired. Return to sign in and try again.";

  assert.equal(verificationResendErrorMessage(400, "Session token not provided"), message);
  assert.equal(verificationResendErrorMessage(401, "Invalid session token"), message);
});

test("does not expose arbitrary upstream errors", () => {
  assert.equal(
    verificationResendErrorMessage(500, "database connection details"),
    "Unable to resend the verification email. Please try again.",
  );
});
