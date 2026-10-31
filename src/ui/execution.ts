import { invoke } from "@tauri-apps/api/core";
import { createWorkflow, learningCandidates, WORKFLOWS, workflowKind, type WorkflowKind, type WorkflowRun } from "../workflow";
import { renderUlwCanvas, type UlwRun } from "./dag";
import { h } from "./dom";

export const DESKTOP_COMMANDS = [
	{ name: "desktop-research", description: "리서치 워크플로 열기", input: { hint: "조사 목표" } },
	{ name: "desktop-team", description: "독립 리서치 팀 구성", input: { hint: "조사 목표" } },
	{ name: "desktop-build", description: "리서치 후 구현·검증 루프", input: { hint: "제작 목표" } },
	{ name: "desktop-taste", description: "프로젝트 취향 기반 코딩", input: { hint: "코딩 목표" } },
];
const STATUS = { ready: "준비", running: "실행 중", passed: "에이전트 검증 통과", failed: "실패", cancelled: "중지됨" };

export class ExecutionPanel {
	readonly root: HTMLElement;
	private readonly kind = h("select", { class: "select", "aria-label": "워크플로" },
		WORKFLOWS.map((item) => h("option", { value: item.id }, item.name)));
	private readonly objective = h("textarea", { class: "execution-objective", rows: 2, "aria-label": "실행 목표", placeholder: "조사하거나 제작할 목표와 완료 기준" });
	private readonly iterations = h("input", { type: "number", min: 1, max: 5, value: 2, "aria-label": "최대 반복 횟수" });
	private readonly taste = h("textarea", { class: "execution-objective", rows: 4, "aria-label": "프로젝트 취향", placeholder: "예: 기존 패턴 우선, 의존성 최소화, 한국어 문서, 성능은 측정 후 최적화" });
	private readonly description = h("p", { class: "execution-description" });
	private readonly status = h("p", { class: "execution-status", role: "status", "aria-live": "polite" });
	private readonly graph = h("div", { class: "execution-graph", tabindex: 0, "aria-label": "실행 의존 그래프" });
	private readonly graphLabel = h("h3", null, "실행 미리보기");
	private readonly results = h("div", { class: "execution-results" });
	private readonly learning = h("div", { class: "execution-learning" });
	private readonly observed = h("details", null, h("summary", null, "CLI ULW 실행 그래프 (관찰)"));
	private readonly start: HTMLButtonElement;
	private readonly stop: HTMLButtonElement;
	private readonly exportButton: HTMLButtonElement;
	private run: WorkflowRun | null = null;
	private active = false;
	private selected: string | null = null;
	private readonly tasteKey: string;

	constructor(cwd: string, private readonly host: {
		start(run: WorkflowRun): void;
		cancel(): void;
	}) {
		this.tasteKey = `commandcode:taste:${cwd}`;
		this.taste.value = localStorage.getItem(this.tasteKey) ?? "";
		this.kind.addEventListener("change", () => this.describe());
		const save = h("button", { type: "button", class: "btn", onclick: () => {
			try {
				localStorage.setItem(this.tasteKey, this.taste.value);
				this.status.textContent = "이 프로젝트의 취향을 저장했습니다.";
			} catch (error) {
				this.status.textContent = `취향 저장 실패: ${String(error)}`;
			}
		} }, "취향 저장");
		this.start = h("button", { class: "btn primary", type: "button", onclick: () => this.begin() }, "실행 시작");
		this.stop = h("button", { class: "btn", type: "button", disabled: true, onclick: () => host.cancel() }, "중지");
		this.exportButton = h("button", { class: "btn", type: "button", disabled: true, onclick: () => this.export() }, "근거 내보내기");
		this.root = h("section", { class: "execution-panel hidden", "aria-label": "에이전트 실행" },
			h("h2", null, "에이전트 실행"),
			h("div", { class: "execution-controls" },
				h("label", null, "워크플로 ", this.kind),
				h("label", null, "최대 반복 ", this.iterations)),
			this.description,
			h("label", { class: "execution-field" }, "목표 · 완료 기준", this.objective),
			h("details", null, h("summary", null, "프로젝트 Taste"),
				h("p", null, "저장한 취향을 각 역할에 전달합니다. 모델 학습이 아닙니다. 기존 taste 파일은 변경하지 않습니다."),
				this.taste, save),
			h("p", { class: "execution-description" }, "현재 Command Code 계정·선택 모델을 사용합니다. 역할마다 추론이 발생합니다. 조사 역할은 계획 모드, 구현은 시작할 때의 권한 모드, 코딩 검증은 표준 모드(권한 무시 중이면 그대로)로 실행하며 읽기 전용 역할의 변경 요청은 거부합니다. 검증은 그 세션에서 실제로 완료된 도구 호출 기록이 있어야 통과합니다. 앱 종료 후 자동 재개되지 않습니다."),
			h("div", { class: "execution-controls" }, this.start, this.stop, this.exportButton),
			this.status, this.graphLabel, this.graph, this.results, this.learning, this.observed,
		);
		this.describe();
	}

