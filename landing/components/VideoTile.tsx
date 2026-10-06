'use client';

import { useEffect, useRef, useState } from 'react';
import type { Media } from '@/content/landing';

/**
 * A 9:16 tile: always a poster image, with the clip layered on top only while
 * it is on screen.
 *
 * The poster is a real <img> so the tile has alt text, paints immediately, and
 * is all a reduced-motion visitor ever gets. The <video> has no src until the
 * tile first comes near the viewport — preload="none" alone still lets some
 * browsers fetch metadata for every clip on the page — and it pauses the
 * moment it leaves.
 */
export function VideoTile({
  media,
  decorative = false,
  eager = false,
  className = '',
}: {
  media: Media;
  /** Background use: hidden from assistive tech, and no alt text. */
  decorative?: boolean;
  eager?: boolean;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [allowMotion, setAllowMotion] = useState(false);
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowMotion(!query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !allowMotion) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const v = video.current;
        if (!entry) return;
        if (entry.isIntersecting) {
          setSrc(media.video);
          // play() rejects if the browser declines autoplay; the poster is
          // already showing, so there is nothing to recover.
          v?.play().catch(() => undefined);
        } else {
          v?.pause();
        }
      },
      { rootMargin: '120px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [allowMotion, media.video]);

  // React sets `muted` as a property only, never as the attribute, and iOS
  // Safari checks the attribute before it will autoplay inline. Set both.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
  }, [allowMotion]);

  // A src set after the element mounted needs an explicit play.
  useEffect(() => {
    if (src) video.current?.play().catch(() => undefined);
  }, [src]);

  return (
    <div
      ref={wrap}
      aria-hidden={decorative || undefined}
      className={`relative aspect-[9/16] overflow-hidden bg-sunken ${className}`}
    >
      <img
        src={media.poster}
        alt={decorative ? '' : media.alt}
        width={360}
        height={640}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {allowMotion ? (
        <video
          ref={video}
          src={src}
          poster={media.poster}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </div>
  );
}
