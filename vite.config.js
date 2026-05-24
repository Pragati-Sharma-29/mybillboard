import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages, base should match the repo name when deployed under
// https://<user>.github.io/<repo>/. Override via VITE_BASE if needed.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/mybillboard/',
});
