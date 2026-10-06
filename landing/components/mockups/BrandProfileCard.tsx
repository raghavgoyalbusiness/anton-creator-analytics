'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { demo } from '@/content/landing';
import { MockFrame, useStart } from './shared';

/**
 * Step 1: a website becomes a brand profile.
 *
 * Types the URL a character at a time, reads for a beat, then reveals the
 * fields one by one. Holds the finished card; a reduced-motion visitor gets the
 * finished card straight away.
 */
type Phase = 'typing' | 'reading' | 'done';

const FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'url', label: 'Website' },
  { key: 'voice', label: 'Voice' },
  { key: 'audience', label: 'Audience' },
  { key: 'sells', label: 'Sells' },
] as const;

export function BrandProfileCard({ active }: { active?: boolean }) {
  const { ref, started, reduced } = useStart(active);
  const url = demo.brand.url;
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<Phase>('typing');

  useEffect(() => {
    if (reduced) {
      setTyped(url.length);
      setPhase('done');
      return;
    }
    if (!started) return;
    let i = 0;
    const timers: number[] = [];
    const tick = window.setInterval(() => {
      i += 1;
      setTyped(i);
      if (i >= url.length) {
        window.clearInterval(tick);
        setPhase('reading');
        timers.push(window.setTimeout(() => setPhase('done'), 900));
      }
    }, 75);
    return () => {
      window.clearInterval(tick);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [started, reduced, url.length]);

  const values: Record<(typeof FIELDS)[number]['key'], string> = {
    name: demo.brand.name,
    url: demo.brand.url,
    voice: demo.brand.voice,
    audience: demo.brand.audience,
    sells: demo.brand.sells,
  };

  return (
    <div ref={ref}>
      <MockFrame
        title="Brand profile"
        label="Example: a website turned into a brand profile"
        status={phase === 'done' ? 'Drafted' : phase === 'reading' ? 'Reading your site…' : 'Paste your site'}
      >
        <div className="flex h-12 items-center rounded-full border border-line-strong bg-paper pl-4 pr-1.5">
          <span className="text-[14px] text-muted">www.</span>
          <span className="tnum text-[14px]">{url.slice(0, typed)}</span>
          {phase === 'typing' ? (
            <span aria-hidden="true" className="ml-px h-4 w-px animate-pulse bg-ink" />
          ) : null}
          <span className="ml-auto rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-paper">
            Get started
          </span>
        </div>

        <div className="mt-5 min-h-[16.75rem]">
          <AnimatePresence mode="wait">
            {phase === 'reading' ? (
              <motion.div
                key="reading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-3"
              >
                {[80, 64, 92, 56].map((w, i) => (
                  <div key={i} className="h-3 animate-pulse rounded-full bg-sunken" style={{ width: `${w}%` }} />
                ))}
              </motion.div>
            ) : phase === 'done' ? (
              <motion.dl
                key="done"
                initial="hidden"
                animate="shown"
                variants={{ shown: { transition: { staggerChildren: reduced ? 0 : 0.12 } } }}
                className="divide-y divide-line rounded-2xl border border-line"
              >
                {FIELDS.map((f) => (
                  <motion.div
                    key={f.key}
                    variants={{
                      hidden: { opacity: 0, y: reduced ? 0 : 6 },
                      shown: { opacity: 1, y: 0, transition: { duration: 0.35 } },
                    }}
                    className="grid grid-cols-[5.5rem_1fr] gap-3 px-4 py-3"
                  >
                    <dt className="text-[12px] uppercase tracking-wider text-muted">{f.label}</dt>
                    <dd className={`text-[14px] leading-snug ${f.key === 'name' ? 'headline text-[20px] leading-none' : ''}`}>
                      {values[f.key]}
                    </dd>
                  </motion.div>
                ))}
              </motion.dl>
            ) : null}
          </AnimatePresence>
        </div>
      </MockFrame>
    </div>
  );
}
