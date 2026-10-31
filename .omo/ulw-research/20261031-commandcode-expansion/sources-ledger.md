# Selected primary sources

As-of: 2026-10-31. Source bodies, raw bytes, hashes and sentence indexes are under
`sources/<id>/`. A snapshot proves what was collected, not that the source's claims
are true. Public HTTP GET was used; the attached browser was permission-blocked.

| source_id | source group | source type | selected reason | URL or local source |
|---|---|---|---|---|
| S1 | executed-local-probe | command | independently executable behavior boundary | verify-claims.mjs stdout |
| S2 | openai-official | primary documentation | app-server lifecycle/protocol/support scope | https://learn.chatgpt.com/docs/app-server |
| S3 | openai-official | primary documentation | OSS/local SIWC scope | https://developers.openai.com/siwc/token-sharing-open-source |
| S4 | openai-official | primary documentation | preview limitations and migration | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations |
| S5 | openai-official | primary documentation | authentication and subscription separation | https://developers.openai.com/codex/auth |
| S8 | sqlite-official | primary documentation | WAL and durability limits; release fix check | https://sqlite.org/wal.html |
| S9 | agentskills-official | primary specification | portable skill format and experimental tool field | https://agentskills.io/specification |
| S11 | hermes-official | primary documentation | procedural skill lifecycle | https://hermes-agent.nousresearch.com/docs/user-guide/features/skills |
| S12 | hermes-official | primary documentation | memory versus procedures | https://hermes-agent.nousresearch.com/docs/user-guide/features/memory |
| S13 | tauri-official | primary documentation | signed updater | https://v2.tauri.app/plugin/updater/ |
| S14 | tauri-official | primary documentation | IPC capabilities are not arbitrary subprocess sandboxing | https://v2.tauri.app/security/capabilities/ |
| S15 | tauri-official | primary documentation | storage/migration integration | https://v2.tauri.app/plugin/sql/ |
| S16 | langgraph-official | primary documentation | recovery and side-effect constraints | https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance |
| S17 | commandcode-official | primary terms | current provider account limits, check-only | https://commandcode.ai/terms |
| S18 | commandcode-official | primary documentation | current ACP integration | https://commandcode.ai/docs/acp |
| S19 | openai-official | primary documentation | avoid basing new product storage on retiring eval services | https://developers.openai.com/api/docs/deprecations |
| S20 | promptfoo-source | pinned primary code | inherited API key routing boundary | https://raw.githubusercontent.com/promptfoo/promptfoo/5582f347bbc5359b201ce2d48c9c7fbebd8dcbd9/src/providers/openai/codexApiKeyGating.ts |
| S21 | smolagents-source | pinned primary code | auxiliary visual model can bypass top-level provider choice | https://raw.githubusercontent.com/huggingface/smolagents/96f33faaf028479119ec8d34507b47694cf14e34/examples/open_deep_research/scripts/visual_qa.py |
| S22 | hermes-source | pinned primary code | write approval default differs from proposed app policy | https://raw.githubusercontent.com/NousResearch/hermes-agent/bf0203a794a07aac3ff764972ab9087baa4e4f4e/tools/write_approval.py |
| S23 | codex-source | pinned primary code | internal auth-token method is not a public SIWC integration | https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/account.rs |
| S24 | project-code | working-tree primary code | runner/verifier/learning implementation | src/workflow.ts |
| S25 | project-code | working-tree primary code | role permissions, session and cancellation | src/views/chat.ts |
| S26 | project-code | working-tree primary code | native process ownership | src-tauri/src/acp.rs |
| S27 | project-code | working-tree primary code | local data/path identity | src/store.ts |
| S28 | project-code | working-tree primary manifest | framework/dependency baseline | package.json |
| S29 | installed-package | primary package manifest | CLI license boundary | installed command-code/package.json |
| S30 | rusqlite-source | pinned primary manifest | candidate dependency | rusqlite Cargo.toml at pinned commit |
| S31 | sqlite-bundled-source | pinned primary header | candidate SQLite runtime provenance | libsqlite3-sys sqlite3.h at pinned commit |
| S32 | agentskills-source | pinned primary repository | code/document license separation | Agent Skills README at pinned commit |
| S33 | hermes-source | pinned primary license | reuse notice boundary | Hermes LICENSE at pinned commit |
| S34 | delivered-documents | primary proposed plan | plan metadata and contracts | .omo/plans/commandcode-research-platform.md |
| S35 | delivered-documents | primary report | report presence and qualifications | docs/research/commandcode-expansion-2026-10-31.md |

## Discovery-only or rejected sources

S6/S7/S10 were captured during LangGraph URL discovery. Some paths redirect to
Persistence or Interrupts rather than the requested page. They are not selected
to substantiate exactly-once or idempotence guarantees. S16 and pinned framework
source observations replace those assumptions.

Search summaries are discovery only. Marketing benchmark numbers, search-cached
old paper versions and unsupported CLI/Taste internals are not selected evidence.

## Source-priority exceptions

Provider eligibility, API support and terms have one authoritative publisher.
OpenAI/Command Code policy conclusions therefore use explicit first-party
exceptions rather than pretend that copies or different model readers are
independent sources. Current source and fixed-version source can disagree;
the implementation plan requires installed-version schema and behavior probes.
Local code and command observations describe this working tree, not an upstream
release. Static risks are not escalated to reproduced effects.
