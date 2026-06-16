import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Prediction Review MCP UI App — also runs standalone.
export default defineConfig({
  plugins: [react()],
  server: { port: 5184 },
});
