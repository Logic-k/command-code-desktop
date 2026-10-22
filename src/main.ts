// App shell: sidebar (projects and their sessions), tabs (chat or terminal),
// settings, shortcuts, and system notifications.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from "@tauri-apps/plugin-notification";
import { openPath } from "@tauri-apps/plugin-opener";
import * as pool from "./acp/pool";
import type { Launch, SessionInfo } from "./acp/types";
import {
	forgetProject,
	loadProjects,
	loadSettings,
	type Project,
	samePath,
	type Settings,
	saveSettings,
	touchProject,
} from "./store";
import { basename, byId, h, relativeTime, svg } from "./ui/dom";
import { icons } from "./ui/icons";
import { ChatView, describeError } from "./views/chat";
import { TerminalView } from "./views/terminal";
import "./styles.css";

type View = ChatView | TerminalView;

interface Tab {
	id: string;
	kind: "chat" | "terminal";
	view: View;
	title: string;
	busy: boolean;
	attention: boolean;
	button: HTMLElement;
	/** Runs when the tab is closed (an add-account login cleans up here). */
	onClose?: () => void;
}

/** Mirrors `accounts::Account` in src-tauri/src/accounts.rs. */
interface Account {
	id: string;
	userName: string;
	addedAt: number;
}

// ---------------------------------------------------------------- state

let settings: Settings = loadSettings();
let projects: Project[] = [];
let activeProject: string | null = null;
const expanded = new Set<string>();
const sessionCache = new Map<string, { at: number; sessions: SessionInfo[] | Error }>();
const tabs: Tab[] = [];
let activeTab: Tab | null = null;
let tabSeq = 0;
let cliUser: string | null = null;
let accounts: Account[] = [];

const appEl = byId<HTMLDivElement>("app");
const projectsEl = byId<HTMLElement>("projects");
const tabsEl = byId<HTMLDivElement>("tabs");
const viewsEl = byId<HTMLDivElement>("views");
const homeEl = byId<HTMLDivElement>("home");
const settingsEl = byId<HTMLDialogElement>("settings");
const appWindow = getCurrentWindow();

// --------------------------------------------------------------- chrome

function iconButton(id: string, icon: keyof typeof icons, label?: string): void {
	const button = byId<HTMLButtonElement>(id);
	button.replaceChildren(svg(icons[icon]), ...(label ? [h("span", null, label)] : []));
}

iconButton("collapse", "sidebar");
iconButton("expand", "sidebar");
iconButton("new-chat", "plus", "새 채팅");
iconButton("open-folder", "folderOpen", "폴더 열기…");
iconButton("open-settings", "settings", "설정");
iconButton("new-tab", "plus");
iconButton("new-term", "terminal");

function setSidebar(collapsed: boolean): void {
	appEl.classList.toggle("side-collapsed", collapsed);
	byId("expand").classList.toggle("hidden", !collapsed);
	try {
		localStorage.setItem("cmdc-desktop:sidebar", collapsed ? "0" : "1");
	} catch {
		// Not persisted; harmless.
	}
}

function applyTheme(): void {
	const theme =
		settings.theme === "system"
			? window.matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark"
			: settings.theme;
	document.documentElement.dataset.theme = theme;
}
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);

// ------------------------------------------------------------- projects

function renderProjects(): void {
	if (!projects.length) {
		projectsEl.replaceChildren(h("div", { class: "side-empty" }, "아직 연 폴더가 없습니다."));
		return;
	}
	projectsEl.replaceChildren(...projects.map(renderProject));
}

