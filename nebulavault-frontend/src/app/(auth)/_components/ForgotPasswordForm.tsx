"use client";

import React, { useId, useState } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordForm() {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setError("Enter a valid email.");
      return;
    }

    setPending(true);
    try {
      // The same response keeps account existence private, including when the
      // requested address is not registered.
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: normalizedEmail }),
      });
      setMessage(
        "If an account matches that email, we’ll send a password reset link shortly.",
      );
    } catch {
      setError("Unable to reach Benzene. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div>
        <label htmlFor={emailId} className="label">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          className="input input-bordered w-full"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          aria-invalid={Boolean(error)}
          aria-describedby={
            error ? `${emailId}-error` : message ? `${emailId}-message` : undefined
          }
        />
      </div>

      {message && (
        <div id={`${emailId}-message`} className="alert alert-success" role="status">
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div id={`${emailId}-error`} className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <button
        className="btn btn-neutral mt-4"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
