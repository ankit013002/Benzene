"use client";

import Link from "next/link";
import React, { useId, useState } from "react";

type ResetPasswordFormProps = {
  hasToken: boolean;
};

const MISSING_TOKEN_MESSAGE =
  "This reset link is missing its token. Request a new link to continue.";

export default function ResetPasswordForm({ hasToken }: ResetPasswordFormProps) {
  const passwordId = useId();
  const confirmationId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tokenError = hasToken ? null : MISSING_TOKEN_MESSAGE;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!hasToken) {
      setError(MISSING_TOKEN_MESSAGE);
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      // Read the token only at submission time. It never enters component
      // state or the DOM, and is sent only in the reset request body.
      const token = new URLSearchParams(window.location.search).get("token");
      if (!token) {
        setError(MISSING_TOKEN_MESSAGE);
        return;
      }

      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, newPassword: password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        setError(body?.message ?? body?.error ?? "Unable to reset your password.");
        return;
      }

      setSuccess(true);
      setPassword("");
      setConfirmation("");
    } catch {
      setError("Unable to reach Benzene. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (success) {
    return (
      <div className="space-y-4" role="status">
        <div className="alert alert-success">
          <span>Your password has been reset. You can now sign in.</span>
        </div>
        <Link href="/login" className="btn btn-neutral">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div>
        <label htmlFor={passwordId} className="label">
          New password
        </label>
        <input
          id={passwordId}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          className="input input-bordered w-full"
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          aria-invalid={Boolean(error)}
        />
      </div>

      <div>
        <label htmlFor={confirmationId} className="label">
          Confirm new password
        </label>
        <input
          id={confirmationId}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className="input input-bordered w-full"
          placeholder="Enter it again"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
          minLength={8}
          aria-invalid={Boolean(error)}
        />
      </div>

      {(error ?? tokenError) && (
        <div className="alert alert-error" role="alert">
          <span>{error ?? tokenError}</span>
        </div>
      )}

      <button
        className="btn btn-neutral mt-4"
        type="submit"
        disabled={pending || !hasToken}
        aria-busy={pending}
      >
        {pending ? "Saving…" : "Reset password"}
      </button>
    </form>
  );
}
