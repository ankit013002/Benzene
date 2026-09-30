import type { Metadata } from "next";
import { PublicInfoLayout } from "../_components/PublicInfoLayout";

export const metadata: Metadata = {
  title: "Privacy — Benzene",
  description: "How the current Benzene service handles account, Vault, device, and file information.",
};

export default function PrivacyPage() {
  return (
    <PublicInfoLayout
      eyebrow="Privacy"
      title="Benzene privacy information"
      intro="This page describes information handled by the current Benzene implementation. What is active can vary by deployment; Benzene is still under development and is not production-ready for real user data."
    >
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Information used by the service</h2>
        <p className="mt-2">
          When you create and use an account, the authentication service processes your email address,
          a password hash, verification and recovery tokens, and session credentials. The profile service
          can hold profile and quota information. The app also processes the Vault and device details
          needed to operate the service, such as device names and platforms, capacity and online status,
          file names, folders, sizes, content hashes, versions, and replica or protection state.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Where file data moves</h2>
        <p className="mt-2">
          Benzene stores file data on devices added to a Vault. The control plane handles identity,
          placement, and other metadata; it is not the normal path for file bytes. Cloud object storage
          is optional and may be used as a secondary protection tier when configured.
        </p>
        <p className="mt-2">
          The native iOS and Android app encrypts file contents on the device before sending them for
          storage. That encrypted mobile transfer is currently limited to 25 MiB per file. The web app
          does not provide the same encrypted file transfer flow. Do not assume that all clients encrypt
          content or that a complete key recovery lifecycle is available.
        </p>
        <p className="mt-2">
          A separately operated relay is designed to carry opaque ciphertext only for an explicit mobile
          transfer fallback. Its public deployment and remote end-to-end operation have not been verified.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Sessions, providers, and retention</h2>
        <p className="mt-2">
          The web app uses HTTP-only session cookies. Benzene components use databases and, depending on
          deployment, may connect to storage or email providers to deliver the service. Those providers
          may process information under their own terms and privacy notices.
        </p>
        <p className="mt-2">
          There is no single retention schedule that applies to every deployment. Metadata, account,
          operational, backup, and provider records may persist for different periods. Ask the service
          operator for details about the deployment you use; no operator contact is configured on this page.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Account deletion</h2>
        <p className="mt-2">
          The mobile app has a request and status flow under Settings → Delete account. A request starts
          staged cleanup; it does not mean cleanup is finished, and offline devices or unavailable cleanup
          services can delay completion. See the <a className="underline underline-offset-4" href="/account-deletion">account deletion information</a> for current details.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Questions or corrections</h2>
        <p className="mt-2">
          Use the support destination configured by the service operator or shown in the app listing.
          This page does not publish an email address or mailing address.
        </p>
      </section>
      <p className="border-t border-bz-border pt-5 text-sm">
        The service publisher should confirm these details against its deployment and applicable requirements before release.
      </p>
    </PublicInfoLayout>
  );
}
