import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The React app. Built to static files that the client's own server hands out.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // For `vite dev` inside the dev container: the API is the client's server.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
