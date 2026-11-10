# Faces belong to the target, not to a fixed toolbar

The workbench stage has **faces** — Cut, Clip editor, Alignment, Export — and which of
them exist is decided by what is open. A `Recording` has Cutting only; a `Draft` and a
committed `Asset` have the Clip editor and Alignment; a `Character` has Alignment only;
an `Export` has Export. Loading a target opens its first face, and the mode bar lists
just the faces that target has.

Cutting moved onto a face of its own because a `Segment` only exists inside a
`Recording`: while repairing a Draft it is an unrelated idea. Sharing one face with
repair also put two draggable things under the same pointer (the range picker and the
existing cut bands), which made "start a new cut" and "move this edge" easy to confuse.
Splitting them puts each gesture on its own surface, and the filmstrip — the cut face's
timeline — is hidden everywhere else instead of costing every other face its height.

This trades a fixed toolbar for one that changes as you work. That is the point: a face
that cannot act on the open target is a dead button, so offering it was the bug.

Rejected: a fourth fixed mode button (Cut shown while repairing a Draft); a "mark mode"
toggle inside the Clip editor (the strip still hangs off faces that never scrub);
splitting only the inspector (the conflicting drags stay on one strip).

## Consequences

- `setMode` clamps to a face the target actually has, so callers cannot ask for a
  meaningless one; every load calls it with the target's default face.
- A Segment's edit surface is the inspector, reached by selecting a band on the
  filmstrip. Selecting is not a mode.
- One action crosses faces on purpose: Extract leaves Cutting for the Draft it produced.
- The mode bar is rebuilt per target; with one face it is a label rather than a switch.
