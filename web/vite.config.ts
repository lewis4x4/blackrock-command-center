import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Port 5173 conflicts with other Vite projects (e.g. Redex Academy) running
    // on the same host. The Command Center always launches on 5180 unless
    // overridden via `npm run dev -- --port <n>`. strictPort prevents Vite from
    // silently picking a different port and confusing which dashboard is which.
    port: 5180,
    strictPort: true,
  },
});