function renderProject(project: Project): HTMLElement {
	const isOpen = expanded.has(project.path.toLowerCase());
	const isActive = activeProject !== null && samePath(activeProject, project.path);
	const row = h(
		"div",
		{ class: `proj-row${isActive ? " active" : ""}`, title: project.path },
		h(
			"button",
			{ class: "proj-main", onclick: () => toggleProject(project.path) },
			h("span", { class: `proj-chevron${isOpen ? " open" : ""}` }, svg(icons.chevron)),
			svg(isOpen ? icons.folderOpen : icons.folder),
			h("span", { class: "proj-name" }, basename(project.path)),
		),
		h(
			"span",
			{ class: "proj-tools" },
			h("button", { class: "icon-btn", title: "이 폴더에서 새 채팅", onclick: () => void openChat(project.path) }, svg(icons.plus)),
			h("button", { class: "icon-btn", title: "이 폴더에서 터미널", onclick: () => void openTerminal(project.path, []) }, svg(icons.terminal)),
			h(
				"button",
				{
					class: "icon-btn",
					title: "목록에서 빼기 (폴더는 그대로)",
					onclick: () => {
						projects = forgetProject(project.path);
						renderProjects();
						renderHome();
					},
				},
				svg(icons.close),
			),
		),
	);
	const wrap = h("div", { class: "proj" }, row);
	if (isOpen) wrap.appendChild(renderSessions(project.path));
	return wrap;
}

function renderSessions(cwd: string): HTMLElement {
	const box = h("div", { class: "sessions" });
	const cached = sessionCache.get(cwd.toLowerCase());
	if (!cached) {
		box.appendChild(h("div", { class: "side-empty" }, h("span", { class: "spinner" }), " 대화 불러오는 중…"));
		void loadSessions(cwd);
		return box;
	}
	if (cached.sessions instanceof Error) {
		box.appendChild(
			h(
				"div",
				{ class: "side-empty error" },
				describeError(cached.sessions),
				h("button", { class: "link", onclick: () => void loadSessions(cwd, true) }, " 다시 시도"),
			),
		);
		return box;
	}
	if (!cached.sessions.length) {
		box.appendChild(h("div", { class: "side-empty" }, "지난 대화 없음"));
	}
	for (const session of cached.sessions.slice(0, 40)) {
		const open = tabs.find((t) => t.view instanceof ChatView && t.view.sessionId === session.sessionId);
		box.appendChild(
			h(
				"button",
				{
					class: `session${open ? " is-open" : ""}${open && open === activeTab ? " active" : ""}`,
					title: `${session.title ?? "제목 없음"}\n${session.sessionId}`,
					onclick: () => void openChat(cwd, session),
				},
				h("span", { class: "session-title" }, session.title || "제목 없는 대화"),
				h("span", { class: "session-time" }, relativeTime(session.updatedAt)),
			),
		);
	}
	box.appendChild(
		h(
			"button",
			{ class: "session session-refresh", onclick: () => void loadSessions(cwd, true) },
			svg(icons.refresh),
			h("span", null, "새로고침"),
		),
	);
	return box;
}

async function loadSessions(cwd: string, force = false): Promise<void> {
	const key = cwd.toLowerCase();
	if (force) {
		sessionCache.delete(key);
		renderProjects();
	}
	try {
		const sessions = await pool.withConnection(cwd, activeAccountId(), (c) => c.listSessions());
		sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
		sessionCache.set(key, { at: Date.now(), sessions });
	} catch (error) {
		sessionCache.set(key, { at: Date.now(), sessions: error instanceof Error ? error : new Error(String(error)) });
	}
	renderProjects();
}

function toggleProject(path: string): void {
	const key = path.toLowerCase();
	if (expanded.has(key)) expanded.delete(key);
	else expanded.add(key);
	activeProject = path;
	renderProjects();
}

function rememberProject(path: string): void {
	projects = touchProject(path);
	activeProject = path;
	expanded.add(path.toLowerCase());
	renderProjects();
}

async function pickFolder(): Promise<string | null> {
	const picked = await open({ directory: true, multiple: false, title: "프로젝트 폴더 선택" });
	return typeof picked === "string" ? picked : null;
}

// ----------------------------------------------------------------- tabs

function makeTab(kind: Tab["kind"], title: string, view: View): Tab {
	const tab: Tab = {
		id: `tab-${(tabSeq += 1)}`,
		kind,
		view,
		title,
		busy: false,
		attention: false,
		button: h("div", { class: "tab", role: "tab" }),
	};
	tab.button.addEventListener("click", () => activate(tab));
	tab.button.addEventListener("auxclick", (event) => {
		if (event.button === 1) void closeTab(tab);
	});
	tabs.push(tab);
	tabsEl.appendChild(tab.button);
	viewsEl.appendChild(view.root);
	renderTab(tab);
	return tab;
}

