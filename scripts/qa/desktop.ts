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
/** Permission requests the peer sent, by JSON-RPC id, until the client answers. */
const asked = new Map<string, (outcome: unknown) => void>();
let askSeq = 0;
const state = () => ({
	modes: { currentModeId: "default", availableModes: [{ id: "default", name: "표준" }, { id: "plan", name: "계획" }, { id: "bypass", name: "권한 무시" }, { id: "dont-ask", name: "묻지 않기" }] },
	configOptions: [
		{ id: "model", category: "model", name: "모델", type: "select", currentValue: "offline-peer", options: [{ value: "offline-peer", name: "OFFLINE QA · 추론 없음" }] },
		{ id: "effort", name: "추론 강도", type: "select", currentValue: "high", options: [{ value: "high", name: "high" }] },
	],
});
const outcomes: unknown[] = [];
/** The agent asks the client for permission; resolves with the client's outcome. */
const ask = (sessionId: string, toolCall: object, meta?: object, options?: object[]) => new Promise<unknown>((resolve) => {
	const id = `perm-${++askSeq}`;
	asked.set(id, resolve);
	channel.onmessage(JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
		sessionId, toolCall, _meta: meta,
		options: options ?? [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
	} }));
});
/** A CLI question (ask_user_question, exit_plan_mode's approval): answers are
 * `option_N` permission options of kind allow_once, as `cmd acp` sends them. */
const question = (sessionId: string, title: string, labels: string[]) => {
	const toolCallId = `question-${askSeq + 1}`;
	return ask(sessionId, { toolCallId, title, kind: "other", rawInput: { options: labels } }, undefined,
		labels.map((label, index) => ({ optionId: `option_${index + 1}`, name: label, kind: "allow_once" })));
};
const reply = (id: number, result: unknown) => channel.onmessage(JSON.stringify({ jsonrpc: "2.0", id, result }));
const update = (sessionId: string, value: object) => channel.onmessage(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } }));
const peer = async (method: string, args: Record<string, unknown>) => {
	if (method === "acp_kill") return;
	if (method !== "acp_send") throw new Error(`Unexpected IPC: ${method}`);
	const message = JSON.parse(String(args.line));
	if (!message.method && typeof message.id === "string") {
		asked.get(message.id)?.(message.result?.outcome);
		asked.delete(message.id);
		return;
	}
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
			if (peerMode === "edit-request" && !verifier && nodeId !== "implement") {
				// A read-only role asking to write: the app must refuse it unseen.
				outcomes.push(await ask(params.sessionId, { toolCallId: `edit-${nodeId}`, title: "Edit: src/main.ts", kind: "edit" }));
			}
			if (peerMode === "allowed-write" && !verifier) {
				// dont-ask runs what the user's allow rules permit without asking.
				update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: `write-${nodeId}`, title: "Edit: src/main.ts", kind: "edit", status: "completed" });
			}
			if (peerMode === "nag" && !verifier) {
				// A role that never stops asking: the app must give up on it.
				for (let round = 0; round < 8; round += 1) {
					const outcome = await question(params.sessionId, "Next step: 무엇을 할까요?", ["더 조사", "형식 변경"]);
					outcomes.push(outcome);
					if ((outcome as { outcome?: string } | undefined)?.outcome === "cancelled") break;
				}
			}
			if (peerMode === "live" && !verifier) {
				// What a live CLI role did: narrate, call a tool, ask to leave plan
				// mode, then ask what to change.
				update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll check the sources first." } });
				update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: `fetch-${nodeId}`, title: "Fetch: https://example.org", kind: "fetch", status: "completed" });
				outcomes.push(await question(params.sessionId, "Exit Plan: Exit plan mode and begin implementation?",
					["Yes, auto-accept edits: Exit plan mode and implement", "Cancel: Stay in plan mode — run /plans to annotate"]));
				outcomes.push(await question(params.sessionId, "Next step: 무엇을 조정할까요?", ["범위 확장", "현재 내용으로 충분 (Recommended)"]));
				outcomes.push(await question(params.sessionId, "Enter plan mode?", ["Yes (Recommended)", "No"]));
				if (nodeId === "synthesis") {
					output = `${output}\n\n\`\`\`json\n${JSON.stringify({
						claims: [{ id: "C1", text: "QA claim", type: "R4", supports: ["S1"], refutes: [], status: "confirmed" }],
						sources: [{ id: "S1", url: "https://example.org", title: "QA", checkedAt: "2026-11-02", grade: "P1" }],
						openQuestions: [],
					})}\n\`\`\``;
				}
			}
			if (verifier) {
				verifyCount += 1;
				// The command the verifier ran, as the app sees it in the session.
				update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: `test-${verifyCount}`, title: "Shell: pnpm test", kind: "execute", status: "in_progress" });
				update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: `test-${verifyCount}`, status: "completed" });
				output = peerMode === "malformed" ? "not-json" : JSON.stringify({
					passed: peerMode !== "retry" || verifyCount > 1,
					evidence: ["Offline peer transport receipt"],
					issues: peerMode === "retry" && verifyCount === 1 ? ["QA: repeat verification"] : [],
				});
				// Live verifiers narrate before the verdict.
				if (peerMode === "live") output = `I'll independently verify the key claims.${output}`;
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

// A plain browser has no Tauri bridge; answer the two commands the composer
// and export use with fixtures. A native WebView keeps its real bridge.
const fixture = [
	{ type: "message", message: { role: "user", content: "README 요약해 줘" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "요약입니다." }] } },
].map((entry) => JSON.stringify(entry)).join("\n");
const saved: { name?: string; content?: string }[] = [];
if (!("__TAURI_INTERNALS__" in window)) {
	Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: { name?: string; content?: string }) => {
		if (cmd === "list_files") return ["README.md", "src/main.ts", "src/views/chat.ts", "src-tauri/src/files.rs"];
		if (cmd === "read_transcript") return fixture;
		if (cmd === "save_text_file") {
			saved.push({ name: args.name, content: args.content });
			return `/offline-qa/${args.name}`;
		}
		throw new Error(`no Tauri bridge: ${cmd}`);
	} } });
}

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
		outcomes,
		saved,
		setMode(mode: string) { peerMode = mode; verifyCount = 0; },
		/** Put the chat in a mode as the agent would report it (no confirm dialog). */
		agentMode(modeId: string) {
			if (!view.sessionId) throw new Error("Not ready");
			update(view.sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
		},
		/** The chat's agent asks for permission; `risk` adds the CLI's `_meta.risk`. */
		ask(risk?: string) {
			if (!view.sessionId) throw new Error("Not ready");
			return ask(view.sessionId, { toolCallId: `ask-${askSeq + 1}`, title: "Shell: rm -rf ../shared", kind: "execute" },
				risk ? { risk: { kind: risk, detail: "../shared" } } : undefined);
		},
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
