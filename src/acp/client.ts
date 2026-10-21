// JSON-RPC 2.0 client for one `cmd acp` process. Rust (src-tauri/src/acp.rs)
// only moves newline-framed lines; everything protocol-shaped lives here.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	InitializeResult,
	Launch,
	PermissionOutcome,
	PermissionRequest,
	SessionInfo,
	SessionUpdate,
} from "./types";

const PROTOCOL_VERSION = 1;
const LOG_LINES = 400;

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
}

let connectionSeq = 0;

export class AcpConnection {
	readonly id = `acp-${Date.now().toString(36)}-${(connectionSeq += 1)}`;
	launch: Launch | null = null;
	info: InitializeResult | null = null;
	alive = false;
	readonly log: string[] = [];

	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly sessions = new Map<string, SessionHandlers>();
	private readonly exitListeners = new Set<(code: number | null) => void>();
	private unlistenExit: UnlistenFn | null = null;
	private ready: Promise<void> | null = null;

	constructor(
		readonly cwd: string,
		readonly profileDir: string | null = null,
	) {}

	/** Spawn the agent and run `initialize`; safe to call more than once. */
	start(): Promise<void> {
		this.ready ??= this.boot().catch((error) => {
			this.ready = null;
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
			profileDir: this.profileDir,
			onMessage,
			onLog,
		});
		this.alive = true;

		this.info = await this.request<InitializeResult>("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "command-code-desktop", title: "Command Code Desktop", version: "0.2.0" },
		});
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (!this.alive) return Promise.reject(new AcpError(-32000, "에이전트 프로세스가 실행 중이 아닙니다."));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
				this.pending.delete(id);
				reject(error);
			});
		});
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

	get acceptsImages(): boolean {
		return Boolean(this.info?.agentCapabilities.promptCapabilities?.image);
	}

	async listSessions(): Promise<SessionInfo[]> {
		await this.start();
		if (!this.canList) return [];
		const result = await this.request<{ sessions: SessionInfo[] }>("session/list", { cwd: this.cwd });
		return result.sessions ?? [];
	}

	async stop(): Promise<void> {
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

		reply({ error: { code: -32601, message: `Method not supported by this client: ${method}` } });
	}

	private handleExit(code: number | null): void {
		this.alive = false;
		this.ready = null;
		for (const { reject } of this.pending.values()) {
			reject(new AcpError(-32000, `에이전트가 종료되었습니다 (코드 ${code ?? "?"}).`));
		}
		this.pending.clear();
		this.unlistenExit?.();
		this.unlistenExit = null;
		for (const listener of this.exitListeners) listener(code);
	}
}
