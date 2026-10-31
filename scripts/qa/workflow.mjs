// Run with: bun scripts/qa/workflow.mjs. No LLM, filesystem changes or timers.
import assert from "node:assert/strict";
import { createWorkflow, executeWorkflow, learningCandidates, parseVerification } from "../../src/workflow.ts";
import { applyUlwTool, layoutUlw } from "../../src/ui/dag.ts";

const receipts = [];
for (const kind of ["research", "team", "build", "taste"]) {
	const run = createWorkflow(kind, "Compare SQLite and DuckDB for local research", "Prefer measured changes", 2);
	const calls = [];
	await executeWorkflow(run, async (node) => {
		calls.push(node.id);
		if (node.id.startsWith("verify-")) return JSON.stringify({ passed: true, evidence: ["transport receipt"], issues: [] });
		if (node.id === "reflect") return JSON.stringify({ lessons: ["measured workflow receipt"] });
		return `${node.id} result`;
	}, () => undefined, new AbortController().signal);
	assert.equal(run.status, "passed");
	assert.equal(new Set(calls).size, run.nodes.length);
	assert.equal(run.nodes.some((node) => !node.readOnly), kind === "build" || kind === "taste");
	assert.equal(learningCandidates(run).length, kind === "build" || kind === "taste" ? 1 : 0);
	receipts.push({ scenario: kind, status: run.status, nodes: calls });
}
assert.throws(() => createWorkflow("research", " ", "", 1));
assert.throws(() => createWorkflow("research", "goal", "", 0));
assert.equal(parseVerification('{"passed":true,"evidence":[],"issues":[]}').passed, false);
assert.throws(() => parseVerification("not-json"));

const retry = createWorkflow("build", "goal", "", 2);
await executeWorkflow(retry, async (node) => node.id.startsWith("verify-")
	? JSON.stringify({ passed: node.id === "verify-2", evidence: ["receipt"], issues: node.id === "verify-1" ? ["missing check"] : [] })
	: "result", () => undefined, new AbortController().signal);
assert.equal(retry.status, "passed");
assert.equal(retry.iteration, 2);
assert.equal(retry.nodes.find((node) => node.id === "verify-1").status, "failed");
assert.equal(layoutUlw(retry).edges.some((edge) => edge.from === "verify-1" && edge.to === "correct-2"), true);
receipts.push({ scenario: "failed-verification-retry", status: retry.status, iteration: retry.iteration });

const malformed = createWorkflow("research", "goal", "", 2);
await executeWorkflow(malformed, async (node) => node.id.startsWith("verify-") ? "{}" : "result",
	() => undefined, new AbortController().signal);
assert.equal(malformed.status, "failed");
assert.equal(malformed.nodes.find((node) => node.id === "verify-1").status, "failed");
assert.equal(malformed.nodes.some((node) => node.id === "correct-2"), false);
receipts.push({ scenario: "malformed-verdict-stops", status: malformed.status });

const cancel = createWorkflow("team", "goal", "", 2);
const abort = new AbortController();
await executeWorkflow(cancel, async () => { abort.abort(); return "result"; }, () => undefined, abort.signal);
assert.equal(cancel.status, "cancelled");
assert.equal(cancel.nodes.some((node) => node.status === "running"), false);
receipts.push({ scenario: "cancelled", status: cancel.status });

let legacy = applyUlwTool(null, { toolCallId: "plan", rawInput: { objective: "legacy", nodes: [{ id: "worker" }] } });
legacy = applyUlwTool(legacy, { toolCallId: "node", rawInput: { id: "worker", status: "done" } });
assert.equal(legacy.nodes[0].status, "done");
assert.equal(legacy.phase, "verify");
receipts.push({ scenario: "legacy-replay", phase: legacy.phase });
const learned = createWorkflow("taste", "goal", "", 1);
learned.nodes.find((node) => node.id === "reflect").output = '{"lessons":["candidate"]}';
assert.deepEqual(learningCandidates(learned), []);
receipts.push({ scenario: "unverified-learning-not-promoted", status: learned.status });
console.log(JSON.stringify({ passed: true, receipts }, null, 2));
