// Which command-line commands may move a 1.3 installation (~/.aemcp) and point AI app settings at the
// new place before they run. Only the server itself (no command, or only options) and the commands
// that set things up; install and update do it themselves. Commands that only read (clients, test,
// selftest, checkpoints, checkpoint-diff, diagnostics, activity, `update --check`, unknown ones) never
// move anything or change any settings: at most they report that the move is pending.
const MOVING_COMMANDS = new Set(["setup", "connect", "disconnect", "chatgpt"]);

export function movesLegacyBeforeRunning(cmd: string | undefined, args: string[] = []): boolean {
  // `skills install` / `uninstall` write or remove the zips in ~/.surehand/ae; `skills` alone only reads
  if (cmd === "skills") return args.includes("install") || args.includes("uninstall");
  // `chatgpt --status` / `--stop` only read or stop what runs
  if (cmd === "chatgpt" && (args.includes("--status") || args.includes("--stop"))) return false;
  return !cmd || cmd.startsWith("-") || MOVING_COMMANDS.has(cmd);
}
