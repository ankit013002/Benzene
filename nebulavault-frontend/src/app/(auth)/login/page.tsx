import AuthShell from "../_components/AuthShell";
import LoginForm from "../_components/LoginForm";
import Link from "next/link";

export const metadata = {
  title: "Sign in — Benzene",
  description: "Sign in to your Benzene account.",
};

export default function Page() {
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to open your Benzene Vault."
      footer={
        <p className="text-sm text-bz-muted">
          New here?{" "}
          <Link href="/register" className="link link-hover">
            Create an account
          </Link>
          .
        </p>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
