// App shell: sidebar (projects and their sessions), tabs (chat or terminal),
// settings, shortcuts, and system notifications.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as pool from "./acp/pool";
import {
	accountBlocker,
	type Billing,
	billingSummary,
	type Catalog,
	modelAccess,
	planName,
	money,
	balance,
	usageOf,
} from "./billing";
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
import { Channel } from "@tauri-apps/api/core";
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

/** The throwaway homes add-account logins run in; never a project. */
function isLoginHome(path: string): boolean {
	return /[\\/]ai\.commandcode\.cmdcgui[\\/]login([\\/]|$)/i.test(path);
}

function rememberProject(path: string): void {
	if (isLoginHome(path)) return;
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
				if (!busy) {
					refreshSessionsSoon(cwd);
					// A finished turn spent credits.
					if (tab.view instanceof ChatView) void loadBilling(tab.view.accountId, { maxAgeMs: 20_000 });
				}
			},
			attention: (kind, body) => {
				if (!tab) return;
				void notify(tab, kind, body);
			},
			openTerminal: (dir, args) => void openTerminal(dir, args),
			login: (accountId) => void (accountId ? addAccount() : cliLogin()),
			access: (accountId) => accessFor(accountId),
			reportLimit: (accountId, window, resetAt) => reportLimit(accountId, window, resetAt),
			openAccounts: () => setTimeout(() => toggleAccountMenu(true), 0),
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
	const tabCwd = activeTab && !(activeTab.view instanceof TerminalView && activeTab.view.isLogin) ? activeTab.view.cwd : null;
	const cwd = tabCwd ?? (activeProject && !isLoginHome(activeProject) ? activeProject : null) ?? (await pickFolder());
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
// Saved accounts are extra keys Rust keeps in Windows Credential Manager
// (src-tauri/src/accounts.rs). Everything is live:
//
// * switching applies to every open tab at once: chats reconnect their
//   session as the new account (history stays), terminals restart;
// * Rust watches the CLI's auth.json, so a login or logout done anywhere
//   (a terminal tab, the user's own shell) re-labels the sidebar and
//   reconnects whatever ran as the CLI login;
// * an add-account login completes the moment `cmd login` writes its key,
//   and its tab closes by itself.

const accountEl = byId<HTMLDivElement>("account-switch");
const accountMenu = h("div", { class: "account-menu hidden", role: "menu" });
document.body.appendChild(accountMenu);
const toastBox = h("div", { id: "toasts" });
document.body.appendChild(toastBox);

/** Add-account login tabs by their throwaway home. */
const loginTabs = new Map<string, Tab>();
/** The tab running `cmd login` for the CLI's own login, if any. */
let cliLoginTab: Tab | null = null;

function toast(
	text: string,
	tone: "info" | "ok" | "error" = "info",
	ms = 4500,
	action?: { label: string; run: () => void },
): void {
	const el = h("div", { class: `toast toast-${tone}${action ? " has-action" : ""}` }, h("span", null, text));
	const dismiss = () => {
		el.classList.add("leaving");
		setTimeout(() => el.remove(), 300);
	};
	if (action) {
		el.appendChild(
			h(
				"button",
				{
					class: "btn toast-action",
					onclick: () => {
						dismiss();
						action.run();
					},
				},
				action.label,
			),
		);
	}
	toastBox.appendChild(el);
	setTimeout(dismiss, ms);
}

/** The saved account new chats use, or null for the CLI's own login. */
function activeAccountId(): string | null {
	return accounts.some((a) => a.id === settings.accountId) ? settings.accountId : null;
}

function accountName(id: string | null): string {
	if (id) return accounts.find((a) => a.id === id)?.userName ?? "알 수 없는 계정";
	return cliUser ?? "로그인 안 됨";
}

// Plan and credits per account ("" = CLI login), and the CLI's model catalog.
const billingCache = new Map<string, { at: number; billing: Billing | null; error: string | null }>();
let catalog: Catalog | null = null;
let catalogAt = 0;

function accessFor(accountId: string | null): { billing: Billing | null; catalog: Catalog | null } {
	return { billing: billingCache.get(accountId ?? "")?.billing ?? null, catalog };
}

async function loadCatalog(): Promise<void> {
	if (catalog && Date.now() - catalogAt < 10 * 60_000) return;
	try {
		catalog = await invoke<Catalog>("model_catalog");
		catalogAt = Date.now();
	} catch (error) {
		console.warn("model_catalog", error);
	}
}

/** Fetch plan/credits for an account, then re-evaluate every chat on it. */
async function loadBilling(accountId: string | null, { maxAgeMs = 60_000 } = {}): Promise<void> {
	const key = accountId ?? "";
	const cached = billingCache.get(key);
	if (cached && Date.now() - cached.at < maxAgeMs) return;
	await loadCatalog();
	try {
		const billing = await invoke<Billing>("account_billing", { accountId });
		billingCache.set(key, { at: Date.now(), billing, error: null });
	} catch (error) {
		billingCache.set(key, { at: Date.now(), billing: cached?.billing ?? null, error: String(error) });
	}
	renderAccountSwitch();
	renderGauge();
	if (!accountMenu.classList.contains("hidden")) toggleAccountMenu(true);
	for (const tab of tabs) {
		if (tab.view instanceof ChatView && (tab.view.accountId ?? "") === key) tab.view.refreshAccess();
	}
}

