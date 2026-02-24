import { readFile as readFileCb, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface DailyActivity {
	date: string;
	messageCount: number;
	sessionCount: number;
	toolCallCount: number;
}

interface DailyModelTokens {
	date: string;
	tokensByModel: Record<string, number>;
}

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUSD: number;
}

interface StatsCache {
	version: number;
	lastComputedDate: string;
	dailyActivity: DailyActivity[];
	dailyModelTokens: DailyModelTokens[];
	modelUsage: Record<string, ModelUsage>;
	totalSessions: number;
	totalMessages: number;
	firstSessionDate: string;
	hourCounts: Record<string, number>;
}

interface RateLimitCache {
	session5h: number;
	weekly7d: number;
	reset5h: number;
	reset7d: number;
	timestamp: number;
}

export interface RateLimitData {
	sessionUsage: number; // 0-1
	weeklyUsage: number; // 0-1
	sessionResetTime: string;
	weeklyResetTime: string;
	sessionResetPassed: boolean;
	weeklyResetPassed: boolean;
	ageLabel: string; // human readable age
	stale: boolean;
}

export interface UsageData {
	today: DailyActivity | null;
	todayTokens: Record<string, number>;
	totalSessions: number;
	totalMessages: number;
	modelUsage: Record<string, ModelUsage>;
	lastComputedDate: string;
	last7Days: DailyActivity[];
	rateLimit: RateLimitData | null;
}

export const CLAUDE_DIR = join(homedir(), ".claude");
const STATS_PATH = join(CLAUDE_DIR, "stats-cache.json");
const RATE_LIMIT_PATH = join(CLAUDE_DIR, "rate-limit-cache.json");

function formatResetTime(epoch: number): string {
	const date = new Date(epoch * 1000);
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const ampm = hours >= 12 ? "pm" : "am";
	const h = hours % 12 || 12;
	const m = minutes > 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
	return `${h}${m}${ampm}`;
}

function formatAge(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function parseRateLimit(raw: string): RateLimitData | null {
	try {
		const data: RateLimitCache = JSON.parse(raw);
		const now = Date.now();
		const ageMs = now - data.timestamp;
		const nowSec = Math.floor(now / 1000);

		return {
			sessionUsage: data.session5h / 100,
			weeklyUsage: data.weekly7d / 100,
			sessionResetTime: formatResetTime(data.reset5h),
			weeklyResetTime: formatResetTime(data.reset7d),
			sessionResetPassed: nowSec > data.reset5h,
			weeklyResetPassed: nowSec > data.reset7d,
			ageLabel: formatAge(ageMs),
			stale: ageMs > 5 * 60 * 1000, // 5 min
		};
	} catch {
		return null;
	}
}

function readRateLimit(): RateLimitData | null {
	try {
		const raw = readFileSync(RATE_LIMIT_PATH, "utf-8");
		return parseRateLimit(raw);
	} catch {
		return null;
	}
}

function parseUsage(statsRaw: string, rateLimitRaw?: string): UsageData {
	const stats: StatsCache = JSON.parse(statsRaw);
	const todayStr = new Date().toISOString().split("T")[0];

	const today = stats.dailyActivity.find((d) => d.date === todayStr) ?? null;
	const todayTokens =
		stats.dailyModelTokens.find((d) => d.date === todayStr)?.tokensByModel ??
		{};

	const last7 = stats.dailyActivity.slice(-7);

	return {
		today,
		todayTokens,
		totalSessions: stats.totalSessions,
		totalMessages: stats.totalMessages,
		modelUsage: stats.modelUsage,
		lastComputedDate: stats.lastComputedDate,
		last7Days: last7,
		rateLimit: rateLimitRaw ? parseRateLimit(rateLimitRaw) : readRateLimit(),
	};
}

export function readUsage(): UsageData {
	const raw = readFileSync(STATS_PATH, "utf-8");
	return parseUsage(raw);
}

function readFileAsync(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		readFileCb(path, "utf-8", (err, data) => {
			if (err) reject(err);
			else resolve(data);
		});
	});
}

export async function readUsageAsync(): Promise<UsageData> {
	const [statsRaw, rateLimitRaw] = await Promise.all([
		readFileAsync(STATS_PATH),
		readFileAsync(RATE_LIMIT_PATH).catch(() => undefined),
	]);
	return parseUsage(statsRaw, rateLimitRaw);
}

export function watchFiles(onChange: () => void): void {
	const debounce = (fn: () => void, ms: number) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		return () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(fn, ms);
		};
	};
	const debouncedChange = debounce(onChange, 500);

	try {
		watch(RATE_LIMIT_PATH, debouncedChange);
	} catch {
		// file may not exist yet
	}
	try {
		watch(STATS_PATH, debouncedChange);
	} catch {
		// file may not exist yet
	}
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

export function getModelShortName(model: string): string {
	if (model.includes("opus-4-6")) return "Opus 4.6";
	if (model.includes("opus-4-5")) return "Opus 4.5";
	if (model.includes("sonnet-4-6")) return "Sonnet 4.6";
	if (model.includes("sonnet-4-5")) return "Sonnet 4.5";
	if (model.includes("haiku")) return "Haiku";
	return model.split("-").slice(0, 3).join(" ");
}

export function buildProgressBar(ratio: number, width: number = 25): string {
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

export function getTotalTokens(data: ModelUsage): number {
	return (
		data.inputTokens +
		data.outputTokens +
		data.cacheReadInputTokens +
		data.cacheCreationInputTokens
	);
}
