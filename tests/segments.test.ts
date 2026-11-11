import { describe, expect, it } from 'vitest';
import {
  addSegment,
  readCutList,
  removeSegment,
  renameSegment,
  setSegmentRange,
  setSegmentRect,
  ValidationError,
  validateArtifact,
} from '../src/core/index.js';
import type { StoreFixture } from './harness.js';
import { withStore } from './harness.js';

const RECORDING_ID = 'mgba-2026-09';
const CUTS_PATH = `recordings/${RECORDING_ID}/cuts.json`;
const HASH = `sha256:${'a'.repeat(64)}`;

/** Seed a Recording's cut list directly, the way ingest would have written it. */
function seedRecording(store: StoreFixture, frameCount = 100): void {
  store.writeJson(CUTS_PATH, { hash: HASH, frameCount, cuts: [] });
}

describe('readCutList', () => {
  it('reads the Recording cut list, carrying its hash and frame count', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);

      const cutList = await readCutList(store.root, RECORDING_ID);

      expect(cutList).toEqual({ hash: HASH, frameCount: 100, cuts: [] });
    });
  });
});

describe('addSegment', () => {
  it('adds a Segment to the Recording cut list, leaving hash and frameCount untouched', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);

      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      const expected = {
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      };
      expect(cutList).toEqual(expected);
      expect(store.readJson(CUTS_PATH)).toEqual(expected);

      // The written artifact satisfies the frozen schema.
      validateArtifact('cuts', store.readJson(CUTS_PATH));
    });
  });

  it('rejects adding a Segment whose cut id already exists in the Recording', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      await expect(
        addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 30,
          endFrame: 40,
        }),
      ).rejects.toThrow(ValidationError);

      // The rejected edit wrote nothing: the original Segment survives alone.
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });
});

describe('renameSegment', () => {
  it('changes a Segment cut id, leaving its range in place', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      const cutList = await renameSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        newId: 'run',
      });

      expect(cutList.cuts).toEqual([{ id: 'run', startFrame: 10, endFrame: 20 }]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'run', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('rejects a rename onto an id that already exists in the Recording', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'jump',
        startFrame: 30,
        endFrame: 40,
      });

      await expect(
        renameSegment(store.root, { recordingId: RECORDING_ID, id: 'walk', newId: 'jump' }),
      ).rejects.toThrow(ValidationError);

      // The collision wrote nothing: both original ids are intact.
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [
          { id: 'walk', startFrame: 10, endFrame: 20 },
          { id: 'jump', startFrame: 30, endFrame: 40 },
        ],
      });
    });
  });
});

describe('removeSegment', () => {
  it('takes a Segment out of the Recording cut list', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'jump',
        startFrame: 30,
        endFrame: 40,
      });

      const cutList = await removeSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
      });

      expect(cutList.cuts).toEqual([{ id: 'jump', startFrame: 30, endFrame: 40 }]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'jump', startFrame: 30, endFrame: 40 }],
      });
    });
  });
});

describe('overlapping and repeated ranges', () => {
  it('accepts a jump and a shorter jump-takeoff that share their opening frames', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);

      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'jump',
        startFrame: 10,
        endFrame: 30,
      });
      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'jump-takeoff',
        startFrame: 10,
        endFrame: 18,
      });

      // Overlap is not policed; both cuts are independent selections.
      expect(cutList.cuts).toEqual([
        { id: 'jump', startFrame: 10, endFrame: 30 },
        { id: 'jump-takeoff', startFrame: 10, endFrame: 18 },
      ]);
      validateArtifact('cuts', store.readJson(CUTS_PATH));
    });
  });

  it('accepts two Segments covering exactly the same range', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);

      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 0,
        endFrame: 24,
      });
      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk-again',
        startFrame: 0,
        endFrame: 24,
      });

      expect(cutList.cuts).toEqual([
        { id: 'walk', startFrame: 0, endFrame: 24 },
        { id: 'walk-again', startFrame: 0, endFrame: 24 },
      ]);
    });
  });
});

describe('Segment range rules', () => {
  it('rejects an endFrame that is not greater than startFrame', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await expect(
        addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 20,
          endFrame: 20,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });

  it('rejects an endFrame beyond the Recording frame count', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await expect(
        addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 90,
          endFrame: 101,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });

  it('rejects a negative startFrame', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await expect(
        addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: -1,
          endFrame: 10,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });

  it('accepts the whole Recording as one range, end-exclusive', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'all',
        startFrame: 0,
        endFrame: 100,
      });
      expect(cutList.cuts).toEqual([{ id: 'all', startFrame: 0, endFrame: 100 }]);
    });
  });
});

