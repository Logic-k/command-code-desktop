// The "에이전트 백엔드" block inside the settings dialog: list, add, remove,
// and the codex-acp preset. Extracted so the offline preview can mount it.

import { codexPreset, loadCustomBackends, parseCommandLine, saveCustomBackends, type AgentSpec } from "../backends";
import { h } from "./dom";
import { isWindows } from "./platform";

export function backendSettingsBlock(): HTMLElement {
	const backendName = h("input", { class: "text", type: "text", placeholder: "이름 (예: Codex)" });
	const backendCmd = h("input", {
		class: "text", type: "text",
		placeholder: isWindows ? "npx -y @agentclientprotocol/codex-acp" : "codex-acp 또는 uvx …",
	});
	const backendList = h("div", { class: "backend-list" });
	const renderBackends = () => {
		const custom = loadCustomBackends();
		backendList.replaceChildren(
			...(custom.length
				? custom.map((b) =>
					h("div", { class: "backend-row" },
						h("span", { class: "backend-name", title: `${b.spec?.program} ${(b.spec?.args ?? []).join(" ")}` }, b.name),
						h("button", {
							class: "btn ghost", type: "button",
							onclick: () => { saveCustomBackends(loadCustomBackends().filter((x) => x.id !== b.id)); renderBackends(); },
						}, "삭제"),
					),
				)
				: [h("div", { class: "field-help" }, "등록된 추가 에이전트가 없습니다. Command Code만 사용합니다.")]),
		);
	};
	renderBackends();
	const addBackend = (name: string, spec: AgentSpec | null) => {
		if (!spec) return;
		const id = `agent-${Date.now().toString(36)}`;
		saveCustomBackends([...loadCustomBackends(), { id, name: name.trim() || spec.program, spec }]);
		renderBackends();
	};
	return h("div", { class: "settings-backends" },
		h("div", { class: "field-label" }, "에이전트 백엔드 (ACP)"),
		backendList,
		h("div", { class: "backend-form" }, backendName, backendCmd,
			h("button", {
				class: "btn", type: "button",
				onclick: () => { addBackend(backendName.value, parseCommandLine(backendCmd.value, isWindows)); backendCmd.value = ""; },
			}, "추가"),
		),
		h("button", {
			class: "btn ghost", type: "button",
			onclick: () => {
				const preset = codexPreset(isWindows);
				if (!loadCustomBackends().some((b) => b.name === preset.name)) {
					saveCustomBackends([...loadCustomBackends(), { ...preset, id: `agent-${Date.now().toString(36)}` }]);
					renderBackends();
				}
			},
		}, "+ Codex (ChatGPT 구독) 프리셋"),
		h("div", { class: "field-help" },
			"stdio로 ACP를 말하는 에이전트면 무엇이든 추가할 수 있습니다. 계정·요금·세션 기록은 Command Code 전용이고, 탭 상단에서 에이전트를 바꿉니다."),
	);
}
