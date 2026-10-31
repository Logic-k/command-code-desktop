// Which models an account may use.
//
// Rules, from the CLI's own `evaluateModelAccess` (command-code 1.87) plus the
// official pricing page (commandcode.ai/docs/resources/pricing-limits):
// 1. No balance at all: nothing runs ("requests stop until your subscription
//    renews or you add credits").
// 2. Free models (`:free`, $0 pricing) need at least $1 of balance to start a
//    session, and then cost nothing.
// 3. Purchased or bonus ("free") credits unlock every model.
// 4. Otherwise the plan must rank at or above the model's `minimumPlan`.

/** Mirrors `billing::Billing` in src-tauri/src/billing.rs. */
export interface Billing {
	userName: string | null;
	planId: string | null;
	planStatus: string | null;
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	/** End of the billing period (ISO 8601). */
	periodEnd: string | null;
	/** Rolling-window limits as the API sends them, while a plan has them. */
	windowLimits: WindowLimits | null;
}

interface WindowLimit {
	used?: number;
	cap?: number;
	/** Epoch ms; 0 while the window has not started. */
	resetAt?: number | string;
	exceeded?: boolean;
}

/** As the credits API sends them (seen 2026-10-27 on a Go plan):
 * `{limited: true, exceeded: "weekly", fiveHour: {used, cap, resetAt, exceeded}, weekly: {…}}`. */
export interface WindowLimits {
	limited?: boolean;
	/** Which window is over its cap right now, if any. */
	exceeded?: string | null;
	fiveHour?: WindowLimit | null;
	weekly?: WindowLimit | null;
	daily?: WindowLimit | null;
}

export interface CatalogModel {
	id: string;
	name: string;
	aliases?: string[];
	hidden?: boolean;
	category?: string | null;
	minimumPlan?: string | null;
	display?: { label?: string; group?: string; badge?: string | null; notice?: string | null };
	pricing?: { inputCost?: number; outputCost?: number };
}

export interface Catalog {
	data: CatalogModel[];
	roles?: { default?: string };
}

/** The CLI's plan ranking (`qr`), lowest first. */
const PLAN_ORDER = [
	"individual-go",
	"individual-go-v1",
	"individual-goat",
	"individual-pro",
	"individual-pro-v1",
	"individual-provider",
	"individual-max",
	"individual-ultra",
	"teams-pro",
];

/** The CLI's plan names (`Yr`). */
const PLAN_NAME: Record<string, string> = {
	"individual-go": "Go",
	"individual-go-v1": "Go",
	"individual-goat": "GOAT",
	"individual-pro": "Pro",
	"individual-pro-v1": "Pro",
	"individual-provider": "Provider",
	"individual-max": "Max",
	"individual-ultra": "Ultra",
	"teams-pro": "Teams Pro",
};

/** Free models need this much balance before a session may start. */
const FREE_MODEL_MIN_BALANCE = 1;

export function planName(planId: string | null | undefined): string {
	if (!planId) return "요금제 없음";
	return PLAN_NAME[planId] ?? planId.replace(/^individual-/, "");
}

export function balance(billing: Billing): number {
	return billing.monthlyCredits + billing.purchasedCredits + billing.freeCredits;
}

