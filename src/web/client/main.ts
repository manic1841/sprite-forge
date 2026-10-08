/**
 * Browser entry point for the sprite-forge workbench (dev-only).
 *
 * `pnpm web` starts the Vite dev server, which serves this app and mounts the
 * core-backed `/api` middleware (`src/web/server.ts`). Point it at a store with
 * `SPRITE_FORGE_STORE=/path/to/store pnpm web`.
 */

import { mountWorkbench } from './app.js';
import { createApi } from './api.js';
import './style.css';

const container = document.getElementById('app');
if (container) {
  mountWorkbench(container, { api: createApi() });
}
