export default function FAQ() {
  const faqs = [
    {
      q: "Where are my files stored?",
      a: "Your files are stored on the computers and drives you add to your Vault. Benzene keeps the physical location out of your way.",
    },
    {
      q: "Do I need cloud storage?",
      a: "No. Your own devices are the primary storage. An optional Cloud Protection tier is planned for people who want extra durability or availability.",
    },
    {
      q: "What is a Vault?",
      a: "A Vault combines the storage contributed by your devices into one private drive with one familiar file hierarchy.",
    },
    {
      q: "How does Benzene protect files?",
      a: "Benzene places protected copies across available devices and reports the Vault's current protection state. Repair automation is still being built.",
    },
    {
      q: "Can I add an older computer?",
      a: "Yes. Any supported computer with available disk space can contribute storage, so older hardware can become useful again.",
    },
    {
      q: "Can I use Benzene away from home?",
      a: "The current preview is focused on devices reachable on your local network. Remote access is planned, but is not available yet.",
    },
  ];

  return (
    <section id="faq" className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold text-bz-text text-center mb-10">
          Frequently asked questions
        </h2>
        <div className="space-y-3">
          {faqs.map((item) => (
            <details
              key={item.q}
              className="group rounded-2xl border border-bz-border bg-bz-surface/60 backdrop-blur-sm p-5"
            >
              <summary className="cursor-pointer list-none font-semibold text-bz-text flex items-center justify-between">
                {item.q}
                <span className="ml-4 text-bz-muted group-open:rotate-45 transition">
                  +
                </span>
              </summary>
              <p className="mt-3 text-bz-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