function loadAllBilling(force = false): void {
	const ids: (string | null)[] = [...(cliUser ? [null] : []), ...accounts.map((a) => a.id)];
	for (const id of ids) void loadBilling(id, force ? { maxAgeMs: 0 } : {});
}

/** "Go · $X.XX", or what went wrong, for an account row. */
function billingLine(accountId: string | null): string {
	const entry = billingCache.get(accountId ?? "");
	if (!entry) return "요금제 확인 중…";
	if (entry.billing) return billingSummary(entry.billing);
	return "요금제를 확인하지 못함";
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
	if (!accountMenu.classList.contains("hidden")) toggleAccountMenu(true);
}

/** Point every open tab at `accountId`. `force` reconnects tabs already on it
 * (their login changed underneath). Returns how many tabs reconnect. */
function applyAccountToTabs(accountId: string | null, force = false): number {
	const name = accountName(accountId);
	let moved = 0;
	for (const tab of tabs) {
		const view = tab.view;
		if (view instanceof ChatView) {
			const differs = view.accountId !== accountId;
			if (differs || force) moved += 1;
			view.setAccount(accountId, name, force && !differs);
		} else if (!view.isLogin && (view.accountId !== accountId || force)) {
			moved += 1;
			void view.switchAccount(accountId, name);
		}
	}
	return moved;
}

function initial(name: string): string {
	return (name.trim()[0] ?? "?").toUpperCase();
}

function renderAccountSwitch(): void {
	const id = activeAccountId();
	const name = accountName(id);
	const loggedOut = !id && !cliUser;
	accountEl.replaceChildren(
		h(
			"button",
			{
				class: `account-btn${loggedOut ? " logged-out" : ""}`,
				title: "계정 · 로그인 · 로그아웃",
				onclick: (event: Event) => {
					event.stopPropagation();
					toggleAccountMenu();
				},
			},
			h("span", { class: `avatar${loggedOut ? " empty" : ""}` }, loggedOut ? "!" : initial(name)),
			h(
				"span",
				{ class: "account-text" },
				h("span", { class: "account-name" }, name),
				h(
					"span",
					{ class: `account-sub${!loggedOut && accountBlocker(accessFor(id).billing) ? " warn" : ""}` },
					loggedOut ? "눌러서 로그인" : billingLine(id),
				),
			),
			svg(icons.chevron, "icon account-chevron"),
		),
	);
}

interface RowAction {
	label: string;
	run: () => void;
	danger?: boolean;
}

function accountRow(id: string | null, name: string, sub: string, selectable: boolean, action: RowAction): HTMLElement {
	const active = selectable && id === activeAccountId();
	return h(
		"div",
		{ class: `account-item${active ? " active" : ""}`, role: "menuitemradio" },
		h(
			"button",
			{ class: "account-pick", disabled: !selectable, onclick: () => void switchAccount(id) },
			h("span", { class: `avatar${selectable ? "" : " empty"}` }, selectable ? initial(name) : "!"),
			h("span", { class: "account-text" }, h("span", { class: "account-name" }, name), h("span", { class: "account-sub" }, sub)),
			active ? svg(icons.check, "icon account-check") : null,
		),
		h(
			"button",
			{
				class: `account-act${action.danger ? " danger" : ""}`,
				onclick: (event: Event) => {
					event.stopPropagation();
					action.run();
				},
			},
			action.label,
		),
	);
}

function toggleAccountMenu(force?: boolean): void {
	const open = force ?? accountMenu.classList.contains("hidden");
	if (!open) {
		accountMenu.classList.add("hidden");
		return;
	}
	loadAllBilling();
	accountMenu.replaceChildren(
		h("div", { class: "account-menu-label" }, "계정"),
		cliUser
			? accountRow(null, cliUser, `CLI 로그인 · ${billingLine(null)}`, true, {
					label: "로그아웃",
					run: () => void cliLogout(),
					danger: true,
				})
			: accountRow(null, "CLI 로그인 안 됨", "cmd login", false, { label: "로그인", run: () => void cliLogin() }),
		...accounts.map((a) =>
			accountRow(a.id, a.userName, `저장된 계정 · ${billingLine(a.id)}`, true, {
				label: "로그아웃",
				run: () => void removeAccount(a.id),
				danger: true,
			}),
		),
		h("div", { class: "account-sep" }),
		h("button", { class: "account-action", onclick: () => void addAccount() }, svg(icons.plus), "다른 계정으로 로그인…"),
		h("button", { class: "account-action", onclick: () => void openModelsDialog() }, svg(icons.check), "계정별 사용 가능한 모델 보기…"),
		h("div", { class: "account-note" }, "계정을 바꾸면 열려 있는 대화도 바로 그 계정으로 다시 연결됩니다. 대화 내용은 그대로 남습니다."),
	);
	const rect = accountEl.getBoundingClientRect();
	accountMenu.style.left = `${rect.left}px`;
	accountMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
	accountMenu.style.width = `${Math.max(rect.width, 280)}px`;
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
	const previous = activeAccountId();
	settings = { ...settings, accountId: id ?? "" };
	saveSettings(settings);
	renderAccountSwitch();
	sessionCache.clear();
	renderProjects();
	const moved = applyAccountToTabs(activeAccountId());
	renderGauge();
	void loadBilling(activeAccountId());
	if (previous !== activeAccountId()) {
		const name = accountName(activeAccountId());
		toast(moved ? `${name} 계정으로 전환 · 열린 탭 ${moved}개 다시 연결` : `${name} 계정으로 전환했습니다`, "ok");
	}
}

