# Command Code Desktop (cmdc-gui)

A Tauri shell that turns the Command Code CLI into a desktop app: pick a folder,
and `cmdc` starts in it. No terminal app, no `cd`, no typing the command.

```
Choose folder…  C:\work\my-project   [ ] --yolo   profile: default   Restart  Stop
┌──────────────────────────────────────────────────────────────────────────────┐
│  (the real Command Code TUI, rendered by xterm.js over a ConPTY)             │
└──────────────────────────────────────────────────────────────────────────────┘
launch: node entry · node            session: tab-…            144×40
```

## Why a PTY, not a subprocess

Command Code is a TUI. It needs a real console: it issues `ESC[6n` (cursor
position), enables bracketed paste and synchronized output, and paints inline
with truecolor. A plain pipe gives it no terminal, so it blocks on the very first
query and never draws. `portable-pty` creates a real **ConPTY** on Windows, and
xterm.js answers those queries exactly like a terminal does.

## Architecture

| Layer | File | Job |
| --- | --- | --- |
| PTY + launch resolution | `src-tauri/src/pty.rs` | spawn `node <npm-bin>/node_modules/command-code/dist/index.mjs` in a ConPTY, stream bytes over a Tauri `Channel`, handle write/resize/kill |
| Commands | `src-tauri/src/lib.rs` | register `cmdc_launch`, `start_dir`, `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `pty_list` |
| Terminal UI | `src/main.ts` | xterm.js + fit / webgl / unicode11 / web-links, base64 framing, folder picker, restart/stop, launch diagnostics |
| PTY diagnostic | `src-tauri/src/bin/pty_probe.rs` | headless proof that the CLI paints over a pty; plays terminal and answers its queries |

### Launch resolution

`cmdc` on Windows is an npm shim that runs `node …/command-code/dist/index.mjs`.
`pty.rs` resolves that layout itself and spawns `node` directly, so there is no
`cmd.exe` layer between the app and the TUI. If resolution fails it falls back to
`%COMSPEC% /c cmdc`, surfaced as `launch: shim fallback` in the status bar.

## Run

```bash
pnpm install
pnpm tauri dev
```

A debug build loads the dev server (`http://localhost:1420`), so `pnpm tauri dev`
is the way to run it during development. A release build (`pnpm tauri build`)
uses the bundled `dist/`.

Open a folder directly (shortcut-friendly):

```bash
cmdc-gui.exe D:\project
# or
CMDC_GUI_START_DIR=D:\project cmdc-gui.exe
```

## Verify

```bash
# 1. Does the CLI paint over a pty at all? (no GUI needed)
cargo run --manifest-path src-tauri/Cargo.toml --bin pty_probe

# 2. Does the app spawn the CLI as its own child?
pnpm tauri dev
# then: Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq <app pid>
# expect: node.exe …command-code\dist\index.mjs  and  conhost.exe --headless
```

`pty_probe` prints the TUI signals it saw (colour, synchronized output, bracketed
paste), a plain-text preview, and a hex dump of the first bytes.

## Verified on this machine

- ConPTY + node spawn: the app owns `node.exe …index.mjs` and a `conhost.exe
  --headless --width 144 --height 40` as direct children.
- The CLI paints: 1148 bytes captured, truecolor (`38;2;…`), `?2026h` sync output,
  `?2004h` bracketed paste, real UI text.
- The window renders the custom theme (dominant `#101115`, panel `#171a20`, 688
  distinct colours).

## Known gaps / next steps

- **Keyboard fidelity is unverified.** The CLI sets `ESC[?9001h` (Win32 input
  mode), a Windows Terminal extension xterm.js ignores. Shift+Enter / Alt+Enter
  and some chords may need an explicit keymap. Verify by hand first.
- **Profile switching is wired but has no UI.** `pty_spawn` accepts
  `profile_dir`; pointing `USERPROFILE` at a fresh directory gives a clean
  `~/.commandcode` (verified: `cmdc status` reports "Not authenticated"). A
  profile switcher is the natural next step — note that a separate `USERPROFILE`
  also separates each profile's git/global tool config.
- **`--yolo` is a checkbox, off by default.** It bypasses every permission
  prompt. Consider per-project opt-in with a visible warning instead.
- **Project trust prompt** appears on a new folder (the CLI asks). `--trust`
  exists but is deliberately not passed automatically.
- Single tab only; no split panes, no session list, no persisted profile store.

## Scope and licensing

This is a personal desktop shell around the Command Code CLI you already have
installed and are subscribed to. It does not bundle, redistribute, or reimplement
Command Code, and it does not change what your plan allows. Account credentials
stay in `~/.commandcode` and are never copied.
