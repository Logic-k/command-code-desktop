// Ultrawork (ULW) run state for the desktop app.
//
// `~/.commandcode/mods/ulw.ts` owns the run and draws its DAG inside the TUI.
// ACP carries only tool calls, so the graph is rebuilt here from `ulw_plan`,
// `ulw_node`, `ulw_verify` and the `agent` calls those tools dispatch. The same
// reducer runs over replayed transcripts, so reopening a chat restores the graph.

import type { ToolCall } from "../acp/types";
import { h } from "./dom";

export type UlwNodeStatus = "pending" | "running" | "done" | "failed";
export type UlwPhase = "fanout" | "verify" | "done";
export type UlwToolKind = "plan" | "node" | "verify" | "agent";

export interface UlwNode {
	id: string;
	role: string;
	label: string;
	status: UlwNodeStatus;
	dependsOn: string[];
	note?: string;
	/** The `agent` tool call this node is running as. */
	callId?: string;
	/** Launched with run_in_background: its tool call returns before it does. */
	background?: boolean;
}

export interface UlwRun {
	objective: string;
	phase: UlwPhase;
	nodes: UlwNode[];
	verifierPassed: boolean;
	/** The `ulw_plan` call that built this graph; its completion must not rebuild it. */
	planCallId: string;
}

const NODE_W = 216;
const NODE_H = 88;
const GAP_X = 46;
const GAP_Y = 12;
const PAD = 2;
const STATUSES = new Set<string>(["pending", "running", "done", "failed"]);

function inputOf(tool: ToolCall): Record<string, unknown> | null {
	const raw = tool.rawInput;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function statusOf(value: unknown): UlwNodeStatus | null {
	const status = text(value);
	return status && STATUSES.has(status) ? (status as UlwNodeStatus) : null;
}

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Which ULW tool this call is, recognised by its input (titles differ between
 * live ACP and replayed transcripts). */
export function ulwToolKind(tool: ToolCall): UlwToolKind | null {
	const input = inputOf(tool);
	if (!input) return null;
	if (Array.isArray(input.nodes)) return "plan";
	if (text(input.id) !== undefined && statusOf(input.status)) return "node";
	if (typeof input.passed === "boolean") return "verify";
	if (text(input.subagent_type) !== undefined) return "agent";
	return null;
}

/** Merge one tool call into the run. Returns the same object when nothing changed. */
export function applyUlwTool(run: UlwRun | null, tool: ToolCall): UlwRun | null {
	const kind = ulwToolKind(tool);
	const input = inputOf(tool);
	if (!kind || !input) return run;
	if (kind === "plan") return applyPlan(run, tool, input);
	if (!run) return null;

	const next = clone(run);
	if (kind === "node") applyNode(next, input);
	else if (kind === "verify") applyVerify(next, input);
	else applyAgent(next, tool, input);
	finishPhase(next);
	return next;
}

function clone(run: UlwRun): UlwRun {
	return { ...run, nodes: run.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })) };
}

function applyPlan(run: UlwRun | null, tool: ToolCall, input: Record<string, unknown>): UlwRun {
	if (run?.planCallId === tool.toolCallId) return run;
	const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
	const seen = new Set<string>();
	const nodes: UlwNode[] = [];
	rawNodes.forEach((raw, index) => {
		if (!raw || typeof raw !== "object") return;
		const value = raw as Record<string, unknown>;
		let id = text(value.id)?.trim() || `node-${index + 1}`;
		while (seen.has(id)) id = `${id}-${index + 1}`;
		seen.add(id);
		nodes.push({
			id,
			role: text(value.role)?.trim() || "ulw-worker",
			label: text(value.label)?.trim() || "",
			status: statusOf(value.status) ?? "pending",
			dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [],
		});
	});
	const objective = text(input.objective)?.trim();
	return {
		objective: objective ?? run?.objective ?? "",
		phase: "fanout",
		nodes,
		verifierPassed: false,
		planCallId: tool.toolCallId,
	};
}

