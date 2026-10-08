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
  ForgeError,
  readCutList,
  removeSegment,
  scan,
  setSegmentRange,
} from '../core/index.js';

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
}

/**
 * Route one API request to a core verb, returning a JSON-serialisable response.
 * Deliberately free of Node's HTTP objects so it can be tested in-process.
 */
export async function handleApiRequest(
  storeRoot: string,
  request: ApiRequest,
): Promise<ApiResponse> {
  const { pathname } = new URL(request.url, 'http://workbench.local');
  const method = request.method.toUpperCase();
  const segments = pathname.split('/').filter((part) => part.length > 0);

  try {
    // GET /api/store
    if (method === 'GET' && matches(segments, ['api', 'store'])) {
      return ok(await scan(storeRoot));
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