/** `cmd login` in a throwaway home. Rust watches that home and fires
 * `accounts://login-complete` the moment the key lands. */
async function addAccount(): Promise<void> {
	toggleAccountMenu(false);
	let dir: string;
	try {
		dir = await invoke<string>("account_login_begin");
	} catch (error) {
		toast(`계정 추가를 시작하지 못했습니다: ${String(error)}`, "error");
		return;
	}
	const tab = await openTerminal(dir, ["login"], {
		account: null,
		profileDir: dir,
		title: "로그인 · 브라우저에서 계속",
		transient: true,
		onClose: () => {
			loginTabs.delete(dir);
			void invoke("account_login_cancel", { dir });
		},
	});
	if (tab) loginTabs.set(dir, tab);
	toast("브라우저에서 로그인하세요. 끝나면 이 탭은 저절로 닫힙니다.");
}

/** `cmd login` for the CLI's own login, in the user's real home. */
async function cliLogin(): Promise<void> {
	toggleAccountMenu(false);
	if (cliLoginTab && tabs.includes(cliLoginTab)) {
		activate(cliLoginTab);
		return;
	}
	const home = await homeDir();
	cliLoginTab = await openTerminal(home, ["login"], {
		account: null,
		title: "CLI 로그인 · 브라우저에서 계속",
		transient: true,
		onClose: () => {
			cliLoginTab = null;
		},
	});
	toast("브라우저에서 로그인하세요. 끝나면 이 탭은 저절로 닫힙니다.");
}

async function cliLogout(): Promise<void> {
	toggleAccountMenu(false);
	const ok = await ask(`${cliUser ?? "CLI"} 계정에서 로그아웃할까요?\nCLI 로그인을 쓰던 대화는 다시 로그인할 때까지 멈춥니다.`, {
		title: "로그아웃",
		kind: "warning",
		okLabel: "로그아웃",
		cancelLabel: "취소",
	});
	if (!ok) return;
	try {
		await invoke("cli_logout");
		// The auth watcher reports the change and reconnects affected tabs.
	} catch (error) {
		toast(String(error), "error");
	}
}

async function removeAccount(id: string): Promise<void> {
	toggleAccountMenu(false);
	const name = accounts.find((a) => a.id === id)?.userName ?? id;
	const ok = await ask(`${name} 계정에서 로그아웃할까요?\n이 앱에 저장된 키를 지웁니다. 다시 쓰려면 다시 로그인하면 됩니다.`, {
		title: "로그아웃",
		kind: "warning",
		okLabel: "로그아웃",
		cancelLabel: "취소",
	});
	if (!ok) return;
	try {
		await invoke("account_remove", { id });
	} catch (error) {
		toast(String(error), "error");
		return;
	}
	pool.forgetAccount(id);
	const wasActive = activeAccountId() === id;
	await refreshAccounts();
	if (wasActive) await switchAccount(null);
	// Tabs still on the removed account follow the active one.
	applyAccountToTabs(activeAccountId());
	toast(`${name} 계정에서 로그아웃했습니다`, "ok");
}

function closeLoginTab(tab: Tab | null | undefined): void {
	if (!tab || !tabs.includes(tab)) return;
	tab.onClose = undefined;
	void closeTab(tab);
}

void listen<{ dir: string; account: Account }>("accounts://login-complete", async (event) => {
	const { dir, account } = event.payload;
	closeLoginTab(loginTabs.get(dir));
	loginTabs.delete(dir);
	// A re-login replaces the key: agents on the old key must go.
	pool.forgetAccount(account.id);
	billingCache.delete(account.id);
	await refreshAccounts();
	const already = activeAccountId() === account.id;
	await switchAccount(account.id);
	if (already) applyAccountToTabs(account.id, true);
	toast(`${account.userName} 로그인 완료`, "ok");
});

void listen<{ dir: string; error: string }>("accounts://login-failed", (event) => {
	closeLoginTab(loginTabs.get(event.payload.dir));
	loginTabs.delete(event.payload.dir);
	toast(`로그인 정보를 저장하지 못했습니다: ${event.payload.error}`, "error", 8000);
});

void listen("accounts://changed", async () => {
	const before = cliUser;
	billingCache.delete("");
	await refreshAccounts();
	if (cliUser) void loadBilling(null);
	pool.forgetAccount(null);
	if (cliUser && cliLoginTab) {
		closeLoginTab(cliLoginTab);
		cliLoginTab = null;
	}
	const moved = activeAccountId() === null ? applyAccountToTabs(null, true) : 0;
	const what = !cliUser
		? "CLI에서 로그아웃했습니다"
		: !before
			? `CLI에 ${cliUser}(으)로 로그인했습니다`
			: before !== cliUser
				? `CLI 계정이 ${cliUser}(으)로 바뀌었습니다`
				: `${cliUser} 로그인 정보가 갱신됐습니다`;
	toast(moved ? `${what} · 열린 탭 ${moved}개 다시 연결` : what, cliUser ? "ok" : "info");
});

// --------------------------------------------------------- model access

