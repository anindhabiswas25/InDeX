"use client";

import { useEffect, useRef } from "react";

const STAR_COUNT = 150;

interface Star {
  x: number;
  y: number;
  size: number;
  opacity: number;
  vx: number;
  vy: number;
  targetVx: number;
  targetVy: number;
  changeTimer: number;
  phase: number;
}

function randomVelocity() {
  const angle = Math.random() * Math.PI * 2;
  const speed = Math.random() * 0.3 + 0.08;
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

export default function SpaceBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<Star[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let currentW = 0;
    let currentH = 0;
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === currentW && h === currentH) return; // no-op if same size
      // Scale existing star positions to the new canvas size
      if (currentW > 0 && starsRef.current.length > 0) {
        const scaleX = w / currentW;
        const scaleY = h / currentH;
        for (const s of starsRef.current) {
          s.x *= scaleX;
          s.y *= scaleY;
        }
      }
      canvas.width = w;
      canvas.height = h;
      currentW = w;
      currentH = h;
    };
    resize();
    window.addEventListener("resize", resize);

    starsRef.current = Array.from({ length: STAR_COUNT }, () => {
      const { vx, vy } = randomVelocity();
      const { vx: tvx, vy: tvy } = randomVelocity();
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.6 + 0.3,
        opacity: Math.random() * 0.55 + 0.15,
        vx,
        vy,
        targetVx: tvx,
        targetVy: tvy,
        changeTimer: Math.floor(Math.random() * 200) + 80,
        phase: Math.random() * Math.PI * 2,
      };
    });

    let time = 0;
    const animate = () => {
      time += 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const star of starsRef.current) {
        star.vx += (star.targetVx - star.vx) * 0.008;
        star.vy += (star.targetVy - star.vy) * 0.008;

        star.x += star.vx;
        star.y += star.vy;

        star.changeTimer--;
        if (star.changeTimer <= 0) {
          const { vx, vy } = randomVelocity();
          star.targetVx = vx;
          star.targetVy = vy;
          star.changeTimer = Math.floor(Math.random() * 250) + 100;
        }

        const pad = 20;
        if (star.x < -pad) star.x = canvas.width + pad;
        if (star.x > canvas.width + pad) star.x = -pad;
        if (star.y < -pad) star.y = canvas.height + pad;
        if (star.y > canvas.height + pad) star.y = -pad;

        const twinkle = 0.5 + 0.5 * Math.sin(time * 0.04 + star.phase);
        const alpha = star.opacity * (0.5 + 0.5 * twinkle);

        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fill();

        if (star.size > 1.0) {
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.06})`;
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ background: "transparent" }}
    />
  );
}
