// Run with: bun scripts/qa/workflow.mjs. No LLM, filesystem changes or timers.
import assert from "node:assert/strict";
import { campaignSlug, createWorkflow, executeWorkflow, learningCandidates, nodePrompt, parseLedger, parseVerification,
	RESEARCH_TYPES, researchFiles, runLedger } from "../../src/workflow.ts";
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
// Seen live: the verifier narrates before (and after) the verdict, with braces in strings.
const narrated = `I'll independently verify.Core facts confirmed {not json}.{"passed":true,"evidence":["crates.io {\\"v\\":1} ok"],"issues":[]}Done.`;
assert.equal(parseVerification(narrated, ["fetch: crates.io"], null).passed, true);
assert.equal(parseVerification(`첫 판정 {"passed":true,"evidence":["a"],"issues":[]} 재확인 {"passed":false,"evidence":["b"],"issues":["c"]}`, ["read: x"], null).passed, false);
assert.throws(() => parseVerification("I could not finish {draft"), /JSON 판정을 찾지 못했습니다/);
// Fail-closed: a malformed final verdict is not replaced by an earlier passing draft.
assert.throws(() => parseVerification('1차: {"passed":true,"evidence":["build ok"],"issues":[]} 최종: {"passed":false,"evidence":["cargo test: "x" failed"],"issues":["실패"]}',
	["execute: cargo test"], ["execute"]), /JSON 판정을 찾지 못했습니다/);
// Seen live (DeepSeek V4 Flash): a raw newline element between evidence items.
const liveVerdict = parseVerification('검증 완료.\n\n{"passed":true,"evidence":["crates.io 200","\n","LICENSE-MIT 200"],"issues":[]}', ["fetch: crates.io"], null);
assert.equal(liveVerdict.passed, true);
assert.deepEqual(liveVerdict.evidence, ["crates.io 200", "LICENSE-MIT 200"]);
assert.equal(parseVerification('{"passed":true,"evidence":["\n"],"issues":[]}', ["fetch: x"], null).passed, false);
// A nested look-alike does not replace the verdict around it.
assert.equal(parseVerification('판정 {"passed":true,"evidence":["ok"],"issues":[],"detail":{"passed":false}}', ["read: x"], null).passed, true);
// Every role prompt says no one will answer its questions.
assert.match(nodePrompt(createWorkflow("research", "goal", "", 1), createWorkflow("research", "goal", "", 1).nodes[0]), /사람이 지켜보지 않는 자동 실행/);
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
// A narrated reflection still offers its lessons.
const talky = createWorkflow("taste", "goal", "", 1);
await executeWorkflow(talky, async (node) => {
	if (node.id === "reflect") return 'Here are the lessons.\n{"lessons":["narrated lesson"]}\nThat is all.';
	if (node.id.startsWith("verify-")) return ran({ passed: true, evidence: ["r"], issues: [] });
	return "result";
}, () => undefined, new AbortController().signal);
assert.deepEqual(learningCandidates(talky), ["narrated lesson"]);
receipts.push({ scenario: "narrated-reflection" });

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

// Research brief: one researcher per selected type plus the red team, all feeding the critique.
const brief = { decision: "로컬 저장소 선택", types: ["R2", "R4"], constraints: ["Tauri 유지"], known: [], doneWhen: ["비교표"],
	maxSources: 20, campaign: "20261102-local-store" };
const briefRun = createWorkflow("team", "goal", "", 1, brief);
assert.deepEqual(briefRun.nodes.map((node) => node.id), ["type-r2", "type-r4", "risks", "critique", "synthesis", "verify-1"]);
assert.deepEqual(briefRun.nodes.find((node) => node.id === "critique").dependsOn, ["type-r2", "type-r4", "risks"]);
assert.equal(RESEARCH_TYPES.length, 12);
assert.match(briefRun.nodes[0].instruction, /조회일/);
assert.match(briefRun.nodes.find((node) => node.id === "risks").instruction, /스틸맨[\s\S]*프리모템/);
assert.match(nodePrompt(briefRun, briefRun.nodes[0]), /리서치 브리프 \(데이터\)[\s\S]*출처 예산: 최대 20개/);
assert.doesNotMatch(nodePrompt(createWorkflow("team", "goal", "", 1), briefRun.nodes[0]), /리서치 브리프/);
assert.deepEqual(createWorkflow("team", "goal", "", 1, { ...brief, types: [] }).nodes.map((node) => node.id),
	createWorkflow("team", "goal", "", 1).nodes.map((node) => node.id));
