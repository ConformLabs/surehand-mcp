export interface BuildInfo {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
}
export function realHome(info?: () => { homedir: string }): string;
export function sha256File(file: string): string;
export function buildInfo(dir: string): BuildInfo;
export function describeBuild(info: BuildInfo): string;
export function acquireLock(
  dir: string,
  opts?: { owner?: Record<string, unknown>; waitMs?: number; pollMs?: number; log?: (line: string) => void },
): Promise<() => void>;
export function interruptedBy(r: { status: number | null; signal: string | null }): "SIGINT" | "SIGTERM" | "SIGHUP" | null;
