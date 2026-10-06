import { UrlInput, type ForcedState } from '@/components/UrlInput';

/**
 * Design review: the URL input in every state, side by side, on both grounds.
 * Not linked from the page and not indexed.
 */
export const metadata = { title: 'Input states', robots: { index: false, follow: false } };

const STATES: { state: ForcedState; label: string; value: string }[] = [
  { state: 'empty', label: 'Empty', value: '' },
  { state: 'hover', label: 'Hover', value: '' },
  { state: 'focus', label: 'Focus', value: '' },
  { state: 'filled', label: 'Filled', value: 'kelpandco.com' },
  { state: 'error', label: 'Error', value: 'kelp and co' },
];

export default function States() {
  return (
    <main className="min-h-dvh">
      <section className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="headline text-title">Input states</h1>
        <div className="mt-10 space-y-7">
          {STATES.map((s) => (
            <div key={s.state}>
              <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.18em] text-muted">{s.label}</p>
              <UrlInput forceState={s.state} defaultValue={s.value} />
            </div>
          ))}
        </div>
      </section>
      <section className="on-ink bg-ink">
        <div className="mx-auto max-w-3xl px-6 py-14">
          <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-dark">On ink</p>
          <div className="mt-6 space-y-7">
            {STATES.map((s) => (
              <div key={s.state}>
                <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.18em] text-muted-dark">{s.label}</p>
                <UrlInput tone="ink" forceState={s.state} defaultValue={s.value} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
