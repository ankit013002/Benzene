"use client";

import React, { useId, useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterForm() {
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const termsId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedName) {
      setError("Enter your name.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Enter a valid email.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!acceptTerms) {
      setError("You must accept the terms.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: normalizedName,
          email: normalizedEmail,
          password,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        setError(body?.message ?? body?.error ?? "Unable to create your account.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Unable to reach Benzene. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <label htmlFor={nameId} className="label">
        Your name
      </label>
      <input
        id={nameId}
        name="name"
        type="text"
        autoComplete="name"
        className="input input-bordered w-full"
        placeholder="Ada Lovelace"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

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
      />

      <label htmlFor={passwordId} className="label">
        Password
      </label>
      <input
        id={passwordId}
        name="password"
        type="password"
        autoComplete="new-password"
        className="input input-bordered w-full"
        placeholder="At least 8 characters"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />

      <label htmlFor={confirmPasswordId} className="label">
        Confirm password
      </label>
      <input
        id={confirmPasswordId}
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        className="input input-bordered w-full"
        placeholder="Enter it again"
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        required
      />

      <div className="form-control pt-2">
        <label htmlFor={termsId} className="label cursor-pointer justify-start gap-3">
          <input
            id={termsId}
            name="acceptTerms"
            type="checkbox"
            className="checkbox border-1 border-bz-primary"
            checked={acceptTerms}
            onChange={(event) => setAcceptTerms(event.target.checked)}
            required
          />
          <span className="label-text">
            I agree to the <a className="link link-hover">Terms</a> and{" "}
            <a className="link link-hover">Privacy</a>.
          </span>
        </label>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <button
        className="btn btn-neutral mt-4"
        type="submit"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
