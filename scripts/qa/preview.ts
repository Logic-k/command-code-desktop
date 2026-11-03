/// <reference types="vite/client" />
// Screenshot harness: mounts the real ChatView / ExecutionPanel / settings
// backend block with an in-memory ACP peer that streams the new v2 events, so
// the report can show what actually changed. Everything is deterministic.
import "../../src/styles.css";
import { ChatView } from "../../src/views/chat";
import { AcpConnection } from "../../src/acp/client";
import { ExecutionPanel } from "../../src/ui/execution";
import { backendSettingsBlock } from "../../src/ui/settings-backends";
import { defaultSettings } from "../../src/store";
import { codexPreset } from "../../src/backends";
import { isWindows } from "../../src/ui/platform";
import { h } from "../../src/ui/dom";

const scene = new URL(window.location.href).searchParams.get("scene") ?? "chat";

// A registered custom backend makes the header's backend select visible.
localStorage.setItem("cmdc-desktop:backends", JSON.stringify([{ ...codexPreset(isWindows), id: "agent-codex" }]));

let channel: { onmessage(line: string): void };
const reply = (id: number | string, result: unknown) => channel.onmessage(JSON.stringify({ jsonrpc: "2.0", id, result }));
const update = (sessionId: string, value: object) =>
	channel.onmessage(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } }));
const elicit = (params: object) =>
	channel.onmessage(JSON.stringify({ jsonrpc: "2.0", id: `elic-${Date.now()}`, method: "elicitation/create", params }));

const state = () => ({
	modes: { currentModeId: "default", availableModes: [{ id: "default", name: "표준" }, { id: "plan", name: "계획" }, { id: "dont-ask", name: "묻지 않기" }] },
	configOptions: [
		{ id: "model", category: "model", name: "모델", type: "select", currentValue: "gpt-5.2", options: [{ value: "gpt-5.2", name: "GPT-5.2" }] },
	],
});

const peer = async (method: string, args: Record<string, unknown>) => {
	if (method !== "acp_send") return;
	const message = JSON.parse(String(args.line));
	const params = message.params ?? {};
	switch (message.method) {
		case "initialize":
			reply(message.id, {
				protocolVersion: 2,
				agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} } },
				authMethods: [{ id: "chatgpt", name: "ChatGPT 로그인" }],
				agentInfo: { name: "Codex (ChatGPT)", version: "0.4.0" },
			});
			break;
		case "session/new": {
			const sessionId = "preview-session";
			reply(message.id, { sessionId, ...state() });
			// Scripted v2 stream: everything the upgrade added, in one view.
			const tick = (fn: () => void, ms: number) => setTimeout(fn, ms);
			tick(() => update(sessionId, { sessionUpdate: "agent_thought", messageId: "th1", content: [{ type: "text", text: "리서치 캠페인 구조를 먼저 확인하겠습니다." }] }), 300);
			tick(() => update(sessionId, { sessionUpdate: "plan_update", planId: "p1", entries: [
				{ content: "기존 ACP v1 호출 지점 조사", status: "completed", priority: "high" },
				{ content: "v2 업데이트 타입 매핑", status: "completed", priority: "high" },
				{ content: "elicitation 카드 렌더링", status: "in_progress", priority: "medium" },
				{ content: "QA 계약 테스트", status: "pending", priority: "medium" },
			] }), 500);
			tick(() => update(sessionId, { sessionUpdate: "agent_message", messageId: "m1", content: [{ type: "text", text: "`session/resume`으로 전환했습니다. 아래는 새로 처리한 v2 이벤트들입니다." }] }), 700);
			tick(() => update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit: src/acp/types.ts", kind: "edit", status: "completed", content: [
				{ type: "diff", path: "src/acp/types.ts", oldText: "const PROTOCOL_VERSION = 1;", newText: "const PROTOCOL_VERSION = 2;" },
			] }), 900);
			tick(() => update(sessionId, { sessionUpdate: "tool_call_content_chunk", toolCallId: "t1", content: { type: "text", text: "+ plan_update, state_update, elicitation 타입 추가" } }), 1100);
			tick(() => update(sessionId, { sessionUpdate: "terminal_update", terminalId: "term-1", title: "bun scripts/qa/acp-v2.mjs", status: "completed" }), 1300);
			tick(() => update(sessionId, { sessionUpdate: "terminal_output_chunk", terminalId: "term-1", data: '{"passed": true, "checks": 35}\n' }), 1500);
			tick(() => update(sessionId, { sessionUpdate: "state_update", state: "requires_action" }), 1700);
			if (scene === "elicit-url") {
				tick(() => elicit({
					sessionId, mode: "url", elicitationId: "e-1",
					message: "ChatGPT 구독 인증을 위해 아래 주소를 열어 로그인해 주세요.",
					url: "https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann",
				}), 1900);
			} else {
				tick(() => elicit({
					sessionId, mode: "form", message: "리서치 캠페인 실행 전 확인이 필요합니다.",
					requestedSchema: {
						type: "object", required: ["scope", "depth"],
						properties: {
							scope: { type: "string", title: "리서치 범위", enum: ["코드베이스만", "코드+외부문서", "전체"] },
							depth: { type: "number", title: "최대 반복", default: 2, minimum: 1, maximum: 5 },
							fresh: { type: "boolean", title: "기존 캐시 무시", default: false },
							notes: { type: "string", title: "추가 지시 (선택)", maxLength: 200 },
						},
					},
				}), 1900);
			}
			break;
		}
		case "session/prompt":
			reply(message.id, { stopReason: "end_turn" });
			break;
		default:
			reply(message.id, {});
	}
};

