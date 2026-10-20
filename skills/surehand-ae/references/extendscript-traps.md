# ExtendScript traps

Each of these was seen live in After Effects. The Surehand tools handle them; code you write for ae_run_script must
handle them too.

1. **TextLayer and ShapeLayer are not AVLayer subclasses.** `layer instanceof AVLayer` is false for them, although they
   have the AV layer attributes. To include them, test `instanceof AVLayer || instanceof TextLayer ||
   instanceof ShapeLayer`, or test for the attribute you need.

2. **Influence 0 can be read but not written.** A key switched to Bezier without an explicit ease reads back speed 0
   and influence 0 (so do the unused sides of the first and last keys). `new KeyframeEase(speed, 0)` throws: influence
   must be 0.1 to 100. Clamp when you construct one: `Math.max(0.1, Math.min(100, influence))`.

3. **No scripts while a modal dialog is open.** With Project Settings, Preferences or an alert open, the call fails
   and does not run later. Don't poll or retry in a loop: ask the user to close the dialog, then try once more.

4. **A script can't be interrupted.** While it runs, After Effects and the Surehand panel are frozen. Keep each
   script short, split large jobs, and send many edits as one ae_batch.

5. **`app.project.activeItem` is not always a comp.** It can be null, footage or a folder. Look comps up by name or
   id (`aemcp.findComp(nameOrId)`), and check `instanceof CompItem`.

6. **"Allow Scripts to Write Files and Access Network" off** blocks `system.callSystem` ("Permission denied") and
   network access. Reading and writing files through Surehand still works. If a script needs the shell or the
   network, ask the user to turn the setting on (Settings › Scripting & Expressions); don't work around it.
