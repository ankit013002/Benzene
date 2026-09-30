import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Account deletion — Benzene",
  description:
    "How to request Benzene account deletion, what cleanup includes, and why it may take time.",
};

export default function AccountDeletionPage() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-6 py-16 text-bz-text sm:px-10">
      <Link href="/" className="text-sm text-bz-muted underline underline-offset-4">
        Benzene home
      </Link>
      <article className="mt-8 space-y-5">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-bz-muted">
          Account and data
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Delete your Benzene account</h1>
        <p className="leading-7 text-bz-muted">
          Account deletion starts a cleanup request. It is not immediate: some
          steps depend on stored data being removed and your devices checking in.
        </p>

        <h2 className="pt-5 text-2xl font-semibold">How to request deletion</h2>
        <ol className="list-decimal space-y-2 pl-6 leading-7">
          <li>
            In the Benzene mobile app, open <strong>Settings → Delete account</strong>.
            You can also choose <strong>Delete account / check status</strong> from
            the sign-in screen.
          </li>
          <li>Enter the account email and password, then confirm the request.</li>
          <li>
            The app signs you out and can check progress with a private status
            receipt saved on that device.
          </li>
        </ol>
        <p className="leading-7 text-bz-muted">
          The current web app does not have a self-service deletion control. If
          you cannot use the mobile app, contact Benzene support using the
          Support screen in the app or the support contact published with your
          Benzene app listing.
        </p>
        <p className="leading-7 text-bz-muted">
          This information page does not collect passwords or submit deletion
          requests. Only enter your password in the official Benzene app.
        </p>

        <h2 className="pt-5 text-2xl font-semibold">What cleanup includes</h2>
        <p className="leading-7 text-bz-muted">
          When the required cleanup services are configured and complete, the
          process removes the account profile and sign-in credentials, then
          removes Vault file objects, device data, and Vault metadata through
          the configured cleanup phases. Refresh credentials are revoked and
          new sign-ins are blocked when the request is accepted.
        </p>
        <p className="leading-7 text-bz-muted">
          An access token already issued before the request may continue to work
          for up to 15 minutes. Stored-object cleanup waits at least 15 minutes
          plus a clock-skew margin before it begins.
        </p>

        <h2 className="pt-5 text-2xl font-semibold">Timing and devices that are offline</h2>
        <p className="leading-7 text-bz-muted">
          Cleanup proceeds in stages and can take longer than the token grace
          period. Device data is removed only after the storage cleanup process
          receives acknowledgements from the devices that hold it. If a device
          is offline, the request can remain pending until that device returns
          and acknowledges deletion. Benzene does not promise an immediate
          completion time.
        </p>
        <p className="leading-7 text-bz-muted">
          Some deployments may not have every cleanup service enabled. A
          missing or failed cleanup step remains pending or blocked; an accepted
          request by itself does not mean all associated data has been erased.
        </p>

        <h2 className="pt-5 text-2xl font-semibold">Records that may remain</h2>
        <p className="leading-7 text-bz-muted">
          Benzene retains a minimal deletion request and status record, including
          a deletion request identifier, a hashed status receipt, and a minimal
          credential-deletion tombstone. The current implementation does not
          specify a fixed retention period for these records.
        </p>
        <p className="leading-7 text-bz-muted">
          Billing records and application-managed backups or logs do not have
          deletion adapters in the current implementation. Those cleanup phases
          remain blocked unless the deployment has verified that it manages no
          data in those categories. Data held by external providers may also
          follow their own retention rules.
        </p>
      </article>
    </main>
  );
}
