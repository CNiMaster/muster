import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist/server',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Bundle Node-native deps (better-sqlite3) and external workspace deps.
  external: ['better-sqlite3', 'express', 'ws', 'zod', 'vite', '@vitejs/plugin-react', 'lightningcss'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
