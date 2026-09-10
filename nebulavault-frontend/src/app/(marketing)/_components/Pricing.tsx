import Link from "next/link";
import { Check } from "lucide-react";

/** Pricing is intentionally not invented while the product is in preview. */
export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-bz-text">
          Start with the storage you own
        </h2>
        <p className="text-bz-muted mt-2">
          Benzene is in an early preview. There is no cloud plan to choose yet:
          your devices are the starting point.
        </p>

        <div className="mt-10 rounded-2xl border border-bz-border bg-bz-surface/60 p-8 text-left shadow-card">
          <h3 className="text-2xl font-semibold text-bz-text">Personal Vault</h3>
          <p className="text-bz-muted mt-1">
            One private drive made from your computers and available storage.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Add devices and choose their storage contribution",
              "Browse files through one familiar Vault",
              "See when your Vault needs more protection",
            ].map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-bz-muted">
                <Check className="size-4 mt-0.5 text-bz-primary" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/register"
            className="mt-8 inline-flex rounded-xl2 border border-bz-border px-5 py-2 font-semibold text-bz-text transition hover:border-bz-primary/40"
          >
            Create your Vault
          </Link>
        </div>
      </div>
    </section>
  );
}
