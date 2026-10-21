// A terminal tab: the real Command Code TUI over ConPTY (the v0.1 path). Kept
// for what only the TUI does: `cmd login`, `/config`, `/usage`, `/rewind`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Launch } from "../acp/types";
import { h } from "../ui/dom";

export interface TerminalHost {
	setBusy(busy: boolean): void;
	exited(): void;
}

const encoder = new TextEncoder();

function toBase64(text: string): string {
	const bytes = encoder.encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

let terminalSeq = 0;

export class TerminalView {
	readonly root: HTMLElement;
	readonly busy = false;
	private readonly term: Terminal;
	private readonly fit = new FitAddon();
	private readonly host: HTMLElement;
	private readonly observer: ResizeObserver;
	private id: string | null = null;
	private unlisten: UnlistenFn | null = null;

	constructor(
		private readonly owner: TerminalHost,
		readonly cwd: string,
		private readonly args: string[],
		fontSize: number,
		private readonly profileDir: string | null,
	) {
		this.host = h("div", { class: "term-host" });
		this.root = h("section", { class: "terminal" }, this.host);

		this.term = new Terminal({
			allowProposedApi: true,
			cursorBlink: true,
			cursorStyle: "bar",
			fontFamily: '"Cascadia Mono", "D2Coding", Consolas, "Courier New", monospace',
			fontSize,
			lineHeight: 1.15,
			scrollback: 10_000,
			theme: {
				background: "#0f1115",
				foreground: "#d7dce3",
				cursor: "#7aa2ff",
				selectionBackground: "#2b3648",
				black: "#1d222b",
				red: "#ff6b6b",
				green: "#5cd68a",
				yellow: "#ffcc66",
				blue: "#7aa2ff",
				magenta: "#c792ea",
				cyan: "#5ad4e6",
				white: "#d7dce3",
				brightBlack: "#6b7688",
			},
		});
		this.term.loadAddon(this.fit);
		this.term.loadAddon(new Unicode11Addon());
		this.term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));
		this.term.unicode.activeVersion = "11";

		this.term.onData((data) => {
			if (!this.id) return;
			void invoke("pty_write", { id: this.id, data: toBase64(data) }).catch(() => undefined);
		});
		this.term.onResize(({ cols, rows }) => {
			if (this.id) void invoke("pty_resize", { id: this.id, cols, rows }).catch(() => undefined);
		});

		// Ctrl+C copies when there is a selection (otherwise it interrupts, as
		// usual); Ctrl+V pastes. Both match Windows Terminal.
		this.term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown" || !event.ctrlKey || event.shiftKey || event.altKey) return true;
			if (event.key === "c" && this.term.hasSelection()) {
				void navigator.clipboard.writeText(this.term.getSelection());
				this.term.clearSelection();
				return false;
			}
			if (event.key === "v") {
				void navigator.clipboard.readText().then((text) => text && this.term.paste(text));
				return false;
			}
			return true;
		});
		this.host.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			if (this.term.hasSelection()) {
				void navigator.clipboard.writeText(this.term.getSelection());
				this.term.clearSelection();
			} else {
				void navigator.clipboard.readText().then((text) => text && this.term.paste(text));
			}
		});

		this.observer = new ResizeObserver(() => this.refit());
		this.observer.observe(this.host);
	}

	/** Called once the root is in the document, so xterm can measure. */
	async start(): Promise<void> {
		if (!this.term.element) {
			this.term.open(this.host);
			try {
				const webgl = new WebglAddon();
				webgl.onContextLoss(() => webgl.dispose());
				this.term.loadAddon(webgl);
			} catch {
				// Software-only GPU: the DOM renderer is the fallback.
			}
		}
		await document.fonts?.ready.catch(() => undefined);
		this.refit();

		// The CLI takes several seconds to paint its first frame on a cold start.
		this.term.write("\x1b[2mCommand Code 시작 중…\x1b[0m");
		const channel = new Channel<string>();
		channel.onmessage = (payload) => this.term.write(fromBase64(payload));
		const id = `pty-${Date.now().toString(36)}-${(terminalSeq += 1)}`;
		this.unlisten = await listen<string>("pty://exit", (event) => {
			if (event.payload !== id) return;
			this.id = null;
			this.term.writeln("\r\n\x1b[2m[종료됨 — 탭을 닫거나 다시 시작하세요]\x1b[0m");
			this.owner.exited();
		});
		try {
			await invoke<Launch>("pty_spawn", {
				id,
				cwd: this.cwd,
				cols: this.term.cols,
				rows: this.term.rows,
				args: this.args,
				profileDir: this.profileDir,
				onOutput: channel,
			});
			this.id = id;
		} catch (error) {
			this.term.writeln(`\x1b[31m실행 실패: ${String(error)}\x1b[0m`);
		}
		this.term.focus();
	}

	async restart(): Promise<void> {
		await this.kill();
		this.term.reset();
		await this.start();
	}

	focus(): void {
		this.refit();
		this.term.focus();
	}

	refit(): void {
		if (!this.root.isConnected || this.root.offsetParent === null) return;
		try {
			this.fit.fit();
		} catch {
			// Not laid out yet; the next resize retries.
		}
	}

	private async kill(): Promise<void> {
		this.unlisten?.();
		this.unlisten = null;
		if (this.id) await invoke("pty_kill", { id: this.id }).catch(() => undefined);
		this.id = null;
	}

	dispose(): void {
		void this.kill();
		this.observer.disconnect();
		this.term.dispose();
	}
}
