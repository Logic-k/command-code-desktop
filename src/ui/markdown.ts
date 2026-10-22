// Agent text → safe HTML. Everything goes through DOMPurify: model output is
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
		let m = /^\$\$([\s\S]+?)\$\$/.exec(src) ?? /^\\\[([\s\S]+?)\\\]/.exec(src);
		if (m) return { type: "inlineMath", raw: m[0], text: m[1].trim(), display: true } satisfies MathToken;
		m = /^\\\(([\s\S]+?)\\\)/.exec(src);
		if (m) return { type: "inlineMath", raw: m[0], text: m[1].trim(), display: false } satisfies MathToken;
		// No backticks inside: "$10, `$x$`" must not swallow the code span.
		m = /^\$(?![\s$])((?:\\.|[^\\$\n`])+?)(?<![\s\\])\$(?!\d)/.exec(src);
		if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: false } satisfies MathToken;
		return undefined;
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
	{ extensions: [blockMath, inlineMath] },
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

export function renderMarkdown(source: string): string {
	const html = marked.parse(source, { async: false }) as string;
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
