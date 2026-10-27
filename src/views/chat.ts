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
import { accountBlocker, type Billing, type Catalog, findModel, modelAccess } from "../billing";
import type { Settings } from "../store";
import { applyUlwTool, renderUlwCanvas, ulwToolKind, type UlwRun } from "../ui/dag";
import { diffStats, renderDiff } from "../ui/diff";
import { basename, h, svg } from "../ui/dom";
import { type IconName, icons } from "../ui/icons";
import {
	findMath,
	looksLikeMarkdown,
	type MathSpan,
	renderDraft,
	renderMarkdown,
	renderMath,
	renderUserText,
	wireMarkdown,
} from "../ui/markdown";
import { keys } from "../ui/platform";

export interface ChatHost {
	settings(): Settings;
	setTitle(title: string): void;
	setBusy(busy: boolean): void;
	/** The tab wants the user's eyes (permission prompt, finished turn). */
	attention(kind: "permission" | "done" | "error", body: string): void;
	openTerminal(cwd: string, args: string[]): void;
	/** Sign the given account in again (null: the CLI's own login). */
	login(accountId: string | null): void;
	/** Plan/credits for an account and the model catalog, when known. */
	access(accountId: string | null): { billing: Billing | null; catalog: Catalog | null };
	/** Open the account menu (to switch away from an account that cannot run). */
	openAccounts(): void;
	/** A turn hit a usage window (5-hour, weekly); the usage gauge shows it. */
	reportLimit(accountId: string | null, window: string, resetAt: number | null): void;
}

interface ChatOptions {
	cwd: string;
	/** Resume this session instead of starting a new one. */
	sessionId?: string;
	title?: string;
	/** Send this as the first message once the session is ready. */
	initialPrompt?: string;
	/** Saved account this chat runs as; null runs as the CLI's own login. */
	accountId: string | null;
	accountName: string;
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

/** `_meta.risk.kind` on a permission request (command-code 1.88). */
const RISK_LABEL: Record<string, string> = {
	"destructive-command": "되돌리기 어려운 삭제 명령",
	"outside-workspace": "작업 폴더 밖 접근",
	"ask-rule": "permissions.ask 규칙에 걸린 호출",
	"permission-config": "권한 설정 변경",
};

/** In bypass mode, how long a risky request waits before the app allows it. */
const BYPASS_COUNTDOWN_SECONDS = 5;

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
	private readonly dagBox: HTMLElement;
	private readonly dagBody: HTMLElement;
	private readonly ulwChip: HTMLButtonElement;
	private readonly input: HTMLTextAreaElement;
	private readonly sendBtn: HTMLButtonElement;
	private readonly mathBtn: HTMLButtonElement;
	/** Rendered LaTeX for the formulas in the composer, above the input. */
	private readonly mathPreview: HTMLElement;
	private readonly attachRow: HTMLElement;
	private readonly slashMenu: HTMLElement;
	private readonly modeSelect: HTMLSelectElement;
	private readonly modelSelect: HTMLSelectElement;
	private readonly effortSelect: HTMLSelectElement;
	private readonly usageMeter: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly jumpBtn: HTMLButtonElement;
	private readonly queueChip: HTMLElement;
	private readonly accountChip: HTMLElement;

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
	/** The agent went into plan mode from bypass; approving the plan returns to
	 * bypass, so its questions are answered as in bypass. */
	private planFromBypass = false;
	private attachments: Attachment[] = [];
	private readonly queue: string[] = [];
	private ulw: UlwRun | null = null;
	/** The user closed the graph; agent updates keep the panel closed until a new plan. */
	private dagDismissed = false;
	private slashIndex = 0;
	private previewTimer: number | null = null;
	/** Composer preview: chips per formula or the whole draft as a document; "off" lasts until the input is cleared. */
	private previewMode: "auto" | "chips" | "doc" | "off" = "auto";
	private stickToBottom = true;
	private renderScheduled = false;
	private turnStarted = 0;
	private turnTimer: number | null = null;
	private hasContent = false;
	/** History came from the transcript file; drop the agent's own replay. */
	private suppressReplay = false;
	/** An account change arrived mid-turn; rebind once the turn ends. */
	private rebindPending = false;
	/** Note shown when the pending rebind happens (default: the account). */
	private rebindReason: string | null = null;
	/** The banner currently shows an account/model access warning. */
	private accessBanner = false;
	/** Bumped by every open(); an older open() that sees a newer value stops. */
	private openGen = 0;
	private disposed = false;

	constructor(
		private readonly host: ChatHost,
		private readonly options: ChatOptions,
	) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId ?? null;
		this.title = options.title ?? "새 대화";
		this.connection = pool.acquire(this.cwd, options.accountId);

		this.modeSelect = h("select", { class: "select hidden", title: "권한 모드 (Shift+Tab)" });
		this.modelSelect = h("select", { class: "select select-model hidden", title: "모델" });
		this.effortSelect = h("select", { class: "select hidden", title: "추론 강도" });
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

