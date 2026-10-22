import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Outside AppDeploy (CI, local dev) the platform client is not installed.
const useLocalClient = process.env.MONOLITH_LOCAL_CLIENT === '1';

export default defineConfig({
  plugins: [react()],
  resolve: useLocalClient
    ? {
        alias: {
          '@appdeploy/client': fileURLToPath(
            new URL('./src/platform/appdeploy-client-local.ts', import.meta.url)
          ),
        },
      }
    : undefined,
  base: './',
  build: {
    outDir: process.env.APPDEPLOY_VITE_OUT_DIR || 'dist',
    sourcemap:
      process.env.APPDEPLOY_VITE_SOURCEMAP === 'hidden' ? 'hidden' : false,
    rollupOptions: {
      maxParallelFileOps: 128,
    },
  },
});
