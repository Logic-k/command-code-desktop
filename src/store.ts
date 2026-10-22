// Per-machine preferences. localStorage is enough: nothing here is shared or
// secret, and the CLI keeps the real state (sessions, auth) in ~/.commandcode.

export interface Project {
	path: string;
	lastOpened: number;
}

export interface Settings {
	/** ACP mode a new chat starts in. `bypass` is never a default. */
	defaultMode: "default" | "auto-accept" | "plan" | "dont-ask";
	/** Enter sends (Shift+Enter is a newline), or Ctrl+Enter sends. */
	sendKey: "enter" | "ctrl-enter";
	/** System notification when a turn ends or needs permission while the window is unfocused. */
	notify: boolean;
	/** Show the agent's reasoning expanded instead of collapsed. */
	expandThoughts: boolean;
	theme: "system" | "dark" | "light";
	/** Saved account new chats run as; "" = the CLI's own `cmd login`. */
	accountId: string;
	terminalFontSize: number;
}

const PROJECTS_KEY = "cmdc-desktop:projects";
const SETTINGS_KEY = "cmdc-desktop:settings";
const LEGACY_LAST_DIR_KEY = "cmdc-gui:lastDir";
const MAX_PROJECTS = 30;

export const defaultSettings: Settings = {
	defaultMode: "default",
	sendKey: "enter",
	notify: true,
	expandThoughts: false,
	theme: "system",
	accountId: "",
	terminalFontSize: 13,
};

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage full or blocked; preferences just won't persist.
	}
}

export function loadSettings(): Settings {
	return { ...defaultSettings, ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(settings: Settings): void {
	write(SETTINGS_KEY, settings);
}

export function loadProjects(): Project[] {
	const projects = read<Project[]>(PROJECTS_KEY, []);
	// Carry over the one folder the v0.1 prototype remembered.
	const legacy = localStorage.getItem(LEGACY_LAST_DIR_KEY);
	if (legacy && !projects.some((p) => samePath(p.path, legacy))) {
		projects.push({ path: legacy, lastOpened: 0 });
		write(PROJECTS_KEY, projects);
	}
	return projects.sort((a, b) => b.lastOpened - a.lastOpened);
}

export function touchProject(path: string): Project[] {
	const projects = loadProjects().filter((p) => !samePath(p.path, path));
	projects.unshift({ path, lastOpened: Date.now() });
	const trimmed = projects.slice(0, MAX_PROJECTS);
	write(PROJECTS_KEY, trimmed);
	return trimmed;
}

export function forgetProject(path: string): Project[] {
	const projects = loadProjects().filter((p) => !samePath(p.path, path));
	write(PROJECTS_KEY, projects);
	return projects;
}

export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
	return norm(a) === norm(b);
}
