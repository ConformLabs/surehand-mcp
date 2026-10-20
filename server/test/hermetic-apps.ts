// For tests that ask which AI apps are on this computer (clientInstalled): the places outside the home folder that
// detection looks at (/Applications, Homebrew's and /usr/local's bin, commands on PATH through `which` / `where`)
// are stand-ins, so the result never depends on what the machine running the tests has installed. Use as
//   vi.mock("node:fs", (orig) => hermeticFs(orig));
//   vi.mock("node:child_process", (orig) => hermeticChildProcess(orig));
// and put what a test's fake computer has there in `systemFiles` (absolute paths).

/** Files and folders the fake computer has in the system places (cleared by the test as it needs). */
export const systemFiles = new Set<string>();

const SYSTEM = [/^\/Applications\//, /^\/opt\/homebrew\//, /^\/usr\/local\//];
const isSystem = (p: unknown) => SYSTEM.some((re) => re.test(String(p)));

export async function hermeticFs(orig: () => Promise<typeof import("node:fs")>) {
  const real = await orig();
  const existsSync = (p: any) => (isSystem(p) ? systemFiles.has(String(p)) : real.existsSync(p));
  return { ...real, existsSync, default: { ...real, existsSync } };
}

/** `which` / `where` find nothing; every other command runs. */
export async function hermeticChildProcess(orig: () => Promise<typeof import("node:child_process")>) {
  const real = await orig();
  const spawnSync = ((cmd: string, ...rest: any[]) =>
    cmd === "which" || cmd === "where" ? { status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null } : (real.spawnSync as any)(cmd, ...rest)) as typeof real.spawnSync;
  return { ...real, spawnSync, default: { ...real, spawnSync } };
}
