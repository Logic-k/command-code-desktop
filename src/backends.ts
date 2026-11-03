// Agent backends: which ACP-speaking program a chat tab talks to.
//
// The builtin backend is Command Code itself — the app resolves `cmd` like
// always (installed or the app-private runtime). A custom backend is any ACP
// agent on stdio (e.g. `npx @agentclientprotocol/codex-acp`, which signs in
// with a ChatGPT subscription); it is spawned with the user's own PATH, so
// launchers like npx/uvx resolve normally.
//
// Custom backends have no account, no billing, and no shared Command Code
// session history — the sidebar and transcripts stay Command Code-only.

export interface AgentSpec {
	program: string;
	args: string[];
}

export interface AgentBackend {
	id: string;
	name: string;
	/** Command Code itself; spawned through the Rust launch resolver. */
	builtin?: boolean;
	/** For custom agents: the full acp command to spawn. */
	spec?: AgentSpec;
	note?: string;
}

export const COMMAND_CODE: AgentBackend = { id: "command-code", name: "Command Code", builtin: true };

const KEY = "cmdc-desktop:backends";

/** Codex through the official ACP adapter: ChatGPT-subscription auth, no key. */
export function codexPreset(isWindows: boolean): AgentBackend {
	const args = ["-y", "@agentclientprotocol/codex-acp"];
	return {
		id: "codex-acp",
		name: "Codex (ChatGPT)",
		spec: isWindows ? { program: "cmd.exe", args: ["/c", "npx", ...args] } : { program: "npx", args },
		note: "npx가 필요합니다. 첫 실행 시 ChatGPT 로그인 창이 열립니다.",
	};
}

export function loadCustomBackends(): AgentBackend[] {
	try {
		const raw = localStorage.getItem(KEY);
		const list = raw ? (JSON.parse(raw) as AgentBackend[]) : [];
		return Array.isArray(list) ? list.filter((b) => b?.id && b?.spec?.program) : [];
	} catch {
		return [];
	}
}

export function saveCustomBackends(list: AgentBackend[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(list.filter((b) => !b.builtin)));
	} catch {
		// Preferences just will not persist.
	}
}

export function allBackends(): AgentBackend[] {
	return [COMMAND_CODE, ...loadCustomBackends()];
}

export function backendById(id: string | undefined, isWindows: boolean): AgentBackend {
	if (!id || id === COMMAND_CODE.id) return COMMAND_CODE;
	return loadCustomBackends().find((b) => b.id === id) ?? (id === "codex-acp" ? codexPreset(isWindows) : COMMAND_CODE);
}

/** "prog --flag 'a b'" → spec; returns null on an empty/unparseable line. */
export function parseCommandLine(line: string, isWindows: boolean): AgentSpec | null {
	const words = line.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
	if (!words.length) return null;
	return isWindows ? { program: "cmd.exe", args: ["/c", ...words] } : { program: words[0], args: words.slice(1) };
}
