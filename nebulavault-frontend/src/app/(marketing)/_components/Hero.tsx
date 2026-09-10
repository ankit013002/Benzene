"use client";

import { motion, useScroll } from "framer-motion";
import AnimatedStorageBar from "./AnimatedStorageBar";
import Starfield from "@/components/Startfield";
import { useEffect, useState } from "react";

export default function Hero() {
  const { scrollY } = useScroll();
  const [atTop, setAtTop] = useState(true);

  useEffect(() => {
    return scrollY.on("change", (latest) => {
      setAtTop(latest <= 1);
    });
  }, [scrollY]);

  const signUpUrl = "/register";
  const signInUrl = "/login";

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <Starfield />

      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-[800px] h-[800px] rounded-full opacity-20">
          <div className="w-full h-full rounded-full bg-gradient-to-r from-bz-primary/20 via-bz-primary2/10 to-transparent blur-3xl animate-pulse-glow" />
        </div>
      </div>

      <div className="flex flex-col gap-4 z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center pt-20">
        {/* Keep the promise small and concrete while the product is in preview. */}
        <motion.div
          className="flex justify-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-bz-surface/80 border border-bz-border text-xs font-semibold uppercase tracking-widest text-bz-muted backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            Private storage, built from your devices
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.1, ease: "easeOut" }}
        >
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold text-bz-text leading-tight mb-6">
            One drive. Every computer.{" "}
            <span className="bg-gradient-to-r from-bz-primary via-bz-primary2 to-bz-muted bg-clip-text text-transparent">
              in one Vault
            </span>
          </h1>
        </motion.div>

        <motion.p
          className="text-lg sm:text-xl text-bz-muted max-w-3xl mx-auto mb-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
        >
          Benzene turns the storage you already own across computers into one
          private Vault. Add your devices, choose what they contribute, and let
          Benzene handle where your files live.
        </motion.p>

        <motion.div
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4, ease: "easeOut" }}
        >
          <motion.a
            href={signUpUrl}
            className="px-8 py-4 bg-gradient-to-r from-bz-primary to-bz-primary2 text-bz-bg font-semibold rounded-xl2 shadow-glow hover:shadow-glow text-lg min-w-[200px]"
            whileHover={{ y: -2, scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            Get started free
          </motion.a>

          <motion.a
            href={signInUrl}
            className="px-8 py-4 bg-bz-surface/50 backdrop-blur-sm text-bz-text font-semibold rounded-xl2 border border-bz-border hover:bg-bz-surface/70 hover:border-bz-primary/30 transition-all duration-200 text-lg min-w-[200px]"
            whileHover={{ y: -2, scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            Sign in
          </motion.a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6, ease: "easeOut" }}
        >
          <AnimatedStorageBar />
        </motion.div>

        <motion.div
          className="pointer-events-none absolute bottom-18 right-10 -translate-x-1/2 z-[1]"
          initial={{ opacity: 0 }}
          animate={atTop ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.8, delay: 1.5 }}
        >
          <motion.div
            className="w-6 h-10 border-2 border-bz-primary/40 rounded-full flex justify-center"
            animate={{
              boxShadow: [
                "0 0 0 color-mix(in srgb, var(--primary) 30%, transparent)",
                "0 0 20px color-mix(in srgb, var(--primary) 30%, transparent)",
                "0 0 0 color-mix(in srgb, var(--primary) 30%, transparent)",
              ],
            }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <motion.div
              className="w-1 h-3 bg-bz-primary rounded-full mt-2"
              animate={{ y: [0, 12, 0] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
