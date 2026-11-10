import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workbenchPage } from '../vite.config.ts';

const site = fileURLToPath(new URL('../site/', import.meta.url));

type Middleware = (
  req: { url?: string },
  res: unknown,
  next: () => void,
) => void;

/** Run the plugin's one middleware in isolation. */
function route(): Middleware {
  const stack: Middleware[] = [];
  const plugin = workbenchPage();
  (plugin as unknown as { configureServer(server: unknown): void }).configureServer({
    middlewares: {
      use: (fn: Middleware) => stack.push(fn),
    },
  });
  return stack[0]!;
}

describe('the workbench is its own page', () => {
  it('rewrites /workbench onto workbench.html', () => {
    const req = { url: '/workbench' };
    route()(req, {}, () => {});
    expect(req.url).toBe('/workbench.html');
  });

  it('keeps the query and accepts a trailing slash', () => {
    const queried = { url: '/workbench?recording=hero' };
    route()(queried, {}, () => {});
    expect(queried.url).toBe('/workbench.html?recording=hero');

    const trailing = { url: '/workbench/?recording=hero' };
    route()(trailing, {}, () => {});
    expect(trailing.url).toBe('/workbench.html?recording=hero');
  });

  it('leaves every other path to Vite', () => {
    const landing = { url: '/' };
    route()(landing, {}, () => {});
    expect(landing.url).toBe('/');

    const api = { url: '/api/store' };
    route()(api, {}, () => {});
    expect(api.url).toBe('/api/store');
  });

  it('serves the app from the standalone document, not the landing page', async () => {
    const workbench = await readFile(`${site}workbench.html`, 'utf8');
    const landing = await readFile(`${site}index.html`, 'utf8');

    expect(workbench).toContain('data-wb-mount');
    expect(workbench).toContain('workbench.js');
    expect(landing).not.toContain('data-wb-mount');
    expect(landing).toContain('href="/workbench"');
  });
});
