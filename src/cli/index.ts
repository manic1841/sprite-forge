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
  addSegment,
  commitDraft,
  commitSequence,
  createCharacter,
  extractClipDraft,
  ForgeError,
  forkAsset,
  ingestRecording,
  readCutList,
  removeSegment,
  renameSegment,
  scan,
  validateStore,
  ValidationError,
} from '../core/index.js';
import type { AssetKind, CutList } from '../core/index.js';

const USAGE = `forge — sprite-forge CLI

Usage:
  forge scan             --store <path>                              List the store's Recordings, Characters and Exports.
  forge validate         --store <path>                              Validate every artifact in the store.
  forge ingest           --store <path> --source <file> --id <id>    Register a raw capture as a Recording.
  forge create-character --store <path> --id <id> --width <n> --height <n> --anchor-x <n> --anchor-y <n>
                                                                     Create a Character and its Canvas/Anchor.
  forge cut              --store <path> --recording <id> --action <add|rename|remove|list> [options]
                                                                     Edit a Recording's Segment cut list.
       add:    --id <cut-id> --start <n> --end <n> [--speed <n>]
       rename: --id <cut-id> --new-id <new-id>
       remove: --id <cut-id>
       list:   (no further options)
  forge extract          --store <path> --character <id> --recording <id> --cut <id> [options]
                                                                     Extract a Segment into a Clip Draft.
       --draft <id>          Draft id (defaults to the cut id)
       --background <#rrggbb>  Explicit background override (default: corner-sampled)
       --tolerance <n>       Per-channel key tolerance (default: 24)
       --no-loop             Do not loop the Draft
  forge commit           --store <path> --character <id> --draft <id> --name <asset-id> [--kind <clip>]
                                                                     Commit a Draft into an immutable Clip.
  forge commit           --store <path> --character <id> --name <sequence-id> --kind sequence --clips <a,b,c> [--fork-from <seq-id>]
                                                                     Concatenate committed Clips into a Sequence.
  forge fork             --store <path> --character <id> --kind <clip|sequence> --id <asset-id> [--draft <id>]
                                                                     Open a Clip as a Draft, or a Sequence as its ordered Clip list.`;

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
  let recording: string | undefined;
  let action: string | undefined;
  let start: string | undefined;
  let end: string | undefined;
  let speed: string | undefined;
  let newId: string | undefined;
  let character: string | undefined;
  let cut: string | undefined;
  let draft: string | undefined;
  let background: string | undefined;
  let tolerance: string | undefined;
  let noLoop: boolean | undefined;
  let name: string | undefined;
  let kind: string | undefined;
  let clips: string | undefined;
  let forkFrom: string | undefined;
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
        recording: { type: 'string' },
        action: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        speed: { type: 'string' },
        'new-id': { type: 'string' },
        character: { type: 'string' },
        cut: { type: 'string' },
        draft: { type: 'string' },
        background: { type: 'string' },
        tolerance: { type: 'string' },
        'no-loop': { type: 'boolean', default: false },
        name: { type: 'string' },
        kind: { type: 'string' },
        clips: { type: 'string' },
        'fork-from': { type: 'string' },
      },
    });
    store = values.store;
    source = values.source;
    id = values.id;
    width = values.width;
    height = values.height;
    anchorX = values['anchor-x'];
    anchorY = values['anchor-y'];
    recording = values.recording;
    action = values.action;
    start = values.start;
    end = values.end;
    speed = values.speed;
    newId = values['new-id'];
    character = values.character;
    cut = values.cut;
    draft = values.draft;
    background = values.background;
    tolerance = values.tolerance;
    noLoop = values['no-loop'];
    name = values.name;
    kind = values.kind;
    clips = values.clips;
    forkFrom = values['fork-from'];
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
    case 'cut':
      return runCut(store, { recording, action, id, start, end, speed, newId });
    case 'extract':
      return runExtract(store, {
        character,
        recording,
        cut,
        draft,
        background,
        tolerance,
        noLoop: noLoop === true,
      });
    case 'commit':
      return runCommit(store, { character, draft, name, kind, clips, forkFrom });
    case 'fork':
      return runFork(store, { character, kind, id, draft });
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

/** Options for the `cut` command, one action per invocation. */
interface CutArgs {
  recording?: string;
  action?: string;
  id?: string;
  start?: string;
  end?: string;
  speed?: string;
  newId?: string;
}

