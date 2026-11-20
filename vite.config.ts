import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const DEFAULT_ALLOWED_HOSTS = ['localhost', '.localhost', '127.0.0.1', '::1'];

export function resolveViteHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AIRBRIDGE_VITE_HOST?.trim();
  if (explicit) return explicit;
  return env.AIRBRIDGE_LAN_DEV === '1' ? '0.0.0.0' : '127.0.0.1';
}

export function resolveViteAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  const raw = env.AIRBRIDGE_VITE_ALLOWED_HOSTS;
  if (raw) {
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'true') continue;
      hosts.add(trimmed);
    }
  }
  return Array.from(hosts);
}

const host = resolveViteHost();
const allowedHosts = resolveViteAllowedHosts();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Build version of the UI bundle; compared with the server's version so a
  // long-lived app window reloads after an update (see buildInfo.ts).
  define: {
    __AIRBRIDGE_UI_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host,
    allowedHosts,
  },
  preview: {
    host,
    allowedHosts,
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
  },
});
