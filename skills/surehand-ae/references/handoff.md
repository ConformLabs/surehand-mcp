# Handing a project off

When the user sends a project to a client, another studio or a render farm, package it with ae_handoff_package
instead of collecting files by hand. It is on demand in a core-tools chat: run it with ae_call.

## Before

1. ae_get_project_info: the project must be saved, with no unsaved changes. If it has some, ask the user whether to
   save (ae_save_project). Don't save without asking: it changes their file.
2. Tell the user what will happen: After Effects saves a copy into the package folder and then opens their project
   again from disk. The project itself is not changed, but its undo history starts fresh.
3. For a proof (verify: true): by default it renders the render queue's comps (any status), else the active comp;
   or pick up to 4 comps for verifyComps. It takes minutes: aerender starts its own After Effects twice.

## The call

ae_handoff_package {folder: "/absolute/path/Package", verify: true}

- collect: "used" (default) copies the footage the comps use; "all" copies every footage item.
- reduce: true leaves unused items out of the package's copy. The user's project keeps them.
- A file that is already in the folder is never replaced unless overwrite: true. Pass it only when the user wants
  that folder's files replaced.

## Reporting

- Give the first line as it is: "Opens clean. Needs: ..." or "Does not open clean: ...", then the verdict line
  (IDENTICAL, DIFFERS or NOT VERIFIED with its reason) and the line about the user's project.
- Never call the package verified when the verdict is NOT VERIFIED, and never call it identical when it DIFFERS.
- Pass on the "Not verified" list: fonts and plug-ins were only checked on this machine, so the recipient needs the
  ones listed (third-party plug-ins with the version After Effects reports, where it reports one).
- handoff.json (for tools) and HANDOFF.txt (for people) are in the package folder. Point the user to HANDOFF.txt to
  send along.

## When it doesn't open clean

- Footage missing: ae_relink_footage finds the files by name in a folder tree. Then package again.
- Unused footage not collected: package again with reduce: true, or collect: "all".
- Missing fonts or plug-ins here: they must be installed on this machine before the package can be checked.
- Expression errors "already in your project" are not caused by the package; new ones are. Find them with
  ae_project_xray (section expressions) before changing anything.
- DIFFERS: show the difference image and the frames. Don't send that package; find the cause first.
