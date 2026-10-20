# Localization round trip

ae_localize exports every text of a comp tree for translators, builds one version per language from the
translated file, fits each text by the user's own rules and checks every language. In a chat with only the core
tools loaded, run it as ae_call {tool: "ae_localize", args: {action: ..., ...}}.

## Rules

- Fit rules come from the user: the minimum font size or cap height, the tracking range, how far a box may grow,
  the most width a point text may take, and their order. Never invent one. Without rules nothing is adjusted and a
  text that doesn't fit FAILs. A missing rule is a question for the user.
- Fonts for a language come from the user too (fonts: {"he": {"*": "TheirHebrewFont-Regular"}}, PostScript names).
  A Latin font usually has no Hebrew or Arabic glyphs: the glyph check FAILs and names the characters.
- Always dry-run first (dryRun: true): show the user what each language gets and every problem.
- Report the verdict word exactly as given: PASS, FAIL (n of m languages), WARNINGS or INCOMPLETE. INCOMPLETE is not
  a pass: say which checks didn't run and why.
- Never pass overwrite: true unless the user said to replace those files or comps.

## Workflow

1. **Export:** ae_localize {action: "export", comp, file: "/loc/main.csv", languages: ["he", "ar"]}.
   - CSV (UTF-8 with a BOM, opens right in Excel): a column per language for the translator to fill.
   - XLIFF 1.2 for CAT tools: file: "/loc/main_{lang}.xlf" and sourceLanguage.
   - maxChars: a number, or "fromBox" (estimated from each box or the width it has). notes: per layer name or id.
   - Each string carries its comp, layer, time on screen, box size or the width it has, and context (keyframe,
     expression, hidden layer, used several times).
2. **Translate:** the user (or their translators) fills the file. Excel: save as "CSV UTF-8".
3. **Drift (optional):** ae_localize {action: "drift", file} lists master texts changed since the export, per language.
4. **Dry run:** ae_localize {action: "import", file, fit, fonts, dryRun: true}.
5. **Import:** the same call without dryRun (checkpoint: true for a big project). One undo step: one ae_undo removes
   every language. The comp tree is duplicated per language ("{comp} [{lang}]" by default): the root and every
   precomp holding a translated text; the copies use each other.
6. **Report** the verdict, each failing language with what and where, and the "adjusted within your rules" lines.
7. **Fix and rebuild:** shorter translation, other rules (ask the user), ae_undo, import again.

## Fit rules

fit: {steps: [...], maxWidth or maxWidthOfSource}, fitLayers: per layer (layer, comp) with the same fields.

- {adjust: "tracking", min: -40}: tracking down to min.
- {adjust: "fontSize", min: 36} or {adjust: "capHeight", min: 24}: cap height in comp px, measured on the font.
- {adjust: "horizontalScale", min: 90}: percent.
- {adjust: "boxWidth" | "boxHeight", maxGrow: 120}: paragraph boxes grow away from the edge the text is aligned to.
- Steps run in the given order; each goes only as far as needed. When the text still doesn't fit with every step
  at its limit, it is left at that best attempt and FAILs with what was tried. Never below a minimum.
- Paragraph text fits when it doesn't overflow its box; point text when it is within maxWidth (comp px) or
  maxWidthOfSource (a multiple of the master's width).

## Right to left (Hebrew, Arabic, Persian, Urdu, Yiddish...)

- Set from the language code (he, ar, fa, ur, yi...; direction: {"xx": "rtl"} for others): paragraph direction right
  to left, the Universal composer (formerly South Asian and Middle Eastern, needed for Arabic shaping), and
  alignment mirrored (left becomes right; centred stays). rtl.justification: "keep" leaves alignment.
- Point text whose alignment flips keeps its place: its anchor point moves so the text ends where the master's did.
- Not done by scripts: mirroring the layout itself (positions, slide-in directions), kashida justification, and
  per-character direction overrides. Say so when the design needs them.
- After Effects before 24.0 can't set the direction from scripts: those versions FAIL and name the panel setting.

## What is checked per language

- Every text read back where it renders (expressions applied); the font the font map gives.
- The fit by the rules; right-to-left direction and composer.
- Paragraph overflow, text inside the frame or title- / action-safe (checks.textMustBeIn with the user's margins)
  on every frame, missing glyphs and missing fonts: Preflight's own checks.
- Untranslated strings FAIL (allowUntranslated: true makes them warnings); a master text changed since export is a
  warning on the import and a line in the drift report.