function applyNode(run: UlwRun, input: Record<string, unknown>): void {
	const id = text(input.id);
	const status = statusOf(input.status);
	if (!id || !status) return;
	const node = run.nodes.find((item) => item.id === id);
	if (!node) return;
	node.status = status;
	const note = text(input.note)?.trim();
	if (note) node.note = clip(note, 200);
}

function applyVerify(run: UlwRun, input: Record<string, unknown>): void {
	const passed = input.passed === true;
	run.verifierPassed = passed;
	run.phase = passed ? "done" : "verify";
	const evidence = text(input.evidence)?.trim();
	const verifier = [...run.nodes].reverse().find((node) => node.role.includes("verifier"));
	if (!verifier) return;
	verifier.status = passed ? "done" : "failed";
	if (evidence) verifier.note = clip(evidence, 240);
}

function applyAgent(run: UlwRun, tool: ToolCall, input: Record<string, unknown>): void {
	const role = text(input.subagent_type)?.trim() || "subagent";
	const description = text(input.description)?.trim() || "";
	const background = input.run_in_background === true;

	let node = run.nodes.find((item) => item.callId === tool.toolCallId);
	if (!node) {
		const free = run.nodes.filter((item) => !item.callId && item.status === "pending");
		node = free.find((item) => item.role === role) ?? free.find((item) => overlaps(item.label, description));
		if (!node) {
			node = {
				id: nextAutoId(run.nodes),
				role,
				label: description || "(unplanned)",
				status: "running",
				dependsOn: [],
				callId: tool.toolCallId,
				background,
			};
			run.nodes.push(node);
		}
		node.callId = tool.toolCallId;
		node.background = background;
	}
	if (node.status === "pending") node.status = "running";
	if (run.phase === "verify" && !run.verifierPassed) run.phase = "fanout";

	const status = tool.status as string | undefined;
	if (status === "failed") {
		node.status = "failed";
		return;
	}
	if (status === "cancelled") {
		if (!node.background) {
			node.status = "failed";
			node.note ??= "취소됨";
		}
		return;
	}
	if (status === "completed") {
		if (!node.background) node.status = "done";
		return;
	}
	if (node.status === "failed") node.status = "running";
}

function finishPhase(run: UlwRun): void {
	if (!run.nodes.length) return;
	if (run.verifierPassed) {
		run.phase = "done";
		return;
	}
	if (run.phase === "verify") return;
	if (run.nodes.every((node) => node.status === "done")) run.phase = "verify";
}

function nextAutoId(nodes: UlwNode[]): string {
	let index = nodes.length + 1;
	while (nodes.some((node) => node.id === `auto-${index}`)) index += 1;
	return `auto-${index}`;
}

function words(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^a-z0-9가-힣]+/)
			.filter((word) => word.length >= 3),
	);
}

/** "add sessions table" matches "Add sessions table + migration" without
 * depending on the model repeating a node id. */
function overlaps(label: string, description: string): boolean {
	const left = words(label);
	if (!left.size) return false;
	for (const word of words(description)) if (left.has(word)) return true;
	return false;
}

export interface DagBox {
	node: UlwNode;
	x: number;
	y: number;
}

export interface DagEdge {
	from: string;
	to: string;
	d: string;
	tone: "idle" | "active" | "done" | "failed";
}

export interface DagLayout {
	width: number;
	height: number;
	boxes: DagBox[];
	edges: DagEdge[];
}

