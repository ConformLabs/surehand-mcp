// Every tool implemented as an ExtendScript body, in one list (server registration, batches, self-test).
import { appTools } from "./app.js";
import { compTools } from "./comp.js";
import { effectTools } from "./effects.js";
import { footageTools } from "./footage.js";
import { inspectTools } from "./inspect.js";
import { keyframeTools } from "./keyframes.js";
import { layerTools } from "./layer.js";
import { projectTools } from "./project.js";
import { propertyTools } from "./property.js";
import type { JsxTool } from "./registry.js";
import { renderTools } from "./render.js";
import { sceneTools } from "./scene.js";
import { egpTools, healthTools, textTools } from "./text.js";

export const ALL_JSX_TOOLS: JsxTool[] = [
  ...projectTools, ...compTools, ...layerTools, ...propertyTools, ...effectTools, ...renderTools, ...appTools,
  ...inspectTools, ...keyframeTools, ...footageTools, ...textTools, ...egpTools, ...healthTools, ...sceneTools,
];
