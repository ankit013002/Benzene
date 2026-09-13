import Link from "next/link";

import AuthShell from "../_components/AuthShell";
import ForgotPasswordForm from "../_components/ForgotPasswordForm";

export const metadata = {
  title: "Reset your password — Benzene",
  description: "Request a password reset link for your Benzene account.",
};

export default function Page() {
  return (
    <AuthShell
      title="Reset your password"
      subtitle="We’ll help you get back into your Benzene Vault."
      footer={
        <p className="text-sm text-bz-muted">
          Remember your password?{" "}
          <Link href="/login" className="link link-hover">
            Sign in
          </Link>
          .
        </p>
      }
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
