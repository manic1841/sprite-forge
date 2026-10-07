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
A half-open frame range (`[startFrame, endFrame)`) selected from one Recording,
covering one action's worth of footage.
_Avoid_: slice, span, cut

## Authoring and repair

**Draft**:
An editable, not-yet-committed working state of an Asset.
_Avoid_: working copy, WIP

**Repair**:
Editing a Clip's de-backgrounded frames by hand with a brush and eyedropper —
painting transparent to erase, or painting a picked colour to patch.
_Avoid_: patch, retouch, cleanup

**Mask**:
The persisted overlay that records a Clip's Repair edits and is re-applied on every
run.
_Avoid_: patch, layer

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
The map from a consumer's Situations to Asset ids.
_Avoid_: mapping, aliases

**Situation**:
A named state the consumer presents to trigger one animation (e.g. `idle`, `happy`);
it exists only in Bindings, never in the asset layer.
_Avoid_: reaction, event, trigger
