"use client";

import { motion, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  initalIsedGB?: number;
  quotaGB?: number;
};

const COLORS = {
  textMuted: "var(--muted-foreground)",
  surface: "var(--muted)",
  border: "var(--border)",
  primary: "var(--primary)",
  shimmer: "color-mix(in srgb, var(--primary-foreground) 35%, transparent)",
};

export default function AnimatedStorageBar({
  initalIsedGB = 50.27,
  quotaGB = 150,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const prefersReduced = useReducedMotion();
  const [pct, setPct] = useState(0);
  const [usedGB, setUsedGB] = useState(initalIsedGB);

  useEffect(() => {
    const interval = setInterval(() => {
      setUsedGB(Math.random() * 150);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const computedPct = useMemo(() => {
    const raw = (usedGB / quotaGB) * 100;
    return Math.min(100, Math.max(raw, raw > 0 ? 0.4 : 0));
  }, [usedGB, quotaGB]);

  useEffect(() => {
    if (isInView) {
      const t = setTimeout(() => setPct(computedPct), 400);
      return () => clearTimeout(t);
    }
  }, [isInView, computedPct]);

  return (
    <motion.div
      ref={ref}
      style={{
        width: "100%",
        maxWidth: 448,
        marginInline: "auto",
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay: 0.2 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 14,
          color: COLORS.textMuted,
          marginBottom: 8,
        }}
      >
        <span>Storage Usage</span>
        <span>{quotaGB} GB</span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(pct.toFixed(2))}
        style={{
          position: "relative",
          height: 8,
          borderRadius: 9999,
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 9999,
            background: "color-mix(in srgb, var(--primary) 10%, transparent)",
          }}
        />

        <motion.div
          style={{
            position: "relative",
            height: "100%",
            borderRadius: 9999,
            background: COLORS.primary,
            boxShadow: "var(--shadow-glow-sm)",
            width: 0,
          }}
          initial={{ width: 0 }}
          animate={isInView ? { width: `${pct}%` } : undefined}
          transition={
            prefersReduced
              ? { duration: 0.01 }
              : { duration: 1.2, ease: "easeOut", delay: 0.3 }
          }
        >
          {!prefersReduced && (
            <motion.div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 9999,
                background: `linear-gradient(90deg, transparent, ${COLORS.shimmer}, transparent)`,
                transform: "translateX(-100%)",
              }}
              initial={{ x: "-100%" }}
              animate={{ x: "200%" }}
              transition={{ duration: 2, repeat: Infinity, repeatDelay: 2 }}
            />
          )}
        </motion.div>
      </div>

      <motion.div
        style={{
          fontSize: 12,
          color: COLORS.textMuted,
          marginTop: 6,
        }}
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : {}}
        transition={{ duration: 0.4, delay: 1.1 }}
      >
        {usedGB.toFixed(2)} GB used
      </motion.div>
    </motion.div>
  );
}
