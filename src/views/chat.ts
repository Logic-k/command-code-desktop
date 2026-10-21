// A chat tab: one ACP session rendered as a conversation.
//
// Streaming model: `agent_message_chunk` / `agent_thought_chunk` append to the
// open text segment; anything else (a tool call, a user message) closes it, so
// text written after a tool call starts a new block below that tool's card.

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AcpError, type AcpConnection } from "../acp/client";
import * as pool from "../acp/pool";
import { transcriptUpdates } from "../acp/transcript";
import type {
	AvailableCommand,
	ConfigOption,
	ContentBlock,
	PermissionOutcome,
	PermissionRequest,
	PlanEntry,
	PromptResult,
	SessionMode,
	SessionState,
	SessionUpdate,
	ToolCall,
	ToolContent,
} from "../acp/types";
import type { Settings } from "../store";
import { diffStats, renderDiff } from "../ui/diff";
import { basename, h, svg } from "../ui/dom";
import { type IconName, icons } from "../ui/icons";
import { renderMarkdown, wireMarkdown } from "../ui/markdown";

export interface ChatHost {
	settings(): Settings;
	setTitle(title: string): void;
	setBusy(busy: boolean): void;
	/** The tab wants the user's eyes (permission prompt, finished turn). */
	attention(kind: "permission" | "done" | "error", body: string): void;
	openTerminal(cwd: string, args: string[]): void;
}

interface ChatOptions {
	cwd: string;
	/** Resume this session instead of starting a new one. */
	sessionId?: string;
	title?: string;
	/** Send this as the first message once the session is ready. */
	initialPrompt?: string;
}

interface TextSegment {
	el: HTMLElement;
	body: HTMLElement;
	text: string;
	dirty: boolean;
}

interface ToolEntry {
	data: ToolCall;
	el: HTMLElement;
	open: boolean;
}

interface Attachment {
	mimeType: string;
	data: string;
	url: string;
}

const KIND_ICON: Record<string, IconName> = {
	read: "read",
	edit: "edit",
	delete: "trash",
	move: "move",
	search: "search",
	execute: "execute",
	think: "think",
	fetch: "fetch",
	switch_mode: "settings",
};

const STATUS_LABEL: Record<string, string> = {
	pending: "대기",
	in_progress: "실행 중",
	completed: "완료",
	failed: "실패",
	cancelled: "취소됨",
};

const PERMISSION_LABEL: Record<string, string> = {
	allow_once: "한 번 허용",
	allow_always: "항상 허용",
	reject_once: "거부",
	reject_always: "항상 거부",
};

const MODE_LABEL: Record<string, string> = {
	default: "표준 (매번 확인)",
	"auto-accept": "편집 자동 허용",
	plan: "계획만",
	"dont-ask": "묻지 않기",
	bypass: "권한 무시 (위험)",
};

const SUGGESTIONS = [
	{ title: "이 프로젝트 설명해 줘", prompt: "이 프로젝트의 구조와 핵심 동작을 한국어로 간단히 설명해 줘." },
	{ title: "AGENTS.md 만들기", prompt: "이 프로젝트를 분석해서 에이전트용 안내 파일 AGENTS.md를 만들어 줘." },
	{ title: "테스트 돌리고 실패 고치기", prompt: "테스트를 실행하고, 실패하는 것이 있으면 원인을 찾아 고쳐 줘." },
	{ title: "최근 변경 리뷰", prompt: "git으로 최근 변경 사항을 보고 버그나 개선점을 리뷰해 줘." },
];

const TOOL_TEXT_LIMIT = 6000;

/** Update kinds `session/load` replays; skipped when the transcript already drew them. */
const REPLAYED = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
]);

export class ChatView {
	readonly root: HTMLElement;
	readonly cwd: string;
	sessionId: string | null;
	title: string;
	busy = false;
	/** The session is attached and can take a prompt. */
	ready = false;

	private connection: AcpConnection;
	private detach: (() => void) | null = null;
	private detachExit: (() => void) | null = null;

	// DOM
	private readonly log: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly welcome: HTMLElement;
	private readonly banner: HTMLElement;
	private readonly planBox: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendBtn: HTMLButtonElement;
	private readonly attachRow: HTMLElement;
	private readonly slashMenu: HTMLElement;
	private readonly modeSelect: HTMLSelectElement;
	private readonly modelSelect: HTMLSelectElement;
	private readonly effortSelect: HTMLSelectElement;
	private readonly usageMeter: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly jumpBtn: HTMLButtonElement;
	private readonly queueChip: HTMLElement;

	// Conversation state
	private message: TextSegment | null = null;
	private thought: TextSegment | null = null;
	private userBubble: TextSegment | null = null;
	private readonly tools = new Map<string, ToolEntry>();
	private readonly permissions: { card: HTMLElement; resolve: (o: PermissionOutcome) => void }[] = [];
	private commands: AvailableCommand[] = [];
	private modes: SessionMode[] = [];
	private currentMode = "default";
	private configOptions: ConfigOption[] = [];
	private attachments: Attachment[] = [];
	private readonly queue: string[] = [];
	private slashIndex = 0;
	private stickToBottom = true;
	private renderScheduled = false;
	private turnStarted = 0;
	private turnTimer: number | null = null;
	private hasContent = false;
	/** History came from the transcript file; drop the agent's own replay. */
	private suppressReplay = false;
	private disposed = false;

