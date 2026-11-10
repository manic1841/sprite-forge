/**
 * Mounts the workbench into the landing page.
 *
 * The page is static, the workbench is not: it reads and writes the store
 * through `/api`, which only exists while `pnpm web` serves this folder. So the
 * mount probes the store first — on a plain static server the section keeps its
 * "start the dev server" notice instead of an empty black box.
 *
 * Kept as `.js` on purpose: the landing page must stay loadable without a
 * bundler, and only this file needs one to reach the TypeScript app.
 */

const shell = document.querySelector('[data-wb-mount]');

if (shell instanceof HTMLElement) {
  const fallback = shell.innerHTML;

  const fail = (reason) => {
    shell.innerHTML = fallback;
    const note = document.createElement('p');
    note.className = 'wb-note';
    note.textContent = reason;
    shell.appendChild(note);
  };

  const start = async () => {
    const probe = await fetch('/api/store', { headers: { accept: 'application/json' } });
    const body = await probe.json().catch(() => ({}));
    if (!probe.ok) {
      throw new Error(body.error ?? `the store could not be read (${probe.status})`);
    }
    if (body.error) {
      throw new Error(body.error);
    }

    const [{ mountWorkbench }, { createApi }] = await Promise.all([
      import('../src/web/client/app.ts'),
      import('../src/web/client/api.ts'),
    ]);

    shell.dataset.live = 'true';
    const workbench = mountWorkbench(shell, { api: createApi() });
    await workbench.ready;
    document.documentElement.dataset.wb = 'live';

    // A visitor meets a cut in progress rather than an empty editor: open the
    // first Recording the store holds (read-only — nothing is written).
    const { recordings } = body;
    if (Array.isArray(recordings) && recordings.length > 0) {
      await workbench.loadRecording(recordings[0].id);
    }
  };

  start().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
