import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works when served by the hub and inside a VS Code webview.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
