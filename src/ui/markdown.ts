// Agent text → safe HTML, plus math-only rendering for the user's own text and
// the composer preview. Everything goes through DOMPurify: model output is
// untrusted, and a webview with IPC access must never run its markup.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { icons } from "./icons";

// ---------------------------------------------------------------- math
//
// LaTeX is pulled out by marked tokenizers before markdown sees it: run
// through markdown, `\,` would lose its backslash and `_`/`*` would turn into
// emphasis. Delimiters models use: $$…$$ and \[…\] (display), $…$ and \(…\)
// (inline). Code spans and fenced blocks are tokenized first, so math inside
// code stays code. A lone `$` (prices like "$5 and $10") is not math: like
// pandoc, inline $…$ needs no space inside the delimiters and no digit right
// after the closing one.

const texCache = new Map<string, string>();

function tex(source: string, display: boolean): string {
	const key = `${display ? "D" : "I"}${source}`;
	const cached = texCache.get(key);
	if (cached !== undefined) return cached;
	const html = katex.renderToString(source, {
		displayMode: display,
		throwOnError: false, // a bad formula shows its source in red, never breaks the message
		strict: "ignore",
		trust: false, // no \href, \url, \includegraphics
		output: "html",
	});
	const wrapped = `<span class="${display ? "math-block" : "math-inline"}" data-tex="${escapeHtml(source)}" title="두 번 클릭: LaTeX 복사">${html}</span>`;
	// Streaming re-renders the same formulas every frame; keep a bounded cache.
	if (texCache.size > 400) texCache.delete(texCache.keys().next().value as string);
	texCache.set(key, wrapped);
	return wrapped;
}

/** A math span in plain text; `open` means it has no closing delimiter yet. */
export interface MathSpan {
	start: number;
	end: number;
	text: string;
	display: boolean;
	open: boolean;
}

