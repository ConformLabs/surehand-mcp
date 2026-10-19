// Per-tool-call context (tool name, cancel signal), available anywhere below the tool handler.
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  tool: string;
  signal?: AbortSignal;
  /** the last script run with an undo group in this call: its undo step name and the revision after it */
  last?: { undoGroup?: string; revision?: number; /** the project's file ("" unsaved) */ project?: string };
  /** how many scripts with an undo group this call ran (the panel's Undo undoes one step only) */
  undoSteps?: number;
  /** the bridge (After Effects instance) that ran the call's scripts */
  instance?: { port: number; pid?: number };
  /** the AI app's name (MCP clientInfo), shown on approval requests in After Effects */
  client?: string;
}

export const callContext = new AsyncLocalStorage<CallContext>();
