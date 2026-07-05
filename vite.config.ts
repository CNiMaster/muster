import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  resolve: {
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
