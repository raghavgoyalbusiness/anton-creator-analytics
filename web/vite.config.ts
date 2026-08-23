import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5210,
    strictPort: true,
    proxy: {
      // Keeps the browser same-origin in development, so the magic-link token
      // in the Authorization header never crosses an origin boundary.
      '/api': { target: 'http://localhost:5310', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