/** Every model, grouped by whether the chosen account may use it. */
async function openModelsDialog(accountId: string | null = activeAccountId()): Promise<void> {
	toggleAccountMenu(false);
	await Promise.all([loadCatalog(), loadBilling(accountId, { maxAgeMs: 30_000 })]);
	const ids: (string | null)[] = [...(cliUser ? [null] : []), ...accounts.map((a) => a.id)];
	const picker = h(
		"select",
		{ class: "select" },
		ids.map((id) => h("option", { value: id ?? "" }, `${accountName(id)} · ${billingLine(id)}`)),
	);
	picker.value = accountId ?? "";
	picker.addEventListener("change", () => void openModelsDialog(picker.value || null));

	const { billing } = accessFor(accountId);
	const models = (catalog?.data ?? []).filter((m) => !m.hidden);
	const groups: { title: string; hint: string; items: HTMLElement[] }[] = [
		{ title: "사용 가능", hint: "", items: [] },
		{ title: "무료 모델", hint: "요청 비용 0원. 단, 세션을 시작하려면 잔액 $1 이상 필요 (공식 문서)", items: [] },
		{ title: "요금제 업그레이드 필요", hint: "", items: [] },
		{ title: "크레딧 부족으로 사용 불가", hint: "", items: [] },
	];
	for (const model of models) {
		const access = modelAccess(model, billing);
		const index = !access.allowed ? (access.kind === "locked" ? 2 : 3) : access.kind === "free" ? 1 : 0;
		groups[index].items.push(
			h(
				"div",
				{ class: `model-row${access.allowed ? "" : " off"}`, title: model.display?.notice ?? "" },
				h("span", { class: "model-name" }, model.display?.label ?? model.name),
				h("span", { class: "model-vendor" }, model.display?.group ?? ""),
				h("span", { class: "model-note" }, access.note || (model.minimumPlan ? `${planName(model.minimumPlan)} 이상` : "")),
			),
		);
	}
	const blocker = accountBlocker(billing);
	const entry = billingCache.get(accountId ?? "");
	settingsEl.replaceChildren(
		h(
			"div",
			{ class: "settings models" },
			h("h2", null, "계정별 사용 가능한 모델"),
			h("label", { class: "field" }, h("span", { class: "field-label" }, "계정"), picker),
			billing
				? h(
						"div",
						{ class: `models-summary${blocker ? " warn" : ""}` },
						h("strong", null, `${planName(billing.planId)} 요금제`),
						` · 잔액 ${money(balance(billing))} (월 ${money(billing.monthlyCredits)} + 충전 ${money(billing.purchasedCredits)} + 보너스 ${money(billing.freeCredits)})`,
						blocker ? h("div", null, blocker) : null,
					)
				: h("div", { class: "models-summary warn" }, entry?.error ?? "요금제를 확인하지 못했습니다."),
			h(
				"div",
				{ class: "models-list" },
				groups
					.filter((g) => g.items.length)
					.map((g) =>
						h(
							"section",
							null,
							h("h3", null, `${g.title} (${g.items.length})`),
							g.hint ? h("p", { class: "field-help" }, g.hint) : null,
							g.items,
						),
					),
			),
			h(
				"p",
				{ class: "field-help" },
				"기준: CLI가 쓰는 모델 목록의 모델별 최소 요금제와 CLI의 접근 판정 규칙, 그리고 공식 요금 문서(commandcode.ai/docs/resources/pricing-limits). 최종 판단은 서버가 하므로 드물게 다를 수 있습니다.",
			),
			h(
				"div",
				{ class: "settings-actions" },
				h(
					"button",
					{ class: "btn", type: "button", onclick: () => void openUrl("https://commandcode.ai/docs/resources/pricing-limits") },
					"공식 요금 안내",
				),
				h("button", { class: "btn primary", type: "button", onclick: () => settingsEl.close() }, "닫기"),
			),
		),
	);
	if (!settingsEl.open) settingsEl.showModal();
}

// ---------------------------------------------------------- usage gauge
//
// Always on screen (tab bar, top right), for the account new chats run as:
// share of the month's credits spent, what is left, days to renewal, and the
// 5-hour / weekly windows when the plan has them or a limit was just hit.
// Same numbers as the CLI's /usage (src/billing.ts `usageOf`).

const gaugeEl = byId<HTMLButtonElement>("usage-gauge");
const gaugePanel = h("div", { class: "gauge-panel hidden" });
document.body.appendChild(gaugePanel);

/** Limits a turn ran into, per account, until they reset. */
const limitHits = new Map<string, { window: string; resetAt: number | null; at: number }>();

function reportLimit(accountId: string | null, window: string, resetAt: number | null): void {
	limitHits.set(accountId ?? "", { window, resetAt, at: Date.now() });
	renderGauge();
	void loadBilling(accountId, { maxAgeMs: 0 });
}

function activeLimit(accountId: string | null): { window: string; resetAt: number | null } | null {
	const hit = limitHits.get(accountId ?? "");
	if (!hit) return null;
	const expired = hit.resetAt !== null ? Date.now() >= hit.resetAt : Date.now() - hit.at > 60 * 60_000;
	if (expired) {
		limitHits.delete(accountId ?? "");
		return null;
	}
	return hit;
}

/** "오후 04:47", or "10월 25일 오후 04:07" when it is not within the next day. */
function clock(ms: number): string {
	const time = new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
	if (ms - Date.now() < 20 * 3_600_000) return time;
	return `${new Date(ms).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} ${time}`;
}

function level(percent: number | null, blocked: boolean): "ok" | "warn" | "danger" {
	if (blocked) return "danger";
	if (percent === null) return "ok";
	return percent >= 95 ? "danger" : percent >= 80 ? "warn" : "ok";
}

