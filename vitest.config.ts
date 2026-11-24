import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// "cloudflare:workers" só existe na Cloudflare; nos testes entra um substituto mínimo.
export default defineConfig({
  test: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
});
