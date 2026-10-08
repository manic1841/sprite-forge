#!/usr/bin/env node
/**
 * `forge` — the CLI front end.
 *
 * A thin adapter: it parses arguments, calls the core verbs, renders the result,
 * and exits non-zero on a hard error. It must never reimplement core logic.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ForgeError, ingestRecording, scan, validateStore, ValidationError } from '../core/index.js';

const USAGE = `forge — sprite-forge CLI

Usage:
  forge scan     --store <path>                              List the store's Recordings, Characters and Exports.
  forge validate --store <path>                              Validate every artifact in the store.
  forge ingest   --store <path> --source <file> --id <id>    Register a raw capture as a Recording.`;

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  let store: string | undefined;
  let source: string | undefined;
  let id: string | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', short: 's' },
        source: { type: 'string' },
        id: { type: 'string' },
      },
    });
    store = values.store;
    source = values.source;
    id = values.id;
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