function renderTab(tab: Tab): void {
	tab.button.className = `tab${tab === activeTab ? " active" : ""}${tab.attention ? " attention" : ""}`;
	tab.button.title = `${tab.title}\n${tab.view.cwd}`;
	tab.button.replaceChildren(
		tab.busy ? h("span", { class: "spinner" }) : svg(tab.kind === "chat" ? icons.chat : icons.terminal),
		h("span", { class: "tab-title" }, tab.title),
		h(
			"button",
			{
				class: "tab-close",
				title: "닫기 (Ctrl+W)",
				onclick: (event: Event) => {
					event.stopPropagation();
					void closeTab(tab);
				},
			},
			svg(icons.close),
		),
	);
}

function activate(tab: Tab | null): void {
	activeTab = tab;
	for (const t of tabs) {
		t.view.root.classList.toggle("hidden", t !== tab);
		if (t === tab) t.attention = false;
		renderTab(t);
	}
	homeEl.classList.toggle("hidden", tab !== null);
	if (tab) {
		activeProject = tab.view.cwd;
		tab.button.scrollIntoView({ block: "nearest", inline: "nearest" });
		requestAnimationFrame(() => tab.view.focus());
		void appWindow.setTitle(`${tab.title} — ${basename(tab.view.cwd)} · Command Code`);
	} else {
		void appWindow.setTitle("Command Code Desktop");
		renderHome();
	}
	renderProjects();
}

async function closeTab(tab: Tab): Promise<void> {
	if (tab.busy) {
		const ok = await ask("작업이 진행 중입니다. 중지하고 탭을 닫을까요?", {
			title: "탭 닫기",
			kind: "warning",
			okLabel: "닫기",
			cancelLabel: "취소",
		});
		if (!ok) return;
	}
	const index = tabs.indexOf(tab);
	if (index < 0) return;
	tabs.splice(index, 1);
	// A view that fails to tear down must not leave a ghost tab behind.
	try {
		tab.onClose?.();
		tab.view.dispose();
	} catch (error) {
		console.warn("closing tab failed", error);
	} finally {
		tab.view.root.remove();
		tab.button.remove();
	}
	if (activeTab === tab) activate(tabs[Math.min(index, tabs.length - 1)] ?? null);
	else renderProjects();
	// The closed chat may have created or renamed a session.
	if (tab.kind === "chat") void refreshSessionsSoon(tab.view.cwd);
}

let refreshTimer: number | null = null;
function refreshSessionsSoon(cwd: string): void {
	if (refreshTimer !== null) clearTimeout(refreshTimer);
	refreshTimer = window.setTimeout(() => {
		if (expanded.has(cwd.toLowerCase())) void loadSessions(cwd, false);
	}, 800);
}

/** False (and the stale entry forgotten) when the folder is gone. */
async function ensureFolder(cwd: string): Promise<boolean> {
	if (await invoke<boolean>("dir_exists", { path: cwd }).catch(() => false)) return true;
	projects = forgetProject(cwd);
	renderProjects();
	renderHome();
	await ask(`폴더를 찾을 수 없습니다:
${cwd}`, { title: "폴더 없음", kind: "error", okLabel: "확인", cancelLabel: "닫기" });
	return false;
}

async function openChat(cwd: string, session?: SessionInfo, initialPrompt?: string): Promise<void> {
	if (!(await ensureFolder(cwd))) return;
	rememberProject(cwd);
	if (session) {
		const existing = tabs.find((t) => t.view instanceof ChatView && t.view.sessionId === session.sessionId);
		if (existing) {
			activate(existing);
			return;
		}
	}
	let tab: Tab | null = null;
	const view = new ChatView(
		{
			settings: () => settings,
			setTitle: (title) => {
				if (!tab) return;
				tab.title = title;
				renderTab(tab);
				if (tab === activeTab) void appWindow.setTitle(`${title} — ${basename(cwd)} · Command Code`);
				refreshSessionsSoon(cwd);
			},
			setBusy: (busy) => {
				if (!tab) return;
				tab.busy = busy;
				renderTab(tab);
				if (!busy) refreshSessionsSoon(cwd);
			},
			attention: (kind, body) => {
				if (!tab) return;
				void notify(tab, kind, body);
			},
			openTerminal: (dir, args) => void openTerminal(dir, args),
			login: (accountId) => void (accountId ? addAccount() : openTerminal(cwd, ["login"], { account: null })),
		},
		{
			cwd,
			sessionId: session?.sessionId,
			title: session?.title ?? undefined,
			initialPrompt,
			accountId: activeAccountId(),
			accountName: accountName(activeAccountId()),
		},
	);
	tab = makeTab("chat", session?.title || "새 대화", view);
	activate(tab);
}

