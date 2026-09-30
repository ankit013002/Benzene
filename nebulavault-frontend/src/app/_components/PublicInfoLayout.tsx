import Link from "next/link";

const links = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/support", label: "Support" },
  { href: "/account-deletion", label: "Account deletion" },
];

export function PublicInfoLayout({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-6 py-12 text-bz-text sm:px-10 sm:py-16">
      <Link href="/" className="text-sm text-bz-muted underline underline-offset-4">
        Benzene home
      </Link>
      <article className="mt-10">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-bz-muted">
          {eyebrow}
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-5 leading-7 text-bz-muted">{intro}</p>
        <div className="mt-8 space-y-7 leading-7 text-bz-muted">{children}</div>
      </article>
      <nav aria-label="Legal and support pages" className="mt-12 border-t border-bz-border pt-5">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {links.map(({ href, label }) => (
            <li key={href}>
              <Link href={href} className="underline underline-offset-4">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