		this.accountChip = h("span", {
			class: "chip chip-account",
			title: "이 대화가 쓰는 Command Code 계정. 사이드바에서 계정을 바꾸면 이 대화도 바로 따라갑니다.",
		});
		this.renderAccountChip();
		this.ulwChip = h("button", {
			class: "chip chip-ulw hidden",
			type: "button",
			title: "ULTRAWORK 실행 그래프 열기/닫기",
			onclick: () => this.toggleDag(),
		});
		const head = h(
			"header",
			{ class: "chat-head" },
			folderBtn,
			this.accountChip,
			this.ulwChip,
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
		this.dagBody = h("div", { class: "dag-body" });
		this.dagBox = h("section", { class: "dag hidden" });

		this.input = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: "무엇을 할까요?  ( / 명령 · 이미지 붙여넣기 )",
			spellcheck: false,
		});
		this.input.addEventListener("input", () => this.onInput());
		this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
		this.input.addEventListener("paste", (event) => this.onPaste(event));
		// The caret decides which formula the preview highlights; input alone misses arrow keys and clicks.
		for (const type of ["keyup", "click", "focus"]) this.input.addEventListener(type, () => this.schedulePreview());

		this.sendBtn = h("button", { class: "send", title: "보내기", onclick: () => this.onSendClick() }, svg(icons.send));
		this.mathBtn = h(
			"button",
			{
				class: "composer-tool",
				type: "button",
				title: "수식 넣기 — 선택한 글을 $…$로 감싸기\nShift+클릭: $$ 블록 수식",
				onclick: (event: Event) => this.insertMath((event as MouseEvent).shiftKey),
			},
			"∑",
		);
		this.mathPreview = h("div", { class: "math-preview hidden", title: "입력창 수식 미리보기 · 두 번 클릭: LaTeX 복사" });
		wireMarkdown(this.mathPreview, (url) => void openUrl(url));
		this.attachRow = h("div", { class: "attachments hidden" });
		this.slashMenu = h("div", { class: "slash hidden" });
		this.queueChip = h("span", { class: "queue hidden" });
		this.statusLine = h("span", { class: "composer-status" });

		const composer = h(
			"div",
			{ class: "composer" },
			this.slashMenu,
			this.attachRow,
			this.mathPreview,
			h("div", { class: "composer-box" }, this.input, this.mathBtn, this.sendBtn),
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
			this.dagBox,
			h("div", { class: "chat-body" }, this.scroller, this.jumpBtn),
			this.planBox,
			composer,
		);
		this.root.addEventListener("keydown", (event) => this.onRootKey(event));

		this.renderUsage(0, 0);
		void this.open();
	}

	focus(): void {
		this.input.focus();
	}

	// ----------------------------------------------------------- lifecycle

	private async open(): Promise<void> {
		// Every open() is one attempt to bind this chat to `this.connection`. A
		// newer attempt (an account switch, a reconnect) or a closed tab makes
		// this one stale: it stops at its next await and cleans up only what it
		// created itself, on the connection it was started on.
		const gen = ++this.openGen;
		const connection = this.connection;
		const stale = () => this.disposed || gen !== this.openGen;
		const closeOn = (sessionId: string) => {
			if (connection.alive) void connection.request("session/close", { sessionId }).catch(() => undefined);
		};

		// History first: the transcript file is local and instant, while a cold
		// `cmd acp` start takes 10-20 s.
		const rendered = this.sessionId && !this.hasContent ? await this.renderTranscript(this.sessionId) : this.hasContent;
		if (stale()) return;
		this.setStatus(rendered ? "세션에 연결하는 중… (입력은 미리 해 두셔도 됩니다)" : "에이전트 시작 중…", true);
		const slow = window.setTimeout(() => {
			if (!this.ready && !stale() && this.statusLine.textContent?.endsWith("중…")) {
				this.setStatus(`${this.statusLine.textContent} 처음 시작은 10~20초 걸릴 수 있습니다.`, true);
			}
		}, 4000);
		try {
			await connection.start();
			if (stale()) return;
			this.detachExit?.();
			this.detachExit = connection.onExit((code) => this.onAgentExit(code));
			let state: SessionState;
			if (this.sessionId) {
				const sessionId = this.sessionId;
				this.suppressReplay = rendered;
				this.attachSession(sessionId);
				const loaded = await connection.request<Omit<SessionState, "sessionId">>("session/load", {
					sessionId,
					cwd: this.cwd,
					mcpServers: [],
				});
				if (stale()) return closeOn(sessionId);
				state = { sessionId, ...loaded };
				this.suppressReplay = false;
				this.closeSegments();
			} else {
				state = await connection.request<SessionState>("session/new", { cwd: this.cwd, mcpServers: [] });
				// dispose() or a rebind could not close a session they did not know about.
				if (stale()) return closeOn(state.sessionId);
				this.sessionId = state.sessionId;
				this.attachSession(state.sessionId);
			}
			this.applyState(state);
			const wanted = this.host.settings().defaultMode;
			if (!this.options.sessionId && wanted !== "default" && this.modes.some((m) => m.id === wanted)) {
				await this.changeMode(wanted);
				if (stale()) return;
			}
			this.ready = true;
			this.setStatus("");
			this.hideBanner();
			this.accessBanner = false;
			this.checkAccess();
			this.scrollToBottom(true);
			// Queued exactly once; a reconnect must not run it again.
			if (this.options.initialPrompt) this.queue.unshift(this.options.initialPrompt);
			this.options.initialPrompt = undefined;
			const next = this.queue.shift();
			this.renderQueue();
			if (next !== undefined) void this.send(next);
		} catch (error) {
			this.suppressReplay = false;
			if (stale()) return;
			this.setStatus("");
			this.showError(error, () => void this.reconnect());
		} finally {
			window.clearTimeout(slow);
		}
	}

	/** Paint history from the transcript file; true when anything was shown. */
	private async renderTranscript(sessionId: string): Promise<boolean> {
		// Sessions are shared by every account (only the key differs), so the
		// transcript always lives under the regular home.
		const jsonl = await invoke<string | null>("read_transcript", { sessionId, profileDir: null }).catch(() => null);
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
			this.hasContent = false;
			this.options.sessionId = this.sessionId;
		} else {
			this.sessionId = null;
		}
		await this.open();
	}

	get accountId(): string | null {
		return this.options.accountId;
	}

	/** The ACP protocol version the agent agreed to (for the compatibility check). */
	get protocolVersion(): number | undefined {
		return this.connection.info?.protocolVersion;
	}

	private renderAccountChip(): void {
		this.accountChip.replaceChildren(svg(icons.user), this.options.accountName);
	}

	/**
	 * Run this chat as another account from now on. The session is closed on
	 * the old agent and loaded on one started with the new key; the visible
	 * history stays. `force` reconnects even for the same account (its login
	 * changed underneath, e.g. a CLI re-login). A running turn finishes first.
	 */
	setAccount(accountId: string | null, accountName: string, force = false, reason?: string): void {
		const changed = accountId !== this.options.accountId;
		this.options.accountName = accountName;
		this.renderAccountChip();
		if (!changed && !force) return;
		this.options.accountId = accountId;
		this.rebindReason = reason ?? null;
		if (this.busy) {
			this.rebindPending = true;
			this.setStatus(`이번 작업이 끝나면 ${accountName} 계정으로 다시 연결합니다.`, true);
			return;
		}
		void this.rebind();
	}

	private async rebind(): Promise<void> {
		this.rebindPending = false;
		if (this.disposed) return;
		this.ready = false;
		if (this.sessionId && this.connection.alive) {
			void this.connection.request("session/close", { sessionId: this.sessionId }).catch(() => undefined);
		}
		this.detach?.();
		this.detach = null;
		this.detachExit?.();
		this.detachExit = null;
		pool.release(this.connection);
		this.connection = pool.acquire(this.cwd, this.options.accountId);
		this.hideBanner();
		// History already on screen stays; an empty chat just starts over.
		if (this.sessionId && this.hasContent) this.options.sessionId = this.sessionId;
		else this.sessionId = null;
		this.appendNote(this.rebindReason ?? `${this.options.accountName} 계정으로 다시 연결했습니다.`);
		this.rebindReason = null;
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
		const model = this.configOptions.find((o) => o.id === "model");
		this.modelSelect.classList.toggle("hidden", !model);
		if (model) this.fillModels(model);
		const effort = this.configOptions.find((o) => o.id === "effort");
		this.effortSelect.classList.toggle("hidden", !effort);
		if (effort) {
			this.effortSelect.replaceChildren(
				...(effort.options ?? []).map((choice) =>
					h("option", { value: choice.value, title: choice.description ?? "" }, choice.name),
				),
			);
			this.effortSelect.value = String(effort.currentValue);
		}
		this.checkAccess();
	}

	/** The model list, grouped by whether this chat's account may use each
	 * model (src/billing.ts); unusable ones stay visible but disabled. */
	private fillModels(option: ConfigOption): void {
		const { billing, catalog } = this.host.access(this.options.accountId);
		const groups: Record<string, HTMLOptionElement[]> = { ok: [], free: [], locked: [], blocked: [] };
		for (const choice of option.options ?? []) {
			const access = modelAccess(findModel(catalog, choice.value), billing);
			const group = !access.allowed
				? access.kind === "locked"
					? "locked"
					: "blocked"
				: access.kind === "free"
					? "free"
					: "ok";
			groups[group].push(
				h(
					"option",
					{ value: choice.value, title: choice.description ?? "", disabled: !access.allowed },
					access.note ? `${choice.name} · ${access.note}` : choice.name,
				),
			);
		}
		const label: Record<string, string> = billing
			? {
					ok: "사용 가능",
					free: "무료 모델",
					locked: "요금제 업그레이드 필요",
					blocked: "크레딧 부족으로 사용 불가",
				}
			: { ok: "모델", free: "무료 모델", locked: "", blocked: "" };
		const children = Object.entries(groups)
			.filter(([, items]) => items.length)
			.map(([key, items]) => h("optgroup", { label: label[key] }, items));
		this.modelSelect.replaceChildren(...children);
		this.modelSelect.value = String(option.currentValue);
	}

	/** Re-evaluate models after the account's plan or credits were (re)loaded. */
	refreshAccess(): void {
		if (this.configOptions.length) this.renderConfig();
		else this.checkAccess();
	}

	/** Warn before a turn fails: the account can run nothing, or the chosen
	 * model is not available to it. */
	private checkAccess(): void {
		const { billing, catalog } = this.host.access(this.options.accountId);
		if (!billing) return;
		const blocker = accountBlocker(billing);
		if (blocker) {
			this.showBanner("alert", `${this.options.accountName}: ${blocker}`, "계정 전환", () => this.host.openAccounts());
			this.accessBanner = true;
			return;
		}
		const model = this.configOptions.find((o) => o.id === "model");
		const current = model ? String(model.currentValue) : null;
		const access = current ? modelAccess(findModel(catalog, current), billing) : null;
		if (access && !access.allowed) {
			const usable = (model?.options ?? []).find((c) => modelAccess(findModel(catalog, c.value), billing).allowed);
			const preferred =
				catalog?.roles?.default && modelAccess(findModel(catalog, catalog.roles.default), billing).allowed
					? (model?.options ?? []).find((c) => c.value === catalog.roles?.default)
					: undefined;
			const target = preferred ?? usable;
			this.showBanner(
				"alert",
				`지금 모델은 ${this.options.accountName} 계정에서 쓸 수 없습니다 (${access.note}).`,
				target ? `${target.name}(으)로 바꾸기` : "계정 전환",
				target ? () => void this.changeConfig("model", target.value) : () => this.host.openAccounts(),
			);
			this.accessBanner = true;
			return;
		}
		if (this.accessBanner) {
			this.accessBanner = false;
			this.hideBanner();
		}
	}

	private async changeMode(modeId: string): Promise<void> {
		if (!this.sessionId || modeId === this.currentMode) return;
		if (modeId === "bypass") {
			const ok = await ask(
				`모든 권한 확인을 건너뜁니다. 에이전트가 묻지 않고 파일을 지우거나 명령을 실행할 수 있습니다.\n\nCLI가 이 모드에서도 묻는 위험한 요청(작업 폴더 밖 삭제 등)은 ${BYPASS_COUNTDOWN_SECONDS}초 뒤 자동으로 허용하고, 에이전트의 질문은 ${BYPASS_COUNTDOWN_SECONDS}초 뒤 첫 번째 답을 고릅니다. 그 사이에 멈출 수 있습니다.\n\n이 대화에서만 켜시겠습니까?`,
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
			// Plan mode the user picked is theirs to review, even coming from bypass.
			this.planFromBypass = false;
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
				this.endThought();
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
				this.planFromBypass =
					update.currentModeId === "plan" && (this.currentMode === "bypass" || this.planFromBypass);
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
			const raw = h("button", { class: "bubble-raw hidden", type: "button", title: "보낸 그대로 보기" }, "원문");
			const el = h("div", { class: "msg msg-user" }, raw, h("div", { class: "bubble" }, body));
			const segment: TextSegment = { el, body, text: "", dirty: false };
			raw.addEventListener("click", () => {
				el.classList.toggle("raw");
				this.renderUserBubble(segment);
			});
			this.log.appendChild(el);
			this.userBubble = segment;
		}
		if (content.type === "text") {
			this.userBubble.text += content.text;
			this.renderUserBubble(this.userBubble);
		} else if (content.type === "image") {
			this.userBubble.body.appendChild(
				h("img", { class: "bubble-img", src: `data:${content.mimeType};base64,${content.data}`, alt: "첨부 이미지" }),
			);
		}
		this.scrollToBottom();
	}

	/**
	 * Own text is a document when written as one (headings, lists, tables…),
	 * otherwise verbatim with its formulas; "원문" shows it exactly as sent.
	 * Attached images sit after the text and survive a re-render.
	 */
	private renderUserBubble(segment: TextSegment): void {
		const { el, body, text } = segment;
		const images = [...body.querySelectorAll("img.bubble-img")];
		const raw = el.classList.contains("raw");
		const { html, markdown } = raw ? { html: "", markdown: false } : renderUserText(text);
		body.className = `bubble-body${markdown ? " md" : ""}`;
		body.parentElement?.classList.toggle("doc", markdown);
		if (raw) body.textContent = text;
		else body.innerHTML = html;
		body.append(...images);
		const button = el.querySelector<HTMLButtonElement>(".bubble-raw");
		if (button) {
			button.textContent = raw ? "렌더링" : "원문";
			button.classList.toggle("hidden", !raw && !looksLikeMarkdown(text) && !findMath(text).length);
		}
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

	/** Text after a thought starts a new block; the thought keeps its last chunk. */
	private endThought(): void {
		if (this.thought?.dirty) {
			this.thought.body.innerHTML = renderMarkdown(this.thought.text);
			this.thought.dirty = false;
		}
		this.thought = null;
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
		this.observeUlw(data);
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
			h("span", { class: "tool-title", title: data.title ?? "" }, displayTitle(data, this.cwd)),
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

	/** Bypass mode, or plan mode the agent entered from it: the app answers
	 * the CLI's remaining prompts itself. */
	private get answersForUser(): boolean {
		return this.currentMode === "bypass" || (this.currentMode === "plan" && this.planFromBypass);
	}

	private onPermission(request: PermissionRequest): Promise<PermissionOutcome> {
		this.closeSegments();
		this.markContent();
		const known = this.tools.get(request.toolCall.toolCallId)?.data;
		const tool: ToolCall = { ...known, ...request.toolCall, toolCallId: request.toolCall.toolCallId };
		const question = isQuestion(request);
		const risk = request._meta?.risk;
		const labels = optionLabels(request, question);

		// Bypass mode: the CLI still asks for risky calls, for a few tools of its
		// own (enter_plan_mode) and questions. Plain requests are allowed here at
		// once; risky ones and questions (first answer, usually the recommended
		// one) after a short countdown the user can stop.
		const autoPick = !this.answersForUser
			? undefined
			: question
				? request.options[0]
				: (request.options.find((o) => o.kind === "allow_once") ??
					request.options.find((o) => o.kind.startsWith("allow")));
		if (autoPick && !question && !risk) {
			this.appendNote(`권한 무시 모드 · 자동 허용: ${displayTitle(tool, this.cwd)}`);
			return Promise.resolve({ outcome: "selected", optionId: autoPick.optionId });
		}

		return new Promise<PermissionOutcome>((resolve) => {
			let countdown: number | null = null;
			const stopCountdown = () => {
				if (countdown !== null) clearInterval(countdown);
				countdown = null;
				card.querySelector(".perm-auto")?.remove();
			};
			const done = (outcome: PermissionOutcome, label: string) => {
				stopCountdown();
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
							class: question
								? "btn perm-option"
								: `btn perm-${option.kind.startsWith("allow") ? "allow" : "reject"}`,
							onclick: () =>
								done(
									{ outcome: "selected", optionId: option.optionId },
									question ? `답: ${labels[index].label}` : `${labels[index].label} 선택함`,
								),
						},
						h("kbd", null, String(index + 1)),
						h("span", { class: "perm-option-label" }, labels[index].label),
						labels[index].description
							? h("span", { class: "perm-option-desc" }, labels[index].description)
							: null,
					),
				),
			);

			const riskLine = risk
				? h(
						"div",
						{ class: "perm-risk" },
						svg(icons.alert),
						h(
							"div",
							null,
							h("div", null, `${RISK_LABEL[risk.kind] ?? risk.kind}${risk.detail ? ` · ${risk.detail}` : ""}`),
							h(
								"div",
								{ class: "perm-risk-note" },
								"위험 표시가 붙은 요청은 CLI가 '항상 허용'을 주지 않고 권한 무시 모드에서도 묻습니다.",
							),
						),
					)
				: null;

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

			const auto = autoPick ? h("div", { class: "perm-auto" }) : null;

			const card = h(
				"div",
				{ class: `perm${question ? " perm-question" : ""}` },
				h(
					"div",
					{ class: "perm-head" },
					svg(question ? icons.chat : icons.shield),
					h("span", null, question ? "질문" : "권한 요청"),
					h(
						"span",
						{ class: "perm-title", title: tool.title ?? "" },
						question ? (tool.title ?? "") : displayTitle(tool, this.cwd),
					),
				),
				riskLine,
				preview.childNodes.length ? preview : null,
				auto,
				actions,
			);
			this.log.appendChild(card);
			this.permissions.push({ card, resolve: (outcome) => done(outcome, "취소됨") });
			this.scrollToBottom(true);

			if (autoPick && auto) {
				const label = labels[request.options.indexOf(autoPick)].label;
				const text = h("span", null);
				auto.append(
					text,
					h("button", { class: "btn", type: "button", onclick: stopCountdown }, "자동 선택 멈추기"),
				);
				let left = BYPASS_COUNTDOWN_SECONDS;
				const tick = () => {
					// Leaving bypass mode while it counts down hands the choice back.
					if (!this.answersForUser) return stopCountdown();
					if (left <= 0) {
						return done(
							{ outcome: "selected", optionId: autoPick.optionId },
							question ? `권한 무시 모드 · 답: ${label} (자동)` : `권한 무시 모드 · ${label} 자동 선택함`,
						);
					}
					text.textContent = `권한 무시 모드 · ${left}초 뒤 '${label}' 자동 선택`;
					left--;
				};
				tick();
				countdown = window.setInterval(tick, 1000);
				return;
			}
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

	// ------------------------------------------------------------ ultrawork

	/** A `ulw_plan` / `ulw_node` / `ulw_verify` / `agent` call changed the graph. */
	private observeUlw(tool: ToolCall): void {
		const kind = ulwToolKind(tool);
		if (!kind) return;
		const next = applyUlwTool(this.ulw, tool);
		if (next === this.ulw) return;
		this.ulw = next;
		if (kind === "plan") {
			this.dagDismissed = false;
			this.dagBox.classList.remove("hidden", "collapsed");
		} else if (kind === "verify" && !this.dagDismissed) {
			this.dagBox.classList.remove("hidden");
		}
		this.renderDag();
	}

	private renderDag(): void {
		const run = this.ulw;
		if (!run) {
			this.dagBox.classList.add("hidden");
			this.ulwChip.classList.add("hidden");
			return;
		}
		const total = run.nodes.length;
		const done = run.nodes.filter((node) => node.status === "done").length;
		const failed = run.nodes.filter((node) => node.status === "failed").length;
		const phase = run.verifierPassed ? "검증 통과" : run.phase === "verify" ? "검증" : "실행";

		this.ulwChip.classList.remove("hidden");
		this.ulwChip.classList.toggle("ok", run.verifierPassed);
		this.ulwChip.classList.toggle("failed", !run.verifierPassed && failed > 0);
		this.ulwChip.replaceChildren(
			h("span", { class: "dot" }),
			run.verifierPassed ? "ULW 검증" : `ULW ${done}/${total}`,
		);

		this.dagBox.classList.toggle("done", run.verifierPassed);
		this.dagBox.classList.toggle("failed", !run.verifierPassed && failed > 0);

		const head = h(
			"div",
			{ class: "dag-head", onclick: () => this.dagBox.classList.toggle("collapsed") },
			svg(icons.sparkle),
			h("span", { class: "dag-title" }, "ULTRAWORK"),
			h("span", { class: `dag-phase${run.verifierPassed ? " ok" : ""}` }, phase),
			h("span", { class: "dag-count" }, `${done}/${total}`),
			h(
				"span",
				{ class: "dag-bar" },
				h("span", { style: `width:${total ? (done / total) * 100 : 0}%` }),
			),
			failed > 0 ? h("span", { class: "dag-failed" }, `${failed} 실패`) : null,
			h("span", { class: "spacer" }),
			h(
				"button",
				{
					class: "icon-btn",
					type: "button",
					title: "그래프 닫기",
					onclick: (event: Event) => {
						event.stopPropagation();
						this.dismissDag();
					},
				},
				svg(icons.close),
			),
		);
		const objective = h(
			"div",
			{ class: "dag-objective", title: run.objective },
			run.objective || "(목표 없음)",
		);
		const left = this.dagBody.scrollLeft;
		const top = this.dagBody.scrollTop;
		this.dagBody.replaceChildren(objective, renderUlwCanvas(run));
		this.dagBox.replaceChildren(head, this.dagBody);
		this.dagBody.scrollLeft = left;
		this.dagBody.scrollTop = top;
	}

	private toggleDag(): void {
		if (this.dagBox.classList.contains("hidden")) {
			this.dagBox.classList.remove("hidden", "collapsed");
			this.dagDismissed = false;
		} else {
			this.dismissDag();
		}
	}

	private dismissDag(): void {
		this.dagBox.classList.add("hidden");
		this.dagDismissed = true;
	}

	// ------------------------------------------------------------ composer

	private sendHint(): string {
		return this.host.settings().sendKey === "enter" ? "Enter 보내기 · Shift+Enter 줄바꿈" : keys("Ctrl+Enter 보내기");
	}

	private onInput(): void {
		this.input.style.height = "auto";
		this.input.style.height = `${Math.min(this.input.scrollHeight, 260)}px`;
		this.renderSlash();
		this.schedulePreview();
	}

	// ------------------------------------------------------- math preview

	/** Coalesces a burst of keystrokes into one render; formulas themselves come from the KaTeX cache. A long document gets a little more slack. */
	private schedulePreview(): void {
		if (this.previewTimer !== null) return;
		this.previewTimer = window.setTimeout(
			() => {
				this.previewTimer = null;
				this.renderMathPreview();
			},
			this.input.value.length > 4000 ? 160 : 80,
		);
	}

	private renderMathPreview(): void {
		const value = this.input.value;
		if (!value) this.previewMode = "auto";
		const enabled = this.host.settings().mathPreview && this.previewMode !== "off";
		// Lenient: a $$ or \[ block still being typed shows up as it grows.
		const spans = enabled && /[$\\]/.test(value) ? findMath(value, true).filter((s) => s.text) : [];
		const markdown = enabled && looksLikeMarkdown(value);
		// A document, or more formulas than chips can show at a glance, previews whole.
		const doc = this.previewMode === "doc" || (this.previewMode === "auto" && (markdown || spans.length > 6));
		if (!enabled || (doc ? !spans.length && !markdown : !spans.length)) {
			this.mathPreview.classList.add("hidden");
			this.mathPreview.replaceChildren();
			return;
		}
		const caret = this.input.selectionStart;
		const bar = this.previewBar(doc);
		if (doc) {
			const body = h("div", { class: "md math-doc" });
			body.innerHTML = renderDraft(value);
			this.mathPreview.replaceChildren(bar, body);
			this.mathPreview.classList.add("doc");
			this.mathPreview.classList.remove("hidden");
			this.followCaret(body, value, caret, spans);
			return;
		}
		this.mathPreview.replaceChildren(
			bar,
			...spans.map((span) => {
				const active = caret >= span.start && caret <= span.end;
				const chip = h("span", {
					class: `math-chip${span.display ? " block" : ""}${span.open ? " open" : ""}${active ? " active" : ""}`,
				});
				chip.innerHTML = renderMath(span.text, span.display);
				return chip;
			}),
		);
		this.mathPreview.classList.remove("doc");
		this.mathPreview.classList.remove("hidden");
		if (this.mathPreview.scrollHeight > this.mathPreview.clientHeight) {
			this.mathPreview.querySelector(".active")?.scrollIntoView({ block: "nearest" });
		}
	}

	/** 수식 · 문서 · × at the strip's corner. mousedown, so the textarea keeps focus and the caret. */
	private previewBar(doc: boolean): HTMLElement {
		const button = (label: string, mode: "chips" | "doc" | "off", active: boolean, title: string) =>
			h(
				"button",
				{
					class: `preview-mode${active ? " active" : ""}`,
					type: "button",
					title,
					onmousedown: (event: Event) => {
						event.preventDefault();
						this.previewMode = mode;
						this.renderMathPreview();
					},
				},
				label,
			);
		return h(
			"div",
			{ class: "preview-bar" },
			button("수식", "chips", !doc, "수식만 칩으로 보기"),
			button("문서", "doc", doc, "전체를 문서로 보기"),
			button("×", "off", false, "이 메시지에서는 미리보기 숨기기"),
		);
	}

	/**
	 * Keep the document preview near where the caret is: the formula under the
	 * caret, else the last heading above it, else the same fraction of the way
	 * down. Scrolls the strip itself, never the page.
	 */
	private followCaret(body: HTMLElement, value: string, caret: number, spans: MathSpan[]): void {
		const box = this.mathPreview;
		const scrollable = box.scrollHeight > box.clientHeight;
		// Rect-based, so a formula inside a table cell (whose offsetParent is the table) works too.
		const scrollTo = (el: HTMLElement, center: boolean) => {
			const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
			box.scrollTop = Math.max(0, top - (center ? box.clientHeight / 2 : 10));
		};
		const i = spans.findIndex((s) => caret >= s.start && caret <= s.end);
		if (i >= 0) {
			const formulas = [...body.querySelectorAll<HTMLElement>("[data-tex]")];
			const target =
				formulas[i]?.dataset.tex === spans[i].text ? formulas[i] : formulas.find((f) => f.dataset.tex === spans[i].text);
			if (target) {
				target.classList.add("active");
				if (scrollable) scrollTo(target, true);
				return;
			}
		}
		if (!scrollable) return;
		const headings = [...value.slice(0, caret).matchAll(/^ {0,3}#{1,6} +(.+?)\s*#*[ \t]*$/gm)];
		if (headings.length) {
			const plain = (s: string) => s.replace(/[*`$_\\{}]/g, "").replace(/\s+/g, " ").trim();
			const want = plain(headings[headings.length - 1][1]);
			const heading = [...body.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].find((el) => plain(el.textContent ?? "") === want);
			if (heading) {
				scrollTo(heading, false);
				return;
			}
		}
		box.scrollTop = (caret / Math.max(1, value.length)) * (box.scrollHeight - box.clientHeight);
	}

	/** Wrap the selection in $…$ (or a $$ block when asked, or when it spans lines); an empty selection gets the caret inside. */
	private insertMath(block: boolean): void {
		const input = this.input;
		const start = input.selectionStart;
		const end = input.selectionEnd;
		const selected = input.value.slice(start, end);
		block ||= selected.includes("\n");
		const open = block ? `${start > 0 && input.value[start - 1] !== "\n" ? "\n" : ""}$$\n` : "$";
		const snippet = `${open}${selected}${block ? "\n$$" : "$"}`;
		input.focus();
		input.setSelectionRange(start, end);
		// execCommand keeps the textarea's undo history and fires `input`; setRangeText is the fallback.
		if (!document.execCommand("insertText", false, snippet)) {
			input.setRangeText(snippet, start, end, "end");
			this.onInput();
		}
		const caret = selected ? start + snippet.length : start + open.length;
		input.setSelectionRange(caret, caret);
		this.schedulePreview();
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
				event.stopPropagation();
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

	private async addImage(file: File): Promise<void> {
		const buffer = new Uint8Array(await file.arrayBuffer());
		let binary = "";
		for (let i = 0; i < buffer.length; i += 0x8000) {
			binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
		}
		this.attachImage(file.type, btoa(binary));
	}

	/** Attach a base64 image to the next message (paste, or a file dropped on the window). */
	attachImage(mimeType: string, data: string): void {
		if (this.connection.info && !this.connection.acceptsImages) {
			this.flash("이 에이전트는 이미지 입력을 지원하지 않습니다.");
			return;
		}
		this.attachments.push({ mimeType, data, url: `data:${mimeType};base64,${data}` });
		this.renderAttachments();
		this.input.focus();
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
			// A crash already put up the banner with "다시 연결"; keep it.
			if (this.connection.alive) this.showError(error);
			const limit = explainError(error).limit;
			if (limit) this.host.reportLimit(this.options.accountId, limit.window, limit.resetAt);
			this.host.attention("error", describeError(error));
		} finally {
			this.finishTurnUi();
		}

		if (this.rebindPending) {
			// The rebind's open() sends whatever is queued once reconnected.
			void this.rebind();
			return;
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
				this.observeUlw(entry.data);
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
			this.showBanner("alert", info.text, "로그인", () => this.host.login(this.options.accountId));
		} else if (info.credits) {
			this.showBanner("alert", `${this.options.accountName}: ${info.text}`, "계정 전환", () => this.host.openAccounts());
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

/** `cmd acp` sends ask_user_question (and enter_plan_mode's "enter plan
 * mode?") as a permission request whose options are the answers, ids
 * `option_N`, every one of kind `allow_once`. */
function isQuestion(request: PermissionRequest): boolean {
	return request.options.length > 0 && request.options.every((o) => /^option_\d+$/.test(o.optionId));
}

/** Button text per option. Answers keep their own wording ("label:
 * description" split back apart); permission options use the Korean label for
 * their kind unless two options share a kind, which would read the same. */
function optionLabels(request: PermissionRequest, question: boolean): { label: string; description: string }[] {
	if (question) {
		const raw = (request.toolCall.rawInput as { options?: unknown } | undefined)?.options;
		return request.options.map((option, index) => {
			const label = Array.isArray(raw) ? raw[index] : undefined;
			if (typeof label === "string" && label && option.name.startsWith(label)) {
				return { label, description: option.name.slice(label.length).replace(/^:\s*/, "") };
			}
			return { label: option.name, description: "" };
		});
	}
	const unique = new Set(request.options.map((o) => o.kind)).size === request.options.length;
	return request.options.map((option) => ({
		label: (unique && PERMISSION_LABEL[option.kind]) || option.name,
		description: "",
	}));
}

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

/** The CLI truncates long titles ("Write: C:\Users\…\46..."); when the tool
 * names a file, rebuild the title from its full path, shortened to the project. */
function displayTitle(tool: ToolCall, cwd: string): string {
	const title = tool.title ?? "도구 실행";
	const path = tool.locations?.[0]?.path;
	const label = title.match(/^([^:]{1,24}):\s/)?.[1];
	if (path && label) return `${label}: ${shortPath(path, cwd)}`;
	return relativeTitle(title, cwd);
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
function explainError(error: unknown): {
	text: string;
	login: boolean;
	credits?: boolean;
	limit?: { window: string; resetAt: number | null };
} {
	const message = error instanceof Error ? error.message : String(error);
	if (/insufficient credits|purchase more credits/i.test(message)) {
		return {
			text: "이 계정에 크레딧이 부족합니다. 크레딧을 충전하거나, 사용 가능한 다른 계정이나 모델로 바꾸세요. (무료 모델도 잔액 $1 이상이 필요합니다)",
			login: false,
			credits: true,
		};
	}
	if (/not available on your plan|upgrade your plan|requires? (the )?\w+ plan/i.test(message)) {
		return { text: `이 모델은 지금 요금제에서 쓸 수 없습니다. 다른 모델을 고르세요. (${message})`, login: false, credits: true };
	}
	if (/not authenticated|cmd login/i.test(message)) {
		return { text: "Command Code에 로그인되어 있지 않습니다.", login: true };
	}
	if (/401|invalid 'authorization'|invalid.*token/i.test(message)) {
		return { text: "이 계정의 로그인 정보가 더 이상 유효하지 않습니다. 다시 로그인해 주세요.", login: true };
	}
	const reset = message.match(/resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
	if ((error instanceof AcpError && error.status === 429) || /usage limit|today's limit|429/i.test(message)) {
		const when = reset
			? new Date(reset[1]).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
			: null;
		// The CLI's wording: "your 5-hour|weekly|daily usage limit", or "today's
		// limit on <model>". Anything else names no window; the gauge then tells
		// which one ran out from the account's numbers instead of guessing here.
		const model = message.match(/today's limit on (.+?)\.(?:\s|$)/i)?.[1];
		const window = /weekly/i.test(message)
			? "주간"
			: model
				? `${model} 일간`
				: /daily/i.test(message)
					? "일간"
					: /5-hour|five.?hour/i.test(message)
						? "5시간"
						: /monthly/i.test(message)
							? "월간"
							: "";
		return {
			text: `${window ? `${window} ` : ""}사용 한도에 도달했습니다.${when ? ` ${when}에 초기화됩니다.` : ""}${window ? "" : " 어느 한도인지는 오른쪽 위 사용량에서 확인하세요."} 다른 계정이나 모델로 바꾸거나 잠시 후 다시 시도하세요.`,
			login: false,
			limit: { window, resetAt: reset ? Date.parse(reset[1]) : null },
		};
	}
	return { text: message, login: false };
}
