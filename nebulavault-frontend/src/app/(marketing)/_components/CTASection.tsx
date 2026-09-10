"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";

export default function CTASection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8" ref={ref}>
      <motion.div
        className="max-w-5xl mx-auto"
        initial={{ opacity: 0, y: 28 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.7, ease: "easeOut" }}
      >
        {/* Gradient-border wrapper — 1px gradient ring around the card */}
        <div className="p-px rounded-[2rem] bg-gradient-to-br from-bz-primary via-bz-primary2 to-bz-muted shadow-2xl shadow-bz-primary/20">
          <div className="bg-bz-card text-bz-text py-16 px-8 md:py-20 md:px-20 rounded-[1.95rem] flex flex-col items-center text-center space-y-8">
            {/* Headline */}
            <h2 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-tight">
              Ready to use the storage you already own?
            </h2>

            {/* Subtitle */}
            <p className="text-bz-muted max-w-lg text-lg leading-relaxed">
              Create a private Vault, add a device, and see your storage as one
              simple drive.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto pt-2">
              <motion.a
                href="/register"
                className="px-10 py-4 bg-bz-primary text-bz-bg rounded-xl font-bold text-lg hover:opacity-90 transition-all duration-200 active:scale-95"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                Create your Vault
              </motion.a>
              <motion.a
                href="#faq"
                className="px-10 py-4 border border-bz-border text-bz-text rounded-xl font-bold text-lg hover:bg-bz-surface transition-all duration-200 active:scale-95"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                Read the FAQs
              </motion.a>
            </div>

          </div>
        </div>
      </motion.div>
    </section>
  );
}
