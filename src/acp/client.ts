// JSON-RPC 2.0 client for one `cmd acp` process. Rust (src-tauri/src/acp.rs)
// only moves newline-framed lines; everything protocol-shaped lives here.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	ElicitationOutcome,
	ElicitationRequest,
	InitializeResult,
	Launch,
	PermissionOutcome,
	PermissionRequest,
	SessionInfo,
	SessionUpdate,
} from "./types";

/** The highest protocol version this client speaks; the agent replies with the
 * version it actually supports, and both v1 and v2 update names are accepted. */
const PROTOCOL_VERSION = 2;
const LOG_LINES = 400;

/** How long a request may go unanswered before it fails. A prompt runs as long
 * as the agent works (the user cancels it); a cold `initialize` can take 10-20 s
 * on a slow disk; everything else answers at once from a live agent. */
function timeoutFor(method: string): number | null {
	if (method === "session/prompt") return null;
	if (method === "initialize") return 120_000;
	if (method === "session/new" || method === "session/load" || method === "session/resume") return 90_000;
	return 30_000;
}

/** v2 `initialize` renamed the response fields too (`capabilities`/`info`,
 * `session` carrying a method subset). Fold it into the v1 shape the rest of
 * this client already reads, so capability gating stays unchanged. */
function normalizeInitialize(raw: unknown): InitializeResult {
	const init = (raw ?? {}) as InitializeResult & {
		capabilities?: {
			session?: {
				prompt?: { image?: unknown; audio?: unknown; embeddedContext?: unknown };
				mcp?: { http?: unknown; sse?: unknown };
			} & Record<string, unknown>;
			terminal?: unknown;
			loadSession?: unknown;
		};
		info?: { name: string; title?: string; version: string };
	};
	if (init.agentCapabilities) return init;
	// A present `session` object advertises the baseline methods (new, list,
	// resume, close, prompt, cancel, update); nested keys refine the rest.
	const session = init.capabilities?.session;
	const on = (value: unknown) => value !== undefined && value !== null && value !== false;
	return {
		protocolVersion: init.protocolVersion,
		agentCapabilities: {
			loadSession: on(init.capabilities?.loadSession) ? true : undefined,
			promptCapabilities: session
				? { image: on(session.prompt?.image), audio: on(session.prompt?.audio), embeddedContext: on(session.prompt?.embeddedContext) }
				: undefined,
			mcpCapabilities: session ? { http: on(session.mcp?.http), sse: on(session.mcp?.sse) } : undefined,
			sessionCapabilities: session
				? {
						list: on(session.list) ? (session.list as object) : {},
						resume: on(session.resume) ? (session.resume as object) : {},
						close: on(session.close) ? (session.close as object) : {},
						delete: on(session.delete) ? (session.delete as object) : undefined,
					}
				: undefined,
			terminal: on(init.capabilities?.terminal) ? {} : undefined,
		},
		authMethods: init.authMethods,
		agentInfo: init.agentInfo ?? (init.info ? { name: init.info.name, version: init.info.version } : undefined),
	};
}

