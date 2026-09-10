"use client";

import { MotionConfig, motion, useInView } from "framer-motion";
import { useRef } from "react";
import {
  Zap,
  Activity,
  ShieldCheck,
  Cloud,
  Laptop,
  LockKeyhole,
} from "lucide-react";

const features = [
  {
    icon: Laptop,
    title: "Use your devices",
    description:
      "Bring together the computers and drives you already own.",
  },
  {
    icon: Zap,
    title: "Automatic placement",
    description:
      "Save to one Vault and let Benzene choose an available device.",
  },
  {
    icon: ShieldCheck,
    title: "Protection status",
    description:
      "See whether your Vault has the storage it needs to stay protected.",
  },
  {
    icon: LockKeyhole,
    title: "Private by default",
    description:
      "Your own devices are the primary home for your files.",
  },
  {
    icon: Cloud,
    title: "Cloud Protection later",
    description:
      "Add an optional cloud durability tier when you need it. Coming later.",
  },
  {
    icon: Activity,
    title: "A calm, clear view",
    description:
      "Browse your files without managing storage locations or device details.",
  },
];

const cardVariants = {
  rest: { y: 0, scale: 1, opacity: 1 },
  hover: { y: -6, scale: 1.02, opacity: 1 },
  press: { scale: 0.995 },
};

export default function FeatureCards() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section id="features" className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto" ref={ref}>
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-bz-text mb-4">
            A simpler way to use your storage{" "}
            <span className="bg-gradient-to-r from-bz-primary via-bz-primary2 to-bz-muted bg-clip-text text-transparent">
              together
            </span>
          </h2>
          <p className="text-lg text-bz-muted max-w-2xl mx-auto">
            The first Benzene experience is focused on one person, one Vault,
            and the devices they already own.
          </p>
        </motion.div>

        <MotionConfig
          transition={{
            type: "spring",
            stiffness: 260,
            damping: 26,
            mass: 0.8,
          }}
        >
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-7">
            {features.map(({ icon: Icon, title, description }, i) => (
              <motion.div
                key={title}
                variants={cardVariants}
                initial="rest"
                whileHover="hover"
                whileTap="press"
                animate={
                  isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }
                }
                transition={{ delay: i * 0.05 }}
                className="
                  group relative rounded-2xl border border-bz-border bg-bz-surface/60
                  backdrop-blur-sm p-6 shadow-card
                  transform-gpu will-change-transform
                  cursor-pointer
                "
              >
                <div
                  className="
                    pointer-events-none absolute inset-0 rounded-2xl opacity-0
                    group-hover:opacity-100 transition-opacity duration-300
                    bg-gradient-to-r from-bz-primary/10 via-transparent to-bz-primary2/10
                  "
                  aria-hidden
                />

                <div className="relative z-10">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="rounded-xl p-2 bg-gradient-to-r from-bz-primary/15 to-bz-primary2/15 border border-bz-border">
                      <Icon className="size-5 text-bz-primary" />
                    </div>
                    <h3 className="text-xl font-semibold text-bz-text">
                      {title}
                    </h3>
                  </div>
                  <p className="text-bz-muted">{description}</p>
                  <div className="mt-5 h-px w-full bg-gradient-to-r from-transparent via-bz-primary/20 to-transparent" />
                </div>
              </motion.div>
            ))}
          </div>
        </MotionConfig>
      </div>
    </section>
  );
}
