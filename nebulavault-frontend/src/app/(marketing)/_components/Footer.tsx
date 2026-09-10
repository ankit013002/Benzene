export default function Footer() {
  const year = new Date().getFullYear();

  const links = [
    { href: "#features", label: "Features" },
    { href: "#security", label: "Security" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "Support" },
  ];

  return (
    <footer className="border-t border-bz-border/60 bg-bz-surface/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
          {/* Brand + copyright */}
          <div className="space-y-1.5">
            <p className="font-bold text-bz-text text-lg">Benzene</p>
            <p className="text-xs text-bz-muted uppercase tracking-widest">
              © {year} Benzene. Private storage, by design.
            </p>
          </div>

          {/* Nav links */}
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="relative text-bz-muted hover:text-bz-text transition-colors duration-200"
              >
                {l.label}
                <span className="absolute -bottom-0.5 left-0 right-0 h-px bg-gradient-to-r from-transparent via-bz-primary/40 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-200" />
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
