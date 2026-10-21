//! Headless probe: does the Command Code TUI actually render under a ConPTY?
//!
//! The GUI cannot self-verify what it paints, so this binary isolates the
//! riskiest half of the design: spawn the CLI on a real pseudo-console, capture
//! what it writes, and report whether that output is a live full-screen TUI
//! (alternate screen, cursor addressing, colour) or just a plain error line.
//!
//!   cargo run --manifest-path src-tauri/Cargo.toml --bin pty_probe
//!
//! Pass `-- <ms>` to change the capture window (default 4000).

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
	let mut argv: Vec<String> = std::env::args().skip(1).collect();
	let capture_ms: u64 = argv
		.first()
		.and_then(|v| v.parse().ok())
		.inspect(|_| {
			argv.remove(0);
		})
		.unwrap_or(4000);
	let passthrough = argv;

	let launch = cmdc_gui_lib::launch::resolve_launch();
	println!("launch.via      = {}", launch.via);
	println!("launch.program  = {}", launch.program);
	println!("launch.args     = {:?}", launch.prefix_args);
	println!("launch.entry    = {:?}", launch.entry);

	let cwd = std::env::current_dir().expect("cwd");
	println!("cwd             = {}", cwd.display());

	let pty_system = native_pty_system();
	let pair = pty_system
		.openpty(PtySize {
			rows: 30,
			cols: 120,
			pixel_width: 0,
			pixel_height: 0,
		})
		.expect("openpty");

	let mut cmd = CommandBuilder::new(&launch.program);
	for arg in &launch.prefix_args {
		cmd.arg(arg);
	}
	// Mirrors the app's spawn; extra CLI arguments can be appended for triage.
	cmd.arg("--no-session");
	for arg in &passthrough {
		cmd.arg(arg);
	}
	cmd.cwd(Path::new(&cwd));

	// Mirror what pty.rs does: inherit everything, then pin the terminal identity.
	for (key, value) in std::env::vars() {
		cmd.env(key, value);
	}
	cmd.env("TERM", "xterm-256color");
	cmd.env("COLORTERM", "truecolor");

	let mut child = pair.slave.spawn_command(cmd).expect("spawn");
	drop(pair.slave);

	let mut reader = pair.master.try_clone_reader().expect("reader");
	let mut writer = pair.master.take_writer().expect("writer");
	let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
	let writer_sink = Arc::clone(&sink);

	let reader_done = Arc::new(AtomicBool::new(false));
	let writer_done = Arc::clone(&reader_done);
	let replies = Arc::new(AtomicUsize::new(0));
	let reply_counter = Arc::clone(&replies);

	// A real terminal answers the CLI's capability queries. Without an answer the
	// CLI blocks on its very first `ESC[6n` and never paints - which is exactly
	// what a naive probe (and any non-terminal pipe) sees. So this thread plays
	// terminal: capture what arrives, and reply to the queries it recognises.
	thread::spawn(move || {
		let mut buffer = [0u8; 16 * 1024];
		let mut pending: Vec<u8> = Vec::new();
		loop {
			match reader.read(&mut buffer) {
				Ok(0) => break,
				Ok(n) => {
					let chunk = &buffer[..n];
					if let Ok(mut guard) = writer_sink.lock() {
						guard.extend_from_slice(chunk);
					}
					pending.extend_from_slice(chunk);
					while let Some(reply) = answer_query(&mut pending) {
						if writer.write_all(&reply).is_err() {
							break;
						}
						let _ = writer.flush();
						reply_counter.fetch_add(1, Ordering::SeqCst);
					}
					if pending.len() > 8192 {
						let cut = pending.len() - 2048;
						pending.drain(..cut);
					}
				}
				Err(_) => break,
			}
		}
		writer_done.store(true, Ordering::SeqCst);
	});

	// Sample growth while the TUI paints, so we can tell "rendered once" from
	// "still drawing". A closed pty ends the wait early.
	let started = Instant::now();
	let mut samples = Vec::new();
	while started.elapsed() < Duration::from_millis(capture_ms) {
		thread::sleep(Duration::from_millis(250));
		let len = sink.lock().map(|g| g.len()).unwrap_or(0);
		samples.push(len);
		if reader_done.load(Ordering::SeqCst) {
			break;
		}
	}

	let bytes = sink.lock().map(|g| g.clone()).unwrap_or_default();
	let eof_before_kill = reader_done.load(Ordering::SeqCst);

	// Did it give up on its own before we killed it? That distinguishes "the CLI
	// refuses to run here" from "the CLI is running and painting".
	let status = child.try_wait().ok().flatten();
	let early_exit = status.is_some();
	let exit_code = status.map(|s| s.exit_code());

	// Killing a ConPTY child does not always close the master, so never block on
	// the reader thread: report what we saw and exit.
	let _ = child.kill();
	thread::sleep(Duration::from_millis(700));
	let eof_after_kill = reader_done.load(Ordering::SeqCst);

	println!();
	println!("=== capture ===");
	println!("bytes captured  = {}", bytes.len());
	println!("growth samples  = {:?}", samples);

	let alt_screen = contains(&bytes, b"\x1b[?1049h") || contains(&bytes, b"\x1b[?47h");
	let clear = contains(&bytes, b"\x1b[2J");
	let cursor = contains(&bytes, b"\x1b[") && has_cursor_address(&bytes);
	let colour = has_sgr_colour(&bytes);
	let mouse = contains(&bytes, b"\x1b[?1000h")
		|| contains(&bytes, b"\x1b[?1002h")
		|| contains(&bytes, b"\x1b[?1003h")
		|| contains(&bytes, b"\x1b[?1006h");
	let hide_cursor = contains(&bytes, b"\x1b[?25l");
	let bracketed_paste = contains(&bytes, b"\x1b[?2004h");
	let sync_output = contains(&bytes, b"\x1b[?2026h");

	println!();
	println!("=== TUI signals ===");
	println!("alternate screen = {alt_screen}");
	println!("clear screen     = {clear}");
	println!("cursor address   = {cursor}");
	println!("SGR colour       = {colour}");
	println!("mouse tracking   = {mouse}");
	println!("cursor hidden    = {hide_cursor}");
	println!("bracketed paste  = {bracketed_paste}");
	println!("synchronized out = {sync_output}");
	println!();
	println!("=== pty lifecycle ===");
	println!("terminal queries answered = {}", replies.load(Ordering::SeqCst));
	println!("child exited on its own = {early_exit} (code {exit_code:?})");
	println!("reader EOF before kill = {eof_before_kill}");
	println!("reader EOF after kill  = {eof_after_kill}");

	// The CLI paints inline (an Ink-style TUI), so it does NOT take the alternate
	// screen. Colour plus any modern repaint protocol is the real signal.
	let verdict = colour && (sync_output || alt_screen || clear || cursor || bracketed_paste);
	println!();
	println!(
		"VERDICT: {}",
		if verdict {
			"PASS - the CLI paints a live TUI over the pty (colour + repaint protocol seen)"
		} else if bytes.len() < 16 {
			"FAIL - almost no output; the CLI likely exited early"
		} else {
			"INCONCLUSIVE - inspect the preview and the raw head"
		}
	);

	println!();
	println!("=== plain-text preview (escapes stripped, first 40 lines) ===");
	let text = strip_ansi(&bytes);
	for line in text.lines().filter(|l| !l.trim().is_empty()).take(40) {
		println!("| {line}");
	}

	println!();
	println!("=== raw head (first 256 bytes, hex) ===");
	println!("{}", hex_head(&bytes, 256));

	// The reader thread may still be parked in read(); exit rather than join.
	std::process::exit(0);
}

