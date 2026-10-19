// Which command-line commands may move a 1.3 installation (~/.aemcp) and point AI app settings at the
// new place before they run. Only the server itself (no command, or only options) and the commands
// that set things up; install and update do it themselves. Commands that only read (clients, test,
// selftest, checkpoints, checkpoint-diff, diagnostics, activity, `update --check`, unknown ones) never
// move anything or change any settings: at most they report that the move is pending.
const MOVING_COMMANDS = new Set(["setup", "connect", "disconnect", "chatgpt"]);

export function movesLegacyBeforeRunning(cmd: string | undefined): boolean {
  return !cmd || cmd.startsWith("-") || MOVING_COMMANDS.has(cmd);
}
