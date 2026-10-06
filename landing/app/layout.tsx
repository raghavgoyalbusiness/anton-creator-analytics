import type { Metadata, Viewport } from 'next';
import { Geist, Instrument_Serif } from 'next/font/google';
import { site } from '@/content/landing';
import './globals.css';

/*
 * Fonts are self-hosted by next/font at build time: no request to Google at
 * runtime and no render-blocking stylesheet. Only the faces the page actually
 * uses are declared — the serif in roman and italic, the sans as a variable
 * font.
 */
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});
const sans = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });

export const metadata: Metadata = {
  title: `${site.name} — ${site.tagline}`,
  description:
    'Match with small creators who fit your brand, run the campaign, and see which posts sold — with every number traced to its source.',
};

export const viewport: Viewport = {
  themeColor: '#f6f2ea',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
