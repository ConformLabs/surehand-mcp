# Stress test

ae_stress_test pushes worst-case inputs through every variable a comp exposes and measures each result. In a chat
with only the core tools loaded, run it as ae_call {tool: "ae_stress_test", args: {...}}.

## What it varies

- By default: the comp's Essential Graphics controllers (text, numbers, checkboxes, menus, colours, media) and text
  layers whose Source Text reads data. Name others with targets: [{layer: "Title"}] or {egp: "Price"}.
- Generated worst cases, each with an id: German and Finnish long (scaled from the current text), twice as long, no
  spaces, all caps, Hebrew and Arabic with digits, Japanese, Chinese, Korean, Thai, Hindi, combining marks, emoji,
  empty, one character, three lines; numbers 0, negative, huge, past the slider limit, many decimals, tiny, separators,
  percent; every checkbox and menu state. sets / exclude pick by id or group.
- The user's own values: values: [{target, values: [...]}], or data (a CSV / JSON file or rows) with columns.
  Real data is the strongest test: ask for it when the user has translations or a spreadsheet.
- combinations: "together" (one case on every text at once) or "all" (sampled to maxVariants; the report says what was
  kept).

## Rules

- Margins, minimum sizes, line limits and widths are the user's (checks.title / action, minFontSizePx, maxLines,
  maxWidthPx). Never invent them; without them those checks are left out, and the report says so.
- Everything runs on a scratch copy, removed in the same step. The report ends with the read-back of the user's comp;
  if it says it could NOT be confirmed unchanged, stop and tell the user before any other edit.
- What already fails in the comp as it is is the baseline, listed once. Don't blame it on a variant.
- Report the verdict as given, the failing variants with their measured numbers and frames, and the contact sheet
  paths. Fixes are the user's call: propose them, don't apply them unasked.

## Workflow

1. **Dry run:** ae_stress_test {comp, dryRun: true}: the controls, the variants and the frames. Check the controls
   are the ones the user means.
2. **Run:** ae_stress_test {comp, checks: {...the user's rules}}. Read-only mode returns the plan and the expression
   scan only.
3. **Fix** what the user agrees to (a box that grows, a fit expression, the Universal composer for Arabic, a font
   that covers the script, a number expression that keeps the sign), then run the same test again.
4. **Expressions only:** ae_stress_test {action: "expressions"} lists expressions that break in After Effects in
   another language, with the language-safe form (match name, index or attribute).