interface TerminalOptions {
	/** Account to run as; defaults to the active one. null = the CLI's own login. */
	account?: string | null;
	/** A separate home for the CLI (the add-account login). */
	profileDir?: string;
	title?: string;
	/** Not a project: don't add the folder to the sidebar. */
	transient?: boolean;
	onExit?: (tab: Tab) => void;
	onClose?: () => void;
}

async function openTerminal(cwd: string, args: string[], options: TerminalOptions = {}): Promise<Tab | null> {
	if (!(await ensureFolder(cwd))) return null;
	if (!options.transient) rememberProject(cwd);
	let tab: Tab | null = null;
	const view = new TerminalView(
		{
			setBusy: () => undefined,
			exited: () => {
				if (!tab) return;
				tab.title = `${tab.title} (종료)`;
				renderTab(tab);
				options.onExit?.(tab);
			},
		},
		cwd,
		args,
		settings.terminalFontSize,
		{
			profileDir: options.profileDir ?? null,
			accountId: options.account === undefined ? activeAccountId() : options.account,
		},
	);
	const title = options.title ?? (args[0] === "login" ? "로그인" : `터미널 · ${basename(cwd)}`);
	tab = makeTab("terminal", title, view);
	tab.onClose = options.onClose;
	activate(tab);
	await view.start();
	return tab;
}

async function newChat(): Promise<void> {
	const cwd = activeTab?.view.cwd ?? activeProject ?? (await pickFolder());
	if (cwd) await openChat(cwd);
}

async function openFolder(): Promise<void> {
	const cwd = await pickFolder();
	if (cwd) await openChat(cwd);
}

function cycleTab(step: number): void {
	if (!tabs.length) return;
	const index = activeTab ? tabs.indexOf(activeTab) : -1;
	activate(tabs[(index + step + tabs.length) % tabs.length]);
}

// -------------------------------------------------------- notifications

let notifyAllowed: boolean | null = null;

async function notify(tab: Tab, kind: "permission" | "done" | "error", body: string): Promise<void> {
	const visible = document.hasFocus() && tab === activeTab;
	if (!visible) {
		tab.attention = true;
		renderTab(tab);
	}
	if (visible || !settings.notify) return;
	if (notifyAllowed === null) {
		notifyAllowed = await isPermissionGranted().catch(() => false);
		if (!notifyAllowed) notifyAllowed = (await requestPermission().catch(() => "denied")) === "granted";
	}
	if (!notifyAllowed) return;
	const title =
		kind === "permission" ? `권한 요청 · ${tab.title}` : kind === "error" ? `오류 · ${tab.title}` : `완료 · ${tab.title}`;
	sendNotification({ title, body: body.slice(0, 180) });
}

// ----------------------------------------------------------------- home

function renderHome(): void {
	const recent = projects.slice(0, 8);
	homeEl.replaceChildren(
		h(
			"div",
			{ class: "home-inner" },
			h("div", { class: "home-mark" }, "⌘"),
			h("h1", null, "Command Code Desktop"),
			h("p", { class: "muted" }, "폴더를 고르면 바로 대화가 시작됩니다. 터미널도, cd도 필요 없습니다."),
			h(
				"div",
				{ class: "home-actions" },
				h("button", { class: "btn primary big", onclick: () => void openFolder() }, svg(icons.folderOpen), "폴더 열기"),
			),
			recent.length
				? h(
						"div",
						{ class: "home-recent" },
						h("div", { class: "side-label" }, "최근 프로젝트"),
						recent.map((project) =>
							h(
								"button",
								{ class: "recent", title: project.path, onclick: () => void openChat(project.path) },
								svg(icons.folder),
								h("span", { class: "recent-name" }, basename(project.path)),
								h("span", { class: "recent-path" }, project.path),
							),
						),
					)
				: null,
			h(
				"div",
				{ class: "home-keys muted small" },
				"Ctrl+N 새 채팅 · Ctrl+O 폴더 열기 · Ctrl+T 터미널 · Ctrl+W 탭 닫기 · Ctrl+Tab 탭 전환 · Ctrl+B 사이드바",
			),
		),
	);
}

