// Run with: bun scripts/qa/acp-v2.mjs. No LLM, no agent process — the checks
// are static contract assertions over the ACP client/types/chat source plus
// pure-function tests. A live protocol run is a separate gate (cmd absent on
// this machine), never silently marked passed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codexPreset, parseCommandLine } from "../../src/backends.ts";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const types = read("src/acp/types.ts");
const client = read("src/acp/client.ts");
const chat = read("src/views/chat.ts");
const lib = read("src-tauri/src/lib.rs");
const conf = read("src-tauri/tauri.conf.json");
const acp = read("src-tauri/src/acp.rs");
const caps = read("src-tauri/capabilities/default.json");

const receipts = [];
const check = (name, ok) => { assert.ok(ok, name); receipts.push({ check: name, ok: true }); };

// --- P0: protocol version negotiation and v2 surface ---------------------
check("protocol version 2 offered", /const PROTOCOL_VERSION = 2/.test(client));
for (const kind of ["plan_update", "state_update", "tool_call_content_chunk",
	"user_message", "agent_message", "agent_thought", "terminal_update", "terminal_output_chunk"]) {
	check(`SessionUpdate covers ${kind}`, types.includes(`"${kind}"`));
}
check("v1 update kinds still accepted", types.includes('"plan"') && types.includes('"agent_message_chunk"'));
check("elicitation capability advertised", client.includes("elicitation: { form"));
check("elicitation/create is served", client.includes('"elicitation/create"'));
check("$/cancel_request on timeout", client.includes('"$/cancel_request"'));
check("cancelSession pairs session/cancel with $/cancel_request",
	client.includes("cancelSession") && client.includes('notify("session/cancel"'));
check("session/delete capability-gated", client.includes("canDelete") && client.includes('"session/delete"'));
check("authMethods exposed", client.includes("authMethods") && client.includes('"auth/login"'));
check("chat prefers session/resume over load", chat.includes('"session/resume"') && chat.includes('"session/load"'));
check("chat renders plan_update", chat.includes('case "plan_update"'));
check("chat renders state_update", chat.includes('case "state_update"'));
check("agent-owned terminals get a card", chat.includes("upsertTerminal"));
check("role sessions decline elicitation unattended", chat.includes('{ action: "decline" }'));
check("replayed v2 kinds are not doubled", chat.includes('"plan_update"') && chat.includes('"agent_message"'));
check("chat cancels via cancelSession", !chat.includes('connection.notify("session/cancel"'));

// Field names verified against the live spec/agents on 2026-11-03 (see
// live-init.mjs): v2 renamed request/response keys — guard the compat shim.
check("$/cancel_request uses requestId", client.includes('"$/cancel_request", { requestId: id }'));
check("initialize sends both v1+v2 param shapes",
	client.includes("capabilities,") && client.includes("clientCapabilities: capabilities") && client.includes("info,") && client.includes("clientInfo: info"));
check("initialize retries v1-only on -32602", /error\.code === -32602[\s\S]{0,200}protocolVersion: 1/.test(client));
check("v2 initialize response normalized", client.includes("normalizeInitialize"));
check("configId normalized to id", types.includes("normalizeConfigOptions") && types.includes("configId"));
check("methodId normalized to id", client.includes("m.id ?? m.methodId"));
check("chat normalizes configOptions", (chat.match(/normalizeConfigOptions/g) ?? []).length >= 3);

// --- P2: generic ACP backends -------------------------------------------
check("acp_spawn accepts a custom agent", acp.includes("agent: Option<AgentSpec>"));
check("custom agent spawns from spec, builtin still clears env",
	acp.includes("cmd.args(&spec.args)") && acp.includes(".env_clear()"));
const win = parseCommandLine("npx -y @agentclientprotocol/codex-acp", true);
assert.equal(win.program, "cmd.exe");
assert.deepEqual(win.args, ["/c", "npx", "-y", "@agentclientprotocol/codex-acp"]);
const unix = parseCommandLine("codex-acp --flag 'a b'", false);
assert.equal(unix.program, "codex-acp");
assert.deepEqual(unix.args, ["--flag", "a b"]);
assert.equal(parseCommandLine("  ", false), null);
assert.equal(codexPreset(true).spec.program, "cmd.exe");
assert.equal(codexPreset(false).spec.program, "npx");
receipts.push({ check: "parseCommandLine/codexPreset", ok: true });

// --- P3: worktree isolation ---------------------------------------------
for (const cmd of ["worktree_create", "worktree_changes", "worktree_file_diff", "worktree_remove"]) {
	check(`tauri command ${cmd} registered`, lib.includes(`worktree::${cmd}`));
}
check("run carries isolate flag", read("src/workflow.ts").includes("isolate?: boolean"));
check("role sessions use the worktree cwd", chat.includes("run.workdir ?? this.cwd"));
check("changes panel renders diffs", read("src/ui/execution.ts").includes("showChanges"));

// --- P4: updater ---------------------------------------------------------
check("updater plugin registered", lib.includes("tauri_plugin_updater"));
check("updater endpoint configured", conf.includes("latest.json") && conf.includes('"pubkey"'));
check("updater artifacts on build", conf.includes("createUpdaterArtifacts"));
check("updater permission granted", caps.includes("updater:default"));
check("installed-build check wired", read("src/main.ts").includes("downloadAndInstall"));

console.log(JSON.stringify({ passed: true, checks: receipts.length, receipts }, null, 2));
