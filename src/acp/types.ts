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
	/** v2 names the same field `configId`; normalized into `id` on receipt. */
	configId?: string;
	name: string;
	category?: string;
	type: "select" | "boolean";
	currentValue: string | boolean;
	options?: { value: string; name: string; description?: string }[];
}

/** v2 renamed the option key `id`→`configId`; fold it into `id` so every
 * consumer keeps reading one field. */
export function normalizeConfigOptions(list: ConfigOption[] | undefined): ConfigOption[] {
	return (list ?? []).map((option) => ({ ...option, id: option.id ?? option.configId ?? option.name }));
}

export type SessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
	// v2: whole messages upserted by id instead of streamed chunks.
	| { sessionUpdate: "user_message"; messageId: string; content: ContentBlock[] }
	| { sessionUpdate: "agent_message"; messageId: string; content: ContentBlock[] }
	| { sessionUpdate: "agent_thought"; messageId: string; content: ContentBlock[] }
	| ({ sessionUpdate: "tool_call" } & ToolCall)
	| ({ sessionUpdate: "tool_call_update" } & ToolCall)
	| { sessionUpdate: "tool_call_content_chunk"; toolCallId: string; content: ContentBlock }
	| { sessionUpdate: "plan"; entries: PlanEntry[] }
	// v2 names the same event `plan_update` and may scope it to a plan id.
	| { sessionUpdate: "plan_update"; planId?: string; title?: string; entries: PlanEntry[] }
	| { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
	| { sessionUpdate: "session_info_update"; title?: string | null }
	| { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
	// v2 foreground state: "running" | "requires_action" | "idle" (with stopReason
	// when foreground work ends); background activity may be listed separately.
	| { sessionUpdate: "state_update"; state: string; stopReason?: StopReason | string | null; backgroundTasks?: unknown[] }
	// v2 display-only terminals owned by the agent itself.
	| { sessionUpdate: "terminal_update"; terminalId: string; toolCallId?: string; title?: string; status?: string }
	| { sessionUpdate: "terminal_output_chunk"; terminalId: string; data: string }
	| { sessionUpdate: "notice"; title: string; severity?: string; description?: string };
// Forward compatibility: an agent newer than this build may still send update
// kinds this union does not name; handlers ignore them, never crash.

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
		mcpCapabilities?: { http?: boolean; sse?: boolean };
		sessionCapabilities?: { list?: object; resume?: object; close?: object; delete?: object };
		/** v2: agent-owned display terminals (`terminal_update`). */
		terminal?: object;
	};
	/** Non-empty means `auth/login`/`auth/logout` exist (v2). v2 spells the
	 * key `methodId`; the client normalizes both into `id`. */
	authMethods?: { id?: string; methodId?: string; name: string; description?: string }[];
	agentInfo?: { name: string; version: string };
}

// --- elicitation/create (v2): structured questions from the agent ---

export type ElicitationProperty =
	| { type: "string"; title?: string; description?: string; enum?: string[]; oneOf?: { const: string; title?: string }[]; default?: string; minLength?: number; maxLength?: number; pattern?: string; format?: string }
	| { type: "number" | "integer"; title?: string; description?: string; default?: number; minimum?: number; maximum?: number }
	| { type: "boolean"; title?: string; description?: string; default?: boolean }
	| { type: "array"; title?: string; description?: string; items?: { type: string; enum?: string[]; anyOf?: { const: string; title?: string }[] }; default?: string[]; minItems?: number; maxItems?: number };

export interface ElicitationSchema {
	type: "object";
	title?: string;
	description?: string;
	properties?: Record<string, ElicitationProperty>;
	required?: string[];
}

export interface ElicitationRequest {
	/** Session scope, or `requestId` for a request-scoped interaction. */
	sessionId?: string;
	requestId?: number | string;
	toolCallId?: string;
	mode: "form" | "url";
	message?: string;
	/** form mode */
	requestedSchema?: ElicitationSchema;
	/** url mode */
	elicitationId?: string;
	url?: string;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationOutcome {
	action: ElicitationAction;
	content?: Record<string, unknown>;
}

/** Mirrors `launch::Launch` in src-tauri/src/launch.rs. */
export interface Launch {
	program: string;
	prefix_args: string[];
	via: string;
	entry: string | null;
	version: string | null;
}
