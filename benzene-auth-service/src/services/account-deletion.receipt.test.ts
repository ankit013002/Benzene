import { describe, expect, it } from "vitest";
import {
  accountDeletionReceiptMatches,
  deriveAccountDeletionReceipt,
  hashAccountDeletionReceipt,
} from "./account-deletion.receipt";

describe("account deletion receipt", () => {
  it("derives a retry-stable, opaque, domain-separated high-entropy value", () => {
    const first = deriveAccountDeletionReceipt(
      "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      "3ad92332-b89b-4082-a78b-4cf29a21fc4e",
    );
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveAccountDeletionReceipt(
      "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      "3ad92332-b89b-4082-a78b-4cf29a21fc4e",
    )).toBe(first);
    expect(deriveAccountDeletionReceipt(
      "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      "5ad92332-b89b-4082-a78b-4cf29a21fc4e",
    )).not.toBe(first);
  });

  it("hashes receipt material and rejects altered or malformed values", () => {
    const receipt = deriveAccountDeletionReceipt(
      "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      "3ad92332-b89b-4082-a78b-4cf29a21fc4e",
    );
    const stored = hashAccountDeletionReceipt(receipt);
    expect(stored).toHaveLength(32);
    expect(stored.toString("base64url")).not.toBe(receipt);
    expect(accountDeletionReceiptMatches(receipt, stored)).toBe(true);
    expect(accountDeletionReceiptMatches(`${receipt.slice(0, -1)}A`, stored)).toBe(false);
    expect(accountDeletionReceiptMatches("bad", stored)).toBe(false);
  });
});
