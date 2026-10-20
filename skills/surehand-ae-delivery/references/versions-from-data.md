# Versions from data, with every row checked

ae_versions_from_data turns a CSV / JSON file (or rows in the chat) into versions of a source comp, then checks
every row. In a chat with only the core tools loaded, run it as ae_call {tool: "ae_versions_from_data", args: {...}}.

## Rules

- Every format, colour, size and margin comes from the user: their data, their number format, their colour rules,
  their value-to-pixels mapping, their safe-area margins, their output module. Never invent one. A missing rule is a
  question for the user.
- Always start with dryRun: true. Show the user the problems and a few planned rows before building.
- Report the verdict word exactly as given: PASS, FAIL (n of m rows), WARNINGS or INCOMPLETE. INCOMPLETE is not a
  pass: name the checks that didn't run and why.
- Rendering only with render: true when the user asked for it. It renders the rows that PASS. Never pass overwrite:
  true unless the user said to replace those files.

## Workflow

1. **Read the source comp** (ae_get_comp_info): the layer names, which are text, which hold the footage, the bar layer
   and the property to set. Read the data file's columns.
2. **Write the mapping**, one entry per column and target:
   - text: {column, layer, kind: "text"}
   - number: {column, layer, kind: "number", format: {decimals, decimalSeparator, thousandsSeparator, prefix, suffix,
     negative}} with the user's own format
   - colour: {column, layer, kind: "color", property, rules: [{op, value, color}], otherwise}, or the colour in the cell
   - footage: {column, layer, kind: "footage"} (relative paths: from the data file's folder, or footageFolder)
   - any property: {column, layer, kind: "value", property}
   - bar: {column, layer, kind: "size", axis, px: [[value, px], ...]} with the user's mapping
3. **Dry run:** ae_versions_from_data {data, comp, map, name, dryRun: true}. Fix every problem it lists: a column that
   isn't there, a target that isn't a text layer, a keyframed property, a name already in the project, an output file
   that exists.
4. **Build:** the same call without dryRun (checkpoint: true for a big run). It is one undo step: one ae_undo removes
   every version. To queue them: queue: {output: an absolute path pattern like "/renders/{City}_{#3}.mov",
   outputModuleTemplate: the user's own}.
5. **Report** the verdict, the totals and each failing row with what and where. A row fails on the data too (a
   number that isn't one, a file that isn't there, a value outside the bar mapping).
6. **Fix and rebuild:** fix the data or the source comp (ask first when it is a creative decision), ae_undo the run, and
   build again.

## What is checked per row

- Each value read back where it renders (expressions applied): the exact formatted text, the colour the rule gives,
  the property value, the footage file.
- Paragraph text overflowing its box, and mapped text leaving the frame on any frame (checks.textMustBeIn; title- or
  action-safe with the user's margins in checks.title / checks.action).
- Characters missing from the font, and missing fonts.
- Bars: the on-screen width or height at checkAt (default: the last frame), through parents, against the mapping
  within checks.sizeTolerancePx.

## Modes

- duplicate (layer targets): the comp is duplicated per row. Precomps inside are shared by every version, so map
  layers of the source comp itself.
- essentialGraphics (egp targets): a comp per row holds the source comp with that row's Essential Graphics values. The
  values are read back, but the row's layout can't be measured there: layout checks the user asks for come back
  INCOMPLETE. Prefer duplicate when the layout must be checked.
