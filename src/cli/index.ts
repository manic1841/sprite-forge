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
  appendRepairOperation,
  commitDraft,
  commitSequence,
  createCharacter,
  deriveAnchor,
  exportCharacter,
  extractClipDraft,
  fitCanvasToContent,
  ForgeError,
  forkAsset,
  ingestRecording,
  readCutList,
  readDraftRepair,
  removeSegment,
  renameSegment,
  resizeCanvas,
  scan,
  setPlacementOffset,
  setSegmentRect,
  StoreError,
  undoRepairOperation,
  validateStore,
  ValidationError,
  verifyReproducible,
} from '../core/index.js';
import type {
  AssetKind,
  CutList,
  RepairOperationInput,
  RepairTool,
  StrokeGeometry,
} from '../core/index.js';

const USAGE = `forge — sprite-forge CLI

Usage:
  forge scan             --store <path>                              List the store's Recordings, Characters and Exports.
  forge validate         --store <path>                              Validate every artifact in the store.
  forge ingest           --store <path> --recording-file <file> --id <id>
                                                                     Register a raw capture as a Recording.
  forge create-character --store <path> --id <id> [--width <n> --height <n> --anchor-x <n> --anchor-y <n>]
                                                                     Create a Character and its Canvas/Anchor.
       Width/height/anchor may instead be derived from a Recording's first frame:
       --recording <id> [--cut <id>] [--background <#rrggbb>] [--tolerance <n>]
  forge cut              --store <path> --recording <id> --action <add|rename|remove|list> [options]
                                                                     Edit a Recording's Segment cut list.
       add:    --id <cut-id> --start <n> --end <n> [--speed <n>] [--rect x,y,w,h]
       rename: --id <cut-id> --new-id <new-id>
       remove: --id <cut-id>
       rect:   --id <cut-id> --rect x,y,w,h|none
       list:   (no further options)
       A rect confines extraction to that source rectangle; "none" clears it.
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
                                                                     Open a Clip as a Draft, or a Sequence as its ordered Clip list.
  forge export           --store <path> --character <id> --target <target> --bindings <s=p,...> [options]
                                                                     Gather an Asset subset into a closed Manifest plus sheets.
       --animations <a,b>      Asset ids to export (default: every committed Asset)
       --bindings <s=a,b;s2=c>  Situation -> one or more animation ids
       --situations <s1,s2>     The consumer's declared Situations (default: the bindings keys)
       --flips-facing <a,b>     Animation ids that flip the consumer's Facing on completion
       --authored-facing <right|left>  The direction the art was drawn in (default: right)
       --exported-at <iso>      Override the lock's export time (default: now)
  forge verify-reproducible --store <path> --character <id> --kind <clip|sequence|export> --id <asset-or-target>
                                                                     Re-run a stage from provenance and check it
                                                                     lands on identical artifacts (exit 1 if not).
  forge repair           --store <path> --character <id> --draft <id> --action <list|append|undo> [options]
                                                                     Edit a Draft's Repair script (its undo stack).
       append: --tool <erase-rect|erase-brush|paint-brush> --start <n> --end <n>
               erase-rect: --x <n> --y <n> --width <n> --height <n>
               brushes:    --points "x,y;x,y" --size <n> [--color <#rrggbb> for paint-brush]
       list/undo: (no further options)
  forge align            --store <path> --character <id> --action <set-offset|resize|fit> [options]
                                                                     Set a Draft's placement offset, or resize the Canvas.
       set-offset: --draft <id> --x <n> --y <n>
       resize:     --width <n> --height <n>   (down to the content floor)
       fit:        shrink to the content floor`;

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  let store: string | undefined;
  let recordingFile: string | undefined;
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
  let tool: string | undefined;
  let x: string | undefined;
  let y: string | undefined;
  let points: string | undefined;
  let size: string | undefined;
  let color: string | undefined;
  let newId: string | undefined;
  let rect: string | undefined;
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
  let target: string | undefined;
  let bindings: string | undefined;
  let animations: string | undefined;
  let situations: string | undefined;
  let flipsFacing: string | undefined;
  let authoredFacing: string | undefined;
  let exportedAt: string | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', short: 's' },
        'recording-file': { type: 'string' },
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
        tool: { type: 'string' },
        x: { type: 'string' },
        y: { type: 'string' },
        points: { type: 'string' },
        size: { type: 'string' },
        color: { type: 'string' },
        'new-id': { type: 'string' },
        rect: { type: 'string' },
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
        target: { type: 'string' },
        bindings: { type: 'string' },
        animations: { type: 'string' },
        situations: { type: 'string' },
        'flips-facing': { type: 'string' },
        'authored-facing': { type: 'string' },
        'exported-at': { type: 'string' },
      },
    });
    store = values.store;
    recordingFile = values['recording-file'];
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
    tool = values.tool;
    x = values.x;
    y = values.y;
    points = values.points;
    size = values.size;
    color = values.color;
    newId = values['new-id'];
    rect = values.rect;
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
    target = values.target;
    bindings = values.bindings;
    animations = values.animations;
    situations = values.situations;
    flipsFacing = values['flips-facing'];
    authoredFacing = values['authored-facing'];
    exportedAt = values['exported-at'];
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
      return runIngest(store, recordingFile, id);
    case 'create-character':
      return runCreateCharacter(store, id, width, height, anchorX, anchorY, recording, cut);
    case 'cut':
      return runCut(store, { recording, action, id, start, end, speed, newId, rect });
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
    case 'export':
      return runExport(store, {
        character,
        target,
        animations,
        bindings,
        situations,
        flipsFacing,
        authoredFacing,
        exportedAt,
      });
    case 'verify-reproducible':
      return runVerifyReproducible(store, { character, kind, id });
    case 'repair':
      return runRepair(store, {
        character, draft, action, tool, start, end, x, y, width, height, points, size, color,
      });
    case 'align':
      return runAlign(store, { character, draft, action, x, y, width, height });
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

