import sharp from 'sharp';
import type { PostMetrics } from '@anton/shared';

/**
 * Renders a synthetic "Insights panel" for seeded posts.
 *
 * Clearly labelled as sample data on the face of the image. Seeded screenshots
 * must never be mistakable for something a real creator sent: the whole product
 * rests on the image being genuine evidence, and a realistic-looking fake in
 * the development database is exactly the thing that ends up in a screenshot of
 * a demo and then in a deck.
 */
export async function renderSyntheticPanel(params: {
  handle: string;
  platform: string;
  format: string;
  metrics: PostMetrics;
}): Promise<Buffer> {
  const rows: [string, number | null][] = [
    ['Reach', params.metrics.reach],
    ['Impressions', params.metrics.impressions],
    ['Likes', params.metrics.likes],
    ['Comments', params.metrics.comments],
    ['Shares', params.metrics.shares],
    ['Saves', params.metrics.saves],
    ['Profile visits', params.metrics.profileVisits],
    ['Follows', params.metrics.followsFromPost],
  ];

  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rowSvg = rows
    .map(([label, value], i) => {
      const y = 250 + i * 62;
      const shown = value === null ? '—' : value.toLocaleString('en-GB');
      return `
        <text x="60" y="${y}" font-family="Helvetica, Arial" font-size="26" fill="#8e8e93">${escape(label)}</text>
        <text x="740" y="${y}" font-family="Helvetica, Arial" font-size="30" font-weight="600" fill="#ffffff" text-anchor="end">${escape(shown)}</text>
        <line x1="60" y1="${y + 22}" x2="740" y2="${y + 22}" stroke="#2c2c2e" stroke-width="1"/>`;
    })
    .join('');

  const svg = `<svg width="800" height="820" xmlns="http://www.w3.org/2000/svg">
    <rect width="800" height="820" fill="#000000"/>
    <rect x="0" y="0" width="800" height="96" fill="#1c1c1e"/>
    <text x="60" y="60" font-family="Helvetica, Arial" font-size="30" font-weight="600" fill="#ffffff">Insights</text>
    <text x="740" y="60" font-family="Helvetica, Arial" font-size="24" fill="#8e8e93" text-anchor="end">@${escape(params.handle)}</text>
    <text x="60" y="160" font-family="Helvetica, Arial" font-size="22" fill="#8e8e93">${escape(params.platform)} · ${escape(params.format)}</text>
    <text x="60" y="200" font-family="Helvetica, Arial" font-size="20" fill="#5a5a5e">Overview</text>
    ${rowSvg}
    <rect x="0" y="760" width="800" height="60" fill="#3a2a10"/>
    <text x="400" y="798" font-family="Helvetica, Arial" font-size="22" font-weight="600" fill="#d9a441" text-anchor="middle">SAMPLE DATA — NOT A REAL SCREENSHOT</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}