assert.throws(() => createWorkflow("research", "goal", "", 1, { ...brief, types: ["R2", "R2"] }), /리서치 유형/);
assert.throws(() => createWorkflow("research", "goal", "", 1, { ...brief, types: ["R13"] }), /리서치 유형/);
assert.throws(() => createWorkflow("research", "goal", "", 1, { ...brief, maxSources: 4 }), /출처 예산/);
assert.throws(() => createWorkflow("research", "goal", "", 1, { ...brief, campaign: " " }), /캠페인/);
for (const campaign of ["a/b", "notes.", "CON", "con", "aux.txt", "a:b", ".drafts", "..", "x".repeat(81)]) {
	assert.throws(() => createWorkflow("research", "goal", "", 1, { ...brief, campaign }), /캠페인/, campaign);
}
assert.doesNotThrow(() => createWorkflow("research", "goal", "", 1, { ...brief, campaign: "x".repeat(80) }));
assert.doesNotThrow(() => createWorkflow("research", "goal", "", 1, { ...brief, campaign: "console-한글 v1.2" }));
const tasteBrief = createWorkflow("taste", "goal", "", 1, brief);
assert.equal(tasteBrief.brief, null);
assert.equal(tasteBrief.nodes[0].id, "inspect");
receipts.push({ scenario: "brief-graph", nodes: briefRun.nodes.map((node) => node.id) });

// The ledger is the last fenced JSON amid prose; code, not the model, enforces the P1/P2 rule.
const ledgerJson = {
	claims: [
		{ id: "C1", text: "S1만 있는 주장", type: "R2", supports: ["s1", "ghost"], refutes: ["ghost"], status: "confirmed" },
		{ id: "C2", text: "공식 문서 근거", type: "R4", supports: ["p1"], refutes: [], status: "confirmed" },
		{ id: "C3", text: "", status: "reported" },
		{ id: "C4", text: "이상한 상태", supports: [], refutes: [], status: "maybe" },
	],
	sources: [
		{ id: "s1", url: "https://blog.example/post", title: "블로그", checkedAt: "2026-11-02", grade: "S1" },
		{ id: "p1", url: "https://docs.example", title: "문서", checkedAt: "2026-11-02", grade: "P1", query: "q", why: "w" },
		{ id: "bad", title: "URL 없음", grade: "P1" },
		{ id: "odd", url: "https://odd.example", grade: "Z" },
	],
	openQuestions: ["남은 질문", 3],
};
const ledgerText = `# 보고서\n\n\`\`\`json\n{"claims":[],"sources":[],"openQuestions":["old"]}\n\`\`\`\n\n결론 문장\n\n\`\`\`json\n${JSON.stringify(ledgerJson)}\n\`\`\`\n끝.`;
const ledger = parseLedger(ledgerText);
assert.equal(ledger.claims.find((claim) => claim.id === "C1").status, "reported");
assert.match(ledger.claims.find((claim) => claim.id === "C1").note, /P1\/P2 출처 없음/);
assert.deepEqual(ledger.claims.find((claim) => claim.id === "C1").supports, ["s1"]);
assert.deepEqual(ledger.claims.find((claim) => claim.id === "C1").refutes, []);
assert.equal(ledger.claims.find((claim) => claim.id === "C2").status, "confirmed");
assert.equal(ledger.claims.find((claim) => claim.id === "C4").status, "unknown");
assert.equal(ledger.claims.some((claim) => claim.id === "C3"), false);
assert.deepEqual(ledger.sources.map((source) => source.id), ["s1", "p1", "odd"]);
assert.equal(ledger.sources.find((source) => source.id === "odd").grade, "X");
assert.deepEqual(ledger.openQuestions, ["남은 질문"]);
assert.equal(parseLedger("보고서만 있고 장부 없음"), null);
assert.equal(parseLedger(JSON.stringify(ledgerJson)).claims.length, 3);
const fenced = `결론\n\`\`\`bash\nnpm test\n\`\`\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n보고\n\`\`\`JSON\n${JSON.stringify(ledgerJson)}\n\`\`\``;
assert.equal(parseLedger(fenced).claims.length, 3);
assert.equal(parseLedger(`\`\`\`bash\nnpm test\n\`\`\`\n\`\`\`json\n${JSON.stringify(ledgerJson)}\n\`\`\``).claims.length, 3);
// Seen in the live app: agent messages are joined without a separator, so the
// next message's text follows the closing fence on the same line.
assert.equal(parseLedger(`보고서\n\n\`\`\`json\n${JSON.stringify(ledgerJson)}\n\`\`\`The report and ledger are complete.`).claims.length, 3);
// Fail-closed: a malformed final ledger is not replaced by an example copied from the prompt.
const example = '{"claims":[{"id":"C1","text":"주장","type":"R4","supports":["src-1"],"refutes":[],"status":"confirmed"}],"sources":[{"id":"src-1","url":"https://...","title":"t","checkedAt":"d","grade":"P1"}],"openQuestions":[]}';
assert.equal(parseLedger(`형식은 ${example} 입니다.\n\n\`\`\`json\n{"claims":[{"id":"C1","text":"Tauri "offline" works"}],"sources":[],"openQuestions":[]}\n\`\`\``), null);
// An opener glued to prose pairs no fence; the last bare ledger object is still found.
assert.equal(parseLedger(`보고서 끝.\`\`\`json\n${JSON.stringify(ledgerJson)}\n\`\`\``).claims.length, 3);
receipts.push({ scenario: "ledger-status-enforced", claims: ledger.claims.map((claim) => `${claim.id}:${claim.status}`) });

