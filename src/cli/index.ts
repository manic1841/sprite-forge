#!/usr/bin/env node
/**
 * `forge` — the CLI front end.
 *
 * A thin adapter: it parses arguments, calls the core verbs, renders the result,
 * and exits non-zero on a hard error. It must never reimplement core logic.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  createCharacter,
  ForgeError,
  ingestRecording,
  scan,
  validateStore,
  ValidationError,
} from '../core/index.js';

const USAGE = `forge — sprite-forge CLI

Usage:
  forge scan             --store <path>                              List the store's Recordings, Characters and Exports.
  forge validate         --store <path>                              Validate every artifact in the store.
  forge ingest           --store <path> --source <file> --id <id>    Register a raw capture as a Recording.
  forge create-character --store <path> --id <id> --width <n> --height <n> --anchor-x <n> --anchor-y <n>
                                                                     Create a Character and its Canvas/Anchor.`;

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  let store: string | undefined;
  let source: string | undefined;
  let id: string | undefined;
  let width: string | undefined;
  let height: string | undefined;
  let anchorX: string | undefined;
  let anchorY: string | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', short: 's' },
        source: { type: 'string' },
        id: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        'anchor-x': { type: 'string' },
        'anchor-y': { type: 'string' },
      },
    });
    store = values.store;
    source = values.source;
    id = values.id;
    width = values.width;
    height = values.height;
    anchorX = values['anchor-x'];
    anchorY = values['anchor-y'];
  } catch (error) {
    return fail((error as Error).message);
  }

  if (!store) {
    return fail('--store <path> is required');
  }

  switch (command) {
    case 'scan':
      return runScan(store);
    case 'validate':
      return runValidate(store);
    case 'ingest':
      return runIngest(store, source, id);
    case 'create-character':
      return runCreateCharacter(store, id, width, height, anchorX, anchorY);
    default:
      return fail(command ? `unknown command "${command}"` : 'no command given', USAGE);
  }
}

async function runScan(store: string): Promise<number> {
  try {
    const tree = await scan(store);
    process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

async function runValidate(store: string): Promise<number> {
  try {
    const report = await validateStore(store);
    process.stdout.write(`OK: validated ${report.artifacts.length} artifact(s)\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

async function runIngest(store: string, source?: string, id?: string): Promise<number> {
  if (!source) {
    return fail('--source <file> is required for ingest');
  }
  if (!id) {
    return fail('--id <recording-id> is required for ingest');
  }
  try {
    const recording = await ingestRecording(store, { recordingId: id, sourcePath: source });
    process.stdout.write(`${JSON.stringify(recording, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

async function runCreateCharacter(
  store: string,
  id?: string,
  width?: string,
  height?: string,
  anchorX?: string,
  anchorY?: string,
): Promise<number> {
  if (!id) {
    return fail('--id <character-id> is required for create-character');
  }
  const widthPx = integerArg(width);
  const heightPx = integerArg(height);
  const anchorXPx = integerArg(anchorX);
  const anchorYPx = integerArg(anchorY);
  if (
    widthPx === undefined ||
    heightPx === undefined ||
    anchorXPx === undefined ||
    anchorYPx === undefined
  ) {
    return fail('--width, --height, --anchor-x and --anchor-y integers are required for create-character');
  }
  try {
    const created = await createCharacter(store, {
      characterId: id,
      width: widthPx,
      height: heightPx,
      anchor: { x: anchorXPx, y: anchorYPx },
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Parse a CLI integer option; `undefined` when absent or not an integer. */
function integerArg(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function failForgeError(error: unknown): number {
  if (error instanceof ValidationError || error instanceof ForgeError) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  throw error;
}

function fail(message: string, usage?: string): number {
  process.stderr.write(`error: ${message}\n`);
  if (usage) {
    process.stderr.write(`${usage}\n`);
  }
  return 1;
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
