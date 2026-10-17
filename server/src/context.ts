// Per-tool-call context (tool name, cancel signal), available anywhere below the tool handler.
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  tool: string;
  signal?: AbortSignal;
}

export const callContext = new AsyncLocalStorage<CallContext>();