function bar(percent: number, tone: string): HTMLElement {
	return h("span", { class: `gauge-bar ${tone}` }, h("span", { style: `width:${Math.max(2, percent).toFixed(1)}%` }));
}

function renderGauge(): void {
	const id = activeAccountId();
	const entry = billingCache.get(id ?? "");
	const billing = entry?.billing ?? null;
	const hit = activeLimit(id);
	if (!cliUser && !id) {
		gaugeEl.className = "usage-gauge danger";
		gaugeEl.replaceChildren(h("span", { class: "gauge-text" }, "로그인 필요"));
		gaugeEl.title = "로그인되어 있지 않습니다";
		return;
	}
	if (!billing) {
		gaugeEl.className = "usage-gauge";
		gaugeEl.replaceChildren(h("span", { class: "gauge-text muted" }, entry?.error ? "사용량 확인 실패" : "사용량 확인 중…"));
		gaugeEl.title = entry?.error ?? "";
		return;
	}
	const usage = usageOf(billing);
	const worstWindow = usage.windows.reduce<number | null>((max, w) => (max === null || w.percent > max ? w.percent : max), null);
	const blocked = Boolean(hit) || usage.remaining <= 0;
	const shown = Math.max(usage.percent ?? 0, worstWindow ?? 0);
	const tone = level(usage.percent === null && worstWindow === null ? null : shown, blocked);
	gaugeEl.className = `usage-gauge ${tone}`;
	const parts: (HTMLElement | string)[] = [];
	if (usage.percent !== null || worstWindow !== null) parts.push(bar(blocked ? 100 : shown, tone));
	parts.push(
		h(
			"span",
			{ class: "gauge-text" },
			hit
				? `${hit.window} 한도${hit.resetAt ? ` · ${clock(hit.resetAt)} 초기화` : ""}`
				: usage.percent !== null
					? `${Math.round(shown)}% · ${money(usage.remaining)}`
					: `잔액 ${money(usage.remaining)}`,
		),
	);
	gaugeEl.replaceChildren(...parts);
	gaugeEl.title = `${accountName(id)} · ${billingSummary(billing)} · 눌러서 자세히`;
	if (!gaugePanel.classList.contains("hidden")) renderGaugePanel();
}

function renderGaugePanel(): void {
	const id = activeAccountId();
	const entry = billingCache.get(id ?? "");
	const billing = entry?.billing ?? null;
	const hit = activeLimit(id);
	const rows: HTMLElement[] = [h("div", { class: "gauge-head" }, h("strong", null, accountName(id)), h("span", { class: "muted" }, billing ? planName(billing.planId) : ""))];
	if (!billing) {
		rows.push(h("div", { class: "muted small" }, entry?.error ?? "사용량을 불러오는 중입니다."));
	} else {
		const usage = usageOf(billing);
		if (usage.percent !== null && usage.pool !== null) {
			const tone = level(usage.percent, usage.remaining <= 0);
			rows.push(
				h(
					"div",
					{ class: "gauge-row" },
					h("div", { class: "gauge-row-head" }, h("span", null, "이번 달 크레딧"), h("span", null, `${Math.round(usage.percent)}% 사용`)),
					bar(usage.percent, tone),
					h(
						"div",
						{ class: "muted small" },
						`남은 ${money(usage.remaining)} / ${money(usage.pool)}${usage.daysLeft !== null ? ` · ${usage.daysLeft}일 뒤 갱신` : ""}`,
					),
				),
			);
		} else {
			rows.push(h("div", { class: "gauge-row" }, h("div", { class: "gauge-row-head" }, h("span", null, "잔액"), h("span", null, money(usage.remaining)))));
		}
		for (const w of usage.windows) {
			rows.push(
				h(
					"div",
					{ class: "gauge-row" },
					h("div", { class: "gauge-row-head" }, h("span", null, `${w.label} 한도`), h("span", null, `${Math.round(w.percent)}%`)),
					bar(w.percent, level(w.percent, false)),
					h("div", { class: "muted small" }, `${money(w.used)} / ${money(w.cap)}${w.resetAt ? ` · ${clock(w.resetAt)} 초기화` : ""}`),
				),
			);
		}
		if (hit) {
			rows.push(
				h(
					"div",
					{ class: "gauge-alert" },
					`${hit.window} 사용 한도에 도달했습니다.${hit.resetAt ? ` ${clock(hit.resetAt)}에 초기화됩니다.` : ""} 다른 계정이나 모델로 바꾸면 계속할 수 있습니다.`,
				),
			);
		}
		if (billing.purchasedCredits > 0 || billing.freeCredits > 0) {
			rows.push(h("div", { class: "muted small" }, `충전 ${money(billing.purchasedCredits)} · 보너스 ${money(billing.freeCredits)} 포함`));
		}
		const blocker = accountBlocker(billing);
		if (blocker) rows.push(h("div", { class: "gauge-alert" }, blocker));
		rows.push(
			h(
				"div",
				{ class: "muted small" },
				`${entry ? `${Math.max(0, Math.round((Date.now() - entry.at) / 1000))}초 전 확인` : ""} · 1분마다, 그리고 답변이 끝날 때마다 갱신`,
			),
		);
	}
	rows.push(
		h(
			"div",
			{ class: "gauge-actions" },
			h("button", { class: "btn", onclick: () => void loadBilling(id, { maxAgeMs: 0 }) }, svg(icons.refresh), "새로고침"),
			h("button", { class: "btn", onclick: () => void openModelsDialog(id) }, "사용 가능한 모델"),
			h("button", { class: "btn", onclick: () => { toggleGauge(false); toggleAccountMenu(true); } }, "계정 전환"),
		),
	);
	gaugePanel.replaceChildren(...rows);
	const rect = gaugeEl.getBoundingClientRect();
	gaugePanel.style.top = `${rect.bottom + 6}px`;
	gaugePanel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
}