export function money(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** "Go · $X.XX" */
export function billingSummary(billing: Billing): string {
	return `${planName(billing.planId)} · ${money(balance(billing))}`;
}

export function isFreeModel(model: CatalogModel): boolean {
	const p = model.pricing;
	return (
		model.display?.badge === "free" ||
		/[:-]free$/i.test(model.id) ||
		(p !== undefined && (p.inputCost ?? 1) === 0 && (p.outputCost ?? 1) === 0)
	);
}

export function findModel(catalog: Catalog | null, id: string): CatalogModel | undefined {
	return catalog?.data.find((m) => m.id === id || m.aliases?.includes(id));
}

export type AccessKind = "plan" | "credits" | "free" | "locked" | "no-balance" | "free-needs-balance" | "unknown";

export interface ModelAccess {
	kind: AccessKind;
	allowed: boolean;
	/** Short reason for the dropdown and the model list. */
	note: string;
}

export function modelAccess(model: CatalogModel | undefined, billing: Billing | null): ModelAccess {
	if (!billing || !model) return { kind: "unknown", allowed: true, note: "" };
	const total = balance(billing);
	const free = isFreeModel(model);
	if (total <= 0) return { kind: "no-balance", allowed: false, note: "크레딧 없음" };
	if (free) {
		return total >= FREE_MODEL_MIN_BALANCE
			? { kind: "free", allowed: true, note: "무료" }
			: { kind: "free-needs-balance", allowed: false, note: `무료지만 잔액 ${money(FREE_MODEL_MIN_BALANCE)} 이상 필요` };
	}
	if (billing.purchasedCredits > 0 || billing.freeCredits > 0) {
		return { kind: "credits", allowed: true, note: "충전 크레딧" };
	}
	if (!billing.planId) return { kind: "credits", allowed: true, note: "" };
	const minimum = model.minimumPlan;
	if (minimum === null) return { kind: "locked", allowed: false, note: "Ultra 이상" };
	if (minimum === undefined) return { kind: "plan", allowed: true, note: "" };
	const have = PLAN_ORDER.indexOf(billing.planId);
	const need = PLAN_ORDER.indexOf(minimum);
	if (have < 0 || need < 0) return { kind: "plan", allowed: true, note: "" };
	return have >= need
		? { kind: "plan", allowed: true, note: "" }
		: { kind: "locked", allowed: false, note: `${planName(minimum)} 이상` };
}

/** Why an account can use nothing at all, or null when something works. */
export function accountBlocker(billing: Billing | null): string | null {
	if (!billing) return null;
	if (balance(billing) <= 0) {
		return billing.planId
			? `이번 달 크레딧을 모두 썼습니다 (${planName(billing.planId)}). 크레딧을 충전하거나 다른 계정으로 바꾸세요.`
			: "이 계정은 요금제와 크레딧이 없어 어떤 모델도 쓸 수 없습니다. 무료 모델도 잔액 $1 이상이 필요합니다.";
	}
	return null;
}

/** Monthly credit allowance per plan, in dollars (the CLI's `Tr`). */
const PLAN_ALLOWANCE: Record<string, number> = {
	"individual-go": 10,
	"individual-go-v1": 10,
	"individual-goat": 70,
	"individual-pro": 30,
	"individual-pro-v1": 80,
	"individual-provider": 15,
	"individual-max": 150,
	"individual-ultra": 300,
	"teams-pro": 40,
};

export interface UsageWindow {
	label: string;
	used: number;
	cap: number;
	percent: number;
	/** Epoch ms, when known. */
	resetAt: number | null;
	/** Over its cap: requests stop until `resetAt`. */
	exceeded: boolean;
}

export interface Usage {
	remaining: number;
	/** The month's pool (plan allowance + top-ups), when the plan is known. */
	pool: number | null;
	/** Share of the pool spent, 0-100; null when there is no plan to measure against. */
	percent: number | null;
	daysLeft: number | null;
	windows: UsageWindow[];
	/** The window that is over its cap right now, if any. */
	exceeded: UsageWindow | null;
}

function epochMs(value: number | string | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") return value <= 0 ? null : value > 1e12 ? value : value * 1000;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** The CLI's /usage numbers: spent share of the month's pool, days left, and
 * any 5-hour / daily / weekly windows, shortest first. */
export function usageOf(billing: Billing, now = Date.now()): Usage {
	const remaining = balance(billing);
	const allowance = billing.planId ? PLAN_ALLOWANCE[billing.planId] : undefined;
	const pool =
		allowance !== undefined
			? Math.max(allowance, billing.monthlyCredits) + billing.purchasedCredits + billing.freeCredits
			: null;
	const percent = pool && pool > 0 ? Math.min(100, Math.max(0, ((pool - remaining) / pool) * 100)) : null;
	const end = billing.periodEnd ? Date.parse(billing.periodEnd) : Number.NaN;
	const daysLeft = Number.isNaN(end) ? null : Math.max(0, Math.ceil((end - now) / 86_400_000));
	const limits = billing.windowLimits;
	const windows: UsageWindow[] = [];
	let exceeded: UsageWindow | null = null;
	const add = (key: "fiveHour" | "daily" | "weekly", label: string) => {
		const window = limits?.[key];
		if (!window || !window.cap) return;
		const resetAt = epochMs(window.resetAt);
		// Billing is fetched now and then; past its reset time the window is
		// empty again even though the last answer still says it is full.
		const reset = resetAt !== null && resetAt <= now;
		const used = reset ? 0 : (window.used ?? 0);
		const entry: UsageWindow = {
			label,
			used,
			cap: window.cap,
			percent: Math.min(100, (used / window.cap) * 100),
			resetAt: reset ? null : resetAt,
			exceeded: !reset && (window.exceeded === true || limits?.exceeded === key || used >= window.cap),
		};
		windows.push(entry);
		if (entry.exceeded && (!exceeded || limits?.exceeded === key)) exceeded = entry;
	};
	add("fiveHour", "5시간");
	add("daily", "일간");
	add("weekly", "주간");
	return { remaining, pool, percent, daysLeft, windows, exceeded };
}
