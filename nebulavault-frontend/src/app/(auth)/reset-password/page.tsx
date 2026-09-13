import Link from "next/link";
import type { Metadata } from "next";

import AuthShell from "../_components/AuthShell";
import ResetPasswordForm from "../_components/ResetPasswordForm";

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string | string[] }>;
};

export const metadata: Metadata = {
  title: "Choose a new password — Benzene",
  description: "Choose a new password for your Benzene account.",
  referrer: "no-referrer",
};

export default async function Page({ searchParams }: ResetPasswordPageProps) {
  const rawToken = (await searchParams).token;
  const hasToken = typeof rawToken === "string" && rawToken.length > 0;

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Set a new password to return to your Benzene Vault."
      footer={
        <p className="text-sm text-bz-muted">
          Need a new reset link?{" "}
          <Link href="/forgot-password" className="link link-hover">
            Request one
          </Link>
          .
        </p>
      }
    >
      <ResetPasswordForm hasToken={hasToken} />
    </AuthShell>
  );
}
