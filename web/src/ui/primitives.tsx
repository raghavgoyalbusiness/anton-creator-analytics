import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}): ReactNode {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 min-h-12 font-medium ' +
    'transition-colors disabled:opacity-45 disabled:cursor-not-allowed ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
  const styles: Record<string, string> = {
    primary: 'bg-accent text-paper hover:opacity-90',
    secondary: 'border border-line bg-transparent text-ink hover:bg-line/40',
    danger: 'bg-danger text-paper hover:opacity-90',
    ghost: 'text-muted hover:text-ink',
  };
  return (
    <button className={`${base} ${styles[variant] ?? ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={`rounded-2xl border border-line bg-paper p-5 ${className}`}>{children}</div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  title?: string;
  children: ReactNode;
}): ReactNode {
  const tones: Record<string, string> = {
    info: 'border-line bg-line/25 text-ink',
    warn: 'border-warn/35 bg-warn-soft text-warn',
    danger: 'border-danger/35 bg-danger-soft text-danger',
    success: 'border-accent/35 bg-accent-soft text-accent',
  };
  return (
    <div className={`rounded-xl border p-4 text-sm leading-relaxed ${tones[tone] ?? ''}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-xl border border-line bg-transparent px-4 py-3 text-ink ' +
  'focus:outline-2 focus:outline-offset-0 focus:outline-accent placeholder:text-muted';

export function Spinner({ label }: { label: string }): ReactNode {
  return (
    <div className="flex items-center gap-3 text-muted" role="status" aria-live="polite">
      <span
        className="size-4 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden="true"
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}
