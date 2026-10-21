// Line diff for tool-call `diff` content. Command Code sends whole files for
// write_file (oldText null) and old/new snippets for edit_file, so inputs are
// usually small; a plain LCS table is enough and stays readable.

import { h } from "./dom";

type Op = { kind: " " | "-" | "+"; text: string; oldNo?: number; newNo?: number };

/** Above this many table cells the diff degrades to "all removed, all added". */
const MAX_CELLS = 2_000_000;
const CONTEXT = 3;

function diffLines(oldLines: string[], newLines: string[]): Op[] {
	const n = oldLines.length;
	const m = newLines.length;
	if (n * m > MAX_CELLS) {
		return [
			...oldLines.map((text, i): Op => ({ kind: "-", text, oldNo: i + 1 })),
			...newLines.map((text, i): Op => ({ kind: "+", text, newNo: i + 1 })),
		];
	}
	const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			table[i][j] =
				oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			ops.push({ kind: " ", text: oldLines[i], oldNo: i + 1, newNo: j + 1 });
			i += 1;
			j += 1;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			ops.push({ kind: "-", text: oldLines[i], oldNo: i + 1 });
			i += 1;
		} else {
			ops.push({ kind: "+", text: newLines[j], newNo: j + 1 });
			j += 1;
		}
	}
	while (i < n) ops.push({ kind: "-", text: oldLines[i], oldNo: ++i });
	while (j < m) ops.push({ kind: "+", text: newLines[j], newNo: ++j });
	return ops;
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export interface DiffStats {
	added: number;
	removed: number;
}

export function diffStats(oldText: string | null, newText: string): DiffStats {
	const ops = diffLines(oldText === null ? [] : splitLines(oldText), splitLines(newText));
	return {
		added: ops.filter((op) => op.kind === "+").length,
		removed: ops.filter((op) => op.kind === "-").length,
	};
}

/** A unified diff with collapsed unchanged runs. */
export function renderDiff(oldText: string | null, newText: string): HTMLElement {
	const ops = diffLines(oldText === null ? [] : splitLines(oldText), splitLines(newText));
	const keep = new Uint8Array(ops.length);
	ops.forEach((op, index) => {
		if (op.kind === " ") return;
		for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k += 1) keep[k] = 1;
	});

	const rows: HTMLElement[] = [];
	let skipped = 0;
	const flushSkip = () => {
		if (skipped > 0) rows.push(h("div", { class: "diff-row diff-skip" }, `⋯ 변경 없는 ${skipped}줄`));
		skipped = 0;
	};
	ops.forEach((op, index) => {
		if (!keep[index]) {
			skipped += 1;
			return;
		}
		flushSkip();
		const cls = op.kind === "+" ? "diff-add" : op.kind === "-" ? "diff-del" : "diff-ctx";
		rows.push(
			h(
				"div",
				{ class: `diff-row ${cls}` },
				h("span", { class: "diff-no" }, op.oldNo ?? ""),
				h("span", { class: "diff-no" }, op.newNo ?? ""),
				h("span", { class: "diff-sign" }, op.kind),
				h("span", { class: "diff-text" }, op.text),
			),
		);
	});
	flushSkip();
	return h("div", { class: "diff" }, rows);
}