	open(kind: WorkflowKind, objective = ""): void {
		if (this.active) return;
		this.kind.value = kind;
		this.objective.value = objective;
		this.describe();
		this.objective.focus();
	}

	private describe(): void {
		const kind = workflowKind(this.kind.value);
		const item = WORKFLOWS.find((entry) => entry.id === kind);
		this.description.textContent = item?.description ?? "";
		if (kind && !this.run) {
			const preview = createWorkflow(kind, "미리보기", this.taste.value, 1);
			this.graph.replaceChildren(renderUlwCanvas(preview));
		}
	}

	private begin(): void {
		const kind = workflowKind(this.kind.value);
		if (!kind || this.active) return;
		try {
			this.run = createWorkflow(kind, this.objective.value, this.taste.value, this.iterations.valueAsNumber);
			this.selected = null;
			this.host.start(this.run);
		} catch (error) {
			this.status.textContent = error instanceof Error ? error.message : String(error);
			this.status.scrollIntoView({ block: "nearest" });
		}
	}

	setActive(active: boolean): void {
		this.active = active;
		this.start.disabled = active;
		this.stop.disabled = !active;
		this.kind.disabled = this.objective.disabled = this.iterations.disabled = this.taste.disabled = active;
	}

	update(run: WorkflowRun): void {
		this.run = run;
		this.graphLabel.textContent = `${WORKFLOWS.find((item) => item.id === run.kind)?.name ?? run.kind} 실행 · ${run.objective}`;
		this.exportButton.disabled = false;
		this.status.textContent = `${STATUS[run.status]} · 반복 ${run.iteration}/${run.maxIterations} · ${run.nodes.filter((node) => node.status === "done").length}/${run.nodes.length} 노드\n${run.verification}`;
		const left = this.graph.scrollLeft;
		this.graph.replaceChildren(renderUlwCanvas(run, (node) => {
			this.selected = node.id;
			this.renderResult();
		}));
		this.graph.scrollLeft = left;
		this.renderResult();
		const candidates = learningCandidates(run);
		// Unchecked by default: a lesson becomes part of every later prompt only
		// when the user picks it.
		const boxes = candidates.map(() => h("input", { type: "checkbox" }));
		this.learning.replaceChildren(h("div", null,
			candidates.length ? h("h3", null, "검증된 실행의 학습 후보") : null,
			candidates.length ? h("ul", { class: "execution-candidates" }, candidates.map((item, index) =>
				h("li", null, h("label", null, boxes[index], ` ${item}`)))) : null,
			candidates.length ? h("button", { class: "btn", type: "button", onclick: () => {
				const picked = candidates.filter((_, index) => (boxes[index] as HTMLInputElement).checked);
				if (!picked.length) {
					this.status.textContent = "반영할 학습 후보를 선택하세요.";
					return;
				}
				const next = [this.taste.value, ...picked].filter(Boolean).join("\n");
				try {
					localStorage.setItem(this.tasteKey, next);
					this.taste.value = next;
					this.learning.replaceChildren(h("p", null, "선택한 학습 후보를 프로젝트 취향에 저장했습니다. 다음 실행부터 적용됩니다."));
				} catch (error) {
					this.status.textContent = `학습 후보 저장 실패: ${String(error)}`;
				}
			} }, "선택한 후보를 취향에 반영") : null));
	}

	private renderResult(): void {
		const run = this.run;
		if (!run) return;
		const node = run.nodes.find((item) => item.id === this.selected) ??
			[...run.nodes].reverse().find((item) => item.output || item.note);
		this.results.replaceChildren(
			h("p", { class: "execution-description" }, "그래프 노드를 선택하면 전체 결과와 근거를 볼 수 있습니다."),
			h("div", null,
				node ? h("h3", null, `${node.label} · ${node.status}`) : null,
				node ? h("pre", null, node.output || node.note || "결과 대기 중") : null),
		);
	}

	observe(run: UlwRun): void {
		this.observed.replaceChildren(h("summary", null, `CLI ULW 실행 그래프 (관찰) · ${run.phase}`),
			h("p", null, run.objective), renderUlwCanvas(run));
	}

	showError(message: string): void {
		this.status.textContent = message;
	}

	private export(): void {
		if (!this.run) return;
		void invoke<string | null>("save_text_file", { name: `workflow-${this.run.planCallId}.json`, content: JSON.stringify(this.run, null, 2) })
			.then((path) => {
				if (path) this.status.textContent = `근거를 저장했습니다: ${path}`;
			})
			.catch((error) => {
				this.status.textContent = `내보내기 실패: ${String(error)}`;
			});
	}
}
