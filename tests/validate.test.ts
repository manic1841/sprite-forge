import { describe, expect, it } from 'vitest';
import { ValidationError, validateArtifact, validateStore } from '../src/core/index.js';
import {
  validAssetMeta,
  validCanvas,
  validClipProvenance,
  validCuts,
  withStore,
} from './harness.js';

function issuesOf(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected ValidationError, but validation passed');
}

describe('validateArtifact', () => {
  it('accepts a valid artifact', () => {
    expect(() => validateArtifact('canvas', validCanvas())).not.toThrow();
    expect(() => validateArtifact('cuts', validCuts())).not.toThrow();
    expect(() => validateArtifact('asset-meta', validAssetMeta('walk'))).not.toThrow();
  });

  it('rejects an unknown key (closed objects)', () => {
    const issues = issuesOf(() =>
      validateArtifact('canvas', { ...validCanvas(), extra: 1 }),
    );
    expect(issues.some((i) => /additional properties/i.test(i.message))).toBe(true);
  });

  it('rejects a bad id', () => {
    const issues = issuesOf(() => validateArtifact('asset-meta', validAssetMeta('Walk')));
    expect(issues.some((i) => i.path === '/id')).toBe(true);
  });

  it('rejects a malformed hash', () => {
    const issues = issuesOf(() => validateArtifact('cuts', { ...validCuts(), hash: 'sha256:nope' }));
    expect(issues.some((i) => i.path === '/hash')).toBe(true);
  });

  it('rejects a canvas whose Anchor is not the bottom-centre (symmetry invariant)', () => {
    const issues = issuesOf(() =>
      validateArtifact('canvas', { width: 60, height: 84, anchor: { x: 31, y: 84 } }),
    );
    expect(issues.some((i) => i.path === '/anchor/x')).toBe(true);

    const issues2 = issuesOf(() =>
      validateArtifact('canvas', { width: 60, height: 84, anchor: { x: 30, y: 83 } }),
    );
    expect(issues2.some((i) => i.path === '/anchor/y')).toBe(true);
  });

  it('rejects delaysMs whose length is neither 1 nor frameCount', () => {
    const issues = issuesOf(() =>
      validateArtifact('asset-meta', { id: 'walk', frameCount: 4, delaysMs: [50, 60], loop: true }),
    );
    expect(issues.some((i) => i.path === '/delaysMs')).toBe(true);
  });

  it('rejects an asset id that does not equal its folder name', () => {
    const issues = issuesOf(() =>
      validateArtifact('asset-meta', validAssetMeta('walk'), { folderId: 'run' }),
    );
    expect(issues.some((i) => i.path === '/id')).toBe(true);
  });
});

describe('validateStore', () => {
  it('accepts a store of valid artifacts', async () => {
    await withStore(async (store) => {
      store.writeJson('recordings/mgba-2026-09/cuts.json', validCuts());
      store.writeJson('characters/hero/canvas.json', validCanvas());
      store.writeJson('characters/hero/clips/walk/meta.json', validAssetMeta('walk'));
      store.writeJson('characters/hero/clips/walk/provenance.json', validClipProvenance());
      store.writeJson('characters/hero/repairs/walk/repair.json', { operations: [] });
      await expect(validateStore(store.root)).resolves.toBeDefined();
    });
  });

  it('fails hard on a store containing an invalid artifact', async () => {
    await withStore(async (store) => {
      store.writeJson('characters/hero/canvas.json', { width: 60, height: 84, anchor: { x: 31, y: 84 } });
      const failure = await validateStore(store.root).catch((error) => error);
      expect(failure).toBeInstanceOf(ValidationError);
      expect((failure as ValidationError).issues.length).toBeGreaterThan(0);
    });
  });

  it('reports every failing artifact, not just the first', async () => {
    await withStore(async (store) => {
      store.writeJson('characters/hero/canvas.json', { width: 60, height: 84, anchor: { x: 31, y: 84 } });
      store.writeJson('characters/hero/clips/walk/meta.json', { ...validAssetMeta('walk'), extra: true });
      const failure = (await validateStore(store.root).catch((error) => error)) as ValidationError;
      const artifacts = new Set(failure.issues.map((i) => i.artifact));
      expect(artifacts.size).toBeGreaterThanOrEqual(2);
    });
  });
});
