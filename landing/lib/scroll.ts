'use client';

/**
 * Every call to action on the page lands on the same place: the hero input.
 *
 * Scrolls it into view and focuses it. Focus waits for the scroll to settle —
 * focusing first makes some browsers jump instantly and skip the smooth
 * scroll — and uses preventScroll so it cannot fight the animation.
 *
 * A plan picked in the pricing table is written into the address bar, so the
 * input's submit carries it on to onboarding and a refresh does not lose it.
 */
export const HERO_INPUT_SLOT = 'hero-url-slot';
export const HERO_INPUT_ID = 'hero-url-input';

export function goToHeroInput(context: { plan?: string; interval?: string } = {}): void {
  if (context.plan || context.interval) {
    const url = new URL(window.location.href);
    if (context.plan) url.searchParams.set('plan', context.plan);
    if (context.interval) url.searchParams.set('interval', context.interval);
    window.history.replaceState(null, '', url);
  }

  const slot = document.getElementById(HERO_INPUT_SLOT);
  const input = document.getElementById(HERO_INPUT_ID) as HTMLInputElement | null;
  if (!slot || !input) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rect = slot.getBoundingClientRect();
  const alreadyVisible = rect.top >= 80 && rect.bottom <= window.innerHeight;

  if (alreadyVisible || reduced) {
    if (!alreadyVisible) slot.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
    return;
  }

  slot.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // scrollend where supported; a timeout everywhere else.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    input.focus({ preventScroll: true });
  };
  window.addEventListener('scrollend', finish, { once: true });
  window.setTimeout(finish, 900);
}