function toggleGauge(force?: boolean): void {
	const open = force ?? gaugePanel.classList.contains("hidden");
	gaugePanel.classList.toggle("hidden", !open);
	if (open) {
		renderGaugePanel();
		void loadBilling(activeAccountId(), { maxAgeMs: 15_000 });
	}
}

gaugeEl.addEventListener("click", (event) => {
	event.stopPropagation();
	toggleGauge();
});
document.addEventListener("click", (event) => {
	if (!gaugePanel.contains(event.target as Node)) toggleGauge(false);
});

// Keep it current: every minute while the window is visible.
setInterval(() => {
	if (document.visibilityState === "visible") void loadBilling(activeAccountId(), { maxAgeMs: 55_000 });
	else renderGauge();
}, 60_000);

// -------------------------------------------------------------- updates
//
// CLI: `cmd update` (the CLI also updates itself in the background; the
// version watcher below moves running chats onto a new version). App: rebuilt
// from the source folder it was built from, then swapped in on restart
// (src-tauri/src/updates.rs). Update state lives here, not in the dialog, so
// closing the dialog never loses a build in progress.

interface AppInfo {
	version: string;
	commit: string;
	debug: boolean;
	sourceDir: string | null;
	sourceCommit: string | null;
	commitsBehind: number | null;
	changes: string[];
}

interface Check {
	name: string;
	ok: boolean;
	detail: string;
}

let appInfo: AppInfo | null = null;
let cliLatest: string | null = null;
let cliCurrent: string | null = null;
let compat: Check[] = [];
const appUpdate: { phase: "idle" | "building" | "ready" | "failed"; log: string[]; exe: string | null; error: string | null } = {
	phase: "idle",
	log: [],
	exe: null,
	error: null,
};
/** Re-renders the update dialog while it is open. */
let renderUpdatesDialog: (() => void) | null = null;

function renderVersionLabel(): void {
	const label = byId("cli-version");
	const appBehind = (appInfo?.commitsBehind ?? 0) > 0 && !appInfo?.debug;
	const cliBehind = Boolean(cliLatest && cliCurrent && cliLatest !== cliCurrent);
	const broken = compat.some((c) => !c.ok);
	label.replaceChildren(
		`앱 ${appInfo?.version ?? ""} · CLI ${cliCurrent ?? "?"}`,
		...(appUpdate.phase === "ready"
			? [h("span", { class: "update-dot" }, " 적용 대기")]
			: appBehind || cliBehind
				? [h("span", { class: "update-dot" }, " 업데이트 있음")]
				: []),
		...(broken ? [h("span", { class: "update-dot warn" }, " 호환성 확인 필요")] : []),
	);
	label.title = "업데이트 · 호환성";
}

function parseLatest(output: string, fallback: string | null): string | null {
	const latest = output.match(/Latest:\s*v?([\d.]+)/i)?.[1];
	return /update available/i.test(output) && latest ? latest : fallback;
}

async function checkUpdates(cli: boolean): Promise<void> {
	appInfo = await invoke<AppInfo>("app_info").catch(() => null);
	const launch = await invoke<Launch>("cmdc_launch").catch(() => null);
	cliCurrent = launch?.version ?? null;
	if (cli) {
		const result = await invoke<{ output: string; version: string | null }>("cli_update", { checkOnly: true }).catch(() => null);
		if (result) cliLatest = parseLatest(result.output, result.version ?? cliCurrent);
	}
	renderVersionLabel();
	renderUpdatesDialog?.();
}

/** What the app relies on in the CLI: static markers in its bundle (Rust)
 * plus the live data the app already has (catalog, billing, ACP). */
async function runCompat(): Promise<Check[]> {
	const checks = await invoke<Check[]>("cli_compat").catch((error): Check[] => [{ name: "CLI 점검", ok: false, detail: String(error) }]);
	await loadCatalog();
	const withPlans = catalog?.data.filter((m) => m.minimumPlan !== undefined).length ?? 0;
	checks.push({
		name: "모델 목록",
		ok: Boolean(catalog && withPlans > 0),
		detail: catalog ? `모델 ${catalog.data.length}개 · 최소 요금제 표시 ${withPlans}개` : "CLI의 모델 목록 캐시를 읽지 못했습니다.",
	});
	const entry = billingCache.get(activeAccountId() ?? "");
	checks.push({
		name: "요금·사용량 API",
		ok: Boolean(entry?.billing),
		detail: entry?.billing ? billingSummary(entry.billing) : (entry?.error ?? "아직 확인 전"),
	});
	const live = tabs
		.map((t) => t.view)
		.find((v): v is ChatView => v instanceof ChatView && v.ready)?.protocolVersion;
	checks.push({
		name: "ACP 프로토콜",
		ok: live === undefined || live === 1,
		detail: live === undefined ? "열린 대화가 없어 다음 대화 때 확인" : `버전 ${live}${live === 1 ? "" : " — 앱은 1을 기대합니다"}`,
	});
	compat = checks;
	renderVersionLabel();
	renderUpdatesDialog?.();
	return checks;
}