// ------------------------------------------------------------- accounts
//
// "CLI 로그인" is whatever `cmd login` signed in as (~/.commandcode/auth.json).
// Saved accounts are extra keys kept in Windows Credential Manager by Rust
// (src-tauri/src/accounts.rs); picking one starts new chats and terminals
// with that key. Sessions and settings stay shared across accounts.

const accountEl = byId<HTMLDivElement>("account-switch");
const accountMenu = h("div", { class: "account-menu hidden", role: "menu" });
document.body.appendChild(accountMenu);

/** The saved account new chats use, or null for the CLI's own login. */
function activeAccountId(): string | null {
	return accounts.some((a) => a.id === settings.accountId) ? settings.accountId : null;
}

function accountName(id: string | null): string {
	if (id) return accounts.find((a) => a.id === id)?.userName ?? "알 수 없는 계정";
	return cliUser ?? "로그인 안 됨";
}

async function refreshAccounts(): Promise<void> {
	try {
		const view = await invoke<{ cliUser: string | null; accounts: Account[] }>("account_list");
		cliUser = view.cliUser;
		accounts = view.accounts;
	} catch (error) {
		console.warn("account_list failed", error);
	}
	renderAccountSwitch();
}

function initial(name: string): string {
	return (name.trim()[0] ?? "?").toUpperCase();
}

function renderAccountSwitch(): void {
	const id = activeAccountId();
	const name = accountName(id);
	accountEl.replaceChildren(
		h(
			"button",
			{
				class: "account-btn",
				title: "Command Code 계정 전환",
				onclick: (event: Event) => {
					event.stopPropagation();
					toggleAccountMenu();
				},
			},
			h("span", { class: `avatar${id || cliUser ? "" : " empty"}` }, initial(name)),
			h(
				"span",
				{ class: "account-text" },
				h("span", { class: "account-name" }, name),
				h("span", { class: "account-sub" }, id ? "저장된 계정" : "CLI 로그인"),
			),
			svg(icons.chevron, "icon account-chevron"),
		),
	);
}

function toggleAccountMenu(force?: boolean): void {
	const open = force ?? accountMenu.classList.contains("hidden");
	if (!open) {
		accountMenu.classList.add("hidden");
		return;
	}
	const active = activeAccountId();
	const item = (id: string | null, name: string, sub: string, removable: boolean) =>
		h(
			"div",
			{ class: `account-item${id === active ? " active" : ""}`, role: "menuitemradio" },
			h(
				"button",
				{ class: "account-pick", onclick: () => void switchAccount(id) },
				h("span", { class: "avatar" }, initial(name)),
				h("span", { class: "account-text" }, h("span", { class: "account-name" }, name), h("span", { class: "account-sub" }, sub)),
				id === active ? svg(icons.check, "icon account-check") : null,
			),
			removable
				? h("button", { class: "icon-btn", title: "이 계정 지우기", onclick: () => void removeAccount(id as string) }, svg(icons.close))
				: null,
		);

	const openChats = tabs.filter((t) => t.kind === "chat").length;
	accountMenu.replaceChildren(
		h("div", { class: "account-menu-label" }, "새 대화를 시작할 계정"),
		item(null, cliUser ?? "로그인 안 됨", "CLI 로그인 (cmd login)", false),
		...accounts.map((a) => item(a.id, a.userName, "저장된 계정", true)),
		h("div", { class: "account-sep" }),
		h("button", { class: "account-action", onclick: () => void addAccount() }, svg(icons.plus), "계정 추가…"),
		h(
			"button",
			{ class: "account-action", onclick: () => void reloginCli() },
			svg(icons.refresh),
			cliUser ? "CLI 로그인 계정 바꾸기…" : "CLI에 로그인…",
		),
		...(openChats ? [h("div", { class: "account-note" }, `열려 있는 대화 ${openChats}개는 원래 계정으로 계속됩니다.`)] : []),
	);
	const rect = accountEl.getBoundingClientRect();
	accountMenu.style.left = `${rect.left}px`;
	accountMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
	accountMenu.style.width = `${Math.max(rect.width, 240)}px`;
	accountMenu.classList.remove("hidden");
}

