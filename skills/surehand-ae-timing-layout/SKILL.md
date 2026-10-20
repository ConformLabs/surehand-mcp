---
name: surehand-ae-timing-layout
description: Sets exact After Effects keyframe timing and easing, aligns layers by measured bounds and reformats comps by the user's rules. Use for keyframes, easing, retiming, layout or reformats.
license: MIT
---

# Exact timing and layout

Numbers, not eyeballing. Tools from the Surehand MCP server (surehand-ae). Follow the surehand-ae skill for every
edit. In a core-tools chat the timing and alignment tools are on demand: ae_tools {describe: [...]} gives their
parameters, ae_call runs them.

## Timing

**Read:** ae_get_keyframes {comp, layers, paths}.

- For every key: whole frame and exact time, value, interpolation, and ease per dimension (speed in the property's
  units per second, influence %).
- Keys between whole frames are flagged with offFrame.
- curves: true adds the normalized cubic-bezier numbers of each segment.

**Write:** ae_set_keyframe_table takes the same rows back. Edit the table, write it, check the keys it returns.

- Place keys by frame (whole frames from the comp's start, frame 0 = time 0) or by time (seconds).
- The ease count per key is fixed by After Effects: 2 for 2D values, 3 for 3D values (Scale), 1 for everything
  else, including Position, Anchor Point and colors. A wrong count fails before that property is written.
- Influence is 0.1 to 100. A 0 read back from After Effects is written as 0.1.
- replace: true clears the property's keys first; otherwise keys at the same time are updated.

**Match easing:** ae_copy_ease copies one reference key's ease onto other keys. Between properties with different
units (Opacity %/s, Position px/s), use speed "keep" or "zero".

**Audit:** ae_audit_easing lists the segments that match none of the comp's own most-used curves. Make outliers
consistent (ae_copy_ease from a conforming key) only when the user asks.

**Retime:** ae_retime_keyframes. Keys land on whole frames.

- mode "scale": factor or durationFrames, around anchor or anchorFrame.
- mode "offset": frames.
- mode "stagger": frames between layers, in order.
- mode "conform": a new frameRate for the comp.
- keepCurves (default true) keeps each curve's shape. Pass on the rounding it reports.

## Layout

**Measure:** ae_get_layer_bounds {comp, layers, time or frame}.

- On-screen boxes after transforms, parents, 3D and the camera.
- Whether each layer is visible and in frame, and inside action-safe (5%) and title-safe (10%).
- includeExtents: true adds strokes and effects.

**Move:** ae_align_layers.

- align (left, right, top, bottom, hcenter, vcenter, center) to: the selection, the comp, titleSafe, actionSafe,
  {layer} or {x, y}.
- distribute horizontal or vertical, by gaps or centers, or with a fixed spacing.
- dryRun: true shows the planned moves first.
- Keyframed Position moves every key by the same amount.
- 3D layers, locked layers and Position with an expression are left alone and listed: report them.

Measure at the frames that matter: a layout can change over time.

## Reformat (another aspect ratio)

ae_reformat {comp, width, height, name, ...rules} makes a new comp at the target size and checks it on every frame.

- Every rule comes from the user. Ask for them; never invent a layout or a safe margin:
  - background: [{layer, mode: "cover" | "fit"}];
  - safe: [{layer, area}] with safeAreas {title, action} margins;
  - pin: [{layer, to, margin}];
  - scale: [{layer, min, max}] (% of the source size);
  - minCapHeightPx;
  - hide: [layer].
- Layers no rule names keep their offset from the frame centre. Its INFO notes list layers that no longer cover the
  frame or are pushed out: pass them on and ask.
- Start with dryRun: true. Show the plan, then run it.
- Report the verdict word as given. A rule that can't be met is a FAIL with its reason and the choices (shorter text,
  a line break, a smaller minimum, another scale limit). Ask the user to choose; never pick one yourself.
- precomps: "auto" (default) reformats a full-frame precomp only when a rule names a layer inside it.

## Verify

- [ ] Read back with ae_get_keyframes or ae_get_layer_bounds, and compare with the intended numbers.
- [ ] Look: ae_render_frame at the key frames, ae_render_contact_sheet (frames or times) for the motion.
- [ ] Report numbers: frames, speeds, influences, pixel positions, any residual.