	constructor(
		private readonly host: ChatHost,
		private readonly options: ChatOptions,
	) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId ?? null;
		this.title = options.title ?? "새 대화";
		this.connection = pool.acquire(this.cwd);

		this.modeSelect = h("select", { class: "select", title: "권한 모드 (Shift+Tab)" });
		this.modelSelect = h("select", { class: "select select-model", title: "모델" });
		this.effortSelect = h("select", { class: "select", title: "추론 강도" });
		this.usageMeter = h("div", { class: "usage", title: "컨텍스트 사용량" });
		this.modeSelect.addEventListener("change", () => void this.changeMode(this.modeSelect.value));
		this.modelSelect.addEventListener("change", () => void this.changeConfig("model", this.modelSelect.value));
		this.effortSelect.addEventListener("change", () => void this.changeConfig("effort", this.effortSelect.value));

		const folderBtn = h(
			"button",
			{ class: "chip chip-folder", title: `${this.cwd}\n클릭: 탐색기에서 열기`, onclick: () => void openPath(this.cwd) },
			svg(icons.folder),
			basename(this.cwd),
		);

		const head = h(
			"header",
			{ class: "chat-head" },
			folderBtn,
			h("span", { class: "spacer" }),
			this.modeSelect,
			this.modelSelect,
			this.effortSelect,
			this.usageMeter,
		);

		this.welcome = this.buildWelcome();
		this.log = h("div", { class: "chat-log" });
		wireMarkdown(this.log, (url) => void openUrl(url));
		this.scroller = h("div", { class: "chat-scroll" }, this.welcome, this.log);
		this.scroller.addEventListener("scroll", () => {
			const gap = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
			this.stickToBottom = gap < 48;
			this.jumpBtn.classList.toggle("hidden", this.stickToBottom);
		});
		this.jumpBtn = h(
			"button",
			{ class: "jump hidden", title: "맨 아래로", onclick: () => this.scrollToBottom(true) },
			"↓ 최신 메시지",
		);

		this.banner = h("div", { class: "banner hidden" });
		this.planBox = h("div", { class: "plan hidden" });

