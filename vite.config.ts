import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiPort = Number(process.env.VITE_PORT ?? 4001);
const apiPort = Number(process.env.E2E_SERVER_PORT ?? 4002);

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
