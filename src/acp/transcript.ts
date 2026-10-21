// Command Code session transcripts (~/.commandcode/projects/<slug>/<id>.jsonl)
// turned into the same `session/update`s a live turn produces, so the chat
// renders history with the code path it uses for streaming.
//
// The tool tables mirror the CLI's own ACP translation (command-code 1.86,
// `toolKindFor` / `toolTitleFor` / `toolDiffFor`), so replayed cards look the
// same as live ones.

import type { ContentBlock, PlanEntry, SessionUpdate, ToolContent, ToolKind } from "./types";

const KIND: Record<string, ToolKind> = {
	read_file: "read",
	read_multiple_files: "read",
	read_directory: "read",
	get_diagnostics: "read",
	edit_file: "edit",
	write_file: "edit",
	grep: "search",
	glob: "search",
	web_search: "search",
	web_fetch: "fetch",
	shell_command: "execute",
	monitor_command: "execute",
	monitor_events: "execute",
	kill_shell: "execute",
	shell_tasks: "execute",
	bash_output: "execute",
	run_command: "execute",
	todo_write: "think",
	enter_plan_mode: "switch_mode",
	exit_plan_mode: "switch_mode",
	plan_review: "think",
	ask_user_question: "think",
	task: "other",
};

const TITLE: Record<string, { label: string; key?: string }> = {
	shell_command: { label: "Shell", key: "command" },
	monitor_command: { label: "Monitor", key: "command" },
	read_file: { label: "Read", key: "file_path" },
	read_multiple_files: { label: "Read", key: "include" },
	read_directory: { label: "List", key: "path" },
	edit_file: { label: "Edit", key: "file_path" },
	write_file: { label: "Write", key: "file_path" },
	grep: { label: "Search", key: "pattern" },
	glob: { label: "Glob", key: "pattern" },
	todo_write: { label: "Updating todos" },
	kill_shell: { label: "Kill", key: "taskId" },
	web_search: { label: "Search", key: "query" },
	web_fetch: { label: "Fetch", key: "url" },
	get_diagnostics: { label: "Diagnostics" },
	run_command: { label: "Command", key: "command" },
	task: { label: "Agent", key: "description" },
};

interface RawBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: RawBlock[] | string;
	is_error?: boolean;
	source?: { data: string; media_type: string };
}

interface Entry {
	type: string;
	id?: string;
	parentId?: string | null;
	message?: { role: string; content: RawBlock[] | string };
	meta?: { isMeta?: boolean };
}

function str(input: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = input?.[key];
	return typeof value === "string" ? value : undefined;
}

function titleFor(name: string, input: Record<string, unknown> | undefined): string {
	const spec = TITLE[name];
	if (!spec) return name;
	if (!spec.key) return spec.label;
	const arg = (str(input, spec.key) ?? "").replace(/\s+/g, " ");
	return `${spec.label}: ${arg.length > 120 ? `${arg.slice(0, 117)}…` : arg}`;
}

function diffFor(name: string, input: Record<string, unknown> | undefined): ToolContent[] {
	const path = str(input, "file_path") ?? str(input, "path");
	if (!path) return [];
	if (name === "write_file") {
		const content = str(input, "content");
		return content === undefined ? [] : [{ type: "diff", path, oldText: null, newText: content }];
	}
	if (name === "edit_file") {
		const oldText = str(input, "old_string");
		const newText = str(input, "new_string");
		return oldText === undefined || newText === undefined ? [] : [{ type: "diff", path, oldText, newText }];
	}
	return [];
}

function resultText(block: RawBlock | undefined): string {
	if (!block) return "";
	if (typeof block.content === "string") return block.content;
	return (block.content ?? [])
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n");
}

function planFrom(input: Record<string, unknown> | undefined): PlanEntry[] | null {
	const todos = input?.todos;
	if (!Array.isArray(todos)) return null;
	return todos.map((todo: { content?: string; status?: string }) => ({
		content: String(todo?.content ?? ""),
		priority: "medium",
		status: todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending",
	}));
}

/** The active branch: walk parent links back from the last message. Sessions
 * are trees (/rewind, /tree), and only one path is the current conversation. */
function activeBranch(entries: Entry[]): Entry[] {
	const messages = entries.filter((e) => e.type === "message" && e.message);
	if (!messages.length || messages.every((m) => m.parentId === undefined)) return messages;
	const byId = new Map(messages.filter((m) => m.id).map((m) => [m.id as string, m]));
	const path: Entry[] = [];
	const seen = new Set<string>();
	let node: Entry | undefined = messages[messages.length - 1];
	while (node && !(node.id && seen.has(node.id))) {
		path.push(node);
		if (node.id) seen.add(node.id);
		node = node.parentId ? byId.get(node.parentId) : undefined;
	}
	return path.reverse();
}

export function transcriptUpdates(jsonl: string): SessionUpdate[] {
	const entries: Entry[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A half-written last line while the CLI is still appending.
		}
	}
	const branch = activeBranch(entries);

	const results = new Map<string, RawBlock>();
	for (const entry of branch) {
		const content = entry.message?.content;
		if (entry.message?.role !== "user" || !Array.isArray(content)) continue;
		for (const block of content) if (block.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, block);
	}

	const updates: SessionUpdate[] = [];
	for (const entry of branch) {
		const { role, content } = entry.message!;
		const blocks: RawBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
		if (role === "user") {
			if (entry.meta?.isMeta) continue;
			for (const block of blocks) {
				if (block.type === "text" && block.text) {
					updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } });
				} else if (block.type === "image" && block.source) {
					const image: ContentBlock = { type: "image", data: block.source.data, mimeType: block.source.media_type };
					updates.push({ sessionUpdate: "user_message_chunk", content: image });
				}
			}
		} else if (role === "assistant") {
			for (const block of blocks) {
				if (block.type === "text" && block.text) {
					updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
				} else if (block.type === "thinking" && block.thinking) {
					updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
				} else if (block.type === "tool_use" && block.id && block.name) {
					const result = results.get(block.id);
					const text = resultText(result);
					const contents: ToolContent[] = [
						...diffFor(block.name, block.input),
						...(text ? [{ type: "content", content: { type: "text", text } } as ToolContent] : []),
					];
					const path = str(block.input, "file_path") ?? str(block.input, "path");
					updates.push({
						sessionUpdate: "tool_call",
						toolCallId: block.id,
						title: titleFor(block.name, block.input),
						kind: KIND[block.name] ?? "other",
						status: result ? (result.is_error ? "failed" : "completed") : "failed",
						rawInput: block.input,
						...(contents.length ? { content: contents } : {}),
						...(path && KIND[block.name] !== "search" ? { locations: [{ path }] } : {}),
					});
					const plan = block.name === "todo_write" ? planFrom(block.input) : null;
					if (plan) updates.push({ sessionUpdate: "plan", entries: plan });
				}
			}
		}
	}
	return updates;
}
