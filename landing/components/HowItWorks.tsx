'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotionAfterMount } from './mockups/shared';
import { howItWorks } from '@/content/landing';
import { BrandProfileCard } from './mockups/BrandProfileCard';
import { OutputGrid } from './mockups/OutputGrid';
import { SwipeStack } from './mockups/SwipeStack';
import { ScheduleCalendar } from './mockups/ScheduleCalendar';
import { HooksLeaderboard } from './mockups/HooksLeaderboard';

/**
 * How it works.
 *
 * Desktop: the steps scroll on the left while a sticky panel on the right
 * crossfades to the matching mockup. The active step is whichever one crosses
 * the middle of the viewport — a line, not a threshold, so exactly one step is
 * ever active and fast scrolling cannot leave two half-lit.
 *
 * Mobile: each step sits directly above its own mockup.
 *
 * Both layouts are in the markup and one is hidden with CSS, rather than
 * picking one in JavaScript: the server cannot know the viewport, and choosing
 * on the client would render the wrong one first and then swap.
 */
const MOCKUPS: Record<string, ComponentType<{ active?: boolean }>> = {
  profile: BrandProfileCard,
  match: OutputGrid,
  shortlist: SwipeStack,
  schedule: ScheduleCalendar,
  results: HooksLeaderboard,
};

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const reduced = useReducedMotionAfterMount();
  const [lead, emphasis] = howItWorks.headline;

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const i = Number((entry.target as HTMLElement).dataset.index);
            if (!Number.isNaN(i)) setActive(i);
          }
        }
      },
      // A zero-height band at the vertical centre of the viewport.
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    stepRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const ActiveMockup = MOCKUPS[howItWorks.steps[active]!.id]!;

  return (
    <section id="how-it-works" aria-labelledby="how-headline" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1240px] px-5 sm:px-8">
        <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted">{howItWorks.eyebrow}</p>
        <h2 id="how-headline" className="headline mt-4 text-title">
          {lead} <em className="italic text-accent">{emphasis}</em>
        </h2>

        {/* ---------------------------------------------------------- desktop */}
        <div className="mt-8 hidden grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-16 lg:grid">
          <ol className="relative">
            {/* Progress rail */}
            <div aria-hidden="true" className="absolute bottom-[38vh] left-[11px] top-[38vh] w-px bg-line">
              <motion.div
                className="w-px origin-top bg-ink"
                animate={{ height: `${(active / (howItWorks.steps.length - 1)) * 100}%` }}
                transition={{ duration: reduced ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            {howItWorks.steps.map((step, i) => (
              <li
                key={step.id}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                data-index={i}
                aria-current={i === active ? 'step' : undefined}
                className="flex min-h-[76vh] items-center"
              >
                <div className="flex gap-6">
                  <span
                    aria-hidden="true"
                    className={`relative z-10 mt-1.5 flex size-[23px] shrink-0 items-center justify-center rounded-full border text-[11px] tnum transition-colors duration-300 ${
                      i <= active ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-paper text-muted'
                    }`}
                  >
                    {i + 1}
                  </span>
                  {/*
                    Inactive steps change colour, not opacity. Dimming with
                    opacity took the body text below AA contrast — and these
                    are steps a reader is meant to be able to read ahead to.
                  */}
                  <div className="max-w-[26rem]">
                    <h3
                      className={`headline text-[34px] leading-[1.05] transition-colors duration-300 ${
                        i === active ? 'text-ink' : 'text-muted'
                      }`}
                    >
                      {step.title}
                    </h3>
                    <p className="mt-3 text-[17px] leading-relaxed text-muted">{step.body}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <div className="relative">
            <div className="sticky top-[88px] flex h-[calc(100svh-120px)] items-center">
              <div className="grid w-full">
                <AnimatePresence initial={false}>
                  <motion.div
                    key={active}
                    className="[grid-area:1/1]"
                    initial={{ opacity: 0, y: reduced ? 0 : 14, scale: reduced ? 1 : 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: reduced ? 0 : -10, scale: reduced ? 1 : 0.985 }}
                    transition={{ duration: reduced ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <ActiveMockup active />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------- mobile */}
        <ol className="mt-12 space-y-16 lg:hidden">
          {howItWorks.steps.map((step, i) => {
            const Mockup = MOCKUPS[step.id]!;
            return (
              <li key={step.id}>
                <div className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-1 flex size-[23px] shrink-0 items-center justify-center rounded-full bg-ink text-[11px] text-paper tnum"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="headline text-[28px] leading-[1.05]">{step.title}</h3>
                    <p className="mt-2 text-[16px] leading-relaxed text-muted">{step.body}</p>
                  </div>
                </div>
                <div className="mt-6">
                  <Mockup />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
