'use client';

import { useEffect, useState } from 'react';
import { nav, site } from '@/content/landing';
import { GetStartedButton } from './GetStartedButton';

/**
 * Sticky nav. Transparent over the hero, then a blurred paper ground with a
 * hairline once the page moves — the ink text is legible on both, so there is
 * no state in which the nav disappears against what is behind it.
 */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={[
        'sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300',
        scrolled
          ? 'border-b border-line/80 bg-paper/75 backdrop-blur-xl backdrop-saturate-150'
          : 'border-b border-transparent bg-transparent',
      ].join(' ')}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-5 sm:h-[72px] sm:px-8"
      >
        <a href="#top" className="flex items-baseline gap-1.5" aria-label={`${site.name} home`}>
          <span className="headline text-[26px] leading-none">{site.wordmark}</span>
          <span className="rounded-[5px] border border-ink/80 px-1 py-px text-[10px] font-semibold uppercase leading-none tracking-wider">
            AI
          </span>
        </a>

        <div className="flex items-center gap-1 sm:gap-2">
          {nav.links.map((link, i) => (
            <a
              key={link.href}
              href={link.href}
              className={[
                'rounded-full px-3 py-2 text-[14px] text-muted transition-colors hover:text-ink',
                // The two in-page links collapse on small screens; the page
                // below is the same content, one scroll away.
                i < 2 ? 'hidden md:inline-flex' : 'inline-flex',
              ].join(' ')}
            >
              {link.label}
            </a>
          ))}
          <GetStartedButton className="ml-1">{nav.cta}</GetStartedButton>
        </div>
      </nav>
    </header>
  );
}
