---
name: surehand-ae-safe-restructure
description: Restructures After Effects projects without changing the picture (un-precompose, merge precomps, bake expressions, reorder effects) with pixel proof. Use for cleaning up an inherited .aep.
license: MIT
---

# Restructure without changing the picture

Structural edits must leave every rendered pixel as it was. The Surehand MCP server (surehand-ae) proves it with
ae_prove_identical. Follow the surehand-ae skill for every edit.

Applies to: un-precomposing, merging or splitting precomps, baking expressions to keyframes, reordering effects,
simplifying rigs (parenting, nulls, expression controls), and renames that expressions depend on.

## Inherited project: understand it first

1. ae_project_xray: what the render queue pulls in, precomp trees, what every expression reads, links that break
   on rename or reorder, missing items, what makes it heavy. On big projects, narrow it with comps and sections.
2. ae_get_comp_map on the comps you will touch.
3. ae_project_history {action: "snapshot", label: "before"}: records the starting state.
4. ae_checkpoint {action: "save", label: "..."} before the first edit.

ae_project_xray and ae_project_history are on demand in a core-tools chat: run them with ae_call.

## Prove every structural edit

One call: ae_prove_identical {action: "run", comps: [...], steps: [...]}.

- steps are ae_batch steps ({tool, args}). They run as one undo step, atomic by default.
- comps: the comps whose picture must not change (up to 4). For un-precompose, prove the parent comp.
- frames (default 5 over the work area) or times: cover what moves, including keyframed sections,
  expression-driven moments, and the first and last frames.
- tolerance: the default 0.5/255 allows only high-bit-depth rounding; 0 requires bit-identical. Never raise it to
  make a difference go away.

When the edit takes several calls or needs a look in between: {action: "capture"}, the edits, then
{action: "compare", id}.

## Read the verdict

- **IDENTICAL** or **IDENTICAL WITHIN TOLERANCE:** report it with the comps and frames checked. Say that only the
  sampled frames were compared (not audio, not the times between samples).
- **DIFFERS:** never call it identical.
  - Look at what differs: frames, area, largest difference.
  - Then either ae_undo the edit, or explain exactly what changed and why, and let the user decide.
- **The batch failed:** nothing was compared, and atomic steps were undone. Fix the step and run again.
- **The comparison failed after the batch:** the edit WAS applied. Compare again with the proof id, or ae_undo.

## Show what changed

- ae_project_history {action: "diff", from: "before"}: the comps, layers, values, keyframes, expressions and
  effects that changed. Together with the proof: the structure changed, the picture didn't.
- Between two versions: take a snapshot of each (ae_checkpoint save stores one too), then diff with from and to
  set to their labels.

## Checklist

- [ ] X-ray and comp map read
- [ ] Checkpoint saved, history snapshot taken
- [ ] Every structural edit proved, verdict quoted as given
- [ ] Every DIFFERS undone or explained
- [ ] History diff shown to the user
