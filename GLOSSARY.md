# sprite-forge

sprite-forge turns emulator screen recordings into pixel-animation assets for a
consumer application (today, `one-piece`'s Pixel Pet). It is the producer: it owns
the asset pipeline and the format contract, while assets are data and the consumer
depends only on an export.

## Source material

**Recording**:
A single screen capture from an emulator, stored as one animated image file.
_Avoid_: source, take, video

**Segment**:
A named cut in a Recording's cut list: a half-open frame range
(`[startFrame, endFrame)`) covering one action's worth of footage.
_Avoid_: slice, span, take

**Cut list**:
A Recording's own record of its Segments, stored beside the Recording.
_Avoid_: chapter list, index

## Authoring and repair

**Draft**:
An editable, not-yet-committed working state of an Asset.
_Avoid_: working copy, WIP

**Repair**:
Editing a Clip's de-backgrounded frames by hand with a brush and eyedropper —
painting transparent to erase, or painting a picked colour to patch.
_Avoid_: patch, retouch, cleanup

**Repair script**:
The persisted, ordered list of Repair operations for a Clip, replayed on every run.
_Avoid_: mask, patch, layer

**Commit**:
The act of promoting a Draft into an immutable, named Asset.
_Avoid_: save, publish

**Fork**:
The act of starting a new Draft from an existing Asset and recording its lineage.
_Avoid_: copy, clone, variant

**Provenance**:
The record of how an Asset was made — its Recording, Segment, settings, and Repair
script — kept beside the Asset so it can be reproduced and traced.
_Avoid_: metadata

## Assets

**Character**:
The subject an Asset depicts, and the owner of that subject's shared Canvas.
_Avoid_: actor, entity, subject

**Clip**:
The atomic reusable animation: a run of de-backgrounded, cropped, aligned frames
with per-frame delays.
_Avoid_: action, motion, sprite

**Sequence**:
An ordered concatenation of Clips that plays as a single animation.
_Avoid_: composition, animation chain

**Asset**:
A named, on-disk, re-openable unit in the Asset store; its kind is a Clip or a
Sequence. A committed Asset is immutable: editing it forks a new Asset that records
its lineage.
_Avoid_: library item, resource, material

**Asset store**:
The directory tree that holds every Asset and its provenance.
_Avoid_: library, catalog, repository

**Canvas**:
The frame size shared by every Asset of a Character, so the consumer can swap sheets
without the subject jumping.
_Avoid_: frame box, bounding box

**Anchor**:
The pixel reference point (foot-base) shared by every Asset of a Character, used to
place the subject on the Canvas.
_Avoid_: pivot, origin, hotspot

## Delivery

**Export**:
A self-contained subset of the Asset store produced for one Character and one
consumer target.
_Avoid_: build, bundle, package

**Manifest**:
The single file a consumer reads; it inlines the metadata of each exported animation.
_Avoid_: index, catalog

**Bindings**:
The map from a consumer's Situations to the Asset ids each may play.
_Avoid_: mapping, aliases

**Situation**:
A named state the consumer presents to trigger animation (e.g. `idle`, `happy`); it
exists only in Bindings, never in the asset layer. A Situation may bind several Assets.
_Avoid_: reaction, event, trigger

**Facing**:
The direction the consumer is currently drawing the Character (`right` or `left`),
mirrored against the direction the art was authored in. It belongs to the consumer,
not the Asset store.
_Avoid_: direction, orientation, side
