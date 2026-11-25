import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const isTauriBuild = process.env.TAURI_ENV_PLATFORM !== undefined;

// `--mode admin` builds the admin app (admin.html) instead of the user app.
export default defineConfig(({ mode }) => {
  const isAdmin = mode === 'admin';
  return {
    plugins: [react(), tailwindcss()],
    // Tauri dev server ports (configured in tauri.conf.json / tauri.admin.conf.json)
    server: {
      port: isAdmin ? 1421 : 1420,
      strictPort: true,
    },
    // Tauri needs relative paths for asset loading
    base: isTauriBuild ? './' : '/',
    ...(isAdmin ? {
      build: {
        outDir: 'dist-admin',
        rollupOptions: { input: 'admin.html' },
      },
    } : {}),
  };
})