		this.input = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: "무엇을 할까요?  ( / 명령 · 이미지 붙여넣기 )",
			spellcheck: false,
		});
		this.input.addEventListener("input", () => this.onInput());
		this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
		this.input.addEventListener("paste", (event) => this.onPaste(event));

		this.sendBtn = h("button", { class: "send", title: "보내기", onclick: () => this.onSendClick() }, svg(icons.send));
		this.attachRow = h("div", { class: "attachments hidden" });
		this.slashMenu = h("div", { class: "slash hidden" });
		this.queueChip = h("span", { class: "queue hidden" });
		this.statusLine = h("span", { class: "composer-status" });

		const composer = h(
			"div",
			{ class: "composer" },
			this.slashMenu,
			this.attachRow,
			h("div", { class: "composer-box" }, this.input, this.sendBtn),
			h(
				"div",
				{ class: "composer-foot" },
				this.statusLine,
				this.queueChip,
				h("span", { class: "spacer" }),
				h("span", { class: "hint" }, this.sendHint()),
			),
		);

		this.root = h(
			"section",
			{ class: "chat" },
			head,
			this.banner,
			h("div", { class: "chat-body" }, this.scroller, this.jumpBtn),
			this.planBox,
			composer,
		);
		this.root.addEventListener("dragover", (event) => event.preventDefault());
		this.root.addEventListener("drop", (event) => this.onDrop(event));
		this.root.addEventListener("keydown", (event) => this.onRootKey(event));

		this.renderUsage(0, 0);
		void this.open();
	}

	focus(): void {
		this.input.focus();
	}

	// ----------------------------------------------------------- lifecycle

	private async open(): Promise<void> {
		this.setStatus("에이전트 시작 중…", true);
		// A cold `cmd acp` start takes 10-20 s on Windows; say so before it looks hung.
		const slow = window.setTimeout(() => {
			if (!this.ready && !this.disposed && this.statusLine.textContent?.endsWith("중…")) {
				this.setStatus(`${this.statusLine.textContent} 처음 시작은 10~20초 걸릴 수 있습니다.`, true);
			}
		}, 4000);
		try {
			await this.connection.start();
			if (this.disposed) return;
			this.detachExit = this.connection.onExit((code) => this.onAgentExit(code));
			let state: SessionState;
			if (this.sessionId) {
				const rendered = await this.renderTranscript(this.sessionId);
				this.setStatus(rendered ? "세션에 다시 연결하는 중… (입력은 미리 해 두셔도 됩니다)" : "지난 대화 불러오는 중…", true);
				this.suppressReplay = rendered;
				this.attachSession(this.sessionId);
				const loaded = await this.connection.request<Omit<SessionState, "sessionId">>("session/load", {
					sessionId: this.sessionId,
					cwd: this.cwd,
					mcpServers: [],
				});
				state = { sessionId: this.sessionId, ...loaded };
				this.suppressReplay = false;
				this.closeSegments();
			} else {
				state = await this.connection.request<SessionState>("session/new", { cwd: this.cwd, mcpServers: [] });
				this.sessionId = state.sessionId;
				this.attachSession(state.sessionId);
			}
			this.applyState(state);
			const wanted = this.host.settings().defaultMode;
			if (!this.options.sessionId && wanted !== "default" && this.modes.some((m) => m.id === wanted)) {
				await this.changeMode(wanted);
			}
			window.clearTimeout(slow);
			this.ready = true;
			this.setStatus("");
			this.hideBanner();
			this.scrollToBottom(true);
			if (this.options.initialPrompt) this.queue.unshift(this.options.initialPrompt);
			const next = this.queue.shift();
			this.renderQueue();
			if (next !== undefined) void this.send(next);
		} catch (error) {
			window.clearTimeout(slow);
			this.suppressReplay = false;
			this.setStatus("");
			this.showError(error, () => void this.reconnect());
		}
	}

	/** Paint history from the transcript file; true when anything was shown. */
	private async renderTranscript(sessionId: string): Promise<boolean> {
		const profileDir = this.host.settings().profileDir || null;
		const jsonl = await invoke<string | null>("read_transcript", { sessionId, profileDir }).catch(() => null);
		if (!jsonl) return false;
		const updates = transcriptUpdates(jsonl);
		for (const update of updates) this.onUpdate(update);
		this.closeSegments();
		this.flushSegments();
		return updates.length > 0;
	}

	private attachSession(sessionId: string): void {
		this.detach?.();
		this.detach = this.connection.attach(sessionId, {
			onUpdate: (update) => this.onUpdate(update),
			onPermission: (request) => this.onPermission(request),
		});
	}

	private async reconnect(): Promise<void> {
		this.ready = false;
		this.detach?.();
		this.detachExit?.();
		this.connection = pool.restart(this.connection);
		this.hideBanner();
		if (this.sessionId && this.hasContent) {
			// Replay the whole history into a clean log.
			this.log.replaceChildren();
			this.tools.clear();
			this.message = this.thought = this.userBubble = null;
			this.options.sessionId = this.sessionId;
		} else {
			this.sessionId = null;
		}
		await this.open();
	}

	private onAgentExit(code: number | null): void {
		if (this.disposed) return;
		this.ready = false;
		this.finishTurnUi();
		this.showBanner(
			"alert",
			`에이전트 프로세스가 종료되었습니다 (코드 ${code ?? "?"}).`,
			"다시 연결",
			() => void this.reconnect(),
		);
	}

	dispose(): void {
		this.disposed = true;
		if (this.busy && this.sessionId) this.connection.notify("session/cancel", { sessionId: this.sessionId });
		for (const pending of this.permissions.splice(0)) pending.resolve({ outcome: "cancelled" });
		if (this.sessionId && this.connection.alive) {
			void this.connection.request("session/close", { sessionId: this.sessionId }).catch(() => undefined);
		}
		this.detach?.();
		this.detachExit?.();
		if (this.turnTimer !== null) clearInterval(this.turnTimer);
		pool.release(this.connection);
		for (const attachment of this.attachments) URL.revokeObjectURL(attachment.url);
	}

	// -------------------------------------------------------- session state

	private applyState(state: Omit<SessionState, "sessionId">): void {
		if (state.modes) {
			this.modes = state.modes.availableModes;
			this.currentMode = state.modes.currentModeId;
			this.renderModes();
		}
		if (state.configOptions) {
			this.configOptions = state.configOptions;
			this.renderConfig();
		}
	}

	private renderModes(): void {
		this.modeSelect.replaceChildren(
			...this.modes.map((mode) =>
				h(
					"option",
					{ value: mode.id, title: mode.description ?? "", selected: mode.id === this.currentMode },
					MODE_LABEL[mode.id] ?? mode.name,
				),
			),
		);
		this.modeSelect.value = this.currentMode;
		this.modeSelect.classList.toggle("danger", this.currentMode === "bypass");
		this.modeSelect.classList.toggle("hidden", this.modes.length === 0);
	}

	private renderConfig(): void {
		const fill = (select: HTMLSelectElement, option: ConfigOption | undefined) => {
			select.classList.toggle("hidden", !option);
			if (!option) return;
			select.replaceChildren(
				...(option.options ?? []).map((choice) =>
					h("option", { value: choice.value, title: choice.description ?? "" }, choice.name),
				),
			);
			select.value = String(option.currentValue);
		};
		fill(this.modelSelect, this.configOptions.find((o) => o.id === "model"));
		fill(this.effortSelect, this.configOptions.find((o) => o.id === "effort"));
	}

	private async changeMode(modeId: string): Promise<void> {
		if (!this.sessionId || modeId === this.currentMode) return;
		if (modeId === "bypass") {
			const ok = await ask(
				"모든 권한 확인을 건너뜁니다. 에이전트가 묻지 않고 파일을 지우거나 명령을 실행할 수 있습니다.\n\n이 대화에서만 켜시겠습니까?",
				{ title: "권한 무시 모드", kind: "warning", okLabel: "켜기", cancelLabel: "취소" },
			);
			if (!ok) {
				this.modeSelect.value = this.currentMode;
				return;
			}
		}
		try {
			await this.connection.request("session/set_mode", { sessionId: this.sessionId, modeId });
			this.currentMode = modeId;
		} catch (error) {
			this.flash(`모드 변경 실패: ${describeError(error)}`);
		}
		this.renderModes();
	}

	private async changeConfig(configId: string, value: string): Promise<void> {
		if (!this.sessionId) return;
		try {
			const result = await this.connection.request<{ configOptions: ConfigOption[] }>("session/set_config_option", {
				sessionId: this.sessionId,
				configId,
				value,
			});
			if (result.configOptions?.length) this.configOptions = result.configOptions;
		} catch (error) {
			this.flash(`변경 실패: ${describeError(error)}`);
		}
		this.renderConfig();
	}

	private renderUsage(used: number, size: number, cost?: { amount: number; currency: string }): void {
		const pct = size > 0 ? Math.min(100, (used / size) * 100) : 0;
		const bar = h("span", { class: "usage-bar" }, h("span", { class: "usage-fill", style: `width:${pct.toFixed(1)}%` }));
		this.usageMeter.replaceChildren(bar, h("span", { class: "usage-text" }, size > 0 ? `${pct.toFixed(0)}%` : "—"));
		this.usageMeter.classList.toggle("warn", pct >= 80);
		const costText = cost ? ` · 이번 세션 $${cost.amount.toFixed(3)}` : "";
		this.usageMeter.title = size > 0 ? `컨텍스트 ${used.toLocaleString()} / ${size.toLocaleString()} 토큰${costText}\n가득 차면 /compact` : "컨텍스트 사용량";
	}

	// --------------------------------------------------------------- updates

	private onUpdate(update: SessionUpdate): void {
		if (this.suppressReplay && REPLAYED.has(update.sessionUpdate)) return;
		switch (update.sessionUpdate) {
			case "user_message_chunk":
				this.closeAgentSegments();
				this.appendUser(update.content);
				break;
			case "agent_message_chunk":
				this.userBubble = null;
				this.thought = null;
				if (update.content.type === "text") this.appendText("message", update.content.text);
				break;
			case "agent_thought_chunk":
				this.userBubble = null;
				if (update.content.type === "text") this.appendText("thought", update.content.text);
				break;
			case "tool_call":
			case "tool_call_update":
				this.closeSegments();
				this.upsertTool(update);
				break;
			case "plan":
				this.renderPlan(update.entries);
				break;
			case "available_commands_update":
				this.commands = update.availableCommands ?? [];
				break;
			case "current_mode_update":
				this.currentMode = update.currentModeId;
				this.renderModes();
				break;
			case "config_option_update":
				this.configOptions = update.configOptions;
				this.renderConfig();
				break;
			case "session_info_update":
				if (update.title) {
					this.title = update.title;
					this.host.setTitle(update.title);
				}
				break;
			case "usage_update":
				this.renderUsage(update.used, update.size, update.cost);
				break;
			case "notice":
				this.appendNote(update.title + (update.description ? ` — ${update.description}` : ""), "notice");
				break;
		}
	}

	private markContent(): void {
		if (this.hasContent) return;
		this.hasContent = true;
		this.welcome.classList.add("hidden");
	}

	private appendUser(content: ContentBlock): void {
		this.markContent();
		if (!this.userBubble) {
			const body = h("div", { class: "bubble-body" });
			const el = h("div", { class: "msg msg-user" }, h("div", { class: "bubble" }, body));
			this.log.appendChild(el);
			this.userBubble = { el, body, text: "", dirty: false };
		}
		if (content.type === "text") {
			this.userBubble.text += content.text;
			this.userBubble.body.textContent = this.userBubble.text;
		} else if (content.type === "image") {
			this.userBubble.body.appendChild(
				h("img", { class: "bubble-img", src: `data:${content.mimeType};base64,${content.data}`, alt: "첨부 이미지" }),
			);
		}
		this.scrollToBottom();
	}

	private appendText(kind: "message" | "thought", text: string): void {
		this.markContent();
		let segment = kind === "message" ? this.message : this.thought;
		if (!segment) {
			segment = kind === "message" ? this.newMessageSegment() : this.newThoughtSegment();
			if (kind === "message") this.message = segment;
			else this.thought = segment;
		}
		segment.text += text;
		segment.dirty = true;
		this.scheduleRender();
	}

	private newMessageSegment(): TextSegment {
		const body = h("div", { class: "md" });
		const copy = h(
			"button",
			{ class: "icon-btn msg-copy", title: "답변 복사" },
			svg(icons.copy),
		);
		const el = h("div", { class: "msg msg-agent" }, body, copy);
		const segment: TextSegment = { el, body, text: "", dirty: false };
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(segment.text);
			copy.classList.add("done");
			setTimeout(() => copy.classList.remove("done"), 1200);
		});
		this.log.appendChild(el);
		return segment;
	}

	private newThoughtSegment(): TextSegment {
		const body = h("div", { class: "md thought-body" });
		const el = h(
			"details",
			{ class: "msg thought", open: this.host.settings().expandThoughts },
			h("summary", null, svg(icons.think), h("span", null, "생각")),
			body,
		);
		this.log.appendChild(el);
		return { el, body, text: "", dirty: false };
	}

	/** Re-render streaming markdown at most once per frame. */
	private scheduleRender(): void {
		if (this.renderScheduled) return;
		this.renderScheduled = true;
		requestAnimationFrame(() => {
			this.renderScheduled = false;
			for (const segment of [this.message, this.thought]) {
				if (segment?.dirty) {
					segment.body.innerHTML = renderMarkdown(segment.text);
					segment.dirty = false;
				}
			}
			this.scrollToBottom();
		});
	}

	private flushSegments(): void {
		for (const segment of [this.message, this.thought]) {
			if (segment?.dirty) {
				segment.body.innerHTML = renderMarkdown(segment.text);
				segment.dirty = false;
			}
		}
	}

	private closeAgentSegments(): void {
		this.flushSegments();
		this.message = null;
		this.thought = null;
	}

	private closeSegments(): void {
		this.closeAgentSegments();
		this.userBubble = null;
	}

	private appendNote(text: string, tone: "info" | "notice" | "error" = "info"): void {
		this.log.appendChild(h("div", { class: `note note-${tone}` }, text));
		this.scrollToBottom();
	}

	// ----------------------------------------------------------------- tools

	private upsertTool(update: ToolCall): void {
		this.markContent();
		let entry = this.tools.get(update.toolCallId);
		if (!entry) {
			entry = { data: { toolCallId: update.toolCallId }, el: h("div", { class: "tool" }), open: false };
			this.tools.set(update.toolCallId, entry);
			this.log.appendChild(entry.el);
		}
		const data = entry.data;
		for (const key of ["title", "kind", "status", "locations", "rawInput"] as const) {
			if (update[key] !== undefined) (data as unknown as Record<string, unknown>)[key] = update[key];
		}
		if (update.content !== undefined) {
			// Updates carry the latest content; diffs from the first event stay.
			const diffs = (data.content ?? []).filter((c) => c.type === "diff");
			const incoming = update.content ?? [];
			data.content = incoming.some((c) => c.type === "diff") ? incoming : [...diffs, ...incoming];
		}
		if (!entry.open && data.status === "failed") entry.open = true;
		this.renderTool(entry);
		this.scrollToBottom();
	}

	private renderTool(entry: ToolEntry): void {
		const { data } = entry;
		const status = data.status ?? "pending";
		const diffs = (data.content ?? []).filter((c): c is Extract<ToolContent, { type: "diff" }> => c.type === "diff");
		const stats = diffs.reduce(
			(acc, d) => {
				const s = diffStats(d.oldText, d.newText);
				return { added: acc.added + s.added, removed: acc.removed + s.removed };
			},
			{ added: 0, removed: 0 },
		);

		const head = h(
			"button",
			{ class: "tool-head", type: "button" },
			h("span", { class: "tool-chevron" }, svg(icons.chevron)),
			svg(icons[KIND_ICON[data.kind ?? ""] ?? "tool"], "icon tool-icon"),
			h("span", { class: "tool-title", title: data.title ?? "" }, relativeTitle(data.title ?? "도구 실행", this.cwd)),
			diffs.length
				? h(
						"span",
						{ class: "tool-stats" },
						h("span", { class: "add" }, `+${stats.added}`),
						h("span", { class: "del" }, `−${stats.removed}`),
					)
				: null,
			h(
				"span",
				{ class: `tool-status st-${status}` },
				status === "in_progress" || status === "pending" ? h("span", { class: "spinner" }) : null,
				STATUS_LABEL[status] ?? status,
			),
		);
		head.addEventListener("click", () => {
			entry.open = !entry.open;
			this.renderTool(entry);
		});

		entry.el.className = `tool st-${status}${entry.open ? " open" : ""}`;
		entry.el.replaceChildren(head);
		if (entry.open) entry.el.appendChild(this.renderToolBody(data));
	}

	private renderToolBody(data: ToolCall): HTMLElement {
		const body = h("div", { class: "tool-body" });
		const locations = data.locations ?? [];
		if (locations.length) {
			body.appendChild(
				h(
					"div",
					{ class: "tool-locations" },
					locations.map((loc) =>
						h(
							"button",
							{
								class: "loc",
								title: "파일 열기 (Shift+클릭: 폴더에서 보기)",
								onclick: (event: Event) =>
									void ((event as MouseEvent).shiftKey ? revealItemInDir(loc.path) : openPath(loc.path)),
							},
							shortPath(loc.path, this.cwd) + (loc.line ? `:${loc.line}` : ""),
						),
					),
				),
			);
		}
		const command = commandOf(data);
		if (command) body.appendChild(h("pre", { class: "tool-command" }, `$ ${command}`));

		for (const item of data.content ?? []) {
			if (item.type === "diff") {
				body.appendChild(
					h(
						"div",
						{ class: "tool-diff" },
						h("div", { class: "tool-diff-path" }, shortPath(item.path, this.cwd), item.oldText === null ? "  (새 파일)" : ""),
						renderDiff(item.oldText, item.newText),
					),
				);
			} else if (item.type === "content") {
				const block = item.content;
				if (block.type === "text" && block.text.trim()) {
					body.appendChild(clippedPre(block.text));
				} else if (block.type === "image") {
					body.appendChild(h("img", { class: "tool-img", src: `data:${block.mimeType};base64,${block.data}` }));
				}
			} else if (item.type === "terminal") {
				body.appendChild(h("div", { class: "note" }, `터미널 ${item.terminalId}`));
			}
		}
		if (!body.childNodes.length) body.appendChild(h("div", { class: "muted" }, "출력 없음"));
		return body;
	}

	// ------------------------------------------------------------ permission

	private onPermission(request: PermissionRequest): Promise<PermissionOutcome> {
		this.closeSegments();
		this.markContent();
		const known = this.tools.get(request.toolCall.toolCallId)?.data;
		const tool: ToolCall = { ...known, ...request.toolCall, toolCallId: request.toolCall.toolCallId };

		return new Promise<PermissionOutcome>((resolve) => {
			const done = (outcome: PermissionOutcome, label: string) => {
				const index = this.permissions.findIndex((p) => p.card === card);
				if (index >= 0) this.permissions.splice(index, 1);
				card.classList.add("answered");
				card.querySelector(".perm-actions")?.replaceWith(h("div", { class: "perm-answer" }, label));
				resolve(outcome);
				this.input.focus();
			};

			const actions = h(
				"div",
				{ class: "perm-actions" },
				request.options.map((option, index) =>
					h(
						"button",
						{
							class: `btn perm-${option.kind.startsWith("allow") ? "allow" : "reject"}`,
							onclick: () =>
								done(
									{ outcome: "selected", optionId: option.optionId },
									`${PERMISSION_LABEL[option.kind] ?? option.name} 선택함`,
								),
						},
						h("kbd", null, String(index + 1)),
						PERMISSION_LABEL[option.kind] ?? option.name,
					),
				),
			);

			const preview = h("div", { class: "perm-preview" });
			const command = commandOf(tool);
			if (command) preview.appendChild(h("pre", { class: "tool-command" }, `$ ${command}`));
			for (const item of tool.content ?? []) {
				if (item.type === "diff") {
					preview.appendChild(
						h(
							"div",
							{ class: "tool-diff" },
							h("div", { class: "tool-diff-path" }, shortPath(item.path, this.cwd)),
							renderDiff(item.oldText, item.newText),
						),
					);
				}
			}

			const card = h(
				"div",
				{ class: "perm" },
				h(
					"div",
					{ class: "perm-head" },
					svg(icons.shield),
					h("span", null, "권한 요청"),
					h("span", { class: "perm-title" }, tool.title ?? "도구 실행"),
				),
				preview.childNodes.length ? preview : null,
				actions,
			);
			this.log.appendChild(card);
			this.permissions.push({ card, resolve: (outcome) => done(outcome, "취소됨") });
			this.scrollToBottom(true);
			this.host.attention("permission", tool.title ?? "권한이 필요합니다");
		});
	}

	// --------------------------------------------------------------- plan

	private renderPlan(entries: PlanEntry[]): void {
		if (!entries.length) {
			this.planBox.classList.add("hidden");
			return;
		}
		const done = entries.filter((e) => e.status === "completed").length;
		const collapsed = this.planBox.classList.contains("collapsed");
		this.planBox.className = `plan${collapsed ? " collapsed" : ""}`;
		const head = h(
			"button",
			{ class: "plan-head", type: "button", onclick: () => this.planBox.classList.toggle("collapsed") },
			svg(icons.check),
			h("span", null, `할 일 ${done}/${entries.length}`),
			h("span", { class: "plan-bar" }, h("span", { style: `width:${(done / entries.length) * 100}%` })),
		);
		const list = h(
			"ol",
			{ class: "plan-list" },
			entries.map((entry) => h("li", { class: `plan-${entry.status}` }, entry.content)),
		);
		this.planBox.replaceChildren(head, list);
	}

	// ------------------------------------------------------------ composer

	private sendHint(): string {
		return this.host.settings().sendKey === "enter" ? "Enter 보내기 · Shift+Enter 줄바꿈" : "Ctrl+Enter 보내기";
	}

	private onInput(): void {
		this.input.style.height = "auto";
		this.input.style.height = `${Math.min(this.input.scrollHeight, 260)}px`;
		this.renderSlash();
	}

	private slashMatches(): AvailableCommand[] {
		const value = this.input.value;
		if (!value.startsWith("/") || /\s/.test(value)) return [];
		const query = value.slice(1).toLowerCase();
		return this.commands
			.filter((c) => c.name.toLowerCase().includes(query))
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
			.slice(0, 50);
	}

	private renderSlash(): void {
		const matches = this.slashMatches();
		if (!matches.length) {
			this.slashMenu.classList.add("hidden");
			return;
		}
		this.slashIndex = Math.min(this.slashIndex, matches.length - 1);
		this.slashMenu.replaceChildren(
			...matches.map((command, index) =>
				h(
					"button",
					{
						class: `slash-item${index === this.slashIndex ? " active" : ""}`,
						type: "button",
						onmousedown: (event: Event) => {
							event.preventDefault();
							this.completeSlash(command);
						},
					},
					h("span", { class: "slash-name" }, `/${command.name}`),
					h("span", { class: "slash-desc" }, command.description),
				),
			),
		);
		this.slashMenu.classList.remove("hidden");
		this.slashMenu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
	}

	private completeSlash(command: AvailableCommand): void {
		this.input.value = `/${command.name}${command.input ? " " : ""}`;
		this.slashMenu.classList.add("hidden");
		this.input.focus();
		if (!command.input) this.submit();
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return; // Korean IME: Enter confirms the syllable.
		const matches = this.slashMenu.classList.contains("hidden") ? [] : this.slashMatches();
		if (matches.length) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				this.slashIndex = (this.slashIndex + step + matches.length) % matches.length;
				this.renderSlash();
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				this.completeSlash(matches[this.slashIndex]);
				return;
			}
			if (event.key === "Escape") {
				this.slashMenu.classList.add("hidden");
				return;
			}
		}
		if (event.key === "Enter") {
			const ctrl = event.ctrlKey || event.metaKey;
			const sends = this.host.settings().sendKey === "enter" ? !event.shiftKey && !ctrl || ctrl : ctrl;
			if (sends) {
				event.preventDefault();
				this.submit();
			}
			return;
		}
		if (event.key === "Tab" && event.shiftKey) {
			event.preventDefault();
			this.cycleMode();
		}
	}

	private onRootKey(event: KeyboardEvent): void {
		if (event.key === "Escape" && this.busy) {
			event.preventDefault();
			this.cancel();
			return;
		}
		const pending = this.permissions[0];
		if (pending && /^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && this.input.value === "") {
			const buttons = pending.card.querySelectorAll<HTMLButtonElement>(".perm-actions button");
			const button = buttons[Number(event.key) - 1];
			if (button) {
				event.preventDefault();
				button.click();
			}
		}
	}

	private cycleMode(): void {
		// Same cycle as the TUI's Shift+Tab, minus bypass, which needs a deliberate choice.
		const order = ["default", "auto-accept", "plan"].filter((id) => this.modes.some((m) => m.id === id));
		if (!order.length) return;
		const next = order[(order.indexOf(this.currentMode) + 1) % order.length];
		void this.changeMode(next);
	}

	private onPaste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
		if (!files.length) return;
		event.preventDefault();
		for (const file of files) void this.addImage(file);
	}

	private onDrop(event: DragEvent): void {
		event.preventDefault();
		const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
		for (const file of files) void this.addImage(file);
	}

	private async addImage(file: File): Promise<void> {
		if (!this.connection.acceptsImages) {
			this.flash("이 에이전트는 이미지 입력을 지원하지 않습니다.");
			return;
		}
		const buffer = new Uint8Array(await file.arrayBuffer());
		let binary = "";
		for (let i = 0; i < buffer.length; i += 0x8000) {
			binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
		}
		this.attachments.push({ mimeType: file.type, data: btoa(binary), url: URL.createObjectURL(file) });
		this.renderAttachments();
	}

	private renderAttachments(): void {
		this.attachRow.classList.toggle("hidden", this.attachments.length === 0);
		this.attachRow.replaceChildren(
			...this.attachments.map((attachment, index) =>
				h(
					"div",
					{ class: "attachment" },
					h("img", { src: attachment.url, alt: "" }),
					h(
						"button",
						{
							class: "attachment-x",
							title: "빼기",
							onclick: () => {
								URL.revokeObjectURL(attachment.url);
								this.attachments.splice(index, 1);
								this.renderAttachments();
							},
						},
						"×",
					),
				),
			),
		);
	}

	private onSendClick(): void {
		if (this.busy && !this.input.value.trim()) this.cancel();
		else this.submit();
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (!text && !this.attachments.length) return;
		if (this.busy || !this.ready) {
			if (!text) return;
			this.queue.push(text);
			this.input.value = "";
			this.onInput();
			this.renderQueue();
			return;
		}
		this.input.value = "";
		this.onInput();
		void this.send(text);
	}

	private renderQueue(): void {
		this.queueChip.classList.toggle("hidden", this.queue.length === 0);
		this.queueChip.textContent = `대기 ${this.queue.length}`;
		this.queueChip.title = this.queue.join("\n---\n");
	}

	// ---------------------------------------------------------------- turns

	async send(text: string): Promise<void> {
		if (!this.sessionId || !this.ready) {
			this.queue.unshift(text);
			this.renderQueue();
			return;
		}
		const images = this.attachments.splice(0);
		this.renderAttachments();
		const prompt: ContentBlock[] = [];
		if (text) prompt.push({ type: "text", text });
		for (const image of images) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });

		this.closeSegments();
		for (const block of prompt) this.appendUser(block);
		for (const image of images) URL.revokeObjectURL(image.url);
		this.userBubble = null;
		this.scrollToBottom(true);
		this.hideBanner();

		this.startTurnUi();
		try {
			const result = await this.connection.request<PromptResult>("session/prompt", {
				sessionId: this.sessionId,
				prompt,
			});
			this.closeSegments();
			if (result.stopReason === "cancelled") this.appendNote("중지됨");
			else if (result.stopReason === "max_turn_requests") this.appendNote("최대 턴 수에 도달해 멈췄습니다. 이어서 하려면 '계속'이라고 보내세요.");
			else if (result.stopReason === "refusal") this.appendNote("에이전트가 요청을 거절했습니다.", "notice");
			else if (result.stopReason === "max_tokens") this.appendNote("응답 길이 한도에 도달했습니다.", "notice");
			this.host.attention("done", lastLine(this.lastAgentText()) || "응답 완료");
		} catch (error) {
			this.closeSegments();
			this.showError(error);
			this.host.attention("error", describeError(error));
		} finally {
			this.finishTurnUi();
		}

		const next = this.queue.shift();
		this.renderQueue();
		if (next !== undefined && !this.disposed) void this.send(next);
	}

	cancel(): void {
		if (!this.busy || !this.sessionId) return;
		this.connection.notify("session/cancel", { sessionId: this.sessionId });
		for (const pending of [...this.permissions]) pending.resolve({ outcome: "cancelled" });
		this.setStatus("중지하는 중…");
	}

	private startTurnUi(): void {
		this.busy = true;
		this.host.setBusy(true);
		this.root.classList.add("busy");
		this.sendBtn.replaceChildren(svg(icons.stop));
		this.sendBtn.title = "중지 (Esc)";
		this.sendBtn.classList.add("stop");
		this.modelSelect.disabled = true;
		this.effortSelect.disabled = true;
		this.turnStarted = Date.now();
		const tick = () => {
			const seconds = Math.floor((Date.now() - this.turnStarted) / 1000);
			this.setStatus(`작업 중 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}  (Esc 중지)`, true);
		};
		tick();
		this.turnTimer = window.setInterval(tick, 1000);
	}

	private finishTurnUi(): void {
		this.busy = false;
		this.host.setBusy(false);
		this.root.classList.remove("busy");
		this.sendBtn.replaceChildren(svg(icons.send));
		this.sendBtn.title = "보내기";
		this.sendBtn.classList.remove("stop");
		this.modelSelect.disabled = false;
		this.effortSelect.disabled = false;
		if (this.turnTimer !== null) clearInterval(this.turnTimer);
		this.turnTimer = null;
		this.setStatus("");
		// Anything still spinning will never hear back.
		for (const entry of this.tools.values()) {
			if (entry.data.status === "pending" || entry.data.status === "in_progress") {
				entry.data.status = "cancelled" as ToolCall["status"];
				this.renderTool(entry);
			}
		}
		for (const pending of [...this.permissions]) pending.resolve({ outcome: "cancelled" });
	}

	private lastAgentText(): string {
		const nodes = this.log.querySelectorAll(".msg-agent .md");
		return nodes.length ? (nodes[nodes.length - 1].textContent ?? "") : "";
	}

	// --------------------------------------------------------------- chrome

	private setStatus(text: string, working = false): void {
		this.statusLine.textContent = text;
		this.statusLine.classList.toggle("working", working);
	}

	private flash(text: string): void {
		this.appendNote(text, "error");
	}

	private showError(error: unknown, retry?: () => void): void {
		const info = explainError(error);
		if (info.login) {
			this.showBanner("alert", info.text, "터미널에서 로그인", () => this.host.openTerminal(this.cwd, ["login"]));
		} else if (retry) {
			this.showBanner("alert", info.text, "다시 시도", retry);
		} else {
			this.showBanner("alert", info.text);
		}
	}

	private showBanner(icon: IconName, text: string, actionLabel?: string, action?: () => void): void {
		this.banner.replaceChildren(
			svg(icons[icon]),
			h("span", { class: "banner-text" }, text),
			...(actionLabel && action ? [h("button", { class: "btn", onclick: action }, actionLabel)] : []),
			h("button", { class: "icon-btn", title: "닫기", onclick: () => this.hideBanner() }, svg(icons.close)),
		);
		this.banner.classList.remove("hidden");
	}

	private hideBanner(): void {
		this.banner.classList.add("hidden");
	}

	private scrollToBottom(force = false): void {
		if (!force && !this.stickToBottom) return;
		this.scroller.scrollTop = this.scroller.scrollHeight;
		this.stickToBottom = true;
		this.jumpBtn.classList.add("hidden");
	}

	private buildWelcome(): HTMLElement {
		return h(
			"div",
			{ class: "welcome" },
			h("div", { class: "welcome-mark" }, svg(icons.sparkle)),
			h("h2", null, basename(this.cwd)),
			h("p", { class: "muted" }, this.cwd),
			h(
				"div",
				{ class: "suggestions" },
				SUGGESTIONS.map((s) =>
					h(
						"button",
						{
							class: "suggestion",
							onclick: () => {
								if (this.busy) return;
								void this.send(s.prompt);
							},
						},
						h("strong", null, s.title),
						h("span", null, s.prompt),
					),
				),
			),
		);
	}
}

