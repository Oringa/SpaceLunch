import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The build uses a relative base ("./") by default so the static output can be
// served from any sub-path, e.g. https://alonoring.com/centrifuge/ , without a
// rebuild. Set BASE_PATH (e.g. "/centrifuge/") to emit absolute asset URLs.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