async function startAppUpdate(): Promise<void> {
	if (appUpdate.phase === "building") return;
	appUpdate.phase = "building";
	appUpdate.log = [];
	appUpdate.error = null;
	renderUpdatesDialog?.();
	renderVersionLabel();
	const channel = new Channel<string>();
	channel.onmessage = (line) => {
		appUpdate.log.push(line);
		if (appUpdate.log.length > 400) appUpdate.log.splice(0, appUpdate.log.length - 400);
		renderUpdatesDialog?.();
	};
	try {
		appUpdate.exe = await invoke<string>("app_update_build", { onLog: channel });
		appUpdate.phase = "ready";
		toast("앱 새 버전이 준비됐습니다.", "ok", 30_000, { label: "다시 시작해서 적용", run: () => void applyAppUpdate() });
	} catch (error) {
		appUpdate.phase = "failed";
		appUpdate.error = String(error);
		toast(`앱 업데이트 빌드 실패: ${appUpdate.error}`, "error", 10_000, { label: "자세히", run: () => void openUpdates() });
	}
	renderUpdatesDialog?.();
	renderVersionLabel();
}

async function applyAppUpdate(): Promise<void> {
	if (appUpdate.phase !== "ready" || !appUpdate.exe) return;
	const busy = tabs.filter((t) => t.busy).length;
	if (busy) {
		const ok = await ask(`작업 중인 탭 ${busy}개가 중지됩니다. 지금 다시 시작할까요?`, {
			title: "업데이트 적용",
			kind: "warning",
			okLabel: "다시 시작",
			cancelLabel: "나중에",
		});
		if (!ok) return;
	}
	pool.stopAll();
	await invoke("app_update_apply", { newExe: appUpdate.exe });
}

async function updateCli(): Promise<void> {
	const install = Boolean(cliLatest && cliCurrent && cliLatest !== cliCurrent);
	try {
		const result = await invoke<{ output: string; version: string | null }>("cli_update", { checkOnly: !install });
		if (install) {
			// The version watcher reports the change and moves chats over.
			cliLatest = result.version;
		} else {
			cliLatest = parseLatest(result.output, result.version ?? cliCurrent);
		}
	} catch (error) {
		toast(String(error), "error");
	}
	await checkUpdates(false);
}

function openUpdates(): void {
	const appStatus = h("div", { class: "update-status" });
	const appBtn = h("button", { class: "btn primary", type: "button" });
	const log = h("pre", { class: "update-log hidden" });
	const cliStatus = h("div", { class: "update-status" });
	const cliBtn = h("button", { class: "btn", type: "button" });
	const compatList = h("div", { class: "compat-list" });
	const compatBtn = h("button", { class: "btn", type: "button" }, "다시 점검");
	let cliBusy = false;

	const render = () => {
		if (!appInfo) {
			appStatus.textContent = "앱 정보를 읽는 중…";
		} else {
			const behind = appInfo.commitsBehind ?? 0;
			appStatus.replaceChildren(
				h("div", null, h("strong", null, `Command Code Desktop ${appInfo.version}`), ` (${appInfo.commit.slice(0, 7) || "커밋 정보 없음"})`),
				h("div", { class: "muted small" }, `소스 폴더: ${appInfo.sourceDir ?? "찾지 못함"}`),
				appInfo.debug
					? h("div", { class: "muted small" }, "개발 모드로 실행 중이라 소스를 고치면 바로 반영됩니다.")
					: behind > 0
						? h(
								"div",
								null,
								h("div", { class: "update-new" }, `새 버전이 있습니다 · 변경 ${behind}개`),
								h("ul", { class: "update-changes" }, appInfo.changes.map((c) => h("li", null, c))),
							)
						: h("div", { class: "muted small" }, "최신 버전입니다."),
			);
		}
		const phase = appUpdate.phase;
		appBtn.textContent =
			phase === "building" ? "빌드 중… (몇 분 걸립니다)" : phase === "ready" ? "다시 시작해서 적용" : phase === "failed" ? "다시 시도" : "앱 업데이트";
		appBtn.disabled =
			phase === "building" ||
			(phase === "idle" && (!appInfo || appInfo.debug || (appInfo.commitsBehind ?? 0) === 0 || !appInfo.sourceDir));
		log.classList.toggle("hidden", appUpdate.log.length === 0 && !appUpdate.error);
		log.textContent = [...appUpdate.log.slice(-200), ...(appUpdate.error ? [`[실패] ${appUpdate.error}`] : [])].join("\n");
		log.scrollTop = log.scrollHeight;

		const cliBehind = Boolean(cliLatest && cliCurrent && cliLatest !== cliCurrent);
		cliStatus.replaceChildren(
			h("div", null, h("strong", null, `Command Code CLI ${cliCurrent ?? "?"}`)),
			h(
				"div",
				{ class: cliBehind ? "update-new" : "muted small" },
				cliBehind ? `새 버전 ${cliLatest}이(가) 있습니다.` : cliLatest ? "최신 버전입니다." : "확인 전입니다.",
			),
			h("div", { class: "muted small" }, "CLI는 스스로도 백그라운드에서 업데이트합니다. 버전이 바뀌면 앱이 알아채고, 열린 대화를 새 버전으로 다시 연결합니다."),
		);
		cliBtn.textContent = cliBusy ? "진행 중…" : cliBehind ? "CLI 지금 업데이트" : "CLI 업데이트 확인";
		cliBtn.disabled = cliBusy;

		compatList.replaceChildren(
			...(compat.length
				? compat.map((c) =>
						h(
							"div",
							{ class: `compat-row${c.ok ? "" : " bad"}` },
							h("span", { class: "compat-mark" }, c.ok ? "✓" : "!"),
							h("span", { class: "compat-name" }, c.name),
							h("span", { class: "compat-detail" }, c.detail),
						),
					)
				: [h("div", { class: "muted small" }, "점검 중…")]),
		);
	};

	appBtn.addEventListener("click", () => {
		if (appUpdate.phase === "ready") void applyAppUpdate();
		else void startAppUpdate();
	});
	cliBtn.addEventListener("click", async () => {
		cliBusy = true;
		render();
		await updateCli();
		cliBusy = false;
		render();
	});
	compatBtn.addEventListener("click", () => void runCompat());

	settingsEl.replaceChildren(
		h(
			"div",
			{ class: "settings" },
			h("h2", null, "업데이트 · 호환성"),
			h("section", { class: "update-block" }, h("h3", null, "앱"), appStatus, h("div", { class: "row" }, appBtn)),
			log,
			h(
				"section",
				{ class: "update-block" },
				h("h3", null, "Command Code CLI"),
				cliStatus,
				h(
					"div",
					{ class: "row" },
					cliBtn,
					h("button", { class: "btn ghost", type: "button", onclick: () => void openUrl("https://commandcode.ai/changelog") }, "변경 내역"),
				),
			),
			h(
				"section",
				{ class: "update-block" },
				h("h3", null, "CLI 호환성 점검"),
				h("div", { class: "muted small" }, "이 앱이 CLI에서 기대는 기능들입니다. CLI가 바뀐 뒤 하나라도 빠지면 여기에 표시됩니다."),
				compatList,
				h("div", { class: "row" }, compatBtn),
			),
			h(
				"div",
				{ class: "settings-actions" },
				h("button", { class: "btn primary", type: "button", onclick: () => settingsEl.close() }, "닫기"),
			),
		),
	);
	renderUpdatesDialog = render;
	settingsEl.addEventListener(
		"close",
		() => {
			if (renderUpdatesDialog === render) renderUpdatesDialog = null;
		},
		{ once: true },
	);
	render();
	if (!settingsEl.open) settingsEl.showModal();
	void checkUpdates(false);
	void runCompat();
}

