'use client';

import { goToHeroInput } from '@/lib/scroll';

/** Every "Get started" on the page: scroll to the hero input and focus it. */
export function GetStartedButton({
  children,
  plan,
  interval,
  variant = 'primary',
  className = '',
}: {
  children: React.ReactNode;
  plan?: string;
  interval?: string;
  variant?: 'primary' | 'secondary' | 'onInk';
  className?: string;
}) {
  const styles = {
    primary: 'bg-ink text-paper hover:bg-accent',
    secondary: 'border border-line-strong bg-surface text-ink hover:border-ink',
    onInk: 'bg-paper text-ink hover:bg-white',
  }[variant];

  return (
    <button
      type="button"
      onClick={() => goToHeroInput({ ...(plan ? { plan } : {}), ...(interval ? { interval } : {}) })}
      className={`inline-flex h-10 items-center justify-center rounded-full px-5 text-[14px] font-medium transition-colors duration-200 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}
