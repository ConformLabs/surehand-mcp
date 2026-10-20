# Faster renders, proven unchanged

ae_render_profile finds where a comp's render time goes and keeps a speed-up only when the picture is proven unchanged.
It is on demand in a core-tools chat: run it with ae_call.

## Measure

ae_render_profile {action: "measure", comp: ...}

- Default: 24 frames over the work area, median of 3 renders each, the 2 slowest frames for the layer and effect costs.
  startFrame / endFrame narrow the range; frames and runs trade time for detail.
- timeBudgetSeconds (default 300) stops new measurements. Quote what was measured; never fill in what wasn't.
- Every switch is put back and read back. Quote the "Project unchanged" line, including what it says about the undo
  history and unsaved changes. If it says PROJECT CHANGED, stop and tell the user before any other edit.
- Never run ae_undo to clean up after a profile: the switch steps cancel each other, and Undo could revert user work.

## Read it

- Heat map and slowest ranges: per sampled frame; frames in between are estimates.
- Layer and effect costs overlap (mattes, adjustment layers, expressions): don't add them up.
- [can apply]: optimize can apply and prove it. [advice]: explain it, the user decides. [unknown]: say it is unknown
  (Multi-Frame Rendering support can't be read from scripting).

## Optimize

ae_render_profile {action: "optimize", id, findings: ["F1", ...]}

- Saves a checkpoint, then applies each finding as its own undo step and proves it with ae_prove_identical at the
  default tolerance.
- KEPT (IDENTICAL or IDENTICAL WITHIN TOLERANCE): report it with the time saved as given (measured frames, plus the
  estimate for the range).
- NOT KEPT (DIFFERS or NOT PROVEN): it was put back automatically and read back. If it says it could NOT be put
  back, tell the user and restore the checkpoint before anything else.
- Never apply an advice finding by hand to get a speed-up without proving it with ae_prove_identical.