/** `forge cut` — add, rename, remove or list a Recording's Segments. */
async function runCut(store: string, args: CutArgs): Promise<number> {
  const { recording, action, id, start, end, speed, newId } = args;
  if (!recording) {
    return fail('--recording <recording-id> is required for cut');
  }
  if (!action) {
    return fail('--action <add|rename|remove|list> is required for cut');
  }

  try {
    let cutList: CutList;
    switch (action) {
      case 'list':
        cutList = await readCutList(store, recording);
        break;
      case 'add': {
        if (!id) {
          return fail('--id <cut-id> is required for cut --action add');
        }
        const startFrame = integerArg(start);
        const endFrame = integerArg(end);
        if (startFrame === undefined || endFrame === undefined) {
          return fail('--start and --end integers are required for cut --action add');
        }
        const speedMultiplier = speed === undefined ? undefined : Number(speed);
        cutList = await addSegment(store, {
          recordingId: recording,
          id,
          startFrame,
          endFrame,
          ...(speedMultiplier !== undefined ? { speed: speedMultiplier } : {}),
        });
        break;
      }
      case 'rename': {
        if (!id) {
          return fail('--id <cut-id> is required for cut --action rename');
        }
        if (!newId) {
          return fail('--new-id <cut-id> is required for cut --action rename');
        }
        cutList = await renameSegment(store, { recordingId: recording, id, newId });
        break;
      }
      case 'remove': {
        if (!id) {
          return fail('--id <cut-id> is required for cut --action remove');
        }
        cutList = await removeSegment(store, { recordingId: recording, id });
        break;
      }
      default:
        return fail(`unknown cut action "${action}"`, USAGE);
    }
    process.stdout.write(`${JSON.stringify(cutList, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Options for the `extract` command. */
interface ExtractArgs {
  character?: string;
  recording?: string;
  cut?: string;
  draft?: string;
  background?: string;
  tolerance?: string;
  noLoop: boolean;
}

/** `forge extract` — turn a Segment into a Clip Draft. */
async function runExtract(store: string, args: ExtractArgs): Promise<number> {
  const { character, recording, cut, draft, background, tolerance, noLoop } = args;
  if (!character) {
    return fail('--character <character-id> is required for extract');
  }
  if (!recording) {
    return fail('--recording <recording-id> is required for extract');
  }
  if (!cut) {
    return fail('--cut <cut-id> is required for extract');
  }
  const toleranceValue = tolerance === undefined ? undefined : integerArg(tolerance);
  if (tolerance !== undefined && toleranceValue === undefined) {
    return fail('--tolerance must be an integer');
  }

  try {
    const created = await extractClipDraft(store, {
      characterId: character,
      recordingId: recording,
      cutId: cut,
      ...(draft !== undefined ? { draftId: draft } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(toleranceValue !== undefined ? { tolerance: toleranceValue } : {}),
      loop: !noLoop,
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Parse a `--kind` option; only `clip` and `sequence` are recognised. */
function assetKind(value: string | undefined): AssetKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === 'clip' || value === 'sequence' ? value : undefined;
}

/** Options for the `commit` command. */
interface CommitArgs {
  character?: string;
  draft?: string;
  name?: string;
  kind?: string;
  /** Comma-separated source Clip ids; required when `--kind sequence`. */
  clips?: string;
  /** The Sequence id to record `derivedFrom` for (a Sequence fork). */
  forkFrom?: string;
}

/** `forge commit` — promote a Draft into a Clip, or Clips into a Sequence. */
async function runCommit(store: string, args: CommitArgs): Promise<number> {
  const { character, draft, name, kind, clips, forkFrom } = args;
  if (!character) {
    return fail('--character <character-id> is required for commit');
  }
  if (!name) {
    return fail('--name <asset-id> is required for commit');
  }
  const parsedKind = assetKind(kind);
  if (kind !== undefined && parsedKind === undefined) {
    return fail(`unknown --kind "${kind}" (expected clip or sequence)`);
  }

  if (parsedKind === 'sequence') {
    const sourceClips = (clips ?? '')
      .split(',')
      .map((clip) => clip.trim())
      .filter((clip) => clip.length > 0);
    if (sourceClips.length === 0) {
      return fail('--clips <a,b,c> is required for commit --kind sequence');
    }
    try {
      const committed = await commitSequence(store, {
        characterId: character,
        sequenceId: name,
        clips: sourceClips,
        ...(forkFrom !== undefined
          ? { derivedFrom: { kind: 'sequence' as const, id: forkFrom } }
          : {}),
      });
      process.stdout.write(`${JSON.stringify(committed, null, 2)}\n`);
      return 0;
    } catch (error) {
      return failForgeError(error);
    }
  }

  if (!draft) {
    return fail('--draft <draft-id> is required for commit');
  }
  try {
    const committed = await commitDraft(store, {
      characterId: character,
      draftId: draft,
      assetId: name,
      ...(parsedKind !== undefined ? { kind: parsedKind } : {}),
    });
    process.stdout.write(`${JSON.stringify(committed, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Options for the `fork` command. */
interface ForkArgs {
  character?: string;
  kind?: string;
  id?: string;
  draft?: string;
}

/** `forge fork` — open a committed Asset as a new Draft. */
async function runFork(store: string, args: ForkArgs): Promise<number> {
  const { character, kind, id, draft } = args;
  if (!character) {
    return fail('--character <character-id> is required for fork');
  }
  if (!kind) {
    return fail('--kind <clip|sequence> is required for fork');
  }
  if (!id) {
    return fail('--id <asset-id> is required for fork');
  }
  const parsedKind = assetKind(kind);
  if (parsedKind === undefined) {
    return fail(`unknown --kind "${kind}" (expected clip or sequence)`);
  }
  try {
    const opened =
      parsedKind === 'sequence'
        ? await forkAsset(store, { characterId: character, kind: 'sequence', id })
        : await forkAsset(store, {
            characterId: character,
            kind: 'clip',
            id,
            ...(draft !== undefined ? { draftId: draft } : {}),
          });
    process.stdout.write(`${JSON.stringify(opened, null, 2)}\n`);
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
