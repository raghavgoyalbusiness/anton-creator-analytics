import { hero } from '@/content/landing';
import { VideoTile } from './VideoTile';

/**
 * The drifting wall behind the hero.
 *
 * Columns drift in alternating directions and ping-pong rather than loop, so no
 * column needs a duplicated track to hide a seam — half the tiles, half the
 * work. Decorative throughout: hidden from assistive tech, and frozen when the
 * visitor has asked for reduced motion (globals.css).
 */
const DESKTOP_COLUMNS = 6;
const MOBILE_COLUMNS = 3;
const PER_COLUMN = 5;

function column(index: number) {
  const tiles = Array.from({ length: PER_COLUMN }, (_, i) => {
    const media = hero.wall[(index * 5 + i * 7) % hero.wall.length];
    return media!;
  });
  return tiles;
}

export function MediaWall() {
  const columns = Array.from({ length: DESKTOP_COLUMNS }, (_, i) => column(i));

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        maskImage: 'linear-gradient(to bottom, transparent 0%, black 18%, black 70%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 18%, black 70%, transparent 100%)',
      }}
    >
      <div className="absolute inset-x-[-4%] -top-[6%] grid grid-cols-3 gap-3 opacity-[0.3] sm:gap-4 md:grid-cols-6">
        {columns.map((tiles, i) => (
          <div
            key={i}
            className={[
              'flex flex-col gap-3 will-change-transform sm:gap-4',
              i % 2 === 0 ? 'animate-drift-up' : 'animate-drift-down',
              i >= MOBILE_COLUMNS ? 'hidden md:flex' : '',
              // Offset alternate columns so the wall reads as masonry, not a grid.
              i % 2 === 0 ? 'mt-0' : 'mt-24',
            ].join(' ')}
            style={{ animationDelay: `${-i * 9}s` }}
          >
            {tiles.map((media, j) => (
              <VideoTile key={j} media={media} decorative className="rounded-2xl" />
            ))}
          </div>
        ))}
      </div>
      {/* Keeps the headline legible over the wall without hiding the wall. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_72%_58%_at_50%_48%,var(--color-paper)_42%,transparent_82%)]" />
    </div>
  );
}
