import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { HowItWorks } from '@/components/HowItWorks';

/*
 * Built section by section. Logo marquee, expansion, showcase, pricing,
 * managed service, final CTA and footer follow once the hero and how-it-works
 * are signed off; their copy is already in content/landing.ts.
 */
export default function Home() {
  return (
    <>
      <a
        href="#hero-url-slot"
        className="sr-only z-[60] rounded-full bg-ink px-4 py-2 text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to the website input
      </a>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
      </main>
    </>
  );
}
