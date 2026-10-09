/**
 * The Node-side half of the web front end.
 *
 * A browser cannot call `node:fs`, so the core (which owns the store) sits behind
 * this thin HTTP/JSON boundary. Every route delegates straight to a core verb —
 * there is no business logic here, and the store stays the single source of truth.
 * The browser half (`./client/`) only speaks to these endpoints.
 *
 * This is **dev-only**: `pnpm web` mounts {@link createApiMiddleware} on the Vite
 * dev server. It is not a production build and ships with the tool.
 *
 * Dependency direction: this module imports core; core never imports it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addSegment,
  appendRepairOperation,
  expandCanvas,
  exportCharacter,
  ForgeError,
  readAssetSheet,
  readCharacterAlignment,
  readClipDraft,
  readDraftAlignment,
  readDraftRepair,
  readDraftRepairFrame,
  readCutList,
  readExportManifest,
  removeSegment,
  sampleDraftRepairColor,
  scan,
  setPlacementOffset,
  setSegmentRange,
  undoRepairOperation,
} from '../core/index.js';
import type { AssetKind, ExportBindings, RepairOperationInput } from '../core/index.js';

/** One request to the workbench API, decoupled from Node's request object. */
export interface ApiRequest {
  /** Upper-case HTTP method, e.g. `GET`. */
  method: string;
  /** Path plus optional query, e.g. `/api/recordings/idle/cuts`. */
  url: string;
  /** Parsed JSON body for write routes; ignored otherwise. */
  body?: unknown;
}

/** One response from the workbench API, decoupled from Node's response object. */
export interface ApiResponse {
  status: number;
  body: unknown;
  /**
   * When set, `body` is raw bytes for a non-JSON response and this is its
   * media type (e.g. a Draft frame served as `image/png`). Absent means JSON.
   */
  contentType?: string;
}

/**
 * Route one API request to a core verb, returning a JSON-serialisable response.
 * Deliberately free of Node's HTTP objects so it can be tested in-process.
 */
