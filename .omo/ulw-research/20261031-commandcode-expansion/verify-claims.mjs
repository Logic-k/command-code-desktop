import assert from "node:assert/strict";
import { createWorkflow, executeWorkflow, learningCandidates, parseVerification } from "../../../src/workflow.ts";

const observations = [];

// Counterexample: syntactically valid model evidence is not an execution receipt.
const forged = createWorkflow("taste", "Demonstrate evidence boundary", "", 1);
await executeWorkflow(forged, async (node) => {
	if (node.id.startsWith("verify-")) {
		return '{"passed":true,"evidence":["I claim all tests passed, without executing anything"],"issues":[]}';
	}
	if (node.id === "reflect") return '{"lessons":["An unsupported preference with no source receipt"]}';
	return "A synthetic result; no tool was executed.";
}, () => undefined, new AbortController().signal);
assert.equal(forged.status, "passed");
assert.equal(learningCandidates(forged).length, 1);
observations.push({
	id: "V-PROOF",
	verdict: "confirmed-gap",
	observed: "The current runner accepts a forged textual verifier receipt and exposes an unsupported learning candidate.",
	implication: "Keep agent verdict separate from deterministic command/source/artifact checks and approved learning provenance.",
});

assert.equal(parseVerification('{"passed":true,"evidence":[],"issues":[]}').passed, false);
assert.throws(() => parseVerification("not-json"));
observations.push({
	id: "V-STRUCTURE",
	verdict: "confirmed-existing-guard",
	observed: "Malformed JSON throws and an empty evidence array does not pass.",
	implication: "Retain these guards; a stronger evidence model extends rather than replaces them.",
});

// Subscribe before triggering the failure; no sleeps, polling or timing luck.
const wave = createWorkflow("team", "Observe sibling cancellation", "", 1);
const barrier = Promise.withResolvers();
let started = 0;
let cancelledSiblings = 0;
const startedIds = [];
await executeWorkflow(wave, async (node, _prompt, signal) => {
	startedIds.push(node.id);
	started += 1;
	if (started === 3) barrier.resolve();
	await barrier.promise;
	if (node.id === "sources") throw new Error("Controlled source-node failure");
	return new Promise((_resolve, reject) => {
		const abort = () => { cancelledSiblings += 1; reject(signal.reason); };
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}, () => undefined, new AbortController().signal);
assert.equal(wave.status, "failed");
assert.equal(cancelledSiblings, 2);
assert.equal(wave.nodes.some((node) => node.status === "running"), false);
assert.equal(startedIds.includes("critique"), false);
observations.push({
	id: "V-CANCEL",
	verdict: "confirmed-existing-guard",
	observed: "Controlled peer failure cancels sibling executors and no dependent critique starts.",
	implication: "Preserve settlement semantics while adding provider-level acknowledgement, deadlines and restart recovery.",
});

const stale = createWorkflow("taste", "Observe stale reflection after correction", "", 2);
await executeWorkflow(stale, async (node) => {
	if (node.id === "reflect") return '{"lessons":["v1-only technique invalidated by correction"]}';
	if (node.id.startsWith("verify-")) return JSON.stringify({
		passed: node.id === "verify-2",
		evidence: [node.id === "verify-2" ? "v2 synthetic receipt" : "v1 synthetic receipt"],
		issues: node.id === "verify-1" ? ["Remove the v1-only technique"] : [],
	});
	if (node.id === "correct-2") return "v2 implementation removed the v1-only technique.";
	return "v1 synthetic implementation.";
}, () => undefined, new AbortController().signal);
assert.equal(stale.status, "passed");
assert.deepEqual(learningCandidates(stale), ["v1-only technique invalidated by correction"]);
observations.push({
	id: "V-STALE",
	verdict: "confirmed-gap",
	observed: "The original reflection remains eligible after a correction invalidates its technique and the second verifier passes.",
	implication: "Bind learning to the final artifact/attempt revision and invalidate or re-evaluate older candidates.",
});

console.log(JSON.stringify({ boundary: "local executor only, no live LLM or Rust stdio", observations }, null, 2));
