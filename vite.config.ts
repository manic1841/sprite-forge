/**
 * Vite config for the **dev-only** site + workbench.
 *
 * The root is `site/`, so the landing page (`/`) and the workbench (`/workbench`)
 * share one origin: the workbench's `/api` calls and its modules resolve on the
 * same server, so the tool runs as its own page without a second dev server.
 * The Node half (`src/web/server.ts`) is mounted as middleware so the browser
 * never touches `node:fs`. Point it at a store with:
 *
 *   SPRITE_FORGE_STORE=/path/to/store pnpm web
 *
 * Without the variable it uses `store/` under the working directory and creates
 * it when missing, the same default the CLI documents (ADR-0011).
 *
 * Not a production build: the tool ships the CLI, not this server.
 */

import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './src/web/server.ts';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * The store root: `SPRITE_FORGE_STORE` when set, else `store/` under the working
 * directory — the same default the CLI uses, so an unconfigured `pnpm web` opens
 * the in-repo store instead of refusing to start.
 */
export function storePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return resolve(cwd, env.SPRITE_FORGE_STORE ?? 'store');
}

/**
 * The root is `site/`, but the workbench's modules live in `src/`. A URL outside
 * the root falls back to the page, so `/src/...` would answer with HTML: rewrite
 * it to Vite's `/@fs/` form, which is the one way it serves a file from outside
 * the root. The page can then keep plain relative `../src/...` links.
 */
function outsideRootModules(): Plugin {
  return {
    name: 'sprite-forge-outside-root-modules',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/src/')) {
          req.url = `/@fs${projectRoot}${req.url.slice(1)}`;
        }
        next();
      });
    },
  };
}

const types: Record<string, string> = {
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * `/assets/` is the kit's own directory (stylesheets, `system.js`, fragments).
 * Vite would run those files through its JS transform, which rewrites
 * `new URL('./', import.meta.url)` to a slash-less `new URL("/assets", …)`; every
 * later `new URL('ui/ui.js', HERE)` then resolves against `/assets` *as a file*
 * and lands on the page's `/ui/ui.js`, i.e. a 404. They never need compiling, so
 * serve them byte-for-byte instead and leave `import.meta.url` alone.
 */
function rawKitAssets(): Plugin {
  const root = `${projectRoot}site/assets/`;
  return {
    name: 'sprite-forge-raw-kit-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/assets/')) {
          next();
          return;
        }
        const file = `${root}${url.slice('/assets/'.length)}`;
        if (!file.startsWith(root)) {
          next();
          return;
        }
        stat(file).then(
          (info) => {
            if (!info.isFile()) {
              next();
              return;
            }
            res.statusCode = 200;
            res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
            res.setHeader('content-length', String(info.size));
            res.setHeader('cache-control', 'no-cache');
            createReadStream(file).pipe(res);
          },
          () => next(),
        );
      });
    },
  };
}

/**
 * The workbench is a page of its own at `/workbench`; Vite only serves the file
 * by its literal name, so rewrite the clean route onto `workbench.html`. The
 * query string is kept. Links can then be plain `/workbench` everywhere.
 */
export function workbenchPage(): Plugin {
  return {
    name: 'sprite-forge-workbench-page',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? '/').split('?');
        if (path === '/workbench' || path === '/workbench/') {
          req.url = `/workbench.html${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
  };
}

function workbenchApi(): Plugin {
  return {
    name: 'sprite-forge-workbench-api',
    async configureServer(server) {
      const storeRoot = storePath();
      await mkdir(storeRoot, { recursive: true });
      server.config.logger.info(`sprite-forge store: ${storeRoot}`);
      const api = createApiMiddleware(storeRoot);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          next();
          return;
        }
        api(req, res, next);
      });
    },
  };
}

export default defineConfig({
  root: 'site',
  server: { port: 5173, fs: { allow: [projectRoot] } },
  plugins: [workbenchPage(), rawKitAssets(), outsideRootModules(), workbenchApi()],
});
