'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { hero } from '@/content/landing';
import { normaliseBrandUrl, onboardingHref } from '@/lib/url';

/**
 * The one input the whole page funnels into.
 *
 * Rendered twice — in the hero and in the final call to action — but only the
 * hero instance carries the ids every "Get started" scrolls to, so there is
 * exactly one target and no duplicate ids.
 *
 * `forceState` exists only for the /states review page, which shows hover,
 * focus, empty, filled and error side by side. It changes the styling, never
 * the behaviour.
 */

export type ForcedState = 'empty' | 'hover' | 'focus' | 'filled' | 'error';

/** Strips what people paste in front of a domain, so the "www." prefix never doubles up. */
function tidy(value: string): string {
  return value.replace(/^\s*(https?:\/\/)?(www\.)?/i, '');
}

export function UrlInput({
  tone = 'light',
  slotId,
  inputId,
  forceState,
  defaultValue = '',
}: {
  tone?: 'light' | 'ink';
  slotId?: string;
  inputId?: string;
  forceState?: ForcedState;
  defaultValue?: string;
}) {
  const router = useRouter();
  const generatedId = useId();
  const id = inputId ?? `url-${generatedId}`;
  const errorId = `${id}-error`;

  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(
    forceState === 'error' ? hero.input.errorInvalid : null,
  );
  const [submitting, setSubmitting] = useState(false);

  const isAppStore = /^apps\.apple\.com|^itunes\.apple\.com/i.test(value);

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (forceState) return;

    const result = normaliseBrandUrl(value);
    if (!result.ok) {
      setError(result.reason === 'empty' ? hero.input.errorEmpty : hero.input.errorInvalid);
      document.getElementById(id)?.focus();
      return;
    }

    setError(null);
    setSubmitting(true);
    // Read at submit time rather than subscribed to: a plan picked in the
    // pricing table is written into the address bar just before the visitor
    // lands here.
    const params = new URLSearchParams(window.location.search);
    router.push(
      onboardingHref(result.value, { plan: params.get('plan'), interval: params.get('interval') }),
    );
  }

  const ink = tone === 'ink';
  const forced = {
    hover: forceState === 'hover',
    focus: forceState === 'focus',
  };

  return (
    <form onSubmit={submit} noValidate className="w-full" id={slotId}>
      <label htmlFor={id} className="sr-only">
        {hero.input.label}
      </label>
      <div
        data-state={forceState}
        className={[
          'group flex h-14 w-full items-center rounded-full border pl-5 pr-1.5 transition-[border-color,box-shadow,background-color] duration-200 sm:h-16 sm:pl-6 sm:pr-2',
          ink
            ? 'border-white/15 bg-white/[0.06] hover:not-focus-within:border-white/30 focus-within:border-accent-dark focus-within:shadow-[0_0_0_4px_rgb(143_209_176/0.18)]'
            : 'border-line-strong bg-surface shadow-lift hover:not-focus-within:border-faint focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgb(30_90_68/0.14)]',
          error ? (ink ? '!border-[#f0a08c]' : '!border-pass') : '',
          forced.hover ? (ink ? '!border-white/30' : '!border-faint') : '',
          forced.focus
            ? ink
              ? '!border-accent-dark shadow-[0_0_0_4px_rgb(143_209_176/0.18)]'
              : '!border-accent shadow-[0_0_0_4px_rgb(30_90_68/0.14)]'
            : '',
        ].join(' ')}
      >
        {!isAppStore ? (
          <span
            aria-hidden="true"
            className={`select-none pr-0.5 text-[15px] sm:text-[17px] ${ink ? 'text-muted-dark' : 'text-muted'}`}
          >
            {hero.input.prefix}
          </span>
        ) : null}
        <input
          id={id}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={hero.input.placeholder}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(tidy(e.target.value));
            if (error) setError(null);
          }}
          className={[
            'min-w-0 flex-1 bg-transparent text-[15px] outline-none sm:text-[17px]',
            // The pill draws the focus ring; the bare input must not draw a second one.
            'focus-visible:outline-none',
            ink ? 'text-paper placeholder:text-muted-dark' : 'text-ink placeholder:text-muted',
          ].join(' ')}
        />
        <button
          type="submit"
          disabled={submitting}
          className={[
            'ml-2 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition-[background-color,transform] duration-200 active:scale-[0.98] sm:h-12 sm:px-6 sm:text-[15px]',
            ink
              ? 'bg-paper text-ink hover:bg-white'
              : 'bg-ink text-paper hover:bg-accent',
            submitting ? 'opacity-70' : '',
          ].join(' ')}
        >
          {hero.input.button}
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" className="transition-transform duration-200 group-hover:translate-x-0.5">
            <path d="M3 8h10m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <p
        id={errorId}
        role={error ? 'alert' : undefined}
        className={`mt-2 min-h-5 pl-6 text-[13px] ${ink ? 'text-[#f0a08c]' : 'text-pass'}`}
      >
        {error ?? ''}
      </p>
    </form>
  );
}
