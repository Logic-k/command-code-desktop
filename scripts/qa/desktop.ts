/// <reference types="vite/client" />
// Deterministic in-memory ACP peer. Runs the real ChatView/client/workflow/panel
// and JSON-RPC request/receive paths, not the Rust stdio bridge or a live model.
import "../../src/styles.css";
import { ChatView } from "../../src/views/chat";
import { AcpConnection } from "../../src/acp/client";
import { defaultSettings } from "../../src/store";


const records: { method: string; params: Record<string, unknown> }[] = [];
const sessions = new Set<string>();
let sequence = 0;
let channel: { onmessage(line: string): void };
let verifyCount = 0;
let peerMode = "retry";
let pending: { id: number; sessionId: string }[] = [];
const state = () => ({
	modes: { currentModeId: "default", availableModes: [{ id: "default", name: "표준" }, { id: "plan", name: "계획" }] },
	configOptions: [
		{ id: "model", category: "model", name: "모델", type: "select", currentValue: "offline-peer", options: [{ value: "offline-peer", name: "OFFLINE QA · 추론 없음" }] },
		{ id: "effort", name: "추론 강도", type: "select", currentValue: "high", options: [{ value: "high", name: "high" }] },
	],
});
const reply = (id: number, result: unknown) => channel.onmessage(JSON.stringify({ jsonrpc: "2.0", id, result }));
const update = (sessionId: string, value: object) => channel.onmessage(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } }));
const peer = async (method: string, args: Record<string, unknown>) => {
	if (method === "acp_kill") return;
	if (method !== "acp_send") throw new Error(`Unexpected IPC: ${method}`);
	const message = JSON.parse(String(args.line));
	const params = message.params ?? {};
	records.push({ method: message.method, params });
	switch (message.method) {
		case "initialize":
			reply(message.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, agentInfo: { name: "Offline ACP peer", version: "1" } });
			break;
		case "session/new": {
			const sessionId = `qa-${++sequence}`;
			sessions.add(sessionId);
			reply(message.id, { sessionId, ...state() });
			break;
		}
		case "session/set_mode":
		case "session/set_config_option":
			reply(message.id, state());
			break;
		case "session/close":
			sessions.delete(params.sessionId);
			reply(message.id, {});
			break;
		case "session/cancel":
			for (const item of pending.filter((item) => item.sessionId === params.sessionId)) reply(item.id, { stopReason: "cancelled" });
			pending = pending.filter((item) => item.sessionId !== params.sessionId);
			break;
		case "session/prompt": {
			if (peerMode === "hold") {
				pending.push({ id: message.id, sessionId: params.sessionId });
				break;
			}
			const prompt = String(params.prompt[0].text);
			const nodeId = prompt.match(/^workflowNode: (.+)$/m)?.[1] ?? "";
			const verifier = nodeId.startsWith("verify-");
			let output = "OFFLINE QA result: local transport exercised. This is not live research evidence.";
			if (nodeId === "reflect") output = JSON.stringify({ lessons: ["QA-only lesson: measure before changing; invocation: local ACP peer"] });
			if (verifier) {
				verifyCount += 1;
				output = peerMode === "malformed" ? "not-json" : JSON.stringify({
					passed: peerMode !== "retry" || verifyCount > 1,
					evidence: ["Offline peer transport receipt"],
					issues: peerMode === "retry" && verifyCount === 1 ? ["QA: repeat verification"] : [],
				});
			}
			update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
			reply(message.id, { stopReason: "end_turn" });
			break;
		}
		default: throw new Error(`Unexpected RPC: ${message.method}`);
	}
};

// Tauri internals are immutable in a native WebView. Intercept only the private
// boot/send seam in this QA entry point, leaving request matching and UI intact.
Object.defineProperty(AcpConnection.prototype, "boot", { value: async function(this: AcpConnection) {
	this.alive = true;
	channel = { onmessage: (line) => Reflect.get(this, "receive").call(this, line) };
	this.info = await this.request("initialize", { protocolVersion: 1 });
} });
Object.defineProperty(AcpConnection.prototype, "send", { value: function(message: object) {
	return peer("acp_send", { line: JSON.stringify(message) });
} });

// The offline peer never touches this directory. Keep the default independent
// of the original workstation; a caller can supply ?cwd=... for a named fixture.
const qaCwd = new URL(window.location.href).searchParams.get("cwd") || "/offline-qa/project";
const view = new ChatView({
	settings: () => ({ ...defaultSettings, sendKey: "enter", theme: "dark" }),
	setTitle: () => undefined,
	setBusy: () => undefined,
	attention: () => undefined,
	openTerminal: () => undefined,
	login: () => undefined,
	access: () => ({ billing: null, catalog: null }),
	openAccounts: () => undefined,
	reportLimit: () => undefined,
}, { cwd: qaCwd, accountId: null, accountName: "OFFLINE QA · 외부 추론 없음" });
document.body.append(view.root);
document.body.style.display = "flex";
view.root.style.width = "100%";
Object.assign(window, {
	qa: {
		records,
		sessions,
		setMode(mode: string) { peerMode = mode; verifyCount = 0; },
		observe() {
			const sessionId = view.sessionId;
			if (!sessionId) throw new Error("Not ready");
			update(sessionId, { sessionUpdate: "tool_call", toolCallId: "legacy-plan", title: "ulw_plan", rawInput: {
				objective: "Legacy ULW replay", nodes: [{ id: "worker", label: "Research", role: "ulw-worker", dependsOn: [] }],
			} });
			update(sessionId, { sessionUpdate: "tool_call", toolCallId: "legacy-node", title: "ulw_node", rawInput: { id: "worker", status: "done" } });
		},
		dispose() { view.dispose(); },
	},
});
