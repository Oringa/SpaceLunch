// Run a TypeScript module's default export through Vite's SSR loader (no extra deps).
// Usage: node scripts/run-ts.mjs path/to/module.ts [args...]
import { createServer } from 'vite';
const [, , file, ...args] = process.argv;
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const mod = await server.ssrLoadModule(file);
  await mod.default(args);
} finally {
  await server.close();
}
