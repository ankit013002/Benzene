"use client";

import { useEffect, useRef } from "react";

type Props = {
  density?: number;
  color?: string;
  opacity?: number;
};

export default function Starfield({
  density = 0.00012,
  color = "var(--primary)",
  opacity = 0.55,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    type Star = {
      x: number;
      y: number;
      r: number;
      a: number;
      vx: number;
      vy: number;
      tw: number;
    };

    const stars: Star[] = [];

    const resolveColor = () =>
      color.startsWith("var(")
        ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1)).trim()
        : color;
    let resolvedColor = resolveColor();

    const hexToRgba = (hex: string, a = 1) => {
      const h = hex.replace("#", "");
      const full =
        h.length === 3
          ? h
              .split("")
              .map((c) => c + c)
              .join("")
          : h;
      const n = parseInt(full, 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return `rgba(${r},${g},${b},${a})`;
    };

    const resize = () => {
      const w =
        canvas.clientWidth ||
        canvas.parentElement?.clientWidth ||
        window.innerWidth;
      const h =
        canvas.clientHeight ||
        canvas.parentElement?.clientHeight ||
        window.innerHeight;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      stars.length = 0;
      const count = Math.max(120, Math.floor(w * h * density));
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.6 + 0.2,
          a: Math.random() * 0.6 + 0.2,
          vx: (Math.random() - 0.5) * 0.15,
          vy: (Math.random() - 0.5) * 0.15,
          tw: Math.random() * 0.015 + 0.005,
        });
      }
    };

    const drawStar = (s: Star) => {
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
      g.addColorStop(0, hexToRgba(resolvedColor, s.a));
      g.addColorStop(0.4, hexToRgba(resolvedColor, s.a * 0.7));
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    };

    const step = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      for (const s of stars) {
        if (!prefersReduced) {
          s.x += s.vx;
          s.y += s.vy;
          s.a += (Math.random() - 0.5) * s.tw;
          if (s.a < 0.15) s.a = 0.15;
          if (s.a > 0.9) s.a = 0.9;

          if (s.x < -5) s.x = w + 5;
          if (s.x > w + 5) s.x = -5;
          if (s.y < -5) s.y = h + 5;
          if (s.y > h + 5) s.y = -5;
        }
        drawStar(s);
      }

      if (!prefersReduced) rafRef.current = requestAnimationFrame(step);
    };

    resize();
    window.addEventListener("resize", resize);
    step();
    const themeObserver = new MutationObserver(() => {
      resolvedColor = resolveColor();
      if (prefersReduced) step();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [density, color, opacity]);

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        opacity,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}
