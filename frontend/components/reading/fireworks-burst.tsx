"use client";

import { useEffect, useRef } from "react";

const COLORS = [
  "#ff5d73",
  "#ffb703",
  "#fb8500",
  "#2ec4b6",
  "#3a86ff",
  "#8338ec",
  "#06d6a0",
  "#ffd166",
];
const BURST_DELAYS_MS = [0, 220, 480, 760, 1080, 1420, 1800];
const PARTICLES_PER_BURST = 64;
const GRAVITY = 0.045;
const FRICTION = 0.985;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
}

function shouldSkipAnimation(): boolean {
  if (typeof window === "undefined") return true;
  // Respect the OS "reduce motion" setting.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return true;
  }
  // jsdom has no canvas implementation and would log "not implemented".
  return /jsdom/i.test(window.navigator.userAgent);
}

/**
 * Full-screen fireworks used to celebrate a correct answer. Purely decorative:
 * it ignores pointer events, is hidden from assistive technology and removes
 * itself (animation frame, listeners) when the effect ends or the component
 * unmounts.
 */
export function FireworksBurst() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || shouldSkipAnimation()) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0;
    let height = 0;
    function resize() {
      if (!canvas || !context) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const particles: Particle[] = [];
    const timers = BURST_DELAYS_MS.map((delay) =>
      window.setTimeout(() => {
        const originX = width * (0.12 + Math.random() * 0.76);
        const originY = height * (0.12 + Math.random() * 0.45);
        const palette = [
          COLORS[Math.floor(Math.random() * COLORS.length)],
          COLORS[Math.floor(Math.random() * COLORS.length)],
        ];
        for (let index = 0; index < PARTICLES_PER_BURST; index += 1) {
          const angle = (Math.PI * 2 * index) / PARTICLES_PER_BURST;
          const speed = 2.2 + Math.random() * 4.2;
          particles.push({
            x: originX,
            y: originY,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            age: 0,
            life: 55 + Math.random() * 35,
            size: 1.8 + Math.random() * 2.2,
            color: palette[index % palette.length],
          });
        }
      }, delay),
    );

    const lastBurstAt = Math.max(...BURST_DELAYS_MS);
    const startedAt = performance.now();
    let frame = 0;

    function draw(now: number) {
      if (!context) return;
      // Fade the previous frame instead of clearing it to leave glowing trails.
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = "rgba(0, 0, 0, 0.22)";
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.vx *= FRICTION;
        particle.vy = particle.vy * FRICTION + GRAVITY;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.age += 1;
        const remaining = 1 - particle.age / particle.life;
        if (remaining <= 0) {
          particles.splice(index, 1);
          continue;
        }
        context.globalAlpha = Math.min(1, remaining * 1.4);
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(
          particle.x,
          particle.y,
          particle.size * (0.6 + remaining * 0.4),
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.globalAlpha = 1;

      const finished =
        now - startedAt > lastBurstAt + 200 && particles.length === 0;
      if (finished) {
        context.clearRect(0, 0, width, height);
        return;
      }
      frame = window.requestAnimationFrame(draw);
    }
    frame = window.requestAnimationFrame(draw);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
      data-testid="fireworks-burst"
      ref={canvasRef}
    />
  );
}
