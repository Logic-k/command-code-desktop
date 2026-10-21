// A tiny element builder; the app is small enough not to need a framework.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs | null = null,
	...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === null || value === undefined || value === false) continue;
			if (key.startsWith("on") && typeof value === "function") {
				node.addEventListener(key.slice(2).toLowerCase(), value);
			} else if (key === "class") {
				node.className = String(value);
			} else if (value === true) {
				node.setAttribute(key, "");
			} else {
				node.setAttribute(key, String(value));
			}
		}
	}
	append(node, children);
	return node;
}

function append(node: Node, children: (Child | Child[])[]): void {
	for (const child of children) {
		if (Array.isArray(child)) append(node, child);
		else if (child === null || child === undefined || child === false) continue;
		else node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
	}
}

export function byId<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
}

/** Inline SVG from a trusted constant (our own icon set only). */
export function svg(markup: string, className = "icon"): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = className;
	span.innerHTML = markup;
	return span;
}

export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.round((Date.now() - then) / 60_000);
	if (minutes < 1) return "방금";
	if (minutes < 60) return `${minutes}분 전`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}시간 전`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}일 전`;
	return new Date(iso).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}
