"use client";

import Link from "next/link";
import { useState } from "react";

import { verificationResendErrorMessage } from "@/utils/auth/verificationResendMessage";

export default function VerificationPendingActions() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resendVerification() {
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        setError(verificationResendErrorMessage(response.status, body?.error));
        return;
      }

      setMessage("A fresh verification link is on its way. Check your inbox.");
    } catch {
      setError("Unable to reach Benzene. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className="alert alert-success" role="status">
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        className="btn btn-neutral w-full"
        onClick={resendVerification}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Sending…" : "Resend verification email"}
      </button>

      <Link href="/login" className="btn btn-ghost w-full">
        Return to sign in
      </Link>
    </div>
  );
}