describe('Segment speed', () => {
  it('omits speed when it is 1', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
        speed: 1,
      });
      expect(cutList.cuts).toEqual([{ id: 'walk', startFrame: 10, endFrame: 20 }]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('records a non-1 speed without changing the frame range', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
        speed: 2,
      });
      expect(cutList.cuts).toEqual([
        { id: 'walk', startFrame: 10, endFrame: 20, speed: 2 },
      ]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20, speed: 2 }],
      });
    });
  });

  it('rejects a non-positive speed', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await expect(
        addSegment(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 10,
          endFrame: 20,
          speed: 0,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({ cuts: [] });
    });
  });
});

describe('setSegmentRange', () => {
  it('retargets a Segment to a new half-open range, keeping its id and speed', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
        speed: 2,
      });

      const cutList = await setSegmentRange(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 12,
        endFrame: 26,
      });

      expect(cutList.cuts).toEqual([
        { id: 'walk', startFrame: 12, endFrame: 26, speed: 2 },
      ]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 12, endFrame: 26, speed: 2 }],
      });
      validateArtifact('cuts', store.readJson(CUTS_PATH));
    });
  });

  it('rejects an empty range (endFrame not greater than startFrame), writing nothing', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      await expect(
        setSegmentRange(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 20,
          endFrame: 20,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('rejects a range that runs past the Recording frame count', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      await expect(
        setSegmentRange(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 90,
          endFrame: 101,
        }),
      ).rejects.toThrow(ValidationError);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('rejects an unknown cut id', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await expect(
        setSegmentRange(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          startFrame: 10,
          endFrame: 20,
        }),
      ).rejects.toThrow(/No Segment/);
    });
  });
});

describe('a Segment box', () => {
  // A box is the source rectangle a Segment is confined to. It is source
  // coordinates, so it is stored verbatim rather than checked against the source.

  it('is stored on the Segment, and copied so a later caller edit cannot reach it', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      const rect = { x: 4, y: 8, width: 16, height: 16 };

      const cutList = await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
        rect,
      });

      rect.x = 99;
      expect(cutList.cuts).toEqual([
        { id: 'walk', startFrame: 10, endFrame: 20, rect: { x: 4, y: 8, width: 16, height: 16 } },
      ]);
      validateArtifact('cuts', store.readJson(CUTS_PATH));
    });
  });

  it('is set and cleared without disturbing the range or speed', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
        speed: 2,
      });

      const set = await setSegmentRect(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        rect: { x: 1, y: 2, width: 3, height: 4 },
      });
      expect(set.cuts).toEqual([
        { id: 'walk', startFrame: 10, endFrame: 20, speed: 2, rect: { x: 1, y: 2, width: 3, height: 4 } },
      ]);

      const cleared = await setSegmentRect(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
      });
      expect(cleared.cuts).toEqual([{ id: 'walk', startFrame: 10, endFrame: 20, speed: 2 }]);
      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20, speed: 2 }],
      });
    });
  });

  it('rejects a box with a fractional or empty size, writing nothing', async () => {
    await withStore(async (store) => {
      seedRecording(store, 100);
      await addSegment(store.root, {
        recordingId: RECORDING_ID,
        id: 'walk',
        startFrame: 10,
        endFrame: 20,
      });

      await expect(
        setSegmentRect(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          rect: { x: 0, y: 0, width: 0, height: 4 },
        }),
      ).rejects.toThrow(/at least 1x1/);

      await expect(
        setSegmentRect(store.root, {
          recordingId: RECORDING_ID,
          id: 'walk',
          rect: { x: 0.5, y: 0, width: 2, height: 2 },
        }),
      ).rejects.toThrow(/must be an integer/);

      expect(store.readJson(CUTS_PATH)).toMatchObject({
        cuts: [{ id: 'walk', startFrame: 10, endFrame: 20 }],
      });
    });
  });

  it('is rejected by the schema when it has an extra key', () => {
    expect(() =>
      validateArtifact('cuts', {
        hash: HASH,
        frameCount: 100,
        cuts: [{ id: 'walk', startFrame: 0, endFrame: 1, rect: { x: 0, y: 0, width: 1, height: 1, z: 2 } }],
      }),
    ).toThrow(ValidationError);
  });
});
