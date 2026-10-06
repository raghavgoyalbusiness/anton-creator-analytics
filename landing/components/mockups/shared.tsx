'use client';

import { useEffect, useRef, useState } from 'react';
import { animate, useInView, useReducedMotion } from 'framer-motion';


/** The card every mockup sits in: a quiet app surface, not a fake browser. */
export function MockFrame({
  title,
  status,
  children,
  label,
}: {
  title: string;
  status?: React.ReactNode;
  children: React.ReactNode;
  /** Read by screen readers: what this example is showing. */
  label: string;
}) {
  return (
    <figure
      aria-label={label}
      className="w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-float"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <span className="text-[13px] font-medium">{title}</span>
        {status ? <span className="text-[12px] text-muted">{status}</span> : null}
      </div>
      <div className="p-5">{children}</div>
    </figure>
  );
}

/**
 * Reduced-motion preference, but only after mount.
 *
 * The server cannot know the preference, so the first client render must
 * match what the server sent — the animated starting state. Reading the media
 * query straight away rendered the finished state on the client and the
 * starting state on the server: a hydration mismatch for every visitor who had
 * asked for less motion, exactly the people least served by a flash of
 * re-rendering.
 */
export function useReducedMotionAfterMount(): boolean {
  const preference = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && preference;
}

/**
 * Whether a mockup should be playing.
 *
 * On desktop the sticky panel mounts only the active mockup, so `active` is
 * passed in. On mobile every mockup is on the page at once and starts when it
 * scrolls into view. Either way it starts once and holds its final state.
 */
export function useStart(active: boolean | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduced = useReducedMotionAfterMount();
  const started = active ?? inView;
  return { ref, started, reduced };
}

/** A number that counts up once it starts, and is simply the target when motion is reduced. */
export function useCountUp(target: number, started: boolean, reduced: boolean, duration = 1.2) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    if (!started) return;
    const controls = animate(0, target, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setValue(Math.round(v)),
    });
    return () => controls.stop();
  }, [target, started, reduced, duration]);
  return value;
}

export function posterFor(n: number): string {
  return `/media/clip-${String(n).padStart(2, '0')}-poster.webp`;
}

export function Thumb({ n, className = '' }: { n: number; className?: string }) {
  return (
    <img
      src={posterFor(n)}
      alt=""
      width={90}
      height={160}
      loading="lazy"
      decoding="async"
      className={`aspect-[9/16] object-cover ${className}`}
    />
  );
}
