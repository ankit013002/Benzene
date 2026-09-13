import Link from "next/link";
import { CircleAlert, CircleCheck, Mail, type LucideIcon } from "lucide-react";

import AuthShell from "../(auth)/_components/AuthShell";
import VerificationPendingActions from "../(auth)/_components/VerificationPendingActions";

type VerificationStatus = "success" | "pending" | "missing" | "invalid";

type VerifyEmailPageProps = {
  searchParams: Promise<{ status?: string | string[] }>;
};

const CONTENT: Record<
  VerificationStatus,
  {
    title: string;
    subtitle: string;
    detail: string;
    icon: LucideIcon;
    iconClassName: string;
  }
> = {
  success: {
    title: "Email verified",
    subtitle: "Your Benzene account is ready.",
    detail: "Your email address has been confirmed. Sign in to open your Vault.",
    icon: CircleCheck,
    iconClassName: "text-bz-success",
  },
  pending: {
    title: "Check your inbox",
    subtitle: "Your Benzene account is almost ready.",
    detail:
      "We sent a verification link to your email address. Confirm it to keep your Vault secure, then sign in.",
    icon: Mail,
    iconClassName: "text-bz-primary",
  },
  missing: {
    title: "Verification link incomplete",
    subtitle: "That link did not include a verification token.",
    detail: "Request a fresh verification email, then open the complete link from your inbox.",
    icon: CircleAlert,
    iconClassName: "text-bz-warning",
  },
  invalid: {
    title: "Verification link expired",
    subtitle: "We could not verify that email link.",
    detail: "The link may have expired or already been used. Request a fresh verification email to try again.",
    icon: CircleAlert,
    iconClassName: "text-bz-danger",
  },
};

function normalizeStatus(value: string | string[] | undefined): VerificationStatus {
  const status = Array.isArray(value) ? value[0] : value;
  return status === "success" ||
    status === "pending" ||
    status === "missing"
    ? status
    : "invalid";
}

export const metadata = {
  title: "Verify your email — Benzene",
  description: "Confirm your Benzene email address.",
};

export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps) {
  const params = await searchParams;
  const status = normalizeStatus(params.status);
  const content = CONTENT[status];
  const Icon = content.icon;

  return (
    <AuthShell title={content.title} subtitle={content.subtitle}>
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-bz-border bg-bz-surface p-3">
            <Icon className={`size-6 ${content.iconClassName}`} aria-hidden="true" />
          </div>
          <p className="pt-1 text-sm leading-6 text-bz-muted">{content.detail}</p>
        </div>

        {status === "pending" ? (
          <VerificationPendingActions />
        ) : (
          <Link href="/login" className="btn btn-neutral w-full">
            Continue to sign in
          </Link>
        )}
      </div>
    </AuthShell>
  );
}