Object.defineProperty(AcpConnection.prototype, "boot", { value: async function(this: AcpConnection) {
	this.alive = true;
	channel = { onmessage: (line) => Reflect.get(this, "receive").call(this, line) };
	this.info = await this.request("initialize", { protocolVersion: 2 });
} });
Object.defineProperty(AcpConnection.prototype, "send", { value: function(message: object) {
	return peer("acp_send", { line: JSON.stringify(message) });
} });

if (!("__TAURI_INTERNALS__" in window)) {
	Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (cmd: string) => {
		if (cmd === "worktree_file_diff") return [
			"export function run() {\n\tconsole.log(\"old\");\n}",
			"export function run() {\n\tconsole.log(\"new\");\n\tconsole.log(\"isolated worktree\");\n}",
		];
		if (cmd === "worktree_remove") return null;
		if (cmd === "list_files") return ["src/main.ts"];
		throw new Error(`no Tauri bridge: ${cmd}`);
	} } });
}

const host = {
	settings: () => ({ ...defaultSettings, theme: "dark" as const }),
	setTitle: () => undefined, setBusy: () => undefined, attention: () => undefined,
	openTerminal: () => undefined, login: () => undefined,
	access: () => ({ billing: null, catalog: null }), openAccounts: () => undefined, reportLimit: () => undefined,
};

if (scene === "settings") {
	const wrap = h("div", { class: "settings", style: "max-width:520px;margin:40px auto;display:flex;flex-direction:column;gap:10px" },
		h("h2", null, "설정"), backendSettingsBlock());
	document.body.append(wrap);
} else if (scene === "changes") {
	const panel = new ExecutionPanel("E:/CommandCode_Desktop", { start: () => undefined, cancel: () => undefined });
	panel.root.classList.remove("hidden");
	panel.root.setAttribute("style", "max-width:760px;margin:30px auto;display:block");
	document.body.append(panel.root);
	const wt = { path: "C:/Users/kimmi/AppData/Local/ai.commandcode.cmdcgui/worktrees/ccd-report-4821", root: "E:/CommandCode_Desktop", branch: "ccd-report-4821" };
	panel.showChanges(wt, {
		branch: wt.branch,
		files: [
			{ path: "src/acp/types.ts", status: "M", added: 38, deleted: 3 },
			{ path: "src/backends.ts", status: "A", added: 74, deleted: null },
			{ path: "docs/old-plan.md", status: "D", added: null, deleted: 12 },
		],
	});
	setTimeout(() => panel.root.querySelector<HTMLButtonElement>(".changes-file")?.click(), 600);
} else {
	const view = new ChatView(host, { cwd: "/preview/project", accountId: null, accountName: "kimmi (Go)", backendId: "command-code" });
	document.body.append(view.root);
	document.body.style.display = "flex";
	view.root.style.width = "100%";
}

document.title = `preview-${scene}`;
