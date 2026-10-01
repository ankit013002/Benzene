import type { Metadata } from "next";
import Link from "next/link";
import { PublicInfoLayout } from "../_components/PublicInfoLayout";

export const metadata: Metadata = {
  title: "Support — Benzene",
  description: "Help with Benzene accounts, Vault devices, file transfers, and account deletion.",
};

export default function SupportPage() {
  return (
    <PublicInfoLayout
      eyebrow="Support"
      title="Benzene support"
      intro="Benzene is under development and is not production-ready for real user data. The available help and service behavior depend on the deployment you are using."
    >
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Account access</h2>
        <p className="mt-2">
          Use the sign-in screen to request a password reset. Email verification and password recovery
          depend on the service having email delivery configured.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Devices and files</h2>
        <p className="mt-2">
          A device must be approved and online to take part in current Vault operations. Web and mobile
          encrypted file transfers support files up to 25 MiB. The current web recovery flow imports a
          Vault recovery kit created through the mobile app. Remote access, public relay operation, and production recovery paths
          have not been verified; if a device is unavailable, files may show as waiting or unavailable.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Delete an account</h2>
        <p className="mt-2">
          The mobile app provides a deletion request and status flow. Read the <Link className="underline underline-offset-4" href="/account-deletion">account deletion page</Link> for its current behavior and limits.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Contact the service operator</h2>
        <p className="mt-2">
          No support email, web form, or mailing address is configured for this page. Use the support
          contact supplied by the service operator in the app listing or deployment materials. Do not
          send passwords, recovery keys, or file contents through an unverified contact channel.
        </p>
      </section>
    </PublicInfoLayout>
  );
}
