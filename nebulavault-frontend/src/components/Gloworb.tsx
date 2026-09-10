"use client";

import { motion, useReducedMotion } from "framer-motion";
import React from "react";

type GlowOrbProps = {
  size?: "sm" | "md" | "lg";
  className?: string;
  from?: string;
  to?: string;
  glow?: number;
};

export default function GlowOrb({
  size = "md",
  className = "",
  from = "var(--primary)",
  to = "var(--muted-foreground)",
  glow = 0.6,
}: GlowOrbProps) {
  const prefersReduced = useReducedMotion();

  const px = size === "sm" ? 12 : size === "lg" ? 24 : 16;

  const glowOuter = Math.round(px * 4);
  const glowInner = Math.max(2, Math.round(px / 3));

  const glowColor = `color-mix(in srgb, ${to} ${Math.round(
    glow * 100,
  )}%, transparent)`;
  const boxShadow = [
    `0 0 ${glowOuter}px ${glowInner}px ${glowColor}`,
    `0 0 ${glowOuter * 1.6}px ${Math.round(glowInner * 1.2)}px ${glowColor}`,
  ].join(", ");

  return (
    <motion.div
      aria-hidden
      className={className}
      style={{
        width: px,
        height: px,
        display: "inline-block",
        borderRadius: "9999px",
        background: `linear-gradient(90deg, ${from}, ${to})`,
        boxShadow,
      }}
      animate={
        prefersReduced
          ? undefined
          : { scale: [1, 1.1, 1], opacity: [0.9, 1, 0.9] }
      }
      transition={
        prefersReduced
          ? undefined
          : { duration: 2, repeat: Infinity, ease: "easeInOut" }
      }
    />
  );
}
