# Precomp surgery (ae_precomp_surgery)

Two actions, both planned first, refused with the exact reason when they can't be done exactly, rehearsed on a scratch
copy, proven with the ae_prove_identical engine, and only then applied in one undo step.

## unprecompose

{action: "unprecompose", comp: <parent comp>, layer: <precomp layer>, dryRun?, removeSource?, bakeNull?, override?,
frames?, times?, tolerance?}

- The precomp's layers go into the parent comp at the precomp layer's place, in the same order.
- A null named "<layer> (null)" carries the precomp layer's anchor point, position, scale and rotation (keyframes and
  expressions too) and its parent; the moved top-level layers and the precomp layer's own children are parented to it.
  bakeNull: true leaves it out only when the transform is the identity and nothing is parented to the layer.
- Time: layers move by the precomp layer's start time and are trimmed to its in and out points. A layer entirely
  outside that span is moved switched off (it may still drive expressions or be a parent).
- Names taken in the parent comp get a number ("Title" becomes "Title 2"); every reference follows.
- One visible layer takes over the precomp layer's blend mode and opacity (multiplied).
- The source comp is kept. removeSource: true removes it only when nothing else uses it: no other comp, no other layer,
  not the render queue, no expression naming it.

### Expression rewrites

- In the moved layers: thisComp.layer("x") points at the moved copy's name; thisComp.layer(3) at its new index; any other
  comp attribute (thisComp.width, .duration, .marker...) becomes comp("<source comp>").width; a reference that is broken
  now stays broken (comp("<source comp>").layer("missing")).
- Anywhere: references to the parent comp's layers by index follow the layers that move down.
- The originals in the source comp keep their text.

### Refused (each with its reason)

- On the precomp layer: effects, masks, layer styles, time remapping, time stretch, track matte (using or used as),
  3D, collapse transformations, adjustment layer, guide, switched off, Preserve Underlying Transparency, motion blur or
  frame blending in effect, Essential Properties, audio levels that aren't 0 dB, expressions outside the transform.
- Blend mode or opacity on the precomp layer when the precomp has more than one visible layer.
- In the precomp: blend modes other than normal, adjustment layers, Preserve Underlying Transparency, cameras, lights,
  3D layers, soloed layers, motion blur or frame blending with settings that differ from the parent comp, keyframed
  layer parameters of effects.
- Comp settings: another frame rate, preserve frame rate or resolution when nested, another pixel aspect ratio,
  Essential Graphics controllers on the source comp.
- Layers that reach outside the precomp's frame where that part would show in the parent comp (override "bounds").
- Expressions (override "expressions"): computed names or indices, eval, the layer's own index or wiggle / random when the
  index changes, time or other comps when the layers move in time, toComp and similar, parent when the layer gets the
  null as parent, inPoint / outPoint on trimmed layers, references to the precomp layer itself, ambiguous comp names,
  an error before the surgery, unparseable legacy syntax that mentions comps or layers.

## deep_duplicate

{action: "deep_duplicate", comp: <root>, dryRun?, suffix?, override?, frames?, times?, tolerance?}

- Every comp of the tree is copied once; a precomp used in several places maps to one copy. The copies' precomp layers
  point at the copies. Footage and solids are shared.
- The copies are made next to their originals. No folder option: After Effects records every move into a folder as an
  undo step of its own, which would break the one undo step. To tidy up, ae_move_items afterwards (separate steps).
- comp("X") inside the copies points at X's copy when X is in the tree; comps outside the tree stay.
- Refused (override "expressions"): computed comp names, names that more than one comp has.
- Reported: Essential Graphics controllers and overrides, expressions that read the comp's name (they show the copy's).
- The originals are never changed. The result names the copy set; ae_undo may take several steps (After Effects doesn't
  always keep comp duplicates in one undo step), so take them back with {action: "remove_copies", id}: it removes exactly
  those comps, and refuses while another comp, the render queue or an expression elsewhere uses one.

## The result

- DONE and proven: the verdict, frames compared and time, checkpoint, what moved or was copied, every rewrite
  (before → after), the change list. The way back: un-precompose, the checkpoint (ae_checkpoint restore with the id given;
  ae_undo may take several steps, After Effects can split the step); deep duplicate, remove_copies with the copy set id.
- DIFFERS / NOT PROVEN: nothing applied (the scratch copy was removed); frames that differ, difference image, likely
  cause. A scaled or rotated precomp layer is the usual one: the precomp was rendered, then resampled as a whole; the
  moved layers are transformed in one step. Report it; the user decides (a higher tolerance only if they accept it).
- REFUSED: nothing changed; the problems with their reasons, and the full plan.
