'use client';

import { motion } from 'framer-motion';
import { demo } from '@/content/landing';
import { MockFrame, Thumb, useCountUp, useStart } from './shared';

/**
 * Step 5: posts ranked by what they sold.
 *
 * Ranked by orders, because that is the claim the product makes; the bar is
 * each post's share of the top post, so the longest bar always means "the
 * best one" rather than an axis nobody can read.
 */
function Row({
  rank,
  item,
  max,
  started,
  reduced,
  delay,
}: {
  rank: number;
  item: (typeof demo.leaderboard)[number];
  max: number;
  started: boolean;
  reduced: boolean;
  delay: number;
}) {
  const orders = useCountUp(item.orders, started, reduced, 1.1 + delay);
  return (
    <li className="grid grid-cols-[1.25rem_2.5rem_1fr_auto] items-center gap-3 py-2.5">
      <span className="tnum text-[13px] text-muted">{rank}</span>
      <Thumb n={item.poster} className="w-10 rounded-md border border-line" />
      <div className="min-w-0">
        <p className="truncate text-[13px] leading-snug">{item.hook}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={{ width: reduced ? `${(item.orders / max) * 100}%` : '0%' }}
              animate={{ width: started || reduced ? `${(item.orders / max) * 100}%` : '0%' }}
              transition={{ duration: reduced ? 0 : 1.1, delay: reduced ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className="shrink-0 text-[11px] text-muted">@{item.handle}</span>
        </div>
      </div>
      <span className="tnum w-12 text-right text-[14px] font-medium">{orders}</span>
    </li>
  );
}

export function HooksLeaderboard({ active }: { active?: boolean }) {
  const { ref, started, reduced } = useStart(active);
  const max = Math.max(...demo.leaderboard.map((r) => r.orders));

  return (
    <div ref={ref}>
      <MockFrame
        title="Top posts"
        label="Example: creator posts ranked by the orders they drove"
        status="Ranked by orders"
      >
        <div className="flex items-center justify-between border-b border-line pb-2 text-[11px] uppercase tracking-wider text-muted">
          <span>Hook</span>
          <span>Orders</span>
        </div>
        <ol className="divide-y divide-line">
          {demo.leaderboard.map((item, i) => (
            <Row key={item.handle} rank={i + 1} item={item} max={max} started={started} reduced={reduced} delay={i * 0.12} />
          ))}
        </ol>
        <p className="mt-3 text-[12px] text-muted">Every figure opens the order export it came from.</p>
      </MockFrame>
    </div>
  );
}