export async function handleApiRequest(
  storeRoot: string,
  request: ApiRequest,
): Promise<ApiResponse> {
  const url = new URL(request.url, 'http://workbench.local');
  const { pathname } = url;
  const params = url.searchParams;
  const method = request.method.toUpperCase();
  const segments = pathname.split('/').filter((part) => part.length > 0);

  try {
    // GET /api/store
    if (method === 'GET' && matches(segments, ['api', 'store'])) {
      return ok(await scan(storeRoot));
    }

    // /api/characters/<characterId>/alignment — the Alignment stage's view model.
    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'alignment' &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      return ok(await readCharacterAlignment(storeRoot, { characterId }));
    }

    // /api/characters/<characterId>/expand-canvas — the explicit Character-wide re-bake.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'expand-canvas' &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const body = asRecord(request.body);
      return ok(
        await expandCanvas(storeRoot, {
          characterId,
          width: requiredNumber(body, 'width'),
          height: requiredNumber(body, 'height'),
        }),
      );
    }

    // /api/characters/<characterId>/(clips|sequences)/<assetId>/sheet — the baked strip.
    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      (segments[3] === 'clips' || segments[3] === 'sequences') &&
      segments[5] === 'sheet' &&
      segments.length === 6
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const kind: AssetKind = segments[3] === 'clips' ? 'clip' : 'sequence';
      const id = decodeURIComponent(segments[4]!);
      const sheet = await readAssetSheet(storeRoot, { characterId, kind, id });
      return { status: 200, body: sheet.data, contentType: sheet.contentType };
    }

    // /api/exports/<target>/manifest — the live Export Manifest (Export stage).
    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'exports' &&
      segments[3] === 'manifest' &&
      segments.length === 4
    ) {
      const target = decodeURIComponent(segments[2]!);
      return ok(await readExportManifest(storeRoot, target));
    }

    // /api/characters/<characterId>/exports/<target> — run the export verb.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'exports' &&
      segments.length === 5
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const target = decodeURIComponent(segments[4]!);
      const body = asRecord(request.body);
      const authoredFacing = body.authoredFacing;
      return ok(
        await exportCharacter(storeRoot, {
          characterId,
          target,
          bindings: bindingsRecord(body, 'bindings'),
          ...(body.animations !== undefined
            ? { animations: stringArray(body, 'animations') }
            : {}),
          ...(body.situations !== undefined
            ? { situations: stringArray(body, 'situations') }
            : {}),
          ...(body.flipsFacing !== undefined
            ? { flipsFacing: stringArray(body, 'flipsFacing') }
            : {}),
          ...(authoredFacing === 'right' || authoredFacing === 'left'
            ? { authoredFacing }
            : {}),
          ...(typeof body.exportedAt === 'string' ? { exportedAt: body.exportedAt } : {}),
        }),
      );
    }

    // /api/characters/<characterId>/drafts/<draftId>[/frames/<index>]
    if (
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'drafts' &&
      segments.length >= 5
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const draftId = decodeURIComponent(segments[4]!);

      if (method === 'GET' && segments.length === 5) {
        return ok(await readClipDraft(storeRoot, { characterId, draftId }));
      }
      if (method === 'GET' && segments[5] === 'frames' && segments.length === 7) {
        const index = Number(decodeURIComponent(segments[6]!));
        // The Clip editor shows the repaired result: replay the script on read.
        const frame = await readDraftRepairFrame(storeRoot, { characterId, draftId, index });
        return { status: 200, body: frame.data, contentType: frame.contentType };
      }

      // /api/characters/<c>/drafts/<d>/alignment[/offset]
      if (segments[5] === 'alignment') {
        if (method === 'GET' && segments.length === 6) {
          return ok(await readDraftAlignment(storeRoot, { characterId, draftId }));
        }
        if (method === 'POST' && segments[6] === 'offset' && segments.length === 7) {
          const body = asRecord(request.body);
          return ok(
            await setPlacementOffset(storeRoot, {
              characterId,
              draftId,
              offset: {
                x: requiredNumber(body, 'x'),
                y: requiredNumber(body, 'y'),
              },
            }),
          );
        }
      }

      // /api/characters/<c>/drafts/<d>/repair[/operations|/undo|/sample]
      if (segments[5] === 'repair') {        if (method === 'GET' && segments.length === 6) {
          return ok(await readDraftRepair(storeRoot, { characterId, draftId }));
        }
        if (method === 'POST' && segments[6] === 'operations' && segments.length === 7) {
          const body = asRecord(request.body);
          return ok(
            await appendRepairOperation(storeRoot, {
              characterId,
              draftId,
              operation: body as unknown as RepairOperationInput,
            }),
          );
        }
        if (method === 'POST' && segments[6] === 'undo' && segments.length === 7) {
          return ok(await undoRepairOperation(storeRoot, { characterId, draftId }));
        }
        if (method === 'GET' && segments[6] === 'sample' && segments.length === 7) {
          const color = await sampleDraftRepairColor(storeRoot, {
            characterId,
            draftId,
            index: Number(params.get('frame') ?? '0'),
            x: Number(params.get('x')),
            y: Number(params.get('y')),
          });
          return ok({ color });
        }
      }
    }

    // /api/recordings/<recordingId>/cuts[/<cutId>]
    if (segments[0] === 'api' && segments[1] === 'recordings' && segments[3] === 'cuts') {
      const recordingId = decodeURIComponent(segments[2]!);
      const cutId = segments[4] === undefined ? undefined : decodeURIComponent(segments[4]);

      if (method === 'GET' && cutId === undefined) {
        return ok(await readCutList(storeRoot, recordingId));
      }
      if (method === 'POST' && cutId === undefined) {
        const body = asRecord(request.body);
        return ok(
          await addSegment(storeRoot, {
            recordingId,
            id: requiredString(body, 'id'),
            startFrame: requiredNumber(body, 'startFrame'),
            endFrame: requiredNumber(body, 'endFrame'),
            speed: optionalNumber(body, 'speed'),
          }),
        );
      }
      if (method === 'PATCH' && cutId !== undefined) {
        const body = asRecord(request.body);
        return ok(
          await setSegmentRange(storeRoot, {
            recordingId,
            id: cutId,
            startFrame: requiredNumber(body, 'startFrame'),
            endFrame: requiredNumber(body, 'endFrame'),
          }),
        );
      }
      if (method === 'DELETE' && cutId !== undefined) {
        return ok(await removeSegment(storeRoot, { recordingId, id: cutId }));
      }
    }

    return { status: 404, body: { error: `No route for ${method} ${pathname}` } };
  } catch (error) {
    if (error instanceof ForgeError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}

/** A connect-style middleware, as Vite's dev server consumes. */
export type ApiMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

/**
 * Wrap {@link handleApiRequest} as connect middleware for the Vite dev server.
 * Non-`/api/` requests fall through to Vite (which serves the browser app).
 */
export function createApiMiddleware(storeRoot: string): ApiMiddleware {
  return (req, res, next) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/api/')) {
      next();
      return;
    }
    void dispatch(storeRoot, req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  };
}

async function dispatch(
  storeRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const response = await handleApiRequest(storeRoot, {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    body,
  });
  res.statusCode = response.status;
  if (response.contentType && Buffer.isBuffer(response.body)) {
    res.setHeader('content-type', response.contentType);
    res.end(response.body);
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response.body));
}

/** Read and JSON-parse a request body. An empty body is `undefined`. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length === 0 ? undefined : JSON.parse(text);
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function matches(parts: string[], expected: string[]): boolean {
  return parts.length === expected.length && expected.every((value, i) => parts[i] === value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForgeError('Expected a JSON object body.');
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new ForgeError(`"${key}" must be a string.`);
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ForgeError(`"${key}" must be a number.`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ForgeError(`"${key}" must be a number.`);
  }
  return value;
}

/** Read an array-of-strings body field. */
function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ForgeError(`"${key}" must be an array of strings.`);
  }
  return value as string[];
}

/** Read a Situation -> string[] bindings object. */
function bindingsRecord(body: Record<string, unknown>, key: string): ExportBindings {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForgeError(`"${key}" must be an object of Situation -> animation ids.`);
  }
  const bindings: ExportBindings = {};
  for (const [situation, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new ForgeError(`bindings["${situation}"] must be an array of animation ids.`);
    }
    bindings[situation] = ids as string[];
  }
  return bindings;
}
