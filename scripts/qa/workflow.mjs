// Run with: bun scripts/qa/workflow.mjs. No LLM, filesystem changes or timers.
import assert from "node:assert/strict";
import { createWorkflow, executeWorkflow, learningCandidates, parseVerification } from "../../src/workflow.ts";
import { applyUlwTool, layoutUlw } from "../../src/ui/dag.ts";
import { usageOf } from "../../src/billing.ts";
import { transcriptMarkdown } from "../../src/acp/transcript.ts";

/** A verifier result with a tool call the app saw complete in its session. */
const ran = (verdict) => ({ output: JSON.stringify(verdict), receipts: ["execute: pnpm test"] });

const receipts = [];
for (const kind of ["research", "team", "build", "taste"]) {
	const run = createWorkflow(kind, "Compare SQLite and DuckDB for local research", "Prefer measured changes", 2);
	const calls = [];
	await executeWorkflow(run, async (node) => {
		calls.push(node.id);
		if (node.id.startsWith("verify-")) return ran({ passed: true, evidence: ["transport receipt"], issues: [] });
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
	? ran({ passed: node.id === "verify-2", evidence: ["receipt"], issues: node.id === "verify-1" ? ["missing check"] : [] })
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

// A verdict is model text; without a tool call the app saw complete it does not pass.
const forged = createWorkflow("taste", "goal", "", 1);
await executeWorkflow(forged, async (node) => node.id.startsWith("verify-")
	? '{"passed":true,"evidence":["I claim all tests passed"],"issues":[]}'
	: "result", () => undefined, new AbortController().signal);
assert.equal(forged.status, "failed");
assert.match(forged.verification, /명령 실행 기록이 없습니다/);
// Coding runs need a command; a read alone is not a test run. Research takes any tool.
const verdict = '{"passed":true,"evidence":["ok"],"issues":[]}';
assert.equal(parseVerification(verdict, ["read: README.md"], ["execute"]).passed, false);
assert.equal(parseVerification(verdict, ["read: README.md"], null).passed, true);
assert.equal(parseVerification("```json\n" + verdict + "\n```", ["execute: pnpm test"], ["execute"]).passed, true);
receipts.push({ scenario: "forged-verdict-rejected", status: forged.status });

// A correction invalidates the first reflection; only the repair's lessons are offered.
const stale = createWorkflow("taste", "goal", "", 2);
await executeWorkflow(stale, async (node) => {
	if (node.id === "reflect") return '{"lessons":["v1-only technique"]}';
	if (node.id === "reflect-2") return '{"lessons":["v2 technique"]}';
	if (node.id.startsWith("verify-")) return ran({ passed: node.id === "verify-2", evidence: ["r"], issues: node.id === "verify-1" ? ["drop v1"] : [] });
	return "result";
}, () => undefined, new AbortController().signal);
assert.equal(stale.status, "passed");
assert.deepEqual(learningCandidates(stale), ["v2 technique"]);
assert.deepEqual(stale.nodes.find((node) => node.id === "verify-2").dependsOn, ["reflect-2"]);
receipts.push({ scenario: "stale-reflection-replaced", candidates: learningCandidates(stale) });

// Past its reset time a usage window is empty again, even on an old billing answer.
const billing = { planId: null, monthlyCredits: 0, purchasedCredits: 5, freeCredits: 0, periodEnd: null,
	windowLimits: { fiveHour: { used: 10, cap: 10, resetAt: 1_000 }, weekly: { used: 3, cap: 10, resetAt: 9_000 } } };
// resetAt is in seconds (the API's unit); `now` in milliseconds.
const usage = usageOf(billing, 5_000_000);
assert.equal(usage.windows[0].exceeded, false);
assert.equal(usage.windows[0].used, 0);
assert.equal(usage.windows[1].used, 3);
assert.equal(usage.exceeded, null);
assert.equal(usageOf(billing, 500_000).exceeded?.label, "5시간");
receipts.push({ scenario: "usage-window-reset" });

const markdown = transcriptMarkdown([
	{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "테스트 돌려 줘" } },
	{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret thinking" } },
	{ sessionUpdate: "tool_call", toolCallId: "1", title: "Shell: pnpm test", kind: "execute", status: "completed", rawInput: { command: "pnpm test" } },
	{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "모두 통과했습니다." } },
], "대화");
assert.match(markdown, /^# 대화\n\n## 사용자\n\n테스트 돌려 줘\n\n## 에이전트\n\n- 도구 · Shell: pnpm test\n/);
assert.match(markdown, /```sh\n  pnpm test\n  ```\n\n모두 통과했습니다.\n$/);
assert.doesNotMatch(markdown, /secret thinking/);
receipts.push({ scenario: "markdown-export" });
console.log(JSON.stringify({ passed: true, receipts }, null, 2));
