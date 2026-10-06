/**
 * Generates the placeholder 9:16 clips and posters in /public/media.
 *
 * These stand in for real creator content until it exists. Each one is labelled
 * PLACEHOLDER on the frame itself, so nobody mistakes it for a finished asset
 * in a screenshot. To use real media, drop files over these with the same
 * names — the page needs no changes.
 *
 * Needs ffmpeg with libx264, libwebp and drawtext. Point FFMPEG at it if it is
 * not on PATH:  FFMPEG=/path/to/ffmpeg npm run media --workspace @anton/landing
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../public/media');
mkdirSync(out, { recursive: true });

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const font = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(
  existsSync,
);
if (!font) throw new Error('No font found for the placeholder labels; edit `font` in this script.');

/** Warm, muted grounds — content-like, not a rainbow. [background, object, label] */
const PALETTE = [
  ['#D9C7B0', '#8C5A3C', 'Product close-up'],
  ['#C9B8A6', '#3F5A4C', 'Morning routine'],
  ['#E3D5C3', '#B4532A', 'Unboxing'],
  ['#BFC6BC', '#2F3B36', 'Talking to camera'],
  ['#DCCBB8', '#6E4A6B', 'Before and after'],
  ['#CDBBA9', '#1F4D3E', 'Get ready with me'],
  ['#E0D2BF', '#9A3B2E', 'Kitchen demo'],
  ['#C4C0B4', '#37474F', 'Gym bag'],
  ['#D6C6B2', '#5B4636', 'Desk setup'],
  ['#CBBFAF', '#7A2E3B', 'Outfit of the day'],
  ['#DED0BC', '#2E5560', 'Three ways to use it'],
  ['#C7BBAA', '#4B5D2E', 'First impressions'],
];

const W = 360;
const H = 640;
const SECONDS = 6;

PALETTE.forEach(([bg, obj, label], i) => {
  const id = String(i + 1).padStart(2, '0');
  const phase = (i * 0.7).toFixed(2);
  // Every motion has the clip's length as its period, so the loop is seamless.
  const bob = `12*sin(2*PI*t/${SECONDS}+${phase})`;
  const sway = `8*sin(2*PI*t/${SECONDS}+${phase}+1.3)`;

  const filter = [
    // A softly lit surface the object stands on.
    `drawbox=x=0:y=${H * 0.66}:w=${W}:h=${H * 0.34}:color=black@0.06:t=fill`,
    // The "product": a body and a cap, gently bobbing.
    `drawbox=x='${W / 2 - 46}+${sway}':y='${H * 0.36}+${bob}':w=92:h=170:color=${obj}:t=fill`,
    `drawbox=x='${W / 2 - 26}+${sway}':y='${H * 0.36 - 34}+${bob}':w=52:h=38:color=${obj}@0.75:t=fill`,
    `drawbox=x='${W / 2 - 46}+${sway}':y='${H * 0.36 + 70}+${bob}':w=92:h=28:color=white@0.35:t=fill`,
    // Caption strip, as a creator post would have.
    `drawbox=x=20:y=${H - 112}:w=${W - 40}:h=56:color=black@0.28:t=fill`,
    `drawtext=fontfile=${font}:text='${label}':x=34:y=${H - 96}:fontsize=20:fontcolor=white@0.95`,
    // Unmissable placeholder label.
    `drawtext=fontfile=${font}:text='PLACEHOLDER ${id}':x=20:y=22:fontsize=13:fontcolor=black@0.55`,
  ].join(',');

  const mp4 = path.join(out, `clip-${id}.mp4`);
  const poster = path.join(out, `clip-${id}-poster.webp`);

  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=24:d=${SECONDS}`,
    '-vf', filter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-crf', '30', '-preset', 'slow', '-movflags', '+faststart', '-an',
    mp4,
  ]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', mp4, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '72', poster]);
  console.log(`clip-${id}  ${label}`);
});
