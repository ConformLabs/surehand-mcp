// Which scripting features the connected After Effects version has. Used by ae_system_info,
// diagnostics and `surehand-ae selftest --full`, so behaviour differences between AE versions are visible.
export const CAPABILITIES_JSX = `
var c = app.project.items.addComp("__aemcp_caps", 64, 64, 1, 1, 30), f = {};
try {
  var t = c.layers.addText("ab"), td = t.property("ADBE Text Properties").property("ADBE Text Document").value;
  var op = t.property("ADBE Transform Group").property("ADBE Opacity");
  var has = function (o, k) { try { return typeof o[k] !== "undefined"; } catch (e) { return false; } };
  var rq = app.project.renderQueue.items.add(c);
  f.perCharacterText = has(td, "characterRange");
  f.paragraphRanges = has(td, "paragraphRange");
  f.renderSettingsApi = has(rq, "getSettings") && has(rq.outputModule(1), "getSettings");
  f.mediaEncoderQueue = has(app.project.renderQueue, "queueInAME");
  rq.remove();
  f.essentialGraphics = has(op, "addToMotionGraphicsTemplateAs");
  f.mogrtExport = has(c, "exportAsMotionGraphicsTemplate");
  f.fontsApi = !!app.fonts;
  f.missingFontsApi = !!app.fonts && has(app.fonts, "missingOrSubstitutedFonts");
  f.keyframeLabels = has(op, "setLabelAtKey");
  f.layerIds = has(t, "id");
  f.anyLayerTrackMatte = has(t, "setTrackMatte");
  f.revision = (function () { try { return typeof app.project.revision === "number"; } catch (e) { return false; } })();
  f.expressionEngine = app.project.expressionEngine;
  f.scriptsCanWriteFiles = (function () { try { return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; } catch (e) { return null; } })();
} finally { c.remove(); }
return { appVersion: app.version, os: $.os, features: f };`;

export const FEATURE_NOTES: Record<string, string> = {
  perCharacterText: "ae_style_text_range (AE 24.0+)",
  paragraphRanges: "per-paragraph settings in ae_set_paragraph (AE 24.0+)",
  renderSettingsApi: "ae_get/set_render_settings",
  mediaEncoderQueue: "ae_queue_in_media_encoder",
  essentialGraphics: "ae_essential_graphics",
  mogrtExport: "ae_export_mogrt",
  fontsApi: "ae_get_fonts (AE 24.0+)",
  missingFontsApi: "missing-font check in ae_project_health and ae_project_xray (AE 24.0+)",
  keyframeLabels: "keyframe color labels in ae_edit_keyframes (AE 22.6+)",
  layerIds: "stable layer ids for the change report (AE 22.0+; older versions match layers by index+name)",
  anyLayerTrackMatte: "track matte to any layer in ae_set_layer_attributes (AE 23.0+)",
  revision: "fast read-only mode and change reports: property snapshots are skipped when nothing changed (app.project.revision)",
};