document.addEventListener("click", (event) => {
	if (!accountMenu.contains(event.target as Node)) toggleAccountMenu(false);
});
window.addEventListener("keydown", (event) => {
	if (event.key === "Escape") toggleAccountMenu(false);
});

async function switchAccount(id: string | null): Promise<void> {
	toggleAccountMenu(false);
	settings = { ...settings, accountId: id ?? "" };
	saveSettings(settings);
	renderAccountSwitch();
	// Session lists are shared, but re-list so a revoked key shows up now.
	sessionCache.clear();
	renderProjects();
}

/** `cmd login` in a throwaway home; when it exits, Rust moves the new key
 * into Credential Manager and deletes that home. */
async function addAccount(): Promise<void> {
	toggleAccountMenu(false);
	let dir: string;
	try {
		dir = await invoke<string>("account_login_begin");
	} catch (error) {
		await ask(`계정 추가를 시작하지 못했습니다: ${String(error)}`, { title: "계정 추가", kind: "error", okLabel: "확인", cancelLabel: "닫기" });
		return;
	}
	let settled = false;
	const finish = async (tab: Tab | null) => {
		if (settled) return;
		settled = true;
		try {
			const account = await invoke<Account>("account_login_finish", { dir });
			pool.forgetAccount(account.id);
			await refreshAccounts();
			await switchAccount(account.id);
			if (tab) {
				tab.title = `로그인 완료 · ${account.userName}`;
				renderTab(tab);
			}
			await ask(`${account.userName} 계정을 추가했고, 새 대화부터 이 계정을 씁니다.`, {
				title: "계정 추가 완료",
				kind: "info",
				okLabel: "확인",
				cancelLabel: "닫기",
			});
			if (tab) void closeTab(tab);
		} catch (error) {
			await ask(String(error), { title: "계정 추가", kind: "warning", okLabel: "확인", cancelLabel: "닫기" });
		}
	};
	await openTerminal(dir, ["login"], {
		account: null,
		profileDir: dir,
		title: "계정 추가 · 로그인",
		transient: true,
		onExit: (tab) => void finish(tab),
		onClose: () => {
			if (!settled) {
				settled = true;
				void invoke("account_login_cancel", { dir });
			}
		},
	});
}

/** Re-run `cmd login` for the CLI's own account (the default one). */
async function reloginCli(): Promise<void> {
	toggleAccountMenu(false);
	const cwd = activeTab?.view.cwd ?? activeProject;
	if (!cwd) {
		await ask("먼저 폴더를 하나 열어 주세요.", { title: "CLI 로그인", kind: "info", okLabel: "확인", cancelLabel: "닫기" });
		return;
	}
	const note = cliUser
		? `CLI에 로그인된 ${cliUser} 계정을 바꾸려면, 열리는 터미널에서 /logout 후 /login 하세요.`
		: "열리는 터미널에서 로그인을 마치세요.";
	await ask(note, { title: "CLI 로그인", kind: "info", okLabel: "터미널 열기", cancelLabel: "취소" }).then(async (ok) => {
		if (!ok) return;
		await openTerminal(cwd, cliUser ? [] : ["login"], {
			account: null,
			onExit: () => {
				pool.forgetAccount(null);
				void refreshAccounts();
			},
			onClose: () => {
				pool.forgetAccount(null);
				void refreshAccounts();
			},
		});
	});
}