fn hex_head(bytes: &[u8], limit: usize) -> String {
	let mut out = String::new();
	for (index, chunk) in bytes.chunks(16).take(limit.div_ceil(16)).enumerate() {
		out.push_str(&format!("{:04x}  ", index * 16));
		for byte in chunk {
			out.push_str(&format!("{byte:02x} "));
		}
		for _ in chunk.len()..16 {
			out.push_str("   ");
		}
		out.push_str(" |");
		for byte in chunk {
			out.push(if (0x20..0x7f).contains(byte) { *byte as char } else { '.' });
		}
		out.push_str("|\n");
	}
	out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
	haystack
		.windows(needle.len())
		.any(|window| window == needle)
}

/// Terminal queries the CLI sends before it will paint, with the reply a real
/// terminal gives. Ordered most-specific-first so a longer query wins.
const QUERIES: &[(&[u8], &[u8])] = &[
	(b"\x1b[>0c", b"\x1b[>0;276;0c"),
	(b"\x1b[>c", b"\x1b[>0;276;0c"),
	(b"\x1b[?2026$p", b"\x1b[?2026;1$y"),
	(b"\x1b[?u", b"\x1b[?0u"),
	(b"\x1b[0c", b"\x1b[?1;2c"),
	(b"\x1b[c", b"\x1b[?1;2c"),
	(b"\x1b[6n", b"\x1b[1;1R"),
	(b"\x1b[5n", b"\x1b[0n"),
	(b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
	(b"\x1b]11;?", b"\x1b]11;rgb:0f0f/1111/1515\x1b\\"),
];

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack.windows(needle.len()).position(|w| w == needle)
}

