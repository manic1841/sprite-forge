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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addSegment,
  appendRepairOperation,
  commitDraft,
  commitSequence,
  createCharacter,
  deleteAsset,
  deriveAnchor,
  discardDraft,
  exportCharacter,
  extractClipDraft,
  fitCanvasToContent,
  ForgeError,
  forkAsset,
  frameCanvasFromSegment,
  ingestRecording,
  listSequenceDrafts,
  readAssetSheet,
  readCharacterAlignment,
  readClip,
  readClipDraft,
  readDraftAlignment,
  readDraftRepair,
  readDraftRepairFrame,
  readCutList,
  readExportManifest,
  readRecordingDelays,
  readRecordingFrame,
  readSequence,
  readSequenceDraft,
  removeSegment,
  removeSequenceDraft,
  renameSegment,
  resizeCanvas,
  sampleDraftRepairColor,
  saveSequenceDraft,
  scan,
  segmentContentBounds,
  setPlacementOffset,
  setSegmentRange,
  setSegmentRect,
  undoRepairOperation,
  validateStore,
  ValidationError,
  verifyReproducible,
  withStoreLock,
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

    // GET /api/validate — the whole store's validation report.
    //
    // `validateStore` throws on the first invalid artifact set; the workbench wants
    // the whole picture, so the failure is normalised into the same report shape
    // instead of becoming a 500.
    if (method === 'GET' && matches(segments, ['api', 'validate'])) {
      try {
        const report = await validateStore(storeRoot);
        return ok({ ok: true, root: report.root, artifactCount: report.artifacts.length, problems: [] });
      } catch (error) {
        if (error instanceof ValidationError) {
          return ok({
            ok: false,
            root: storeRoot,
            artifactCount: 0,
            problems: error.issues.map((issue) => ({
              artifact: issue.artifact,
              path: issue.path,
              message: issue.message,
            })),
          });
        }
        throw error;
      }
    }

    // GET /api/characters/<characterId>/<kind>/<assetId>/reproducible
    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      (segments[3] === 'clips' || segments[3] === 'sequences') &&
      segments[5] === 'reproducible'
    ) {
      return ok(
        await verifyReproducible(storeRoot, {
          characterId: decodeURIComponent(segments[2]!),
          kind: segments[3] === 'clips' ? 'clip' : 'sequence',
          id: decodeURIComponent(segments[4]!),
        }),
      );
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

    // /api/characters/<characterId>/resize-canvas — the explicit Character-wide
    // re-bake, in either direction (down to the content floor).
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      (segments[3] === 'resize-canvas' || segments[3] === 'expand-canvas') &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const body = asRecord(request.body);
      return ok(
        await resizeCanvas(storeRoot, {
          characterId,
          width: requiredNumber(body, 'width'),
          height: requiredNumber(body, 'height'),
        }),
      );
    }

    // /api/characters/<characterId>/fit-canvas — shrink to the content floor.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'fit-canvas' &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      return ok(await fitCanvasToContent(storeRoot, { characterId }));
    }

    // /api/characters/<characterId>/frame-canvas — frame a blank Character from a
    // Segment (replaces the provisional Canvas; a drawn Character is resized).
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'frame-canvas' &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const body = asRecord(request.body);
      const cutId = requiredOptionalString(body, 'cutId');
      return ok(
        await frameCanvasFromSegment(storeRoot, {
          characterId,
          recordingId: requiredString(body, 'recordingId'),
          ...(cutId === undefined ? {} : { cutId }),
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

    // POST /api/recordings — ingest an uploaded capture as a Recording.
    if (method === 'POST' && matches(segments, ['api', 'recordings'])) {
      const body = asRecord(request.body);
      return { status: 201, body: await ingestUploaded(storeRoot, body) };
    }

    // GET /api/recordings/<recordingId>/frames/<index> — a preview frame.
    if (
      method === 'GET' &&
      segments[0] === 'api' &&
      segments[1] === 'recordings' &&
      segments[3] === 'frames' &&
      segments[4] !== undefined
    ) {
      const recordingId = decodeURIComponent(segments[2]!);
      const frame = await readRecordingFrame(storeRoot, {
        recordingId,
        index: Number(segments[4]),
      });
      return { status: 200, body: frame.data, contentType: frame.contentType };
    }

    // GET /api/recordings/<recordingId>/delays — per-frame delays for playback.
    if (
      method === 'GET' &&
      matches(segments, ['api', 'recordings', segments[2] ?? '', 'delays'])
    ) {
      const recordingId = decodeURIComponent(segments[2]!);
      return ok(await readRecordingDelays(storeRoot, recordingId));
    }

    // GET /api/recordings/<recordingId>/cuts/<cutId>/content — the tight box the
    // Segment draws, in source pixels; `null` when it draws nothing.
    if (
      method === 'GET' &&
      matches(segments, ['api', 'recordings', segments[2] ?? '', 'cuts', segments[4] ?? '', 'content'])
    ) {
      return ok(
        await segmentContentBounds(storeRoot, {
          recordingId: decodeURIComponent(segments[2]!),
          cutId: decodeURIComponent(segments[4]!),
        }),
      );
    }

    // GET /api/recordings/<recordingId>/anchor?cut=<cutId> — preview a derived Canvas.
    if (
      method === 'GET' &&
      matches(segments, ['api', 'recordings', segments[2] ?? '', 'anchor'])
    ) {
      const recordingId = decodeURIComponent(segments[2]!);
      const cutId = params.get('cut') ?? undefined;
      return ok(
        await deriveAnchor(storeRoot, {
          recordingId,
          ...(cutId === undefined ? {} : { cutId }),
        }),
      );
    }

    // POST /api/characters — create a Character. A body without a Canvas starts it
    // on the provisional blank Canvas; framing is derived or expanded afterwards.
    if (method === 'POST' && matches(segments, ['api', 'characters'])) {
      const body = asRecord(request.body);
      const width = optionalNumber(body, 'width');
      const height = optionalNumber(body, 'height');
      const anchorX = optionalNumber(body, 'anchorX');
      const anchorY = optionalNumber(body, 'anchorY');
      const canvas =
        width === undefined || height === undefined
          ? {}
          : {
              width,
              height,
              anchor: { x: anchorX ?? width / 2, y: anchorY ?? height },
            };
      return {
        status: 201,
        body: await createCharacter(storeRoot, {
          characterId: requiredString(body, 'id'),
          ...canvas,
        }),
      };
    }

    // POST /api/characters/<characterId>/drafts — extract a Segment into a Draft.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'drafts' &&
      segments.length === 4
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const body = asRecord(request.body);
      return {
        status: 201,
        body: await extractClipDraft(storeRoot, {
          characterId,
          recordingId: requiredString(body, 'recordingId'),
          cutId: requiredString(body, 'cutId'),
          draftId: requiredOptionalString(body, 'draftId'),
          background: requiredOptionalString(body, 'background'),
          tolerance: optionalNumber(body, 'tolerance'),
          loop: body['loop'] === undefined ? undefined : body['loop'] === true,
        }),
      };
    }

    // POST /api/characters/<characterId>/drafts/<draftId>/commit — bake a Clip.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'drafts' &&
      segments[5] === 'commit'
    ) {
      const body = asRecord(request.body);
      return {
        status: 201,
        body: await commitDraft(storeRoot, {
          characterId: decodeURIComponent(segments[2]!),
          draftId: decodeURIComponent(segments[4]!),
          assetId: requiredString(body, 'name'),
          kind: 'clip',
        }),
      };
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
        const rect = optionalRect(body, 'rect');
        return ok(
          await addSegment(storeRoot, {
            recordingId,
            id: requiredString(body, 'id'),
            startFrame: requiredNumber(body, 'startFrame'),
            endFrame: requiredNumber(body, 'endFrame'),
            speed: optionalNumber(body, 'speed'),
            ...(rect === undefined || rect === null ? {} : { rect }),
          }),
        );
      }
      if (method === 'PATCH' && cutId !== undefined) {
        const body = asRecord(request.body);
        let cutList = await readCutList(storeRoot, recordingId);
        // The range and the box are edited by the same verb: a Segment is one
        // piece of footage, and the inspector may change either.
        if ('startFrame' in body || 'endFrame' in body) {
          const current = cutList.cuts.find((cut) => cut.id === cutId);
          cutList = await setSegmentRange(storeRoot, {
            recordingId,
            id: cutId,
            startFrame:
              'startFrame' in body
                ? requiredNumber(body, 'startFrame')
                : (current?.startFrame ?? requiredNumber(body, 'startFrame')),
            endFrame:
              'endFrame' in body
                ? requiredNumber(body, 'endFrame')
                : (current?.endFrame ?? requiredNumber(body, 'endFrame')),
          });
        }
        const rect = optionalRect(body, 'rect');
        if (rect !== undefined) {
          cutList = await setSegmentRect(storeRoot, {
            recordingId,
            id: cutId,
            rect: rect === null ? undefined : rect,
          });
        }
        return ok(cutList);
      }
      if (method === 'DELETE' && cutId !== undefined) {
        return ok(await removeSegment(storeRoot, { recordingId, id: cutId }));
      }
    }

    // /api/characters/<characterId>/<clips|sequences>/<assetId>[/fork]
    if (
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      (segments[3] === 'clips' || segments[3] === 'sequences') &&
      segments.length >= 5
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const kind = segments[3] === 'clips' ? 'clip' : 'sequence';
      const id = decodeURIComponent(segments[4]!);

      if (method === 'GET' && segments.length === 5 && kind === 'clip') {
        return ok(await readClip(storeRoot, { characterId, clipId: id }));
      }
      if (method === 'GET' && segments.length === 5) {
        return ok(await readSequence(storeRoot, { characterId, sequenceId: id }));
      }
      if (method === 'DELETE' && segments.length === 5) {
        await deleteAsset(storeRoot, { characterId, kind, id });
        return ok({ deleted: id });
      }
      if (method === 'POST' && segments[5] === 'fork' && segments.length === 6) {
        const body = asRecord(request.body);
        const draftId = requiredOptionalString(body, 'draftId');
        const forked =
          kind === 'clip'
            ? await forkAsset(storeRoot, { characterId, kind: 'clip', id, draftId })
            : await forkAsset(storeRoot, { characterId, kind: 'sequence', id, draftId });
        return { status: 201, body: forked };
      }
    }

    // POST /api/characters/<characterId>/sequences — concatenate Clips into a Sequence.
    // A `draftId` names the Sequence draft the composition came from; it is
    // removed once the Asset is on disk, the same way a Clip Draft is consumed.
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'sequences' &&
      segments.length === 4
    ) {
      const body = asRecord(request.body);
      const characterId = decodeURIComponent(segments[2]!);
      const draftId = requiredOptionalString(body, 'draftId');
      const forkOf = requiredOptionalString(body, 'forkOf');
      const committed = await commitSequence(storeRoot, {
        characterId,
        sequenceId: requiredString(body, 'name'),
        clips: requiredStringArray(body, 'clips'),
        derivedFrom: forkOf === undefined ? undefined : { kind: 'sequence', id: forkOf },
      });
      if (draftId !== undefined) {
        await removeSequenceDraft(storeRoot, { characterId, draftId });
      }
      return { status: 201, body: committed };
    }

    // /api/characters/<characterId>/sequence-drafts[/<draftId>]
    if (
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'sequence-drafts'
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      const draftId = segments[4] === undefined ? undefined : decodeURIComponent(segments[4]);

      if (method === 'GET' && draftId === undefined) {
        return ok({ drafts: await listSequenceDrafts(storeRoot, characterId) });
      }
      if (method === 'GET' && draftId !== undefined) {
        return ok(await readSequenceDraft(storeRoot, { characterId, draftId }));
      }
      if (method === 'POST' && draftId === undefined) {
        const body = asRecord(request.body);
        return {
          status: 201,
          body: await saveSequenceDraft(storeRoot, {
            characterId,
            draftId: requiredOptionalString(body, 'draftId'),
            clips: requiredStringArray(body, 'clips'),
            forkOf: requiredOptionalString(body, 'forkOf') ?? null,
          }),
        };
      }
      if (method === 'DELETE' && draftId !== undefined) {
        await removeSequenceDraft(storeRoot, { characterId, draftId });
        return ok({ discarded: draftId });
      }
    }

    // POST /api/characters/<characterId>/drafts/<draftId>/discard
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'characters' &&
      segments[3] === 'drafts' &&
      segments[5] === 'discard'
    ) {
      const characterId = decodeURIComponent(segments[2]!);
      await discardDraft(storeRoot, { characterId, draftId: decodeURIComponent(segments[4]!) });
      return ok({ discarded: decodeURIComponent(segments[4]!) });
    }

    // POST /api/recordings/<recordingId>/cuts/<cutId>/rename
    if (
      method === 'POST' &&
      segments[0] === 'api' &&
      segments[1] === 'recordings' &&
      segments[3] === 'cuts' &&
      segments[5] === 'rename'
    ) {
      const body = asRecord(request.body);
      return ok(
        await renameSegment(storeRoot, {
          recordingId: decodeURIComponent(segments[2]!),
          id: decodeURIComponent(segments[4]!),
          newId: requiredString(body, 'newId'),
        }),
      );
    }

    return { status: 404, body: { error: `No route for ${method} ${pathname}` } };
  } catch (error) {
    if (error instanceof ForgeError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}

/**
 * Ingest a recording whose bytes arrived in the request body.
 *
 * A browser cannot hand the core a filesystem path, so the upload's base64
 * payload is written to a throwaway file, handed to `ingestRecording` (which
 * owns the copy, the hash and the metadata read), then removed. The store stays
 * the only place a Recording ends up.
 */
async function ingestUploaded(
  storeRoot: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const id = requiredString(body, 'id');
  const encoded = requiredString(body, 'dataBase64');
  // The extension only names the temp file; `sharp` sniffs the real format.
  const suffix = path.extname(requiredOptionalString(body, 'filename') ?? '') || '.gif';

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) {
    throw new ForgeError('"dataBase64" must decode to at least one byte.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'sprite-forge-upload-'));
  try {
    const file = path.join(dir, `upload${suffix}`);
    await writeFile(file, bytes);
    return await ingestRecording(storeRoot, { recordingId: id, sourcePath: file });
  } finally {
    await rm(dir, { recursive: true, force: true });
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
  const method = req.method ?? 'GET';
  const request = { method, url: req.url ?? '/', body };
  // Mutations are queued per store. Each route does its own read-modify-write, so
  // two of them arriving together would both read the old file and one edit would
  // be lost (the "edit X then Y saves (0, 2)" bug). Reads are never queued.
  const response =
    method === 'GET' || method === 'HEAD'
      ? await handleApiRequest(storeRoot, request)
      : await withStoreLock(storeRoot, () => handleApiRequest(storeRoot, request));
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

function requiredOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ForgeError(`"${key}" must be a string.`);
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

/**
 * Read a box body field: `{x, y, width, height}`.
 *
 * The `null` answer is meaningful — the key being present but nul means "clear
 * the box", while the key being absent means "leave it alone".
 */
function optionalRect(
  body: Record<string, unknown>,
  key: string,
): { x: number; y: number; width: number; height: number } | null | undefined {
  if (!(key in body) || body[key] === undefined) {
    return undefined;
  }
  const value = body[key];
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  return {
    x: requiredNumber(record, 'x'),
    y: requiredNumber(record, 'y'),
    width: requiredNumber(record, 'width'),
    height: requiredNumber(record, 'height'),
  };
}

/** Read an array-of-strings body field. */
function stringArray(body: Record<string, unknown>, key: string): string[] {  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ForgeError(`"${key}" must be an array of strings.`);
  }
  return value as string[];
}

/** Read a required array-of-strings body field (a Sequence's source Clip list). */
function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  if (body[key] === undefined) {
    throw new ForgeError(`"${key}" is required.`);
  }
  return stringArray(body, key);
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