async function removeAccount(id: string): Promise<void> {
	const account = accounts.find((a) => a.id === id);
	toggleAccountMenu(false);
	const ok = await ask(`${account?.userName ?? id} 계정을 이 앱에서 지울까요?\nCommand Code 계정 자체는 그대로이고, 다시 추가할 수 있습니다.`, {
		title: "계정 지우기",
		kind: "warning",
		okLabel: "지우기",
		cancelLabel: "취소",
	});
	if (!ok) return;
	try {
		await invoke("account_remove", { id });
	} catch (error) {
		await ask(String(error), { title: "계정 지우기", kind: "error", okLabel: "확인", cancelLabel: "닫기" });
	}
	pool.forgetAccount(id);
	if (settings.accountId === id) await switchAccount(null);
	await refreshAccounts();
}

// ------------------------------------------------------------- settings

function openSettings(): void {
	const field = (label: string, control: HTMLElement, help?: string) =>
		h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, help ? h("span", { class: "field-help" }, help) : null);
	const select = (value: string, options: [string, string][]) => {
		const el = h("select", { class: "select" }, options.map(([v, label]) => h("option", { value: v }, label)));
		el.value = value;
		return el;
	};

	const mode = select(settings.defaultMode, [
		["default", "표준 — 바꾸기 전에 매번 확인"],
		["auto-accept", "편집 자동 허용 — 위험한 명령만 확인"],
		["plan", "계획만 — 읽기 전용"],
		["dont-ask", "묻지 않기 — 안전장치는 유지"],
	]);
	const sendKey = select(settings.sendKey, [
		["enter", "Enter로 보내기 (Shift+Enter 줄바꿈)"],
		["ctrl-enter", "Ctrl+Enter로 보내기"],
	]);
	const theme = select(settings.theme, [
		["system", "시스템 설정 따르기"],
		["dark", "어둡게"],
		["light", "밝게"],
	]);
	const notifyBox = h("input", { type: "checkbox" });
	notifyBox.checked = settings.notify;
	const thoughtsBox = h("input", { type: "checkbox" });
	thoughtsBox.checked = settings.expandThoughts;
	const fontSize = h("input", { class: "text narrow", type: "number", min: 10, max: 22, value: settings.terminalFontSize });

	const save = () => {
		settings = {
			...settings,
			defaultMode: mode.value as Settings["defaultMode"],
			sendKey: sendKey.value as Settings["sendKey"],
			theme: theme.value as Settings["theme"],
			notify: notifyBox.checked,
			expandThoughts: thoughtsBox.checked,
			terminalFontSize: Math.min(22, Math.max(10, Number(fontSize.value) || 13)),
		};
		saveSettings(settings);
		applyTheme();
		settingsEl.close();
	};

	settingsEl.replaceChildren(
		h(
			"form",
			{ class: "settings", method: "dialog" },
			h("h2", null, "설정"),
			field("새 채팅의 권한 모드", mode, "'권한 무시'는 기본값으로 둘 수 없습니다. 채팅 상단에서 대화마다 켜세요."),
			field("보내기 키", sendKey),
			field("테마", theme),
			h("label", { class: "check" }, notifyBox, "창이 뒤에 있을 때 완료·권한 요청을 알림으로 받기"),
			h("label", { class: "check" }, thoughtsBox, "에이전트의 생각 과정을 펼쳐서 보기"),
			field("터미널 글자 크기", fontSize),
			h(
				"div",
				{ class: "settings-actions" },
				h("button", { class: "btn", type: "button", onclick: () => settingsEl.close() }, "취소"),
				h("button", { class: "btn primary", type: "button", onclick: save }, "저장"),
			),
		),
	);
	settingsEl.showModal();
}

// ------------------------------------------------------------ shortcuts

window.addEventListener("keydown", (event) => {
	const ctrl = event.ctrlKey || event.metaKey;
	if (!ctrl || event.altKey) return;
	const key = event.key.toLowerCase();
	const handled = (() => {
		if (key === "n" && !event.shiftKey) return void newChat(), true;
		if (key === "o") return void openFolder(), true;
		if (key === "t") {
			const cwd = activeTab?.view.cwd ?? activeProject;
			if (cwd) void openTerminal(cwd, []);
			return true;
		}
		if (key === "w") return activeTab && void closeTab(activeTab), true;
		if (key === "tab") return cycleTab(event.shiftKey ? -1 : 1), true;
		if (key === "b") return setSidebar(!appEl.classList.contains("side-collapsed")), true;
		if (key === ",") return openSettings(), true;
		if (/^[1-9]$/.test(key)) {
			const target = key === "9" ? tabs[tabs.length - 1] : tabs[Number(key) - 1];
			if (target) activate(target);
			return true;
		}
		return false;
	})();
	if (handled) event.preventDefault();
});

