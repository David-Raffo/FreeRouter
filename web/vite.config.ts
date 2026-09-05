import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // El panel se sirve desde /app/ del propio servidor Fastify.
  base: '/app/',
  server: {
    port: 5173,
    // En desarrollo el panel corre en Vite y habla con el servidor en 8787.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
