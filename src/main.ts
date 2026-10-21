import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

/** Mirrors `pty::Launch` in src-tauri/src/pty.rs. */
interface Launch {
	program: string;
	prefix_args: string[];
	via: string;
	entry: string | null;
}

const LAST_DIR_KEY = "cmdc-gui:lastDir";
const YOLO_KEY = "cmdc-gui:yolo";

function byId<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
}

const pickBtn = byId<HTMLButtonElement>("pick");
const restartBtn = byId<HTMLButtonElement>("restart");
const killBtn = byId<HTMLButtonElement>("kill");
const yoloBox = byId<HTMLInputElement>("yolo");
const cwdLabel = byId<HTMLSpanElement>("cwd");
const launchLabel = byId<HTMLSpanElement>("launch");
const sessionLabel = byId<HTMLSpanElement>("session");
const dimsLabel = byId<HTMLSpanElement>("dims");
const emptyPane = byId<HTMLDivElement>("empty");
const termHost = byId<HTMLDivElement>("terminal");

// ------------------------------------------------------------------ base64

const encoder = new TextEncoder();

function toBase64(text: string): string {
	const bytes = encoder.encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

// ---------------------------------------------------------------- terminal

const term = new Terminal({
	allowProposedApi: true,
	cursorBlink: true,
	cursorStyle: "bar",
	fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
	fontSize: 13,
	lineHeight: 1.15,
	scrollback: 10_000,
	macOptionIsMeta: false,
	theme: {
		background: "#0f1115",
		foreground: "#d7dce3",
		cursor: "#4c8dff",
		selectionBackground: "#2b3648",
		black: "#1d222b",
		red: "#ff5c5c",
		green: "#5cd68a",
		yellow: "#ffcc66",
		blue: "#4c8dff",
		magenta: "#c792ea",
		cyan: "#5ad4e6",
		white: "#d7dce3",
		brightBlack: "#6b7688",
	},
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new Unicode11Addon());
term.loadAddon(new WebLinksAddon());
term.unicode.activeVersion = "11";

term.open(termHost);

// The WebGL renderer is a big win on redraw-heavy TUIs, but it can fail on
// software-only GPUs; the DOM renderer is the safe fallback.
try {
	const webgl = new WebglAddon();
	webgl.onContextLoss(() => webgl.dispose());
	term.loadAddon(webgl);
} catch (error) {
	console.warn("WebGL renderer unavailable, using DOM renderer", error);
}

function fitNow(): void {
	try {
		fitAddon.fit();
	} catch {
		// The host has no size yet (first paint); the ResizeObserver will retry.
	}
}

// --------------------------------------------------------------- lifecycle

let currentDir: string | null = null;
let sessionId: string | null = null;
let running = false;

function setRunning(next: boolean): void {
	running = next;
	restartBtn.disabled = !next;
	killBtn.disabled = !next;
	sessionLabel.textContent = next ? `session: ${sessionId}` : "session: —";
	if (next) emptyPane.classList.add("hidden");
}

function describeLaunch(launch: Launch): string {
	const via = launch.via === "node" ? "node entry" : "shim fallback";
	return `launch: ${via} · ${launch.program}`;
}

async function spawn(dir: string): Promise<void> {
	if (running) await stop();

	await fontReady();
	fitNow();

	const args = yoloBox.checked ? ["--yolo"] : [];
	const channel = new Channel<string>();
	channel.onmessage = (payload) => term.write(fromBase64(payload));

	sessionId = `tab-${Date.now().toString(36)}`;

	try {
		const launch = await invoke<Launch>("pty_spawn", {
			id: sessionId,
			cwd: dir,
			cols: term.cols,
			rows: term.rows,
			args,
			profileDir: null,
			onOutput: channel,
		});
		launchLabel.textContent = describeLaunch(launch);
		launchLabel.className = launch.via === "node" ? "" : "degraded";
	} catch (error) {
		sessionId = null;
		launchLabel.textContent = `launch failed: ${String(error)}`;
		launchLabel.className = "failed";
		term.writeln(`\r\n\x1b[31mFailed to start cmdc: ${String(error)}\x1b[0m`);
		return;
	}

	emptyPane.classList.add("hidden");
	setRunning(true);
	term.focus();
	await pushSize();
}

async function stop(): Promise<void> {
	if (sessionId) {
		try {
			await invoke("pty_kill", { id: sessionId });
		} catch (error) {
			console.warn("pty_kill failed", error);
		}
	}
	sessionId = null;
	setRunning(false);
}

async function pushSize(): Promise<void> {
	if (!sessionId) return;
	dimsLabel.textContent = `${term.cols}×${term.rows}`;
	try {
		await invoke("pty_resize", { id: sessionId, cols: term.cols, rows: term.rows });
	} catch {
		// The session may have exited between the fit and the resize; harmless.
	}
}

/** Wait for the webfont so xterm measures the cell size correctly. */
async function fontReady(): Promise<void> {
	if (document.fonts?.ready) {
		try {
			await document.fonts.ready;
		} catch {
			// Measuring with the fallback font is acceptable.
		}
	}
}

// ---------------------------------------------------------------- wiring

term.onData((data) => {
	if (!sessionId) return;
	void invoke("pty_write", { id: sessionId, data: toBase64(data) }).catch(() => {
		// The session ended; the exit event has already cleared the UI.
	});
});

term.onResize(() => {
	void pushSize();
});

// Right-click pastes, which is what people expect from a terminal panel.
termHost.addEventListener("contextmenu", async (event) => {
	event.preventDefault();
	try {
		const text = await navigator.clipboard.readText();
		if (text && sessionId) {
			await invoke("pty_write", { id: sessionId, data: toBase64(text) });
		}
	} catch {
		// Clipboard permission denied; typing and Ctrl+V still work.
	}
});

const resizeObserver = new ResizeObserver(() => {
	fitNow();
});
resizeObserver.observe(termHost);

void listen<string>("pty://exit", (event) => {
	if (event.payload !== sessionId) return;
	setRunning(false);
	sessionId = null;
	term.writeln("\r\n\x1b[2m[cmdc exited]\x1b[0m");
});

yoloBox.checked = localStorage.getItem(YOLO_KEY) === "1";
yoloBox.addEventListener("change", () => {
	localStorage.setItem(YOLO_KEY, yoloBox.checked ? "1" : "0");
});

pickBtn.addEventListener("click", async () => {
	const picked = await open({ directory: true, multiple: false, title: "Pick a project folder" });
	if (typeof picked !== "string") return;
	currentDir = picked;
	localStorage.setItem(LAST_DIR_KEY, picked);
	cwdLabel.textContent = picked;
	cwdLabel.title = picked;
	await spawn(picked);
});

restartBtn.addEventListener("click", () => {
	if (currentDir) void spawn(currentDir);
});

killBtn.addEventListener("click", () => {
	void stop();
});

window.addEventListener("beforeunload", () => {
	if (sessionId) void invoke("pty_kill", { id: sessionId });
});

// ----------------------------------------------------------------- startup

void (async () => {
	try {
		const launch = await invoke<Launch>("cmdc_launch");
		launchLabel.textContent = describeLaunch(launch);
		launchLabel.className = launch.via === "node" ? "" : "degraded";
	} catch (error) {
		launchLabel.textContent = `lookup failed: ${String(error)}`;
		launchLabel.className = "failed";
	}

	const last = localStorage.getItem(LAST_DIR_KEY);
	if (last) {
		cwdLabel.textContent = last;
		cwdLabel.title = last;
	}

	// A folder passed on the command line (or via CMDC_GUI_START_DIR) wins: the
	// app opens straight into it, which also makes it scriptable from a shortcut.
	const startDir = await invoke<string | null>("start_dir").catch(() => null);
	if (startDir) {
		currentDir = startDir;
		localStorage.setItem(LAST_DIR_KEY, startDir);
		cwdLabel.textContent = startDir;
		cwdLabel.title = startDir;
		await spawn(startDir);
		return;
	}

	requestAnimationFrame(() => {
		fitNow();
		pushSize();
	});
})();
