import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/client',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react()],
  resolve: {
    // Worktrees can otherwise prebundle React separately for routed lazy pages,
    // leaving React Router with a different hook dispatcher in dev mode.
    dedupe: ['react', 'react-dom', 'react-router-dom'],
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@client': resolve(__dirname, 'src/client'),
    },
  },
  server: {
    middlewareMode: false,
  },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          flow: ['@xyflow/react'],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  appType: 'spa',
});
