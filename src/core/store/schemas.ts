/**
 * Loading the tool's own JSON Schemas.
 *
 * The schemas live at the **repo root** in `schemas/` and are deliberately not
 * vendored into any store (ADR-0010) — a store is data, not a program. This is
 * therefore part of the IO boundary, not store data.
 *
 * The path is derived from this module's own location, so it resolves identically
 * whether the code runs from `src/` (tsx, vitest) or `dist/` (built CLI): both
 * sit three directories below the repo root.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The schema files, keyed by the artifact kind they validate. */
export type SchemaName =
  | 'cuts'
  | 'canvas'
  | 'asset.meta'
  | 'clip.provenance'
  | 'sequence.provenance'
  | 'repair'
  | 'export.manifest';

const SCHEMA_DIR = fileURLToPath(new URL('../../../schemas/', import.meta.url));

/** Read (and parse) a schema file from the repo's `schemas/` directory. */
export function readSchemaSource(name: SchemaName): unknown {
  const file = path.join(SCHEMA_DIR, `${name}.schema.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
