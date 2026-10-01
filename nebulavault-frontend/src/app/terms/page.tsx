import type { Metadata } from "next";
import { PublicInfoLayout } from "../_components/PublicInfoLayout";

export const metadata: Metadata = {
  title: "Terms — Benzene",
  description: "Current service terms and important limits for using Benzene.",
};

export default function TermsPage() {
  return (
    <PublicInfoLayout
      eyebrow="Terms"
      title="Benzene service terms"
      intro="These terms summarize the current Benzene service and its limitations. The service is under development, operates as a development/LAN slice, and is not production-ready for real user data. A deployment may provide additional terms from its operator."
    >
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Your account and content</h2>
        <p className="mt-2">
          Keep your account credentials private and use the service only with content you are entitled
          to store and share. You remain responsible for your files, device access, and any key material
          needed to read encrypted mobile files. The key lifecycle and recovery design is not complete;
          losing required key material may make encrypted content unreadable.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">How the service works today</h2>
        <p className="mt-2">
          A Vault places file copies on participating devices. Those devices can be offline, unreachable,
          removed, or out of capacity, which can affect access and protection. Cloud Protection is optional
          and depends on deployment configuration. No availability, durability, recovery, or response-time
          commitment is stated here.
        </p>
        <p className="mt-2">
          Native and web file transfers encrypt before storage and currently support files up to 25 MiB.
          The current web recovery flow imports a Vault recovery kit created through the mobile app; the unlocked key is
          held in tab memory and must be imported again after reload. Files stored before encrypted transfers remain in
          their original format and are not migrated automatically. The encrypted relay path is not
          verified in a public deployment. Features and limits may change as Benzene is developed.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Use and service limits</h2>
        <p className="mt-2">
          Do not rely on Benzene as the only copy of important information or for critical workloads.
          You are responsible for keeping independent copies until the service and recovery paths have
          been validated for your deployment. The service operator may limit or suspend access to address
          security, operational, or legal requirements.
        </p>
      </section>
      <section>
        <h2 className="text-xl font-semibold text-bz-text">Deletion and questions</h2>
        <p className="mt-2">
          Account deletion begins a staged request and may wait for devices or configured services to
          complete cleanup. Review the <a className="underline underline-offset-4" href="/account-deletion">account deletion information</a> before requesting it.
          For questions, use the support destination configured by the service operator or shown in the
          app listing; this page does not publish a direct contact address.
        </p>
      </section>
      <p className="border-t border-bz-border pt-5 text-sm">
        The service publisher should review and adopt deployment-specific terms before offering the service publicly.
      </p>
    </PublicInfoLayout>
  );
}
