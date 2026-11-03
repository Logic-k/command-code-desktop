// Live ACP handshake probe: spawn an agent over stdio, send `initialize` with
// the dual v1/v2 param shape, print negotiated version + capabilities, then
// exercise session/new, session/list, session/resume and (with --prompt) a
// real session/prompt. Read-only aside from the optional prompt. Usage:
//   node scripts/qa/live-init.mjs [--prompt] -- <npx-args...>
//   node scripts/qa/live-init.mjs -- -y -p command-code@1.88.2 commandcode acp
import { spawn } from "node:child_process";
import readline from "node:readline";

const argv = process.argv.slice(2);
const withPrompt = argv.includes("--prompt");
const args = argv.filter((a) => a !== "--prompt" && a !== "--");
const cmd = process.platform === "win32" ? "cmd.exe" : "npx";
const cmdArgs = process.platform === "win32" ? ["/c", "npx", ...args] : args;
const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let notifications = 0;
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
rl.on("line", (line) => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
	if (msg.method && msg.id !== undefined) {
		// Agent-to-client request: answer minimally so nothing hangs.
		const result = msg.method === "session/request_permission" ? { outcome: "cancelled" }
			: msg.method === "elicitation/create" ? { action: "cancel" } : null;
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
		return;
	}
	if (msg.method === "session/update" && notifications < 15) {
		notifications += 1;
		const u = msg.params?.update?.sessionUpdate ?? msg.params?.update;
		console.log(`  [update] ${typeof u === "string" ? u : JSON.stringify(u)?.slice(0, 120)}`);
	} else if (msg.method) {
		console.log(`  [notify] ${msg.method}`);
	}
});
const call = (method, params, timeout = 30_000) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, resolve);
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeout);
});
const show = async (label, method, params, timeout) => {
	const res = await call(method, params, timeout).catch((e) => ({ error: String(e) }));
	console.log(`=== ${label} ===`);
	console.log(JSON.stringify(res.result ?? res.error ?? res, null, 2).slice(0, 4000));
	return res.result;
};

try {
	const caps = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {}, url: {} } };
	const info = { name: "qa-live-init", version: "0.0.0" };
	await show("initialize", "initialize", {
		protocolVersion: 2, capabilities: caps, info, clientCapabilities: caps, clientInfo: info,
	}, 60_000);
	const created = await show("session/new", "session/new", { cwd: process.cwd(), mcpServers: [] }, 30_000);
	const list = await show("session/list", "session/list", { cwd: process.cwd() });
	const first = list?.sessions?.[0]?.sessionId;
	if (first) {
		await show(`session/resume ${first.slice(0, 8)}…`, "session/resume", { sessionId: first, cwd: process.cwd(), mcpServers: [] }, 30_000);
	}
	if (withPrompt && created?.sessionId) {
		await show("session/prompt (expect auth error or stream)", "session/prompt", {
			sessionId: created.sessionId, prompt: [{ type: "text", text: "Reply with the single word: ok" }],
		}, 60_000);
	}
} finally {
	child.kill("SIGTERM");
	process.exit(0);
}
