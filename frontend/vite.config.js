import { defineConfig } from 'vite';

export default defineConfig({
  // No React plugin — vanilla JS portal
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: 'index.html',
    }
  }
});
