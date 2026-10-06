import type { NextConfig } from 'next';

const config: NextConfig = {
  // Next 16's dev server refuses its own JS chunks to hosts it does not
  // recognise, 127.0.0.1 included, and the page then renders but never
  // hydrates — with no browser error. Both names are listed so headless checks
  // that navigate to 127.0.0.1 see the same page a person does.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
