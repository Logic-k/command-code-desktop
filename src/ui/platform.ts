// Windows and macOS name and press the main shortcut modifier differently.

export const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** The shortcut modifier as shown to people: "⌘" on macOS, "Ctrl+" elsewhere. */
export const mod = isMac ? "⌘" : "Ctrl+";

/** Whether the platform's shortcut modifier (⌘ / Ctrl) is held. On macOS
 * Ctrl stays free for the terminal (Ctrl+C, Ctrl+W mean what they mean there). */
export function modHeld(event: KeyboardEvent | MouseEvent): boolean {
	return isMac ? event.metaKey : event.ctrlKey;
}

/** Rewrite "Ctrl+X" in a label for this platform. */
export function keys(label: string): string {
	return isMac ? label.replace(/Ctrl\+/g, "⌘") : label;
}
