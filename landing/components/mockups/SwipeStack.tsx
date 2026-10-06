'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'framer-motion';
import { demo } from '@/content/landing';
import { MockFrame, Thumb, useStart } from './shared';

/**
 * Step 3: shortlist creators in a swipe.
 *
 * Drag the top card right to keep, left to pass. The same decisions are on
 * buttons and on the arrow keys, so nothing here needs a pointer.
 *
 * Left alone, the stack demonstrates itself. The demo stops while the stack is
 * hovered or focused, and for a while after any real input: a card that moves
 * on its own under a keyboard user's focus is a card they did not decide on.
 */
const IDLE_MS = 3200;
const THRESHOLD = 110;
const DEMO_PATTERN = [1, 1, -1, 1, -1] as const;
const DEFAULT_BRIEF = 'One reel showing your morning routine with the serum. Mention your code in the caption.';

export function SwipeStack({ active }: { active?: boolean }) {
  const { ref, started, reduced } = useStart(active);
  const creators = demo.creators;

  const [index, setIndex] = useState(0);
  const [kept, setKept] = useState(0);
  const [passed, setPassed] = useState(0);
  const [editing, setEditing] = useState(false);
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [announcement, setAnnouncement] = useState('');

  const x = useMotionValue(0);
  const rotate = useTransform(x, [-220, 220], [-9, 9]);
  const keepTint = useTransform(x, [0, THRESHOLD], [0, 1]);
  const passTint = useTransform(x, [-THRESHOLD, 0], [1, 0]);

  const busy = useRef(false);
  const lastInput = useRef(Date.now());
  const engaged = useRef(false);
  const demoStep = useRef(0);

  const current = creators[index % creators.length]!;
  const behind = [1, 2].map((o) => creators[(index + o) % creators.length]!);

  const decide = useCallback(
    async (dir: 1 | -1, fromUser: boolean) => {
      if (busy.current) return;
      busy.current = true;
      if (fromUser) lastInput.current = Date.now();
      const who = creators[index % creators.length]!;

      await animate(x, dir * 420, { duration: reduced ? 0 : 0.32, ease: [0.4, 0, 0.2, 1] });

      if (dir === 1) setKept((n) => n + 1);
      else setPassed((n) => n + 1);
      setAnnouncement(`${dir === 1 ? 'Kept' : 'Passed on'} @${who.handle}`);
      setEditing(false);
      setBrief(DEFAULT_BRIEF);
      setIndex((i) => i + 1);
      x.set(0);
      busy.current = false;
    },
    [creators, index, reduced, x],
  );

  // Idle demo.
  useEffect(() => {
    if (!started || reduced) return;
    const timer = window.setInterval(() => {
      if (busy.current || engaged.current || editing) return;
      if (Date.now() - lastInput.current < IDLE_MS) return;
      const dir = DEMO_PATTERN[demoStep.current % DEMO_PATTERN.length]!;
      demoStep.current += 1;
      lastInput.current = Date.now();
      // A short peek in the chosen direction first, so the gesture reads.
      void animate(x, dir * 46, { duration: 0.45, ease: 'easeOut' }).then(() => decide(dir, false));
    }, 700);
    return () => window.clearInterval(timer);
  }, [started, reduced, editing, decide, x]);

  function onDragEnd(_: unknown, info: PanInfo): void {
    lastInput.current = Date.now();
    if (info.offset.x > THRESHOLD || info.velocity.x > 600) void decide(1, true);
    else if (info.offset.x < -THRESHOLD || info.velocity.x < -600) void decide(-1, true);
    else void animate(x, 0, { type: 'spring', stiffness: 420, damping: 32 });
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (editing) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      void decide(1, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      void decide(-1, true);
    }
  }

  return (
    <div ref={ref}>
      <MockFrame
        title="Shortlist"
        label="Example: swiping through matched creators to build a shortlist"
        status={
          <span className="tnum">
            {kept} kept · {passed} passed
          </span>
        }
      >
        <div
          role="group"
          tabIndex={0}
          aria-label="Creator shortlist. Right arrow keeps the creator on top, left arrow passes."
          onKeyDown={onKeyDown}
          onPointerEnter={() => (engaged.current = true)}
          onPointerLeave={() => (engaged.current = false)}
          onFocus={() => (engaged.current = true)}
          onBlur={() => (engaged.current = false)}
          className="relative mx-auto h-[25rem] w-full max-w-[19rem] rounded-2xl"
        >
          {behind
            .slice()
            .reverse()
            .map((c, i) => {
              const depth = behind.length - i; // 2, then 1
              return (
                <div
                  key={`${c.handle}-${index + depth}`}
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[23rem] origin-bottom overflow-hidden rounded-2xl border border-line bg-surface shadow-lift"
                  style={{ transform: `translateY(${depth * 13}px) scale(${1 - depth * 0.05})`, zIndex: 10 - depth }}
                >
                  <Thumb n={c.poster} className="h-[68%] w-full" />
                </div>
              );
            })}

          <motion.div
            key={`${current.handle}-${index}`}
            drag={editing ? false : 'x'}
            dragSnapToOrigin={false}
            dragMomentum={false}
            onDragStart={() => (lastInput.current = Date.now())}
            onDragEnd={onDragEnd}
            style={{ x, rotate, zIndex: 20 }}
            initial={reduced ? false : { scale: 0.96, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-x-0 top-0 h-[23rem] cursor-grab touch-pan-y select-none overflow-hidden rounded-2xl border border-line bg-surface shadow-lift active:cursor-grabbing"
          >
            <div className="relative h-[68%]">
              <Thumb n={current.poster} className="pointer-events-none h-full w-full" />
              <motion.div
                aria-hidden="true"
                style={{ opacity: keepTint }}
                className="absolute inset-0 flex items-start justify-start bg-accent/25 p-4"
              >
                <span className="rounded-md border-2 border-accent bg-surface/90 px-2 py-0.5 text-[13px] font-semibold uppercase tracking-wider text-accent">
                  Keep
                </span>
              </motion.div>
              <motion.div
                aria-hidden="true"
                style={{ opacity: passTint }}
                className="absolute inset-0 flex items-start justify-end bg-pass/20 p-4"
              >
                <span className="rounded-md border-2 border-pass bg-surface/90 px-2 py-0.5 text-[13px] font-semibold uppercase tracking-wider text-pass">
                  Pass
                </span>
              </motion.div>
            </div>

            <div className="flex h-[32%] flex-col justify-between p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">@{current.handle}</p>
                  <p className="text-[12px] text-muted">
                    {current.niche} · {current.followers} followers
                  </p>
                </div>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    lastInput.current = Date.now();
                    setEditing((v) => !v);
                  }}
                  aria-pressed={editing}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    editing ? 'border-ink bg-ink text-paper' : 'border-line-strong hover:border-ink'
                  }`}
                >
                  {editing ? 'Done' : 'Edit'}
                </button>
              </div>
              {editing ? (
                <textarea
                  aria-label={`Brief for @${current.handle}`}
                  value={brief}
                  onChange={(e) => {
                    lastInput.current = Date.now();
                    setBrief(e.target.value);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-line-strong bg-paper px-2 py-1 text-[12px] leading-snug focus-visible:border-accent focus-visible:outline-none"
                />
              ) : (
                <p className="line-clamp-2 text-[12px] leading-snug text-muted">Brief: {brief}</p>
              )}
            </div>
          </motion.div>
        </div>

        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => void decide(-1, true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line-strong px-4 text-[13px] font-medium text-pass transition-colors hover:border-pass hover:bg-pass-soft"
          >
            <span aria-hidden="true">←</span> Pass
          </button>
          <button
            type="button"
            onClick={() => void decide(1, true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line-strong px-4 text-[13px] font-medium text-accent transition-colors hover:border-accent hover:bg-accent-soft"
          >
            Keep <span aria-hidden="true">→</span>
          </button>
        </div>

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </MockFrame>
    </div>
  );
}