/** A JSON-RPC error from the agent, kept structured so the UI can explain it. */
export class AcpError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}

	get status(): number | undefined {
		const data = this.data as { status?: number } | undefined;
		return data?.status;
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface SessionHandlers {
	onUpdate: (update: SessionUpdate) => void;
	onPermission: (request: PermissionRequest) => Promise<PermissionOutcome>;
	/** v2 `elicitation/create`; absent means "cancel" for the agent. */
	onElicitation?: (request: ElicitationRequest) => Promise<ElicitationOutcome>;
}

let connectionSeq = 0;

export class AcpConnection {
	readonly id = `acp-${Date.now().toString(36)}-${(connectionSeq += 1)}`;
	launch: Launch | null = null;
	info: InitializeResult | null = null;
	alive = false;
	/** Exited or stopped; never usable again (the pool replaces it). */
	dead = false;
	readonly log: string[] = [];

	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	/** Which request ids belong to which method/session, for `$/cancel_request`. */
	private readonly requestMeta = new Map<number, { method: string; sessionId?: string }>();
	private readonly sessions = new Map<string, SessionHandlers>();
	private readonly exitListeners = new Set<(code: number | null) => void>();
	private unlistenExit: UnlistenFn | null = null;
	private ready: Promise<void> | null = null;

	constructor(
		readonly cwd: string,
		/** Saved account to run as; null runs as the CLI's own `cmd login`. */
		readonly accountId: string | null = null,
		/** Which backend this connection runs (pool key + restart). */
		readonly backendId?: string,
		/** Custom ACP agent command; null spawns the builtin `cmd acp`. */
		readonly agent: { program: string; args: string[] } | null = null,
	) {}

	/** Spawn the agent and run `initialize`; safe to call more than once. */
	start(): Promise<void> {
		if (this.dead) return Promise.reject(new AcpError(-32000, "연결이 이미 닫혔습니다."));
		// A failed start leaves no half-started process behind: the pool sees
		// `dead` and the next attempt gets a fresh connection.
		this.ready ??= this.boot().catch(async (error) => {
			await this.stop();
			throw error;
		});
		return this.ready;
	}

	private async boot(): Promise<void> {
		const onMessage = new Channel<string>();
		onMessage.onmessage = (line) => this.receive(line);
		const onLog = new Channel<string>();
		onLog.onmessage = (line) => {
			this.log.push(line);
			if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
		};

		this.unlistenExit = await listen<{ id: string; code: number | null }>("acp://exit", (event) => {
			if (event.payload.id === this.id) this.handleExit(event.payload.code);
		});

		this.launch = await invoke<Launch>("acp_spawn", {
			id: this.id,
			cwd: this.cwd,
			profileDir: null,
			accountId: this.agent ? null : this.accountId,
			agent: this.agent,
			onMessage,
			onLog,
		});
		// stop() during the spawn found nothing to kill; the process exists now.
		if (this.dead) {
			this.unlistenExit?.();
			this.unlistenExit = null;
			await invoke("acp_kill", { id: this.id }).catch(() => undefined);
			throw new AcpError(-32000, "연결이 닫혔습니다.");
		}
		this.alive = true;

		const capabilities = {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
			// v2 structured questions: forms render as cards; URL mode asks
			// consent and then opens the link in the system browser.
			elicitation: { form: {}, url: {} },
		};
		const info = { name: "command-code-desktop", title: "Command Code Desktop", version: "0.5.0" };
		// The v2 schema renamed the params (clientCapabilities→capabilities,
		// clientInfo→info), so send both shapes in one request: a v2 agent reads
		// the new names, a v1 agent the old ones, each ignoring the rest. Some
		// agents reject unknown fields outright; those get a plain v1 retry.
		let init: unknown;
		try {
			init = await this.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities,
				info,
				clientCapabilities: capabilities,
				clientInfo: info,
			});
		} catch (error) {
			if (!(error instanceof AcpError && error.code === -32602)) throw error;
			init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: capabilities, clientInfo: info });
		}
		this.info = normalizeInitialize(init);
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (!this.alive) return Promise.reject(new AcpError(-32000, "에이전트 프로세스가 실행 중이 아닙니다."));
		const id = this.nextId++;
		const limit = timeoutFor(method);
		this.requestMeta.set(id, { method, sessionId: (params as { sessionId?: string } | null)?.sessionId });
		return new Promise<T>((resolve, reject) => {
			const timer = limit === null ? null : window.setTimeout(() => {
				if (!this.pending.delete(id)) return;
				this.requestMeta.delete(id);
				this.cancelRequest(id);
				reject(new AcpError(-32001, `에이전트가 ${Math.round(limit / 1000)}초 동안 응답하지 않았습니다 (${method}).`));
			}, limit);
			const settle = () => {
				this.requestMeta.delete(id);
				if (timer !== null) clearTimeout(timer);
			};
			this.pending.set(id, {
				resolve: (value) => { settle(); resolve(value as T); },
				reject: (error) => { settle(); reject(error); },
			});
			this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
				this.pending.delete(id);
				settle();
				reject(error);
			});
		});
	}

	/** JSON-RPC level cancellation (v2): tell the agent to drop our own request. */
	cancelRequest(id: number): void {
		this.notify("$/cancel_request", { requestId: id });
	}

	/** `session/cancel` plus `$/cancel_request` for that session's open prompt:
	 * v1 agents ignore what they do not know; v2 agents stop the RPC too. */
	cancelSession(sessionId: string): void {
		this.notify("session/cancel", { sessionId });
		for (const [id, meta] of this.requestMeta) {
			if (meta.sessionId === sessionId && meta.method === "session/prompt") this.cancelRequest(id);
		}
	}

	notify(method: string, params: unknown): void {
		void this.send({ jsonrpc: "2.0", method, params }).catch(() => {
			// The process is gone; the exit handler already told every session.
		});
	}

	/** Route `session/update` and permission requests for one session. */
	attach(sessionId: string, handlers: SessionHandlers): () => void {
		this.sessions.set(sessionId, handlers);
		return () => {
			if (this.sessions.get(sessionId) === handlers) this.sessions.delete(sessionId);
		};
	}

	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	get sessionCount(): number {
		return this.sessions.size;
	}

	get canList(): boolean {
		return Boolean(this.info?.agentCapabilities.sessionCapabilities?.list);
	}

	get canResume(): boolean {
		return Boolean(this.info?.agentCapabilities.sessionCapabilities?.resume);
	}

	get canDelete(): boolean {
		return Boolean(this.info?.agentCapabilities.sessionCapabilities?.delete);
	}

	get canClose(): boolean {
		return Boolean(this.info?.agentCapabilities.sessionCapabilities?.close);
	}

	/** Advertised auth methods; empty when the agent needs no `auth/login`.
	 * v2 spells the id `methodId`; folded into `id` here. */
	get authMethods(): { id: string; name: string; description?: string }[] {
		return (this.info?.authMethods ?? []).map((m) => ({ ...m, id: m.id ?? m.methodId ?? m.name }));
	}

	get acceptsImages(): boolean {
		return Boolean(this.info?.agentCapabilities.promptCapabilities?.image);
	}

	async listSessions(): Promise<SessionInfo[]> {
		await this.start();
		if (!this.canList) return [];
		const result = await this.request<{ sessions: SessionInfo[] }>("session/list", { cwd: this.cwd });
		return result.sessions ?? [];
	}

	/** `session/delete` (v2, capability-gated); false when unsupported. */
	async deleteSession(sessionId: string): Promise<boolean> {
		if (!this.canDelete) return false;
		await this.request("session/delete", { sessionId });
		return true;
	}

	/** `auth/login` with the agent's first advertised method (v2). The agent
	 * may still need the user to finish a browser or terminal step itself. */
	async login(methodId?: string): Promise<void> {
		const id = methodId ?? this.authMethods[0]?.id;
		await this.request("auth/login", id ? { methodId: id } : {});
	}

	async stop(): Promise<void> {
		if (this.dead) return;
		this.dead = true;
		for (const { reject } of this.pending.values()) reject(new AcpError(-32000, "연결이 닫혔습니다."));
		this.pending.clear();
		this.alive = false;
		await invoke("acp_kill", { id: this.id }).catch(() => undefined);
		this.unlistenExit?.();
		this.unlistenExit = null;
	}

	// ------------------------------------------------------------ internals

	private async send(message: object): Promise<void> {
		await invoke("acp_send", { id: this.id, line: JSON.stringify(message) });
	}

	private receive(line: string): void {
		let message: {
			id?: number | string;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { code: number; message: string; data?: unknown };
		};
		try {
			message = JSON.parse(line);
		} catch {
			this.log.push(`[stdout] ${line}`);
			return;
		}

		if (message.method && message.id !== undefined) {
			void this.serve(message.id, message.method, message.params);
			return;
		}
		if (message.method) {
			this.handleNotification(message.method, message.params);
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method !== "session/update") return;
		const { sessionId, update } = params as { sessionId: string; update: SessionUpdate };
		this.sessions.get(sessionId)?.onUpdate(update);
	}

	/** Agent-to-client requests. We advertise no fs/terminal capability, so
	 * permission prompts are the only ones we expect. */
	private async serve(id: number | string, method: string, params: unknown): Promise<void> {
		const reply = (body: object) => {
			void this.send({ jsonrpc: "2.0", id, ...body }).catch(() => undefined);
		};

		if (method === "session/request_permission") {
			const request = params as PermissionRequest;
			const handlers = this.sessions.get(request.sessionId);
			const outcome: PermissionOutcome = handlers
				? await handlers.onPermission(request).catch((): PermissionOutcome => ({ outcome: "cancelled" }))
				: { outcome: "cancelled" };
			reply({ result: { outcome } });
			return;
		}

		if (method === "elicitation/create") {
			const request = params as ElicitationRequest;
			const handlers = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
			const outcome: ElicitationOutcome = handlers?.onElicitation
				? await handlers.onElicitation(request).catch((): ElicitationOutcome => ({ action: "cancel" }))
				: { action: "cancel" };
			reply({ result: outcome });
			return;
		}

		reply({ error: { code: -32601, message: `Method not supported by this client: ${method}` } });
	}

	private handleExit(code: number | null): void {
		this.alive = false;
		this.dead = true;
		for (const { reject } of this.pending.values()) {
			reject(new AcpError(-32000, `에이전트가 종료되었습니다 (코드 ${code ?? "?"}).`));
		}
		this.pending.clear();
		this.unlistenExit?.();
		this.unlistenExit = null;
		for (const listener of this.exitListeners) listener(code);
	}
}
