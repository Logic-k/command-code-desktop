// One agent process per project folder (and account profile), shared by that
// folder's chat tabs and its sidebar session list. `cmd acp` serves exactly
// one directory, and `session/list` answers for the process's own cwd.
//
// References are counted per connection, not per folder: a connection that
// died and was replaced still has holders, and their releases must land on
// the connection they actually hold.

import { AcpConnection } from "./client";

/** How long an unused connection lingers, so reopening a chat is instant. */
const IDLE_MS = 90_000;

interface Entry {
	key: string;
	connection: AcpConnection;
	refs: number;
	idleTimer: number | null;
}

/** The current connection for each folder. */
const current = new Map<string, Entry>();
/** Every connection someone still holds, current or replaced. */
const held = new Map<AcpConnection, Entry>();
let profileDir: string | null = null;

function keyFor(cwd: string): string {
	return `${profileDir ?? ""}|${cwd.replace(/[\\/]+$/, "").toLowerCase()}`;
}

function clearIdle(entry: Entry): void {
	if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
	entry.idleTimer = null;
}

function retire(entry: Entry): void {
	clearIdle(entry);
	if (current.get(entry.key) === entry) current.delete(entry.key);
	held.delete(entry.connection);
	void entry.connection.stop();
}

/** Take a reference; pair every call with `release`. */
export function acquire(cwd: string): AcpConnection {
	const key = keyFor(cwd);
	let entry = current.get(key);
	if (!entry || entry.connection.dead) {
		const connection = new AcpConnection(cwd, profileDir);
		const fresh: Entry = { key, connection, refs: 0, idleTimer: null };
		connection.onExit(() => {
			if (fresh.refs === 0) retire(fresh);
			else if (current.get(key) === fresh) current.delete(key);
		});
		current.set(key, fresh);
		held.set(connection, fresh);
		entry = fresh;
	}
	entry.refs += 1;
	clearIdle(entry);
	return entry.connection;
}

export function release(connection: AcpConnection): void {
	const entry = held.get(connection);
	if (!entry) {
		void connection.stop();
		return;
	}
	entry.refs = Math.max(0, entry.refs - 1);
	if (entry.refs > 0) return;
	if (connection.dead || current.get(entry.key) !== entry) {
		retire(entry);
		return;
	}
	clearIdle(entry);
	entry.idleTimer = window.setTimeout(() => {
		entry.idleTimer = null;
		if (entry.refs === 0) retire(entry);
	}, IDLE_MS);
}

/** Borrow a connection for one call (the sidebar's session list). */
export async function withConnection<T>(cwd: string, run: (connection: AcpConnection) => Promise<T>): Promise<T> {
	const connection = acquire(cwd);
	try {
		await connection.start();
		return await run(connection);
	} finally {
		release(connection);
	}
}

/** For a tab's retry: a healthy connection is kept (other tabs share it);
 * a dead one is swapped for a fresh process. */
export function restart(connection: AcpConnection): AcpConnection {
	if (!connection.dead) return connection;
	release(connection);
	return acquire(connection.cwd);
}

/** New connections use this account profile; idle ones from the old profile go. */
export function setProfileDir(dir: string | null): void {
	const next = dir && dir.trim() ? dir : null;
	if (next === profileDir) return;
	profileDir = next;
	for (const entry of [...current.values()]) {
		if (entry.refs === 0) retire(entry);
		else current.delete(entry.key);
	}
}

export function stopAll(): void {
	for (const entry of [...held.values()]) retire(entry);
}