/** One column per dependency depth, nodes in a column stacked and centred. */
export function layoutUlw(run: UlwRun): DagLayout {
	const byId = new Map(run.nodes.map((node) => [node.id, node]));
	const depth = new Map<string, number>();
	const depthOf = (id: string, seen: Set<string>): number => {
		const cached = depth.get(id);
		if (cached !== undefined) return cached;
		if (seen.has(id)) return 0;
		seen.add(id);
		let value = 0;
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (!byId.has(dep)) continue;
			value = Math.max(value, depthOf(dep, seen) + 1);
		}
		seen.delete(id);
		depth.set(id, value);
		return value;
	};
	for (const node of run.nodes) depthOf(node.id, new Set());

	const columns = new Map<number, UlwNode[]>();
	for (const node of run.nodes) {
		const value = depth.get(node.id) ?? 0;
		const column = columns.get(value) ?? [];
		column.push(node);
		columns.set(value, column);
	}
	const maxDepth = columns.size ? Math.max(...columns.keys()) : 0;
	const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
	const width = PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * GAP_X;
	const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;

	const boxes: DagBox[] = [];
	const at = new Map<string, DagBox>();
	for (const [columnIndex, column] of columns) {
		const columnHeight = column.length * NODE_H + (column.length - 1) * GAP_Y;
		const top = PAD + (height - PAD * 2 - columnHeight) / 2;
		column.forEach((node, row) => {
			const box = { node, x: PAD + columnIndex * (NODE_W + GAP_X), y: top + row * (NODE_H + GAP_Y) };
			boxes.push(box);
			at.set(node.id, box);
		});
	}

	const edges: DagEdge[] = [];
	for (const box of boxes) {
		for (const dep of box.node.dependsOn) {
			const from = at.get(dep);
			if (!from) continue;
			const x1 = from.x + NODE_W;
			const y1 = from.y + NODE_H / 2;
			const x2 = box.x;
			const y2 = box.y + NODE_H / 2;
			const bend = Math.max(18, (x2 - x1) / 2);
			const tone: DagEdge["tone"] =
				box.node.status === "failed"
					? "failed"
					: box.node.status === "done" && from.node.status === "done"
						? "done"
						: box.node.status === "running" || from.node.status === "running"
							? "active"
							: "idle";
			edges.push({
				from: dep,
				to: box.node.id,
				d: `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
				tone,
			});
		}
	}
	return { width, height, boxes, edges };
}

export function renderUlwCanvas(run: UlwRun, select?: (node: UlwNode) => void): HTMLElement {
	if (!run.nodes.length) return h("div", { class: "dag-empty" }, "계획 등록을 기다리는 중…");
	const layout = layoutUlw(run);
	const canvas = h("div", {
		class: "dag-canvas",
		style: `width:${layout.width}px;height:${layout.height}px`,
	});

	const NS = "http://www.w3.org/2000/svg";
	const edges = document.createElementNS(NS, "svg");
	edges.setAttribute("class", "dag-edges");
	edges.setAttribute("width", String(layout.width));
	edges.setAttribute("height", String(layout.height));
	edges.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
	for (const edge of layout.edges) {
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", edge.d);
		path.setAttribute("class", `dag-edge ${edge.tone}`);
		edges.appendChild(path);
	}
	canvas.appendChild(edges);

	for (const { node, x, y } of layout.boxes) {
		const title = [
			`${node.id} · ${node.role}`,
			node.label,
			node.note,
			node.dependsOn.length ? `after ${node.dependsOn.join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n");
		canvas.appendChild(
			h(
				"button",
				{
					class: `dag-node st-${node.status}`,
					type: "button",
					"aria-label": `${node.id}: ${node.label} (${node.status})`,
					onclick: () => select?.(node),
					style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px`,
					title,
					"data-node": node.id,
				},
				h(
					"div",
					{ class: "dag-node-top" },
					h("span", { class: "dag-dot" }),
					h("span", { class: "dag-id" }, node.id),
					h("span", { class: "dag-role" }, node.role.replace(/^ulw-/, "")),
				),
				h("div", { class: "dag-label" }, node.label || "(제목 없음)"),
				node.note
					? h("div", { class: "dag-note" }, node.note)
					: node.dependsOn.length
						? h("div", { class: "dag-note" }, `after ${node.dependsOn.join(", ")}`)
						: null,
			),
		);
	}
	return canvas;
}
