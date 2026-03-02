import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitData } from "./usage";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT = 15_000;

interface OAuthCredentials {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
	scopes: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
}

interface CredentialsFile {
	claudeAiOauth: OAuthCredentials;
}

interface OAuthUsageWindow {
	utilization?: number;
	resets_at?: string;
}

interface OAuthExtraUsage {
	is_enabled?: boolean;
	monthly_limit?: number;
	used_credits?: number;
	utilization?: number;
	currency?: string;
}

interface OAuthUsageResponse {
	five_hour?: OAuthUsageWindow;
	seven_day?: OAuthUsageWindow;
	seven_day_opus?: OAuthUsageWindow;
	seven_day_sonnet?: OAuthUsageWindow;
	extra_usage?: OAuthExtraUsage;
}

function formatResetTimeFromISO(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const ampm = hours >= 12 ? "pm" : "am";
	const h = hours % 12 || 12;
	const m = minutes > 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
	return `${h}${m}${ampm}`;
}

function hasResetPassed(iso: string | undefined): boolean {
	if (!iso) return false;
	return Date.now() > new Date(iso).getTime();
}

async function readCredentials(): Promise<OAuthCredentials | null> {
	try {
		const raw = await readFile(CREDENTIALS_PATH, "utf-8");
		const data: CredentialsFile = JSON.parse(raw);
		const creds = data.claudeAiOauth;
		if (!creds?.accessToken) return null;
		// Check if token is expired
		if (creds.expiresAt && Date.now() > creds.expiresAt) return null;
		return creds;
	} catch {
		return null;
	}
}

export async function fetchOAuthUsage(): Promise<RateLimitData | null> {
	const creds = await readCredentials();
	if (!creds) return null;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

		const response = await fetch(USAGE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "claude-code-tray",
			},
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) return null;

		const data = (await response.json()) as OAuthUsageResponse;

		const sessionUtil = data.five_hour?.utilization ?? 0;
		const weeklyUtil = data.seven_day?.utilization ?? 0;
		const opusUtil = data.seven_day_opus?.utilization;
		const sonnetUtil = data.seven_day_sonnet?.utilization;

		const toEpoch = (iso?: string) => (iso ? new Date(iso).getTime() : 0);

		return {
			sessionUsage: sessionUtil / 100,
			weeklyUsage: weeklyUtil / 100,
			sessionResetTime: data.five_hour?.resets_at
				? formatResetTimeFromISO(data.five_hour.resets_at)
				: "",
			weeklyResetTime: data.seven_day?.resets_at
				? formatResetTimeFromISO(data.seven_day.resets_at)
				: "",
			sessionResetEpoch: toEpoch(data.five_hour?.resets_at),
			weeklyResetEpoch: toEpoch(data.seven_day?.resets_at),
			sessionResetPassed: hasResetPassed(data.five_hour?.resets_at),
			weeklyResetPassed: hasResetPassed(data.seven_day?.resets_at),
			ageLabel: "just now",
			stale: false,
			source: "oauth",
			opusUsage: opusUtil != null ? opusUtil / 100 : undefined,
			opusResetTime: data.seven_day_opus?.resets_at
				? formatResetTimeFromISO(data.seven_day_opus.resets_at)
				: undefined,
			opusResetEpoch: toEpoch(data.seven_day_opus?.resets_at) || undefined,
			sonnetUsage: sonnetUtil != null ? sonnetUtil / 100 : undefined,
			sonnetResetTime: data.seven_day_sonnet?.resets_at
				? formatResetTimeFromISO(data.seven_day_sonnet.resets_at)
				: undefined,
			sonnetResetEpoch: toEpoch(data.seven_day_sonnet?.resets_at) || undefined,
			subscriptionType: creds.subscriptionType,
		};
	} catch {
		return null;
	}
}

export async function getSubscriptionType(): Promise<string | undefined> {
	const creds = await readCredentials();
	return creds?.subscriptionType;
}