// The CLI updated itself (or was updated from here): new agents already use
// it; move running chats over too, and re-check what the app relies on.
void listen<{ from: string | null; to: string | null }>("cli://version", async (event) => {
	const { from, to } = event.payload;
	cliCurrent = to;
	if (cliLatest && to && cliLatest === to) cliLatest = to;
	for (const id of [null, ...accounts.map((a) => a.id)]) pool.forgetAccount(id);
	let moved = 0;
	for (const tab of tabs) {
		if (tab.view instanceof ChatView) {
			moved += 1;
			tab.view.setAccount(tab.view.accountId, accountName(tab.view.accountId), true, `CLI ${to ?? "새 버전"}(으)로 다시 연결했습니다.`);
		}
	}
	catalogAt = 0;
	const checks = await runCompat();
	const broken = checks.filter((c) => !c.ok);
	toast(
		`Command Code CLI가 ${from ?? "?"} → ${to ?? "?"}(으)로 업데이트됐습니다${moved ? ` · 대화 ${moved}개를 새 버전으로 다시 연결` : ""}`,
		broken.length ? "error" : "ok",
		10_000,
		broken.length ? { label: `호환성 문제 ${broken.length}건 보기`, run: () => void openUpdates() } : undefined,
	);
});

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
				"button",
				{ class: "btn", type: "button", onclick: () => void openUpdates() },
				svg(icons.refresh),
				"업데이트 확인…",
			),
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
		__cmdc: { tabs: () => tabs, active: () => activeTab, openChat, openTerminal, closeTab, refreshAccounts, switchAccount, addAccount, cliLogin, openModelsDialog, openUpdates, accessFor, loadBilling, reportLimit, runCompat, renderGauge },
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
	// Earlier versions could remember an add-account login home as a project.
	for (const stray of projects.filter((p) => isLoginHome(p.path))) projects = forgetProject(stray.path);
	const exists = await Promise.all(projects.map((p) => invoke<boolean>("dir_exists", { path: p.path }).catch(() => true)));
	projects = projects.filter((_, i) => exists[i]);
	renderProjects();
	activate(null);

	byId("cli-version").addEventListener("click", () => void openUpdates());
	void checkUpdates(false).then(() => {
		if ((appInfo?.commitsBehind ?? 0) > 0) toast("앱 새 버전이 있습니다 · 왼쪽 아래 버전을 눌러 업데이트", "info", 8000);
	});
	// The CLI check spawns the CLI (~10 s); keep it off the startup path.
	setTimeout(() => void checkUpdates(true).then(() => runCompat()), 20_000);
	renderGauge();
	void loadCatalog().then(() => loadAllBilling());

	// A folder from the command line (or CMDC_GUI_START_DIR) opens straight
	// into a chat, which makes the app scriptable from a shortcut.
	const startDir = await invoke<string | null>("start_dir").catch(() => null);
	if (startDir) await openChat(startDir);

	// A second launch with a folder (single-instance) lands here.
	void listen<string>("app://open-folder", (event) => void openChat(event.payload));
})();