// ------------------------------------------------------------------ helpers

function commandOf(tool: ToolCall): string | null {
	if (tool.kind !== "execute") return null;
	const input = tool.rawInput as { command?: unknown } | undefined;
	return typeof input?.command === "string" ? input.command : null;
}

function shortPath(path: string, cwd: string): string {
	const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
	const base = cwd.replace(/[\\/]+$/, "");
	if (norm(path).startsWith(`${norm(base)}\\`)) return path.slice(base.length + 1);
	return path;
}

/** "Write: C:\proj\src\a.ts" → "Write: src\a.ts" inside the project. */
function relativeTitle(title: string, cwd: string): string {
	const norm = (text: string) => text.replace(/\//g, "\\").toLowerCase();
	const prefix = `${norm(cwd).replace(/\\+$/, "")}\\`;
	const at = norm(title).indexOf(prefix);
	return at < 0 ? title : title.slice(0, at) + title.slice(at + prefix.length);
}

function clippedPre(text: string): HTMLElement {
	if (text.length <= TOOL_TEXT_LIMIT) return h("pre", { class: "tool-output" }, text);
	const pre = h("pre", { class: "tool-output" }, text.slice(0, TOOL_TEXT_LIMIT));
	const more = h(
		"button",
		{
			class: "link",
			onclick: () => {
				pre.textContent = text;
				more.remove();
			},
		},
		`… ${(text.length - TOOL_TEXT_LIMIT).toLocaleString()}자 더 보기`,
	);
	return h("div", null, pre, more);
}

function lastLine(text: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	return (lines[lines.length - 1] ?? "").slice(0, 140);
}

export function describeError(error: unknown): string {
	return explainError(error).text;
}

/** Turn agent errors into something a person can act on. */
function explainError(error: unknown): { text: string; login: boolean } {
	const message = error instanceof Error ? error.message : String(error);
	if (/not authenticated|cmd login/i.test(message)) {
		return { text: "Command Code에 로그인되어 있지 않습니다.", login: true };
	}
	const reset = message.match(/resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
	if ((error instanceof AcpError && error.status === 429) || /usage limit|429/.test(message)) {
		const when = reset
			? new Date(reset[1]).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
			: null;
		return {
			text: `사용 한도에 도달했습니다.${when ? ` ${when}에 초기화됩니다.` : ""} 다른 모델로 바꾸거나 잠시 후 다시 시도하세요.`,
			login: false,
		};
	}
	return { text: message, login: false };
}