async function runIngest(store: string, recordingFile?: string, id?: string): Promise<number> {
  if (!recordingFile) {
    return fail('--recording-file <file> is required for ingest');
  }
  if (!id) {
    return fail('--id <recording-id> is required for ingest');
  }
  try {
    const recording = await ingestRecording(store, { recordingId: id, sourcePath: recordingFile });
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
  recording?: string,
  cut?: string,
): Promise<number> {
  if (!id) {
    return fail('--id <character-id> is required for create-character');
  }
  const widthPx = integerArg(width);
  const heightPx = integerArg(height);
  const anchorXPx = integerArg(anchorX);
  const anchorYPx = integerArg(anchorY);
  const allExplicit =
    widthPx !== undefined &&
    heightPx !== undefined &&
    anchorXPx !== undefined &&
    anchorYPx !== undefined;
  const noneExplicit =
    widthPx === undefined &&
    heightPx === undefined &&
    anchorXPx === undefined &&
    anchorYPx === undefined;

  try {
    // Either the Canvas is given outright, derived from a Recording's first frame
    // (user story 42), or left out entirely to start the Character **blank** on a
    // provisional Canvas. A partial set is ambiguous and rejected.
    let canvas: { width: number; height: number; anchor: { x: number; y: number } } | undefined;
    if (allExplicit) {
      canvas = { width: widthPx, height: heightPx, anchor: { x: anchorXPx, y: anchorYPx } };
    } else if (noneExplicit && recording) {
      const derived = await deriveAnchor(store, {
        recordingId: recording,
        ...(cut !== undefined ? { cutId: cut } : {}),
      });
      canvas = derived.canvas;
    } else if (noneExplicit) {
      canvas = undefined;
    } else {
      return fail(
        'provide --width, --height, --anchor-x and --anchor-y, --recording [--cut] to derive them, or nothing for a blank Character',
      );
    }

    const created = await createCharacter(store, { characterId: id, ...canvas });
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

/**
 * Parse `--rect x,y,width,height`; `undefined` when absent.
 *
 * Returns `null` for the literal `none`, which is how a box is cleared.
 */
function rectArg(value: string | undefined): { x: number; y: number; width: number; height: number } | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'none') {
    return null;
  }
  const parts = value.split(',').map((part) => integerArg(part.trim()));
  if (parts.length !== 4 || parts.some((part) => part === undefined)) {
    return undefined;
  }
  const [x, y, width, height] = parts as number[];
  return { x: x!, y: y!, width: width!, height: height! };
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
  rect?: string;
}

/** `forge cut` — add, rename, remove or list a Recording's Segments. */
async function runCut(store: string, args: CutArgs): Promise<number> {
  const { recording, action, id, start, end, speed, newId, rect } = args;
  if (!recording) {
    return fail('--recording <recording-id> is required for cut');
  }
  if (!action) {
    return fail('--action <add|rename|remove|rect|list> is required for cut');
  }
  if (rect !== undefined && rectArg(rect) === undefined) {
    return fail('--rect must be x,y,width,height or `none`');
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
        const box = rectArg(rect);
        cutList = await addSegment(store, {
          recordingId: recording,
          id,
          startFrame,
          endFrame,
          ...(speedMultiplier !== undefined ? { speed: speedMultiplier } : {}),
          ...(box === undefined || box === null ? {} : { rect: box }),
        });
        break;
      }
      case 'rect': {
        if (!id) {
          return fail('--id <cut-id> is required for cut --action rect');
        }
        if (rect === undefined) {
          return fail('--rect x,y,width,height|none is required for cut --action rect');
        }
        const box = rectArg(rect) ?? undefined;
        cutList = await setSegmentRect(store, { recordingId: recording, id, rect: box });
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

/** Options for the `export` command. */
interface ExportArgs {
  character?: string;
  target?: string;
  animations?: string;
  bindings?: string;
  situations?: string;
  flipsFacing?: string;
  authoredFacing?: string;
  exportedAt?: string;
}

/** `forge export` — gather an Asset subset into a closed Manifest plus sheets. */
async function runExport(store: string, args: ExportArgs): Promise<number> {
  const { character, target, animations, bindings, situations, flipsFacing, authoredFacing } = args;
  if (!character) {
    return fail('--character <character-id> is required for export');
  }
  if (!target) {
    return fail('--target <target> is required for export');
  }
  if (!bindings) {
    return fail('--bindings <situation=id[,id][;...]> is required for export');
  }
  let facing: 'right' | 'left' | undefined;
  if (authoredFacing !== undefined) {
    if (authoredFacing !== 'right' && authoredFacing !== 'left') {
      return fail(`unknown --authored-facing "${authoredFacing}" (expected right or left)`);
    }
    facing = authoredFacing;
  }
  try {
    const result = await exportCharacter(store, {
      characterId: character,
      target,
      bindings: parseBindings(bindings),
      ...(animations !== undefined ? { animations: commaList(animations) } : {}),
      ...(situations !== undefined ? { situations: commaList(situations) } : {}),
      ...(flipsFacing !== undefined ? { flipsFacing: commaList(flipsFacing) } : {}),
      ...(facing !== undefined ? { authoredFacing: facing } : {}),
      ...(args.exportedAt !== undefined ? { exportedAt: args.exportedAt } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Options for the `verify-reproducible` command. */
interface VerifyReproducibleArgs {
  character?: string;
  kind?: string;
  id?: string;
}

/**
 * `forge verify-reproducible` — re-run a stage from provenance and check it lands
 * on identical artifacts. Exits `0` when reproducible, `1` when it is not (the
 * report is printed either way).
 */
async function runVerifyReproducible(
  store: string,
  args: VerifyReproducibleArgs,
): Promise<number> {
  const { character, kind, id } = args;
  if (!character) {
    return fail('--character <character-id> is required for verify-reproducible');
  }
  if (!id) {
    return fail('--id <asset-or-target> is required for verify-reproducible');
  }
  if (kind !== 'clip' && kind !== 'sequence' && kind !== 'export') {
    return fail('--kind <clip|sequence|export> is required for verify-reproducible');
  }
  try {
    const report = await verifyReproducible(store, { characterId: character, kind, id });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.reproducible ? 0 : 1;
  } catch (error) {
    return failForgeError(error);
  }
}

/** Options for the `repair` command. */
interface RepairArgs {
  character?: string;
  draft?: string;
  action?: string;
  tool?: string;
  start?: string;
  end?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  points?: string;
  size?: string;
  color?: string;
}

/** `forge repair` — list, append to, or undo a Draft's Repair script. */
async function runRepair(store: string, args: RepairArgs): Promise<number> {
  const { character, draft, action } = args;
  if (!character) {
    return fail('--character <character-id> is required for repair');
  }
  if (!draft) {
    return fail('--draft <draft-id> is required for repair');
  }
  if (!action) {
    return fail('--action <list|append|undo> is required for repair');
  }
  try {
    switch (action) {
      case 'list': {
        const state = await readDraftRepair(store, { characterId: character, draftId: draft });
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        return 0;
      }
      case 'undo': {
        const state = await undoRepairOperation(store, { characterId: character, draftId: draft });
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        return 0;
      }
      case 'append': {
        const operation = parseRepairOperation(args);
        if (typeof operation === 'string') {
          return fail(operation);
        }
        const state = await appendRepairOperation(store, {
          characterId: character,
          draftId: draft,
          operation,
        });
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        return 0;
      }
      default:
        return fail(`unknown repair action "${action}"`, USAGE);
    }
  } catch (error) {
    return failForgeError(error);
  }
}

/** Build a Repair operation from CLI args; a string result is an error message. */
function parseRepairOperation(args: RepairArgs): RepairOperationInput | string {
  const tool = args.tool;
  const knownTools: readonly RepairTool[] = ['erase-rect', 'erase-brush', 'paint-brush'];
  if (!knownTools.includes(tool as RepairTool)) {
    return '--tool <erase-rect|erase-brush|paint-brush> is required for repair --action append';
  }
  const start = integerArg(args.start);
  const end = integerArg(args.end);
  if (start === undefined || end === undefined) {
    return '--start and --end integers are required for repair --action append';
  }

  if (tool === 'erase-rect') {
    const x = integerArg(args.x);
    const y = integerArg(args.y);
    const width = integerArg(args.width);
    const height = integerArg(args.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return '--x, --y, --width and --height integers are required for repair --tool erase-rect';
    }
    return { tool, frames: { start, end }, geometry: { x, y, width, height } };
  }

  const points = parsePoints(args.points);
  const size = integerArg(args.size);
  if (points === null || size === undefined) {
    return '--points "x,y;x,y" and --size <n> are required for a brush repair tool';
  }
  const geometry: StrokeGeometry = { points, size };
  return {
    tool: tool as RepairTool,
    frames: { start, end },
    geometry,
    ...(args.color !== undefined ? { color: args.color } : {}),
  };
}

/** Parse `"x,y;x,y"` into integer points; `null` when any pair is malformed. */
function parsePoints(value: string | undefined): Array<[number, number]> | null {
  if (!value) {
    return null;
  }
  const points: Array<[number, number]> = [];
  for (const pair of value.split(';')) {
    const [px, py] = pair.split(',').map((part) => Number(part.trim()));
    if (!Number.isInteger(px) || !Number.isInteger(py)) {
      return null;
    }
    points.push([px!, py!]);
  }
  return points.length > 0 ? points : null;
}

/** Options for the `align` command. */
interface AlignArgs {
  character?: string;
  draft?: string;
  action?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
}

/** `forge align` — set a Draft's placement offset, or resize the Canvas. */
async function runAlign(store: string, args: AlignArgs): Promise<number> {
  const { character, action } = args;
  if (!character) {
    return fail('--character <character-id> is required for align');
  }
  if (!action) {
    return fail('--action <set-offset|resize|fit> is required for align');
  }
  try {
    switch (action) {
      case 'set-offset': {
        const { draft } = args;
        if (!draft) {
          return fail('--draft <draft-id> is required for align --action set-offset');
        }
        const x = integerArg(args.x);
        const y = integerArg(args.y);
        if (x === undefined || y === undefined) {
          return fail('--x and --y integers are required for align --action set-offset');
        }
        const updated = await setPlacementOffset(store, {
          characterId: character,
          draftId: draft,
          offset: { x, y },
        });
        process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
        return 0;
      }
      case 'resize': {
        const width = integerArg(args.width);
        const height = integerArg(args.height);
        if (width === undefined || height === undefined) {
          return fail('--width and --height integers are required for align --action resize');
        }
        const result = await resizeCanvas(store, { characterId: character, width, height });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      case 'fit': {
        const result = await fitCanvasToContent(store, { characterId: character });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      default:
        return fail(`unknown align action "${action}"`, USAGE);
    }
  } catch (error) {
    return failForgeError(error);
  }
}

/** Split a comma-separated option into trimmed, non-empty values. */
function commaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parse `situation=id[,id][;situation=id...]` into a bindings map. */
function parseBindings(value: string): Record<string, string[]> {
  const bindings: Record<string, string[]> = {};
  for (const entry of value.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [situation, ids] = trimmed.split('=');
    if (!situation || ids === undefined) {
      throw new StoreError(`Malformed --bindings entry "${trimmed}" (expected situation=id[,id]).`);
    }
    bindings[situation.trim()] = commaList(ids);
  }
  return bindings;
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
