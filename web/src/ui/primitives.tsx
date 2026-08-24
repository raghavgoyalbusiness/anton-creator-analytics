import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Anton component library.
 *
 * Every status surface pairs its colour with an icon and a label. Amber and red
 * at equal lightness are indistinguishable to a deuteranope, so colour is never
 * the only channel carrying "this is a warning" versus "this is an error".
 */

/* ------------------------------------------------------------------ icons */

const iconBase = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const Icon = {
  info: (): ReactNode => (
    <svg {...iconBase}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.75M8 5.1v.1" />
    </svg>
  ),
  warn: (): ReactNode => (
    <svg {...iconBase}>
      <path d="M8 2.2 1.9 13.1h12.2L8 2.2Z" />
      <path d="M8 6.4v3.1M8 11.3v.1" />
    </svg>
  ),
  danger: (): ReactNode => (
    <svg {...iconBase}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />
    </svg>
  ),
  success: (): ReactNode => (
    <svg {...iconBase}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.3 8.2 1.9 1.9 3.5-3.9" />
    </svg>
  ),
  chevron: (): ReactNode => (
    <svg {...iconBase}>
      <path d="m6 4 4 4-4 4" />
    </svg>
  ),
  external: (): ReactNode => (
    <svg {...iconBase}>
      <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" />
    </svg>
  ),
};

/* ----------------------------------------------------------------- button */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md';

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}): ReactNode {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[--radius-md] font-medium ' +
    'transition-[background-color,border-color,color,opacity] duration-[--duration-fast] ' +
    'ease-[--ease-out] disabled:opacity-45 disabled:cursor-not-allowed select-none';

  const sizes: Record<ButtonSize, string> = {
    sm: 'min-h-9 px-3 text-label',
    md: 'min-h-11 px-5 text-body',
  };

  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-white hover:bg-accent-hover',
    secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken',
    danger: 'bg-danger text-white hover:opacity-90',
    ghost: 'text-muted hover:text-ink hover:bg-sunken',
  };

  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- card */

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}): ReactNode {
  return (
    <div
      className={`rounded-[--radius-lg] border border-line bg-surface shadow-[--shadow-raised] ${
        padded ? 'p-5' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-heading font-semibold">{title}</h2>
        {hint ? <p className="mt-0.5 text-label text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------------- notice */

type Tone = 'info' | 'warn' | 'danger' | 'success';

const TONE_STYLE: Record<Tone, { box: string; icon: ReactNode; label: string }> = {
  info: {
    box: 'border-line bg-sunken text-ink-secondary',
    icon: <Icon.info />,
    label: 'Note',
  },
  warn: {
    box: 'border-warn-line bg-warn-soft text-warn',
    icon: <Icon.warn />,
    label: 'Warning',
  },
  danger: {
    box: 'border-danger-line bg-danger-soft text-danger',
    icon: <Icon.danger />,
    label: 'Error',
  },
  success: {
    box: 'border-good-line bg-good-soft text-good',
    icon: <Icon.success />,
    label: 'Success',
  },
};

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}): ReactNode {
  const style = TONE_STYLE[tone];
  return (
    <div
      className={`flex gap-2.5 rounded-[--radius-md] border p-3.5 text-label ${style.box}`}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <span className="mt-px shrink-0">{style.icon}</span>
      <div className="min-w-0 flex-1">
        {/* The tone name is announced for screen readers and carried visually by
            the icon, so a colourblind reader never depends on the hue. */}
        <span className="sr-only">{style.label}: </span>
        {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
        <div className="[&_a]:underline">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ badge */

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'success';
  children: ReactNode;
}): ReactNode {
  const tones: Record<string, string> = {
    neutral: 'border-line bg-sunken text-muted',
    accent: 'border-accent-line bg-accent-soft text-accent-ink',
    warn: 'border-warn-line bg-warn-soft text-warn',
    danger: 'border-danger-line bg-danger-soft text-danger',
    success: 'border-good-line bg-good-soft text-good',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-caption font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- stat */

/**
 * A single figure.
 *
 * `value === null` renders "not captured" rather than a zero or a dash, because
 * the difference between "we did not measure this" and "this was zero" is the
 * whole point of the product.
 */
export function Stat({
  label,
  value,
  unit,
  footnote,
  unavailable,
  size = 'md',
  emphasis = false,
}: {
  label: string;
  value: string | null;
  unit?: string;
  footnote?: string;
  unavailable?: string | null;
  size?: 'sm' | 'md' | 'lg';
  emphasis?: boolean;
}): ReactNode {
  const sizes = {
    sm: 'text-heading',
    md: 'text-figure',
    lg: 'text-display',
  };
  return (
    <div
      className={`rounded-[--radius-lg] border p-4 ${
        emphasis ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface'
      }`}
    >
      <p className="text-label text-muted">{label}</p>
      {value !== null ? (
        <p
          className={`tnum mt-1.5 font-semibold ${sizes[size]} ${emphasis ? 'text-accent-ink' : ''}`}
        >
          {value}
          {unit ? <span className="ml-1 text-label font-normal text-muted">{unit}</span> : null}
        </p>
      ) : (
        <p className="mt-1.5 text-heading text-muted" title={unavailable ?? undefined}>
          not captured
        </p>
      )}
      {footnote ? <p className="mt-1.5 text-caption text-muted">{footnote}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ table */

export function Table({
  columns,
  children,
  minWidth = '48rem',
}: {
  columns: { key: string; label: string; align?: 'left' | 'right' }[];
  children: ReactNode;
  minWidth?: string;
}): ReactNode {
  return (
    <div className="scroll-x rounded-[--radius-lg] border border-line bg-surface">
      <table className="w-full border-collapse text-label" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-3 py-2.5 text-caption font-medium uppercase tracking-wide text-muted ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  align = 'left',
  className = '',
  numeric = false,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  numeric?: boolean;
}): ReactNode {
  return (
    <td
      className={`px-3 py-2.5 ${align === 'right' ? 'text-right' : ''} ${
        numeric ? 'tnum' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <tr className={`border-b border-line/70 last:border-0 ${className}`}>{children}</tr>;
}

/* ------------------------------------------------------------------ forms */

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
      <span className="mb-1.5 block text-label font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-caption text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-[--radius-md] border border-line-strong bg-surface px-3.5 py-2.5 text-ink ' +
  'placeholder:text-muted transition-colors duration-[--duration-fast] ' +
  'hover:border-muted focus:border-accent';

/* ---------------------------------------------------------------- spinner */

export function Spinner({ label }: { label: string }): ReactNode {
  return (
    <div className="flex items-center gap-3 text-muted" role="status" aria-live="polite">
      <span
        className="size-4 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden="true"
      />
      <span className="text-label">{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <Card className="text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-1 text-label text-muted">{children}</p> : null}
    </Card>
  );
}
