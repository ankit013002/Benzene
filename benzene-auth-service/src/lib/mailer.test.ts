import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { sendPasswordResetEmail, sendVerificationEmail } from "./mailer";

describe("auth email links", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends verification only through the HTTPS page so the token stays off custom schemes", async () => {
    await sendVerificationEmail("ada@example.com", "verification token");
    const message = sendMail.mock.calls[0]?.[0] as { html: string };

    expect(message.html).toContain("http://localhost:3000/api/auth/verify-email?token=verification%20token");
    expect(message.html).not.toContain("benzene://");
    expect(message.html).not.toContain("verification token");
  });

  it("sends password resets only through the HTTPS page so the token stays off custom schemes", async () => {
    await sendPasswordResetEmail("ada@example.com", "reset/token");
    const message = sendMail.mock.calls[0]?.[0] as { html: string };

    expect(message.html).toContain("http://localhost:3000/reset-password?token=reset%2Ftoken");
    expect(message.html).not.toContain("benzene://");
    expect(message.html).not.toContain("reset/token");
  });
});
