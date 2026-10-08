/**
 * Vite config for the **dev-only** web workbench.
 *
 * `pnpm web` serves the browser app from `src/web/client/` and mounts the
 * core-backed `/api` middleware (the Node half of the web front end) so the
 * browser never touches `node:fs`. Point it at a store with:
 *
 *   SPRITE_FORGE_STORE=/path/to/store pnpm web
 *
 * Not a production build: the tool ships the CLI, not this server.
 */

import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './src/web/server.ts';

const storeRoot = process.env.SPRITE_FORGE_STORE;

function workbenchApi(): Plugin {
  return {
    name: 'sprite-forge-workbench-api',
    configureServer(server) {
      if (!storeRoot) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/')) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                error: 'SPRITE_FORGE_STORE is not set; start with `SPRITE_FORGE_STORE=/path/to/store pnpm web`.',
              }),
            );
            return;
          }
          next();
        });
        return;
      }
      server.middlewares.use(createApiMiddleware(storeRoot));
    },
  };
}

export default defineConfig({
  root: 'src/web/client',
  server: { port: 5173 },
  plugins: [workbenchApi()],
});
