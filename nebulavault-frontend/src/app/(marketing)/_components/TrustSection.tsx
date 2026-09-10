"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { LockKeyhole, ShieldCheck } from "lucide-react";

const items = [
  {
    icon: ShieldCheck,
    title: "Your devices first",
    body: "The computers and drives you add are the primary home for your files.",
  },
  {
    icon: ShieldCheck,
    title: "Protection is visible",
    body: "Your Vault reports whether the available devices can provide the protection you chose.",
  },
  {
    icon: LockKeyhole,
    title: "Private by default",
    body: "Benzene is designed to minimize unnecessary exposure of your data to the service.",
  },
];

export default function TrustSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section
      id="security"
      className="py-24 px-4 sm:px-6 lg:px-8 bg-bz-surface/50"
    >
      <div className="max-w-7xl mx-auto" ref={ref}>
        <div className="flex flex-col md:flex-row items-center gap-16 lg:gap-24">
          {/* ── Left: server visual with floating data badges ── */}
          <motion.div
            className="flex-1 relative"
            initial={{ opacity: 0, x: -24 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.7, ease: "easeOut" }}
          >
            <div className="relative w-full aspect-square max-w-md mx-auto">
              {/* Background glow */}
              <div
                aria-hidden
                className="absolute inset-0 bg-bz-primary/10 rounded-full blur-3xl"
              />

              {/* Server rack card */}
              <div className="absolute inset-4 bg-bz-card rounded-3xl shadow-2xl overflow-hidden border border-bz-border flex flex-col items-stretch justify-center gap-3 p-8">
                {[
                  { width: "78%", pulse: "bg-success", label: "DESKTOP" },
                  { width: "62%", pulse: "bg-bz-primary", label: "LAPTOP" },
                  { width: "91%", pulse: "bg-success", label: "HOME PC" },
                  { width: "55%", pulse: "bg-bz-primary", label: "SERVER" },
                  { width: "83%", pulse: "bg-success", label: "DRIVE" },
                ].map((row, i) => (
                  <div
                    key={i}
                    className="w-full h-9 rounded-lg bg-bz-surface border border-bz-border flex items-center px-4 gap-3"
                  >
                    <motion.div
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${row.pulse}`}
                      animate={{ opacity: [0.5, 1, 0.5] }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        delay: i * 0.35,
                      }}
                    />
                    <div className="flex-1 h-1 bg-bz-border rounded-full overflow-hidden">
                      <div
                        className="h-full bg-bz-primary/40 rounded-full"
                        style={{ width: row.width }}
                      />
                    </div>
                    <span className="text-xs font-mono text-bz-muted flex-shrink-0">
                      {row.label}
                    </span>
                  </div>
                ))}
                <div
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-b from-bz-primary/5 to-transparent pointer-events-none rounded-3xl"
                />
              </div>

              {/* Floating tag — top right */}
              <motion.div
                className="absolute -top-5 -right-4 p-3 bg-bz-card/90 backdrop-blur-md rounded-xl shadow-lg border border-bz-border"
                initial={{ opacity: 0, y: -10 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.5, delay: 0.45 }}
              >
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-bz-primary mb-0.5">
                  Devices in your Vault
                </p>
                <p className="text-2xl font-black tracking-tight text-bz-text leading-none">
                  Your devices
                </p>
              </motion.div>

              {/* Floating tag — bottom left */}
              <motion.div
                className="absolute -bottom-6 -left-4 p-3 bg-bz-card/90 backdrop-blur-md rounded-xl shadow-lg border border-bz-border"
                initial={{ opacity: 0, y: 10 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.5, delay: 0.55 }}
              >
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-bz-muted mb-0.5">
                  Storage you control
                </p>
                <p className="text-base font-bold text-bz-text">At home</p>
              </motion.div>
            </div>
          </motion.div>

          {/* ── Right: compliance list ── */}
          <motion.div
            className="flex-1 space-y-8"
            initial={{ opacity: 0, x: 24 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.7, delay: 0.12, ease: "easeOut" }}
          >
            <h2 className="text-4xl font-extrabold tracking-tight text-bz-text leading-tight">
              Private storage, made simple{" "}
              <span className="bg-gradient-to-r from-bz-primary to-bz-primary2 bg-clip-text text-transparent">
                by design
              </span>
            </h2>

            <div className="space-y-7">
              {items.map(({ icon: Icon, title, body }, i) => (
                <motion.div
                  key={title}
                  className="flex gap-4"
                  initial={{ opacity: 0, y: 12 }}
                  animate={inView ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.45, delay: 0.3 + i * 0.1 }}
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bz-primary/10 border border-bz-border flex items-center justify-center">
                    <Icon
                      className="size-5 text-bz-primary"
                      strokeWidth={1.5}
                    />
                  </div>
                  <div>
                    <h4 className="font-bold text-bz-text">{title}</h4>
                    <p className="text-sm text-bz-muted mt-0.5 leading-relaxed">
                      {body}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