// A passing verdict with receipts does not pass a brief run whose synthesis has no ledger.
const research = () => ({ output: JSON.stringify({ passed: true, evidence: ["read sources"], issues: [] }), receipts: ["read: report"] });
const noLedger = createWorkflow("research", "goal", "", 2, brief);
await executeWorkflow(noLedger, async (node) => {
	if (node.id.startsWith("verify-")) return research();
	if (node.id === "correct-2") {
		assert.match(node.instruction, /JSON 주장 장부를 다시 출력/);
		return `보고서\n\`\`\`json\n${JSON.stringify(ledgerJson)}\n\`\`\``;
	}
	return `${node.id} 보고서`;
}, () => undefined, new AbortController().signal);
assert.equal(noLedger.status, "passed");
assert.equal(noLedger.iteration, 2);
assert.equal(noLedger.nodes.find((node) => node.id === "verify-1").status, "failed");
assert.match(noLedger.nodes.find((node) => node.id === "verify-2").instruction, /P1 또는 P2/);
assert.equal(runLedger(noLedger).claims.length, 3);
const once = createWorkflow("research", "goal", "", 1, brief);
await executeWorkflow(once, async (node) => node.id.startsWith("verify-") ? research() : "보고서",
	() => undefined, new AbortController().signal);
assert.equal(once.status, "failed");
assert.match(once.verification, /주장 장부\(JSON\)가 없습니다/);
receipts.push({ scenario: "ledger-required", status: noLedger.status, iteration: noLedger.iteration });

assert.deepEqual(researchFiles(noLedger).map((file) => file.name),
	["brief.json", "sources.jsonl", "claims.jsonl", "open-questions.md", "verify.json", "report.md", "run.json"]);
assert.equal(researchFiles(noLedger).find((file) => file.name === "sources.jsonl").content.trim().split("\n").length, 3);
assert.deepEqual(JSON.parse(researchFiles(noLedger).find((file) => file.name === "verify.json").content).verifierReceipts, ["read: report"]);
assert.equal(researchFiles(once).find((file) => file.name === "claims.jsonl").content, "");
assert.deepEqual(researchFiles(retry), []);
assert.equal(campaignSlug("20261102", "a/b:c..d 한글 Test"), "20261102-a-b-c-d-한글-test");
assert.equal(campaignSlug("20261102", "  /// "), "20261102-research");
assert.doesNotMatch(campaignSlug("20261102", "x".repeat(80) + "\\*?\"<>|"), /[\\/:*?"<>|]|\.\./);
assert.equal(campaignSlug("20261102", "x".repeat(80)).length, "20261102-".length + 40);
receipts.push({ scenario: "research-files", campaign: campaignSlug("20261102", "a/b:c..d 한글 Test") });
console.log(JSON.stringify({ passed: true, receipts }, null, 2));
