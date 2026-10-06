'use client';

import { useEffect, useState } from 'react';
import { demo } from '@/content/landing';
import { MockFrame, Thumb, useStart } from './shared';

/**
 * Step 4: the campaign on a calendar.
 *
 * A "today" marker walks through the month; every post it passes flips from
 * scheduled to published and the counter climbs with it. It stops on the 24th
 * so the finished state shows both — what has gone out and what is still to
 * come — rather than a month that is entirely done.
 */
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const STOP_ON = 24;

export function ScheduleCalendar({ active }: { active?: boolean }) {
  const { ref, started, reduced } = useStart(active);
  const { month, days, startsOn, posts } = demo.schedule;
  const [today, setToday] = useState(0);

  useEffect(() => {
    if (reduced) {
      setToday(STOP_ON);
      return;
    }
    if (!started) return;
    let d = 0;
    const timer = window.setInterval(() => {
      d += 1;
      setToday(d);
      if (d >= STOP_ON) window.clearInterval(timer);
    }, 110);
    return () => window.clearInterval(timer);
  }, [started, reduced]);

  const postDays = Object.keys(posts).map(Number);
  const published = postDays.filter((d) => d <= today).length;
  const scheduled = postDays.length - published;
  const cells = [...Array.from({ length: startsOn }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];

  return (
    <div ref={ref}>
      <MockFrame
        title={`${month} campaign`}
        label="Example: a month of scheduled creator posts"
        status={
          <span className="tnum">
            <span className="font-medium text-accent">{published} published</span> · {scheduled} scheduled
          </span>
        }
      >
        <div className="grid grid-cols-7 gap-1.5 text-center">
          {WEEKDAYS.map((d, i) => (
            <span key={i} className="pb-1 text-[11px] font-medium uppercase text-muted">
              {d}
            </span>
          ))}
          {cells.map((day, i) => {
            if (day === null) return <span key={`blank-${i}`} aria-hidden="true" />;
            const poster = posts[day as keyof typeof posts] as number | undefined;
            const isPublished = poster !== undefined && day <= today;
            const isToday = day === today;
            return (
              <div
                key={day}
                className={[
                  'relative flex aspect-[3/4] flex-col overflow-hidden rounded-lg border text-left transition-colors duration-300',
                  isToday ? 'border-ink' : 'border-line',
                  poster !== undefined ? '' : 'bg-paper/60',
                ].join(' ')}
              >
                <span className={`absolute left-1 top-0.5 z-10 text-[10px] tnum ${poster !== undefined ? 'text-ink/80' : 'text-muted'}`}>
                  {day}
                </span>
                {poster !== undefined ? (
                  <>
                    <Thumb
                      n={poster}
                      className={`h-full w-full object-top transition-[filter,opacity] duration-500 ${isPublished ? '' : 'opacity-45 grayscale'}`}
                    />
                    <span
                      className={`absolute bottom-1 left-1 right-1 rounded-sm py-px text-center text-[8px] font-semibold uppercase tracking-wide ${
                        isPublished ? 'bg-accent text-paper' : 'bg-surface/90 text-muted'
                      }`}
                    >
                      {isPublished ? 'Live' : 'Due'}
                    </span>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </MockFrame>
    </div>
  );
}