// Sticky regexes anchor at `lastIndex`, so one set of delimiter rules serves
// the marked tokenizer (position 0 of the remaining source) and findMath.
const DISPLAY_DOLLAR = /\$\$([\s\S]+?)\$\$/y;
const DISPLAY_BRACKET = /\\\[([\s\S]+?)\\\]/y;
const INLINE_PAREN = /\\\(([\s\S]+?)\\\)/y;
// No backticks inside: "$10, `$x$`" must not swallow the code span.
const INLINE_DOLLAR = /\$(?![\s$])((?:\\.|[^\\$\n`])+?)(?<![\s\\])\$(?!\d)/y;
// Display math still being typed: opened, never closed.
const OPEN_DISPLAY = /(?:\$\$|\\\[)([\s\S]*)/y;

function stickyExec(re: RegExp, src: string, at: number): RegExpExecArray | null {
	re.lastIndex = at;
	return re.exec(src);
}

/** The math span starting exactly at `at`, if any. `lenient` also takes unclosed display math, for a live preview. */
function matchMathAt(src: string, at: number, lenient: boolean): MathSpan | undefined {
	let m = stickyExec(DISPLAY_DOLLAR, src, at) ?? stickyExec(DISPLAY_BRACKET, src, at);
	if (m) return { start: at, end: at + m[0].length, text: m[1].trim(), display: true, open: false };
	m = stickyExec(INLINE_PAREN, src, at);
	if (m) return { start: at, end: at + m[0].length, text: m[1].trim(), display: false, open: false };
	m = stickyExec(INLINE_DOLLAR, src, at);
	if (m) return { start: at, end: at + m[0].length, text: m[1], display: false, open: false };
	if (lenient) {
		m = stickyExec(OPEN_DISPLAY, src, at);
		// A half-typed closer ("$$x$") is not part of the formula.
		if (m) return { start: at, end: src.length, text: m[1].replace(/(?<!\\)\$$/, "").trim(), display: true, open: true };
	}
	return undefined;
}

/**
 * Math spans in plain text, by the markdown renderer's rules: code spans and
 * fenced code are skipped, `\$` is a literal dollar, and inline $…$ follows the
 * pandoc rules above. With `lenient`, display math that is still open ($$… or
 * \[… without a closer) runs to the end, so a formula can be previewed while
 * it is being typed.
 */
export function findMath(src: string, lenient = false): MathSpan[] {
	const spans: MathSpan[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "`") {
			const n = stickyExec(/`+/y, src, i)![0].length;
			const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
			close.lastIndex = i + n;
			const m = close.exec(src);
			if (m) i = m.index + n;
			else if (n >= 3 && (i === 0 || src[i - 1] === "\n")) break; // unterminated fence: the rest is code
			else i += n;
			continue;
		}
		if (ch === "\\") {
			const next = src[i + 1];
			const span = next === "[" || next === "(" ? matchMathAt(src, i, lenient) : undefined;
			if (span) {
				spans.push(span);
				i = span.end;
			} else {
				i += 2;
			}
			continue;
		}
		if (ch === "$") {
			const span = matchMathAt(src, i, lenient);
			if (span) {
				spans.push(span);
				i = span.end;
				continue;
			}
		}
		i++;
	}
	return spans;
}

/**
 * Whether text is written as a document rather than a plain sentence: a
 * heading, list, table, fence, quote, rule or bold somewhere. The user's own
 * messages are rendered as markdown only then, so `*` and `#` in an ordinary
 * prompt stay what they are.
 */
export function looksLikeMarkdown(text: string): boolean {
	return (
		/^(?: {0,3}#{1,6} \S| {0,3}(?:[-*+]|\d+[.)]) \S| {0,3}> | {0,3}(?:```|~~~)| {0,3}\|.*\|[ \t]*$| {0,3}(?:-{3,}|\*{3,})[ \t]*$)/m.test(text) ||
		/\*\*[^*\n]+\*\*/.test(text)
	);
}

// ------------------------------------------------------------ obsidian
//
// Notes pasted from Obsidian carry `![[file.png|480]]` embeds. The file lives
// in the vault, which this app cannot see, so the embed becomes a labelled
// slot; the text sent to the agent keeps the original syntax.

const EMBED = /!\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/y;

function embedHtml(name: string): string {
	const image = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
	return `<span class="embed-slot" title="옵시디언 첨부 — 볼트 밖이라 여기서는 열 수 없습니다">${icons.image}${image ? "첨부 이미지 자리" : "첨부 자리"}: ${escapeHtml(name)}</span>`;
}

interface EmbedToken {
	type: "obsidianEmbed";
	raw: string;
	text: string;
}

const obsidianEmbed: TokenizerAndRendererExtension = {
	name: "obsidianEmbed",
	level: "inline",
	start(src) {
		const i = src.indexOf("![[");
		return i < 0 ? undefined : i;
	},
	tokenizer(src) {
		const m = stickyExec(EMBED, src, 0);
		return m ? ({ type: "obsidianEmbed", raw: m[0], text: m[1].trim() } satisfies EmbedToken) : undefined;
	},
	renderer(token) {
		return embedHtml((token as EmbedToken).text);
	},
};

interface MathToken {
	type: "blockMath" | "inlineMath";
	raw: string;
	text: string;
	display: boolean;
}

const blockMath: TokenizerAndRendererExtension = {
	name: "blockMath",
	level: "block",
	start(src) {
		const i = src.search(/\$\$|\\\[/);
		return i < 0 ? undefined : i;
	},
	tokenizer(src) {
		const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
		if (!m) return undefined;
		return { type: "blockMath", raw: m[0], text: (m[1] ?? m[2]).trim(), display: true } satisfies MathToken;
	},
	renderer(token) {
		return `<div class="math-display">${tex((token as MathToken).text, true)}</div>\n`;
	},
};

const inlineMath: TokenizerAndRendererExtension = {
	name: "inlineMath",
	level: "inline",
	start(src) {
		const i = src.search(/\$|\\\(|\\\[/);
		return i < 0 ? undefined : i;
	},
	tokenizer(src) {
		const m = matchMathAt(src, 0, false);
		if (!m) return undefined;
		return { type: "inlineMath", raw: src.slice(0, m.end), text: m.text, display: m.display } satisfies MathToken;
	},
	renderer(token) {
		const t = token as MathToken;
		return t.display ? `<span class="math-display">${tex(t.text, true)}</span>` : tex(t.text, false);
	},
};

// ------------------------------------------------------------- markdown

const marked = new Marked(
	{
		gfm: true,
		breaks: false,
		renderer: {
			code({ text, lang }) {
				const language = (lang ?? "").trim().split(/\s+/)[0];
				const known = language && hljs.getLanguage(language);
				const body = known
					? hljs.highlight(text, { language, ignoreIllegals: true }).value
					: escapeHtml(text);
				const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
				return `<div class="code-block"><div class="code-head">${label}<button class="code-copy" type="button" title="복사">${icons.copy}</button></div><pre><code class="hljs">${body}</code></pre></div>`;
			},
		},
	},
	{ extensions: [blockMath, inlineMath, obsidianEmbed] },
);

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Model output must not fetch anything by itself: a remote <img> would leak
// whatever the model put in its URL the moment it renders. Only inline data
// images survive; links still need a click and open in the system browser.
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
	if (data.tagName === "img") {
		const src = (node as Element).getAttribute?.("src") ?? "";
		if (!src.startsWith("data:image/")) node.parentNode?.removeChild(node);
	}
});

function sanitize(html: string): string {
	return DOMPurify.sanitize(html, {
		// KaTeX output is plain spans with inline sizing styles, plus SVG for
		// radicals and stretchy arrows; both profiles already cover it.
		USE_PROFILES: { html: true, svg: true },
		// Our own code-copy <button> survives; anything that can submit or embed does not.
		FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
		ADD_TAGS: ["button"],
		ADD_ATTR: ["title", "type"],
	});
}

export function renderMarkdown(source: string): string {
	return sanitize(marked.parse(source, { async: false }) as string);
}

function mathHtml(text: string, display: boolean): string {
	return display ? `<span class="math-display">${tex(text, true)}</span>` : tex(text, false);
}

/** One formula as safe HTML, for the composer's live preview. */
export function renderMath(text: string, display: boolean): string {
	return sanitize(mathHtml(text, display));
}

/**
 * Plain text with only its math (and Obsidian embeds) rendered: no markdown,
 * everything else escaped. Line breaks come from the container's
 * `white-space: pre-wrap`, so the newline next to a display formula is
 * dropped, or it would show as a blank line beside the block.
 */
export function renderMathText(source: string): string {
	const pieces = findMath(source).map((s) => ({ start: s.start, end: s.end, html: mathHtml(s.text, s.display), block: s.display }));
	const embed = new RegExp(EMBED.source, "g");
	for (let m = embed.exec(source); m; m = embed.exec(source)) {
		const start = m.index;
		const end = start + m[0].length;
		if (!pieces.some((p) => start < p.end && end > p.start)) pieces.push({ start, end, html: embedHtml(m[1].trim()), block: false });
	}
	if (!pieces.length) return escapeHtml(source);
	pieces.sort((a, b) => a.start - b.start);
	let html = "";
	let last = 0;
	for (const piece of pieces) {
		let before = source.slice(last, piece.start);
		if (piece.block && before.endsWith("\n")) before = before.slice(0, -1);
		html += escapeHtml(before) + piece.html;
		last = piece.end;
		if (piece.block && source[last] === "\n") last++;
	}
	return sanitize(html + escapeHtml(source.slice(last)));
}

/** The user's own message: a document when it is written as one, otherwise verbatim text with its formulas. */
export function renderUserText(text: string): { html: string; markdown: boolean } {
	const markdown = looksLikeMarkdown(text);
	return { markdown, html: markdown ? renderMarkdown(text) : renderMathText(text) };
}

/** A whole draft as a document, for the composer preview: a display block still being typed is closed for the preview only. */
export function renderDraft(text: string): string {
	const spans = findMath(text, true);
	const last = spans[spans.length - 1];
	if (last?.open) text += text.startsWith("$$", last.start) ? "\n$$" : "\\]";
	return renderMarkdown(text);
}

/** Code-copy buttons, LaTeX copy and external links, wired once on a container. */
export function wireMarkdown(container: HTMLElement, openUrl: (url: string) => void): void {
	container.addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		const copy = target.closest<HTMLButtonElement>(".code-copy");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
			void navigator.clipboard.writeText(code).then(() => {
				copy.classList.add("done");
				setTimeout(() => copy.classList.remove("done"), 1200);
			});
			return;
		}
		const link = target.closest<HTMLAnchorElement>("a[href]");
		if (link) {
			event.preventDefault();
			const href = link.getAttribute("href") ?? "";
			if (/^https?:\/\//i.test(href)) openUrl(href);
		}
	});
	container.addEventListener("dblclick", (event) => {
		const math = (event.target as HTMLElement).closest<HTMLElement>("[data-tex]");
		if (!math) return;
		event.preventDefault();
		window.getSelection()?.removeAllRanges();
		void navigator.clipboard.writeText(math.dataset.tex ?? "").then(() => {
			math.classList.add("copied");
			setTimeout(() => math.classList.remove("copied"), 900);
		});
	});
}
