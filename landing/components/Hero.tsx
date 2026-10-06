import { hero } from '@/content/landing';
import { HERO_INPUT_ID, HERO_INPUT_SLOT } from '@/lib/scroll';
import { MediaWall } from './MediaWall';
import { UrlInput } from './UrlInput';

export function Hero() {
  const [lead, emphasis] = hero.headline;

  return (
    <section
      id="top"
      aria-labelledby="hero-headline"
      className="relative -mt-16 flex min-h-[92svh] items-center overflow-hidden pt-16 sm:-mt-[72px] sm:pt-[72px]"
    >
      <MediaWall />

      <div className="relative mx-auto flex w-full max-w-[1240px] flex-col items-center px-5 py-20 text-center sm:px-8 sm:py-28">
        <h1 id="hero-headline" className="headline max-w-[16ch] text-display sm:max-w-none">
          <span className="block">{lead}</span>
          <em className="block italic text-accent">{emphasis}</em>
        </h1>

        <p className="mt-6 max-w-[34rem] text-[17px] leading-relaxed text-muted sm:mt-7 sm:text-[19px]">
          {hero.subhead}
        </p>

        <div className="mt-9 w-full max-w-[34rem] sm:mt-10">
          <UrlInput slotId={HERO_INPUT_SLOT} inputId={HERO_INPUT_ID} />
          <a
            href={hero.noWebsite.href}
            className="-mt-1 inline-block text-[14px] text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
          >
            {hero.noWebsite.label}
          </a>
        </div>
      </div>
    </section>
  );
}
