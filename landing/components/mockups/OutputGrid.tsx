'use client';

import { motion } from 'framer-motion';
import { demo } from '@/content/landing';
import { MockFrame, Thumb, useCountUp, useStart } from './shared';

/**
 * Step 2: matched creators arrive one by one.
 *
 * Shows what each creator is — handle, niche, audience size — and nothing
 * invented on top. A "fit score" would be the obvious embellishment and is
 * left out on purpose: a number with no method behind it is the thing this
 * product exists not to show.
 */
export function OutputGrid({ active }: { active?: boolean }) {
  const { ref, started, reduced } = useStart(active);
  const count = useCountUp(demo.creators.length, started, reduced, 1.6);

  return (
    <div ref={ref}>
      <MockFrame
        title="Matched creators"
        label="Example: twelve creators matched to a brand"
        status={<span className="tnum">{count} found</span>}
      >
        <motion.ul
          initial="hidden"
          animate={started || reduced ? 'shown' : 'hidden'}
          variants={{ shown: { transition: { staggerChildren: reduced ? 0 : 0.11, delayChildren: 0.1 } } }}
          className="grid grid-cols-4 gap-2.5 sm:grid-cols-6"
        >
          {demo.creators.map((c) => (
            <motion.li
              key={c.handle}
              variants={{
                hidden: { opacity: 0, y: reduced ? 0 : 10, scale: reduced ? 1 : 0.97 },
                shown: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
              }}
              className="min-w-0"
            >
              <div className="overflow-hidden rounded-xl border border-line">
                <Thumb n={c.poster} className="w-full" />
              </div>
              <p className="mt-1.5 truncate text-[11px] font-medium">@{c.handle}</p>
              <p className="truncate text-[11px] text-muted">
                {c.niche} · {c.followers}
              </p>
            </motion.li>
          ))}
        </motion.ul>
      </MockFrame>
    </div>
  );
}
