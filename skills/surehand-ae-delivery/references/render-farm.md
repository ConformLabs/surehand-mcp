# Render farm and chunked renders

ae_farm finds why a render would fail on another machine before it does, splits a render into frame chunks, and
proves the chunks add up. In a chat with only the core tools loaded, run it as ae_call {tool: "ae_farm", args: {...}}.
It never runs anything on another machine: other machines get scripts and a manifest to check against.

## Rules

- The render queue item's own render settings and output module are the source of truth. Never change them to suit
  the farm without asking; when a plan is refused (several output modules, "Starting #" numbering for a chunked
  sequence, the render settings' own frame rate), tell the user the exact fix the refusal names and let them decide.
- aerender renders the project as saved on disk. Save first (ae_save_project), then plan.
- Report verdicts as given: check and verify say PASS, WARNINGS (n), FAIL (n) or INCOMPLETE (...). INCOMPLETE is not
  a pass.
- Quote missing or extra frames exactly as the report lists them.
- Existing files are never replaced: pass overwrite: true only when the user wants the old manifest, plan or render
  replaced.
- ffmpeg (for movie checks) is downloaded only with the user's explicit consent: ask first, then pass
  allowFfmpegDownload: true.

## Workflow

1. **Manifest:** ae_farm {action: "manifest", save: true} (default: the queued items; rqIndex: [n] for others).
   - It lists the After Effects version, bit depth, colour settings and OCIO config, expressions engine, every plug-in
     by match name (third-party ones marked), fonts, every file the render pulls in through its precomps (sequence
     ranges and gaps, proxies the render uses) and the outputs.
   - Paths marked LOCAL are on this machine only (home folder, Desktop, a local disk): other machines can't read them.
     Ask the user which folders are shared and pass sharedPaths, or have them move the files to a share.
2. **Check a node:** on the node, `surehand-ae farm check <manifest.json>` (no After Effects needed), with
   `--map <from>=<to>` when it sees the share at another path and `--ae <folder>` for a non-default install. In a
   chat on that machine: ae_farm {action: "check", manifest: "<path>"} (asks the running After Effects too).
3. **Plan:** ae_farm {action: "plan", rqIndex, processes} for this machine, or machines: [{name, platform,
   aerender?, pathMap?, weight?}] for several. It writes farm-plan.json and one script per machine (.command on macOS,
   .bat on Windows) next to the project. dryRun: true shows it first.
   - Sequences: every chunk writes into the same sequence (files numbered by comp frame).
   - Movies: each chunk writes its own file. The join is lossless by stream copy only for intra-frame codecs (ProRes,
     DNx, Animation...) with PCM audio on whole samples. For H.264, HEVC or AAC audio the plan says it is not lossless:
     recommend rendering an image sequence in chunks and making the final file from it in one go.
   - The estimate comes from ae_render_profile measurements of the comp, else a few frames sampled now; it leaves out
     aerender's start-up. Say so when you quote it.
   - -s / -e are the frame numbers After Effects shows, from the comp's start frame (a comp that starts at
     01:00:00:00 at 25 fps renders 90000 onwards). Quote frames that way to the user.
4. **Run here:** ae_farm {action: "run_local"} uses the plan next to the open project (or pass plan, or rqIndex when
   several items have one). It runs at most as many aerender processes as this machine's cores and memory allow and
   starts the rest as those finish. The renders go on if the AI app reloads. Progress: ae_farm {action: "status"}
   (the latest run; it only reports); cancel: status with cancel: true. A run reported as interrupted resumes with
   ae_farm {action: "run_local", run} only when it is recent and the project is unchanged; otherwise tell the user
   and give the commands status lists.
5. **Verify:** ae_farm {action: "verify"} wherever the chunks ran. It looks at a few frames (all the same flat
   picture fails) and, with the project open in After Effects, compares 2 of them with its own render. join: true
   joins movie parts when that is lossless; proveFrames: n makes the pixel proof strict. The report gives the -s / -e
   ranges of every frame to render again.
