import AuthShell from "../_components/AuthShell";
import RegisterForm from "../_components/RegisterForm";
import Link from "next/link";

export const metadata = {
  title: "Create account — Benzene",
  description: "Create your Benzene account.",
};

export default function Page() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Create a private Vault from the storage you already own."
      footer={
        <p className="text-sm text-bz-muted">
          Already have an account?{" "}
          <Link href="/login" className="link link-hover">
            Sign in
          </Link>
          .
        </p>
      }
    >
      <RegisterForm />
    </AuthShell>
  );
}
