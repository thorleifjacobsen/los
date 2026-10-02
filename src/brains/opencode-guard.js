// An opencode plugin that los loads into every opencode run (OPENCODE_CONFIG_CONTENT → plugin). opencode's free tier
// refuses requests with its built-in tools switched off, so they stay *declared*, and this hook refuses to *run* them,
// locally, before they do anything. Only los's MCP tools (los_*) run, so every call goes through los: approvals,
// privacy, logging, limits. Plain JS: opencode loads it itself.
export const LosGuard = async () => ({
  "tool.execute.before": async (input) => {
    if (String(input.tool).startsWith("los_")) return;
    throw new Error(
      `"${input.tool}" is switched off here. Use the los_ tools instead: los_shell_run for commands, ` +
      "los_files_read/los_files_write/los_files_edit/los_files_list/los_files_search for files, " +
      "los_web_search/los_web_fetch for the web.",
    );
  },
});