/// Find the earliest recognised query in `pending`, consume through it, and
/// return the reply. Consuming means each query is answered exactly once.
fn answer_query(pending: &mut Vec<u8>) -> Option<Vec<u8>> {
	let mut best: Option<(usize, usize, &'static [u8])> = None;
	for (query, reply) in QUERIES {
		if let Some(at) = find(pending, query) {
			let better = match best {
				Some((best_at, _, _)) => at < best_at,
				None => true,
			};
			if better {
				best = Some((at, at + query.len(), reply));
			}
		}
	}
	let (_, end, reply) = best?;
	pending.drain(..end);
	Some(reply.to_vec())
}

fn has_cursor_address(bytes: &[u8]) -> bool {
	// "\x1b[<row>;<col>H" - a digit-led parameter followed by H.
	let mut i = 0;
	while i + 3 < bytes.len() {
		if bytes[i] == 0x1b && bytes[i + 1] == b'[' {
			let mut j = i + 2;
			let mut digits = 0;
			while j < bytes.len() && bytes[j].is_ascii_digit() {
				digits += 1;
				j += 1;
			}
			if digits > 0 && j < bytes.len() && bytes[j] == b'H' {
				return true;
			}
		}
		i += 1;
	}
	false
}

fn has_sgr_colour(bytes: &[u8]) -> bool {
	// "\x1b[" ... "m" where the parameters mention 3x/4x/38/48.
	let mut i = 0;
	while i + 2 < bytes.len() {
		if bytes[i] == 0x1b && bytes[i + 1] == b'[' {
			let mut j = i + 2;
			let start = j;
			while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b';') {
				j += 1;
			}
			if j < bytes.len() && bytes[j] == b'm' && j > start {
				let params = &bytes[start..j];
				if params.windows(2).any(|w| w == b"38" || w == b"48") {
					return true;
				}
				if params
					.split(|b| *b == b';')
					.any(|p| p.len() == 2 && (p[0] == b'3' || p[0] == b'4') && p[1].is_ascii_digit())
				{
					return true;
				}
				if params.iter().any(|b| matches!(b, b'0'..=b'9')) && params.len() >= 1 {
					// Bare "\x1b[<n>m" colour codes (0-9) also count as styling.
					if params.len() == 1 && params[0].is_ascii_digit() {
						return true;
					}
				}
			}
			i = j;
			continue;
		}
		i += 1;
	}
	false
}

fn strip_ansi(bytes: &[u8]) -> String {
	let mut out = String::new();
	let mut i = 0;
	while i < bytes.len() {
		let byte = bytes[i];
		if byte == 0x1b {
			i += 1;
			if i < bytes.len() && bytes[i] == b'[' {
				i += 1;
				while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
					i += 1;
				}
				i += 1;
				continue;
			}
			if i < bytes.len() && bytes[i] == b']' {
				i += 1;
				while i < bytes.len() && bytes[i] != 0x07 {
					i += 1;
				}
				i += 1;
				continue;
			}
			continue;
		}
		if byte == b'\n' || byte == b'\r' {
			out.push('\n');
			i += 1;
			continue;
		}
		if byte < 0x20 {
			i += 1;
			continue;
		}
		if byte < 0x80 {
			out.push(byte as char);
			i += 1;
			continue;
		}
		// Keep multi-byte UTF-8 intact.
		let start = i;
		let width = if byte >= 0xf0 {
			4
		} else if byte >= 0xe0 {
			3
		} else {
			2
		};
		let end = (start + width).min(bytes.len());
		if let Ok(chunk) = std::str::from_utf8(&bytes[start..end]) {
			out.push_str(chunk);
		}
		i = end;
	}
	out
}
