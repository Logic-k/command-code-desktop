// Agent Client Protocol shapes, as `cmd acp` (command-code 1.86) actually sends
// them. Spec: https://agentclientprotocol.com/protocol/schema

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string; uri?: string }
	| { type: "resource_link"; uri: string; name: string; mimeType?: string }
	| { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };

export type ToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolContent =
	| { type: "content"; content: ContentBlock }
	| { type: "diff"; path: string; oldText: string | null; newText: string }
	| { type: "terminal"; terminalId: string };

export interface ToolCall {
	toolCallId: string;
	title?: string;
	kind?: ToolKind;
	status?: ToolStatus;
	content?: ToolContent[];
	locations?: { path: string; line?: number | null }[];
	rawInput?: unknown;
}

export interface PlanEntry {
	content: string;
	priority: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
}

export interface AvailableCommand {
	name: string;
	description: string;
	input?: { hint: string } | null;
}

export interface SessionMode {
	id: string;
	name: string;
	description?: string;
}

export interface ConfigOption {
	id: string;
	name: string;
	category?: string;
	type: "select" | "boolean";
	currentValue: string | boolean;
	options?: { value: string; name: string; description?: string }[];
}

export type SessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
	| ({ sessionUpdate: "tool_call" } & ToolCall)
	| ({ sessionUpdate: "tool_call_update" } & ToolCall)
	| { sessionUpdate: "plan"; entries: PlanEntry[] }
	| { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
	| { sessionUpdate: "session_info_update"; title?: string | null }
	| { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
	| { sessionUpdate: "notice"; title: string; severity?: string; description?: string };

export interface SessionState {
	sessionId: string;
	modes?: { currentModeId: string; availableModes: SessionMode[] };
	configOptions?: ConfigOption[];
}

export interface SessionInfo {
	sessionId: string;
	cwd: string;
	title: string | null;
	updatedAt: string | null;
}

export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: PermissionKind | string;
}

export interface PermissionRequest {
	sessionId: string;
	toolCall: ToolCall;
	options: PermissionOption[];
	/** Set when the CLI flags the call as risky; it then offers no "always"
	 * options and asks even in bypass mode. */
	_meta?: { risk?: { kind: string; detail?: string } };
}

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface PromptResult {
	stopReason: StopReason;
	usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
}

export interface InitializeResult {
	protocolVersion: number;
	agentCapabilities: {
		loadSession?: boolean;
		promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
		sessionCapabilities?: { list?: object; resume?: object; close?: object };
	};
	agentInfo?: { name: string; version: string };
}

/** Mirrors `launch::Launch` in src-tauri/src/launch.rs. */
export interface Launch {
	program: string;
	prefix_args: string[];
	via: string;
	entry: string | null;
	version: string | null;
}
