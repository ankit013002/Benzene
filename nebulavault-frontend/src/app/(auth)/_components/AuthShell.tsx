"use client";

import { motion } from "framer-motion";
import Startfield from "@/components/Startfield";
import GlowOrb from "@/components/Gloworb";
import { HardDrive, LockKeyhole, Vault } from "lucide-react";

type AuthShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: AuthShellProps) {
  return (
    <section className="relative min-h-dvh flex items-center justify-center overflow-hidden">
      <Startfield density={0.00012} />

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="w-[900px] h-[900px] rounded-full opacity-25">
          <div className="w-full h-full rounded-full bg-gradient-to-r from-bz-primary/25 via-bz-primary2/10 to-transparent blur-3xl animate-pulse-glow" />
        </div>
      </div>

      <div className="relative z-10 w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid lg:grid-cols-2 gap-8 items-center">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="hidden lg:block"
          >
            <div className="flex items-center gap-3 mb-6">
              <GlowOrb size="md" />
              <div className="leading-tight">
                <div className="text-2xl font-extrabold tracking-tight text-bz-text">
                  BENZENE
                </div>
              </div>
            </div>

            <h1 className="text-4xl font-bold text-bz-text mb-3">{title}</h1>
            {subtitle && (
              <p className="text-bz-muted text-lg mb-8">{subtitle}</p>
            )}

            <div className="space-y-3">
              <FeatureRow
                icon={<HardDrive className="size-4 text-bz-primary" />}
                title="Your devices, together"
                text="Add computers you already own and choose how much storage to contribute."
              />
              <FeatureRow
                icon={<Vault className="size-4 text-bz-primary" />}
                title="One private Vault"
                text="Benzene gives your files one familiar place, wherever the bytes live."
              />
              <FeatureRow
                icon={<LockKeyhole className="size-4 text-bz-primary" />}
                title="Private by default"
                text="Your devices are the primary home for your data."
              />
            </div>

            <div className="mt-8 h-px w-full bg-gradient-to-r from-transparent via-bz-primary/30 to-transparent" />
            <p className="mt-4 text-sm text-bz-muted">
              Built around the storage you already own
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1, ease: "easeOut" }}
            className="rounded-2xl border border-bz-border bg-bz-surface/70 backdrop-blur-xl shadow-card p-6 sm:p-8"
          >
            <div className="lg:hidden mb-6">
              <div className="flex items-center gap-3">
                <GlowOrb size="md" />
                <div className="text-lg font-bold text-bz-text">
                  Benzene
                </div>
              </div>
              <h1 className="mt-4 text-3xl font-bold text-bz-text">{title}</h1>
              {subtitle && <p className="text-bz-muted mt-1">{subtitle}</p>}
              <div className="mt-6 h-px w-full bg-gradient-to-r from-transparent via-bz-primary/30 to-transparent" />
            </div>

            {children}

            {footer && <div className="mt-6">{footer}</div>}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function FeatureRow({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="p-2 rounded-xl border border-bz-border bg-gradient-to-r from-bz-primary/15 to-bz-primary2/15">
        {icon}
      </div>
      <div>
        <div className="text-bz-text font-semibold">{title}</div>
        <div className="text-bz-muted text-sm">{text}</div>
      </div>
    </div>
  );
}
