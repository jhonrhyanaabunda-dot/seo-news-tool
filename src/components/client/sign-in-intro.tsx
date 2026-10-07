"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

/** The cookie the sign-in action sets; read once, then cleared so the intro plays only on a fresh sign-in. */
export const INTRO_COOKIE = "a3_intro";
/** Logo settles, bar fills, then the overlay lifts away. */
const HOLD_MS = 1150;
const LIFT_MS = 520;

export function SignInIntro({ name }: { name: string }) {
  const [phase, setPhase] = useState<"playing" | "leaving" | "gone">("playing");

  useEffect(() => {
    document.cookie = `${INTRO_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    // With reduced motion both timers fire at once, so the veil is gone on the next tick.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lift = setTimeout(() => setPhase("leaving"), reduced ? 0 : HOLD_MS);
    const done = setTimeout(() => setPhase("gone"), reduced ? 0 : HOLD_MS + LIFT_MS);
    return () => {
      clearTimeout(lift);
      clearTimeout(done);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      // Clicking anywhere skips the wait; it is decoration, so it stays out of the accessibility tree.
      onClick={() => setPhase("gone")}
      aria-hidden
      className={`intro-veil fixed inset-0 z-50 flex flex-col items-center justify-center gap-7 bg-white ${phase === "leaving" ? "intro-leaving" : ""}`}
    >
      <Image src="/a3brands-logo.png" alt="" width={1388} height={879} priority className="intro-mark h-16 w-auto sm:h-20" />
      <div className="intro-track h-[3px] w-44 overflow-hidden rounded-full bg-slate-200">
        <div className="intro-bar h-full w-full rounded-full bg-brand-600" />
      </div>
      <p className="intro-greeting text-sm text-slate-500">Welcome back, {name.split(" ")[0]}</p>
    </div>
  );
}
