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

ae_project_xray, ae_project_history and ae_precomp_surgery are on demand in a core-tools chat: run them with ae_call.

## Un-precompose and deep duplicate: ae_precomp_surgery

Don't script these by hand: ae_precomp_surgery rewrites every expression reference exactly, refuses what it can't
reproduce, and proves the picture before it changes anything (details: references/precomp-surgery.md).

1. {action: "unprecompose", comp, layer, dryRun: true} or {action: "deep_duplicate", comp, dryRun: true}: the plan.
   Show the user what moves, what is renamed, every expression rewrite and every problem.
2. Problems: report each reason as given. Never work around one with a script. An `override` only when the user
   accepts that those references stay as they are and the pixel proof decides.
3. Run it without dryRun. DONE means proven IDENTICAL and applied. The way back is the one the result names (the
   checkpoint for an un-precompose, {action: "remove_copies", id} for a deep duplicate), not a count of ae_undo steps. DIFFERS means nothing was applied: report the frames, the difference and the
   likely cause, and let the user decide.

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

## Faster renders

To find what makes a comp slow and speed it up without changing the picture: ae_render_profile measure, then optimize
with the findings to apply (details: references/render-profile.md).

## Checklist

- [ ] X-ray and comp map read
- [ ] Checkpoint saved, history snapshot taken
- [ ] Every structural edit proved, verdict quoted as given (un-precompose / deep duplicate with ae_precomp_surgery)
- [ ] Every DIFFERS undone or explained
- [ ] History diff shown to the user
