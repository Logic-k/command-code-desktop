// One agent process per project folder, shared by that folder's chat tabs and
// its sidebar session list. `cmd acp` serves exactly one directory, and
// `session/list` answers for the process's own cwd, so the folder is the key.

import { AcpConnection } from "./client";

/** How long an unused connection lingers, so reopening a chat is instant. */
const IDLE_MS = 90_000;

interface Entry {
	connection: AcpConnection;
	refs: number;
	idleTimer: number | null;
}

const entries = new Map<string, Entry>();
let profileDir: string | null = null;

function keyFor(cwd: string): string {
	return cwd.replace(/[\\/]+$/, "").toLowerCase();
}

function entryFor(cwd: string): Entry {
	const key = keyFor(cwd);
	let entry = entries.get(key);
	if (!entry || !entry.connection.alive && entry.refs === 0) {
		entry?.connection.stop();
		const connection = new AcpConnection(cwd, profileDir);
		const fresh: Entry = { connection, refs: 0, idleTimer: null };
		connection.onExit(() => {
			if (entries.get(key) === fresh && fresh.refs === 0) entries.delete(key);
		});
		entries.set(key, fresh);
		entry = fresh;
	}
	return entry;
}

/** Take a reference; pair every call with `release`. */
export function acquire(cwd: string): AcpConnection {
	const entry = entryFor(cwd);
	entry.refs += 1;
	if (entry.idleTimer !== null) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
	}
	return entry.connection;
}

export function release(connection: AcpConnection): void {
	const key = keyFor(connection.cwd);
	const entry = entries.get(key);
	if (!entry || entry.connection !== connection) {
		void connection.stop();
		return;
	}
	entry.refs = Math.max(0, entry.refs - 1);
	if (entry.refs > 0) return;
	entry.idleTimer = window.setTimeout(() => {
		if (entry.refs > 0) return;
		entries.delete(key);
		void connection.stop();
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

/** A dead process is replaced on the next `acquire`; tabs call this to retry. */
export function restart(connection: AcpConnection): AcpConnection {
	const key = keyFor(connection.cwd);
	const entry = entries.get(key);
	if (entry?.connection === connection) {
		void connection.stop();
		const fresh = new AcpConnection(connection.cwd, profileDir);
		entry.connection = fresh;
		return fresh;
	}
	return acquire(connection.cwd);
}

/** Switching account profile restarts every idle agent on the next use. */
export function setProfileDir(dir: string | null): void {
	profileDir = dir && dir.trim() ? dir : null;
}

export function stopAll(): void {
	for (const entry of entries.values()) void entry.connection.stop();
	entries.clear();
}
