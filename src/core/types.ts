/** Public result types of the core command surface. */

/** A committed Asset is a Clip or a Sequence; the two share one id namespace. */
export type AssetKind = 'clip' | 'sequence';

/**
 * A reference to a committed Asset (format-spec §8). The `kind` is required
 * because a Clip and a Sequence share one id namespace, so an id alone is
 * ambiguous.
 */
export interface AssetRef {
  kind: AssetKind;
  id: string;
}

/** A Recording discovered in the store. */
export interface ScannedRecording {
  /** The recording id (its folder name). */
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
}

/** A committed Asset discovered in the store. */
export interface ScannedAsset {
  kind: AssetKind;
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
}

/** A Character discovered in the store, with its committed Assets. */
export interface ScannedCharacter {
  id: string;
  /** Store-relative POSIX directory. */
  dir: string;
  /** Committed Clips and Sequences, Clips first, each alphabetical. */
  assets: ScannedAsset[];
}

/** An Export target discovered in the store. */
export interface ScannedExport {
  target: string;
  /** Store-relative POSIX directory. */
  dir: string;
}

/** What `scan` discovered: the store, listed purely from its directory tree. */
export interface StoreScan {
  root: string;
  recordings: ScannedRecording[];
  characters: ScannedCharacter[];
  exports: ScannedExport[];
}
