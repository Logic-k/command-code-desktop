// Agent text → safe HTML. Everything goes through DOMPurify: model output is
// untrusted, and a webview with IPC access must never run its markup.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { icons } from "./icons";

const marked = new Marked({
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
});

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function renderMarkdown(source: string): string {
	const html = marked.parse(source, { async: false }) as string;
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true, svg: true },
		// Our own code-copy <button> survives; anything that can submit or embed does not.
		FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
		ADD_TAGS: ["button"],
		ADD_ATTR: ["title", "type"],
	});
}

/** Code-copy buttons and external links, wired once on a container. */
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
}
