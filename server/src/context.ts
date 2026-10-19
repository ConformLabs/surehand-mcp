// Per-tool-call context (tool name, cancel signal), available anywhere below the tool handler.
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  tool: string;
  signal?: AbortSignal;
  /** the last script run with an undo group in this call: its undo step name and the revision after it */
  last?: { undoGroup?: string; revision?: number };
}

export const callContext = new AsyncLocalStorage<CallContext>();