// ---------------------------------------------------------------- wiring

byId("collapse").addEventListener("click", () => setSidebar(true));
byId("expand").addEventListener("click", () => setSidebar(false));
byId("new-chat").addEventListener("click", () => void newChat());
byId("open-folder").addEventListener("click", () => void openFolder());
byId("open-settings").addEventListener("click", openSettings);
byId("new-tab").addEventListener("click", () => void newChat());
byId("new-term").addEventListener("click", async () => {
	const cwd = activeTab?.view.cwd ?? activeProject ?? (await pickFolder());
	if (cwd) void openTerminal(cwd, []);
});
tabsEl.addEventListener("wheel", (event) => {
	if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) tabsEl.scrollLeft += event.deltaY;
});
window.addEventListener("focus", () => {
	if (activeTab?.attention) {
		activeTab.attention = false;
		renderTab(activeTab);
	}
});
window.addEventListener("beforeunload", () => pool.stopAll());

// Files dropped on the window: folders open as projects, images attach to
// the active chat. Tauri handles native drops itself, so HTML5 drop events
// never see these files.
const dropHint = h("div", { id: "drop-hint", class: "hidden" }, h("div", null, "폴더를 놓으면 프로젝트로 열고, 이미지를 놓으면 현재 대화에 첨부합니다"));
document.body.appendChild(dropHint);
void appWindow.onDragDropEvent(async (event) => {
	const payload = event.payload;
	if (payload.type === "enter" || payload.type === "over") {
		dropHint.classList.remove("hidden");
		return;
	}
	dropHint.classList.add("hidden");
	if (payload.type !== "drop") return;
	for (const path of payload.paths) {
		if (await invoke<boolean>("dir_exists", { path }).catch(() => false)) {
			await openChat(path);
			continue;
		}
		const view = activeTab?.view;
		if (!(view instanceof ChatView)) continue;
		try {
			const image = await invoke<{ mimeType: string; data: string }>("read_image", { path });
			view.attachImage(image.mimeType, image.data);
		} catch (error) {
			await ask(`첨부할 수 없습니다: ${String(error)}`, { title: "첨부", kind: "warning", okLabel: "확인", cancelLabel: "닫기" });
		}
	}
});

// Dev builds expose the shell for driving the UI over the WebView2 debug port.
if (import.meta.env.DEV) {
	Object.assign(window, {
		__cmdc: { tabs: () => tabs, active: () => activeTab, openChat, openTerminal, closeTab, refreshAccounts, switchAccount, addAccount },
	});
}

// ---------------------------------------------------------------- startup

void (async () => {
	applyTheme();
	await refreshAccounts();
	try {
		setSidebar(localStorage.getItem("cmdc-desktop:sidebar") === "0");
	} catch {
		setSidebar(false);
	}

	projects = loadProjects();
	const exists = await Promise.all(projects.map((p) => invoke<boolean>("dir_exists", { path: p.path }).catch(() => true)));
	projects = projects.filter((_, i) => exists[i]);
	renderProjects();
	activate(null);

	invoke<Launch>("cmdc_launch")
		.then((launch) => {
			const label = byId("cli-version");
			label.textContent =
				launch.via === "node" ? `command-code ${launch.version ?? ""}` : "command-code: npm 심으로 실행 (node 경로 못 찾음)";
			label.title = launch.entry ?? launch.program;
			label.addEventListener("click", () => launch.entry && void openPath(launch.entry.replace(/[\\/]dist[\\/]index\.mjs$/, "")));
		})
		.catch(() => undefined);

	// A folder from the command line (or CMDC_GUI_START_DIR) opens straight
	// into a chat, which makes the app scriptable from a shortcut.
	const startDir = await invoke<string | null>("start_dir").catch(() => null);
	if (startDir) await openChat(startDir);

	// A second launch with a folder (single-instance) lands here.
	void listen<string>("app://open-folder", (event) => void openChat(event.payload));
})();
