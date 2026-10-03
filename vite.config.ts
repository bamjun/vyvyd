import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), {
    // Stage 0 is a development experiment. Do not ship its 28 MB compiler.
    name: 'studio-proof-development-only',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      if (source === './features/studio/StudioProofPanel') return '\0studio-proof-disabled';
    },
    load(id) {
      if (id === '\0studio-proof-disabled') return 'export default function StudioProofDisabled() { return null; }';
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@remotion/browser-bundler'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
