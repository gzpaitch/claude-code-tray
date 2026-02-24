import { exec } from "node:child_process";
import path from "node:path";
import {
	app,
	BrowserWindow,
	Menu,
	nativeImage,
	nativeTheme,
	screen,
	Tray,
} from "electron";
import {
	buildProgressBar,
	formatTokens,
	getModelShortName,
	readUsage,
	type UsageData,
	watchFiles,
} from "./usage";

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

function createTrayIcon(): Electron.NativeImage {
	const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png");
	try {
		const icon = nativeImage.createFromPath(iconPath);
		if (!icon.isEmpty()) {
			return icon.resize({ width: 16, height: 16 });
		}
	} catch {
		// fallback to generated icon
	}

	// Fallback: programmatic circle icon
	const size = 16;
	const canvas = Buffer.alloc(size * size * 4);

	const isDark = nativeTheme.shouldUseDarkColors;
	const fg = isDark ? [255, 255, 255, 255] : [0, 0, 0, 255];

	const cx = 8,
		cy = 8,
		r = 6;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
			if (dist <= r && dist >= r - 2) {
				const idx = (y * size + x) * 4;
				canvas[idx] = fg[0];
				canvas[idx + 1] = fg[1];
				canvas[idx + 2] = fg[2];
				canvas[idx + 3] = fg[3];
			}
		}
	}

	return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function buildTooltip(usage: UsageData): string {
	const lines = ["Claude Code Usage"];

	if (usage.rateLimit) {
		const rl = usage.rateLimit;
		const sessionPct = rl.sessionResetPassed
			? "reset"
			: `${Math.round(rl.sessionUsage * 100)}%`;
		const weeklyPct = rl.weeklyResetPassed
			? "reset"
			: `${Math.round(rl.weeklyUsage * 100)}%`;
		lines.push(`Session: ${sessionPct} | Week: ${weeklyPct} (${rl.ageLabel})`);
	}

	if (usage.today) {
		lines.push(
			`Today: ${usage.today.messageCount} msgs, ${usage.today.sessionCount} sessions`,
		);
	} else {
		lines.push("Today: no activity yet");
	}

	return lines.join("\n");
}

function buildContextMenu(usage: UsageData): Menu {
	const items: Electron.MenuItemConstructorOptions[] = [
		{ label: "Claude Code Usage", enabled: false },
		{ type: "separator" },
	];

	// Rate limits
	if (usage.rateLimit) {
		const rl = usage.rateLimit;
		const staleTag = rl.stale ? ` (${rl.ageLabel})` : "";

		// Session
		items.push({ label: "Current session", enabled: false });
		if (rl.sessionResetPassed) {
			items.push({
				label: "  Session has reset since last update",
				enabled: false,
			});
		} else {
			const sessionPct = Math.round(rl.sessionUsage * 100);
			items.push({
				label: `  ${buildProgressBar(rl.sessionUsage, 20)}  ${sessionPct}%`,
				enabled: false,
			});
			items.push({
				label: `  Resets ${rl.sessionResetTime}${staleTag}`,
				enabled: false,
			});
		}

		items.push({ type: "separator" });

		// Weekly
		items.push({ label: "Current week (all models)", enabled: false });
		if (rl.weeklyResetPassed) {
			items.push({
				label: "  Week has reset since last update",
				enabled: false,
			});
		} else {
			const weeklyPct = Math.round(rl.weeklyUsage * 100);
			items.push({
				label: `  ${buildProgressBar(rl.weeklyUsage, 20)}  ${weeklyPct}%`,
				enabled: false,
			});
			items.push({
				label: `  Resets ${rl.weeklyResetTime}${staleTag}`,
				enabled: false,
			});
		}

		if (rl.stale) {
			items.push({ type: "separator" });
			items.push({
				label: `  Data from ${rl.ageLabel} - updates when Claude Code runs`,
				enabled: false,
			});
		}

		items.push({ type: "separator" });
	} else {
		items.push({ label: "Rate limits: no data yet", enabled: false });
		items.push({ type: "separator" });
	}

	// Today
	if (usage.today) {
		items.push({
			label: `Today: ${usage.today.messageCount} messages, ${usage.today.sessionCount} sessions`,
			enabled: false,
		});
		items.push({
			label: `  ${usage.today.toolCallCount} tool calls`,
			enabled: false,
		});

		const tokenEntries = Object.entries(usage.todayTokens);
		for (const [model, tokens] of tokenEntries) {
			items.push({
				label: `  ${getModelShortName(model)}: ${formatTokens(tokens)} tokens`,
				enabled: false,
			});
		}
	} else {
		items.push({ label: "Today: no activity", enabled: false });
	}

	items.push({ type: "separator" });

	// Last 7 days
	items.push({ label: "Last 7 days:", enabled: false });
	for (const day of usage.last7Days) {
		const dateLabel = day.date.slice(5);
		items.push({
			label: `  ${dateLabel}: ${day.messageCount} msgs, ${day.sessionCount} sessions`,
			enabled: false,
		});
	}

	items.push({ type: "separator" });

	// Totals by model
	items.push({ label: "All-time by model:", enabled: false });
	for (const [model, data] of Object.entries(usage.modelUsage)) {
		const total =
			data.inputTokens +
			data.outputTokens +
			data.cacheReadInputTokens +
			data.cacheCreationInputTokens;
		items.push({
			label: `  ${getModelShortName(model)}: ${formatTokens(total)} total tokens`,
			enabled: false,
		});
	}

	items.push({ type: "separator" });
	items.push({
		label: `Total: ${usage.totalMessages.toLocaleString()} messages, ${usage.totalSessions} sessions`,
		enabled: false,
	});

	items.push({ type: "separator" });
	items.push({ label: "Details...", click: () => showDetailsWindow(usage) });
	items.push({ label: "Refresh", click: () => refreshTray() });
	items.push({ type: "separator" });
	items.push({ label: "Quit", click: () => app.quit() });

	return Menu.buildFromTemplate(items);
}

function generateDetailsHtml(usage: UsageData): string {
	const isDark = nativeTheme.shouldUseDarkColors;
	const rl = usage.rateLimit;

	const getBarColor = (pct: number, isDarkTheme: boolean) => {
		if (pct >= 90) return isDarkTheme ? "#ff99a4" : "#c42b1c";
		if (pct >= 70) return isDarkTheme ? "#fce100" : "#9d5d00";
		return isDarkTheme ? "#6ccb5f" : "#0f7b0f";
	};

	const rateLimitSection = rl
		? (() => {
				const sessionPct = Math.round(rl.sessionUsage * 100);
				const weeklyPct = Math.round(rl.weeklyUsage * 100);
				const staleBadge = rl.stale
					? `<span class="stale-badge">updated ${rl.ageLabel}</span>`
					: `<span class="fresh-badge">updated ${rl.ageLabel}</span>`;

				const sessionContent = rl.sessionResetPassed
					? `<div class="limit-block">
					<div class="limit-header"><span>Current session</span><span class="reset-note">reset since last update</span></div>
				</div>`
					: `<div class="limit-block">
					<div class="limit-header">
						<span>Current session</span>
						<span class="value">${sessionPct}%</span>
					</div>
					<div class="progress-track">
						<div class="progress-fill" style="width: ${sessionPct}%; background: ${getBarColor(sessionPct, isDark)}"></div>
					</div>
					<div class="reset-info">Resets ${rl.sessionResetTime}</div>
				</div>`;

				const weeklyContent = rl.weeklyResetPassed
					? `<div class="limit-block">
					<div class="limit-header"><span>Current week</span><span class="reset-note">reset since last update</span></div>
				</div>`
					: `<div class="limit-block">
					<div class="limit-header">
						<span>Current week (all models)</span>
						<span class="value">${weeklyPct}%</span>
					</div>
					<div class="progress-track">
						<div class="progress-fill" style="width: ${weeklyPct}%; background: ${getBarColor(weeklyPct, isDark)}"></div>
					</div>
					<div class="reset-info">Resets ${rl.weeklyResetTime}</div>
				</div>`;

				return `<div class="card">
				<div class="card-header"><h2>Rate Limits</h2>${staleBadge}</div>
				${sessionContent}
				${weeklyContent}
			</div>`;
			})()
		: `<div class="card"><h2>Rate Limits</h2><p class="muted">No data - run Claude Code to populate</p></div>`;

	const todaySection = usage.today
		? `<div class="card">
			<h2>Today</h2>
			<div class="stat-row"><span>Messages</span><span class="value">${usage.today.messageCount}</span></div>
			<div class="stat-row"><span>Sessions</span><span class="value">${usage.today.sessionCount}</span></div>
			<div class="stat-row"><span>Tool Calls</span><span class="value">${usage.today.toolCallCount}</span></div>
			${Object.entries(usage.todayTokens)
				.map(
					([m, t]) =>
						`<div class="stat-row"><span>${getModelShortName(m)}</span><span class="value">${formatTokens(t)} tokens</span></div>`,
				)
				.join("")}
		</div>`
		: `<div class="card"><h2>Today</h2><p class="muted">No activity yet</p></div>`;

	const last7Html = usage.last7Days
		.map(
			(d) => `<tr>
			<td>${d.date}</td>
			<td>${d.messageCount}</td>
			<td>${d.sessionCount}</td>
			<td>${d.toolCallCount}</td>
		</tr>`,
		)
		.join("");

	const modelsHtml = Object.entries(usage.modelUsage)
		.map(([model, data]) => {
			const total =
				data.inputTokens +
				data.outputTokens +
				data.cacheReadInputTokens +
				data.cacheCreationInputTokens;
			return `<div class="stat-row">
				<span>${getModelShortName(model)}</span>
				<span class="value">${formatTokens(total)}</span>
			</div>
			<div class="stat-detail">
				In: ${formatTokens(data.inputTokens)} | Out: ${formatTokens(data.outputTokens)} | Cache R: ${formatTokens(data.cacheReadInputTokens)} | Cache W: ${formatTokens(data.cacheCreationInputTokens)}
			</div>`;
		})
		.join("");

	const themeClass = isDark ? "dark" : "light";

	return `<!DOCTYPE html>
<html class="${themeClass}">
<head>
<style>
	:root {
		--bg-solid: #202020;
		--bg-card: rgba(255, 255, 255, 0.0419);
		--bg-card-hover: rgba(255, 255, 255, 0.0698);
		--text-primary: #ffffff;
		--text-secondary: #9d9d9d;
		--text-tertiary: #717171;
		--border-card: rgba(255, 255, 255, 0.0698);
		--border-subtle: rgba(255, 255, 255, 0.0419);
		--accent: #60cdff;
		--accent-text: #60cdff;
		--progress-track: rgba(255, 255, 255, 0.0698);
		--divider: rgba(255, 255, 255, 0.0837);
		--stale-bg: rgba(252, 225, 0, 0.12);
		--stale-text: #fce100;
		--fresh-bg: rgba(108, 203, 95, 0.12);
		--fresh-text: #6ccb5f;
	}
	html.light {
		--bg-solid: #f3f3f3;
		--bg-card: rgba(255, 255, 255, 0.7);
		--bg-card-hover: rgba(255, 255, 255, 0.85);
		--text-primary: #1a1a1a;
		--text-secondary: #616161;
		--text-tertiary: #8b8b8b;
		--border-card: rgba(0, 0, 0, 0.0578);
		--border-subtle: rgba(0, 0, 0, 0.0326);
		--accent: #005fb8;
		--accent-text: #003d7a;
		--progress-track: rgba(0, 0, 0, 0.0578);
		--divider: rgba(0, 0, 0, 0.0803);
		--stale-bg: rgba(157, 93, 0, 0.1);
		--stale-text: #9d5d00;
		--fresh-bg: rgba(15, 123, 15, 0.1);
		--fresh-text: #0f7b0f;
	}

	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
		background: transparent;
		color: var(--text-primary);
		padding: 16px;
		user-select: none;
		-webkit-app-region: no-drag;
		overflow-y: auto;
		font-size: 13px;
		line-height: 1.4;
	}
	body::-webkit-scrollbar { width: 10px; }
	body::-webkit-scrollbar-track { background: transparent; }
	body::-webkit-scrollbar-thumb { background: var(--text-tertiary); border-radius: 3px; }
	.titlebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
		padding-bottom: 8px;
		-webkit-app-region: drag;
	}
	h1 { font-size: 20px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.02em; }
	h2 { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 10px; }
	.card {
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-radius: 8px;
		padding: 14px 16px;
		margin-bottom: 8px;
		backdrop-filter: blur(2px);
	}
	.card-header { display: flex; align-items: center; gap: 8px; }
	.card-header h2 { margin-bottom: 10px; }
	.limit-block { margin-bottom: 14px; }
	.limit-block:last-child { margin-bottom: 0; }
	.limit-header {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		margin-bottom: 6px;
		color: var(--text-secondary);
	}
	.progress-track {
		width: 100%;
		height: 4px;
		background: var(--progress-track);
		border-radius: 2px;
		overflow: hidden;
	}
	.progress-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; }
	.reset-info { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; }
	.reset-note { font-size: 11px; color: var(--text-tertiary); font-style: italic; }
	.stale-badge {
		font-size: 10px; font-weight: 600;
		color: var(--stale-text); background: var(--stale-bg);
		padding: 2px 8px; border-radius: 99px;
		margin-bottom: 10px; display: inline-block;
	}
	.fresh-badge {
		font-size: 10px; font-weight: 600;
		color: var(--fresh-text); background: var(--fresh-bg);
		padding: 2px 8px; border-radius: 99px;
		margin-bottom: 10px; display: inline-block;
	}
	.stat-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 5px 0; font-size: 13px; color: var(--text-secondary);
	}
	.stat-row + .stat-row { border-top: 1px solid var(--divider); }
	.stat-detail {
		font-size: 11px; color: var(--text-tertiary);
		padding: 0 0 6px 0; border-bottom: 1px solid var(--divider);
	}
	.value { font-weight: 600; color: var(--accent-text); font-variant-numeric: tabular-nums; }
	.muted { color: var(--text-tertiary); font-size: 13px; }
	table { width: 100%; border-collapse: collapse; font-size: 12px; }
	th, td { padding: 6px 8px; text-align: left; }
	th {
		color: var(--text-secondary); font-weight: 600; font-size: 11px;
		text-transform: uppercase; letter-spacing: 0.04em;
		border-bottom: 1px solid var(--divider);
	}
	td { color: var(--text-secondary); border-bottom: 1px solid var(--border-subtle); }
	.footer { text-align: center; font-size: 11px; color: var(--text-tertiary); margin-top: 10px; }
	.close-btn {
		-webkit-app-region: no-drag;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 16px;
		font-family: inherit;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		padding: 0;
		line-height: 1;
	}
	.close-btn:hover { background: rgba(196, 43, 28, 0.9); color: #fff; }
	.accordion-trigger {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-radius: 8px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		-webkit-app-region: no-drag;
		margin-bottom: 8px;
		transition: background 0.15s, border-color 0.15s;
	}
	.accordion-trigger:hover { background: var(--bg-card-hover); }
	.accordion-trigger.open { border-radius: 8px 8px 0 0; margin-bottom: 0; border-bottom-color: var(--divider); }
	.accordion-chevron {
		width: 16px;
		height: 16px;
		transition: transform 0.2s ease;
		flex-shrink: 0;
	}
	.accordion-trigger.open .accordion-chevron { transform: rotate(180deg); }
	.extra-content {
		clip-path: inset(0);
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 0.25s ease;
		overflow: hidden;
	}
	.extra-content.visible { grid-template-rows: 1fr; }
	.extra-content-inner {
		min-height: 0;
		overflow: hidden;
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-top: none;
		border-radius: 0 0 8px 8px;
		padding: 0 16px;
		margin-bottom: 8px;
	}
	.launch-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	.launch-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 10px 0;
		background: var(--bg-card);
		border: 1px solid var(--border-card);
		border-radius: 8px;
		color: var(--text-primary);
		font-size: 13px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		-webkit-app-region: no-drag;
		transition: background 0.15s, border-color 0.15s;
	}
	.launch-btn:hover { background: var(--bg-card-hover); }
	.launch-btn .btn-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		border-radius: 4px;
	}
	.launch-btn .btn-text {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		line-height: 1.2;
	}
	.launch-btn .label-sub {
		font-size: 11px;
		font-weight: 400;
		color: var(--text-tertiary);
	}
</style>
</head>
<body>
	<div class="titlebar"><h1>Claude Code</h1><button class="close-btn" id="closeBtn" aria-label="Close">&#x2715;</button></div>
	${rateLimitSection}
	${todaySection}
	<button class="accordion-trigger" id="accordionBtn" aria-expanded="false" aria-controls="extraContent">
		<span>Detailed Stats</span>
		<svg class="accordion-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
	</button>
	<div class="extra-content" id="extraContent">
		<div class="extra-content-inner">
		<div class="card" style="border:none;padding:0;margin-bottom:0;background:transparent;">
			<h2>Last 7 Days</h2>
			<table>
				<tr><th>Date</th><th>Msgs</th><th>Sessions</th><th>Tools</th></tr>
				${last7Html}
			</table>
		</div>
		<div class="card" style="border:none;padding:8px 0 0;background:transparent;">
			<h2>All-time by Model</h2>
			${modelsHtml}
		</div>
		<div class="card" style="border:none;padding:8px 0 0;margin-bottom:0;background:transparent;">
			<div class="stat-row"><span>Total Messages</span><span class="value">${usage.totalMessages.toLocaleString()}</span></div>
			<div class="stat-row"><span>Total Sessions</span><span class="value">${usage.totalSessions}</span></div>
		</div>
		<div class="footer">Stats last computed ${usage.lastComputedDate}</div>
		</div>
	</div>
	<div class="launch-actions">
		<button class="launch-btn" id="launchClaude">
			<img class="btn-icon" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHNoYXBlLXJlbmRlcmluZz0iZ2VvbWV0cmljUHJlY2lzaW9uIiB0ZXh0LXJlbmRlcmluZz0iZ2VvbWV0cmljUHJlY2lzaW9uIiBpbWFnZS1yZW5kZXJpbmc9Im9wdGltaXplUXVhbGl0eSIgZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIHZpZXdCb3g9IjAgMCA1MTIgNTA5LjY0Ij48cGF0aCBmaWxsPSIjRDc3NjU1IiBkPSJNMTE1LjYxMiAwaDI4MC43NzVDNDU5Ljk3NCAwIDUxMiA1Mi4wMjYgNTEyIDExNS42MTJ2Mjc4LjQxNWMwIDYzLjU4Ny01Mi4wMjYgMTE1LjYxMi0xMTUuNjEzIDExNS42MTJIMTE1LjYxMkM1Mi4wMjYgNTA5LjYzOSAwIDQ1Ny42MTQgMCAzOTQuMDI3VjExNS42MTJDMCA1Mi4wMjYgNTIuMDI2IDAgMTE1LjYxMiAweiIvPjxwYXRoIGZpbGw9IiNGQ0YyRUUiIGZpbGwtcnVsZT0ibm9uemVybyIgZD0iTTE0Mi4yNyAzMTYuNjE5bDczLjY1NS00MS4zMjYgMS4yMzgtMy41ODktMS4yMzgtMS45OTYtMy41ODktLjAwMS0xMi4zMS0uNzU5LTQyLjA4NC0xLjEzOC0zNi40OTgtMS41MTYtMzUuMzYxLTEuODk2LTguODk3LTEuODk1LTguMzQtMTAuOTk1Ljg1OS01LjQ4NCA3LjQ4Mi01LjAzIDEwLjcxNy45MzUgMjMuNjgzIDEuNjE3IDM1LjUzNyAyLjQ1MiAyNS43ODIgMS41MTcgMzguMTkzIDMuOTY4aDYuMDY0bC44Ni0yLjQ1MS0yLjA3My0xLjUxNy0xLjYxOC0xLjUxNy0zNi43NzYtMjQuOTIyLTM5LjgxLTI2LjMzOC0yMC44NTItMTUuMTY2LTExLjI3My03LjY4My01LjY4Ny03LjIwNC0yLjQ1MS0xNS43MjEgMTAuMjM3LTExLjI3MyAxMy43NS45MzUgMy41MTMuOTM2IDEzLjkyOCAxMC43MTYgMjkuNzQ5IDIzLjAyNyAzOC44NDggMjguNjEyIDUuNjg3IDQuNzI3IDIuMjc1LTEuNjE3LjI3OC0xLjEzOC0yLjU1My00LjI3MS0yMS4xMy0zOC4xOTMtMjIuNTQ2LTM4Ljg0OC0xMC4wMzUtMTYuMTAxLTIuNjU0LTkuNjU1Yy0uOTM1LTMuOTY4LTEuNjE3LTcuMzA0LTEuNjE3LTExLjM3NGwxMS42NTItMTUuODIzIDYuNDQ1LTIuMDczIDE1LjU0NSAyLjA3MyA2LjU0NyA1LjY4NyA5LjY1NSAyMi4wOTIgMTUuNjQ2IDM0Ljc4IDI0LjI2NSA0Ny4yOTEgNy4xMDMgMTQuMDI4IDMuNzkxIDEyLjk5MiAxLjQxNiAzLjk2OCAyLjQ0OS0uMDAxdi0yLjI3NWwxLjk5Ny0yNi42NDEgMy42OS0zMi43MDcgMy41ODktNDIuMDg0IDEuMjM5LTExLjg1NCA1Ljg2My0xNC4yMDYgMTEuNjUyLTcuNjgzIDkuMDk5IDQuMzQ4IDcuNDgyIDEwLjcxNi0xLjAzNiA2LjkyNi00LjQ0OSAyOC45MTUtOC43MiA0NS4yOTQtNS42ODcgMzAuMzMxaDMuMzEzbDMuNzkyLTMuNzkxIDE1LjM0Mi0yMC4zNzIgMjUuNzgyLTMyLjIyNyAxMS4zNzQtMTIuNzg5IDEzLjI3LTE0LjEyOSA4LjUxNy02LjcyNCAxNi4xLS4wMDEgMTEuODU0IDE3LjYxNy01LjMwNyAxOC4xOTktMTYuNTgxIDIxLjAyOS0xMy43NSAxNy44MTktMTkuNzE2IDI2LjU0LTEyLjMwOSAyMS4yMzEgMS4xMzggMS42OTQgMi45MzItLjI3OCA0NC41MzYtOS40NzkgMjQuMDYyLTQuMzQ3IDI4LjcxNC00LjkyOCAxMi45OTIgNi4wNjYgMS40MTYgNi4xNjctNS4xMDYgMTIuNjEzLTMwLjcxIDcuNTgzLTM2LjAxOCA3LjIwNC01My42MzYgMTIuNjg5LS42NTcuNDguNzU4LjkzNSAyNC4xNjQgMi4yNzUgMTAuMzM3LjU1NmgyNS4zMDFsNDcuMTE0IDMuNTE0IDEyLjMwOSA4LjEzOSA3LjM4MSA5Ljk1OS0xLjIzOCA3LjU4My0xOC45NTcgOS42NTUtMjUuNTc5LTYuMDY2LTU5LjcwMi0xNC4yMDUtMjAuNDc0LTUuMTA2LTIuODMtLjAwMXYxLjY5NGwxNy4wNjEgMTYuNjgyIDMxLjI2NiAyOC4yMzMgMzkuMTUyIDM2LjM5NyAxLjk5NyA4Ljk5OS01LjAzIDcuMTAyLTUuMzA3LS43NTgtMzQuNDAxLTI1Ljg4My0xMy4yNy0xMS42NTEtMzAuMDUzLTI1LjMwMi0xLjk5Ni0uMDAxdjIuNjU0bDYuOTI2IDEwLjEzNiAzNi41NzQgNTQuOTc1IDEuODk1IDE2Ljg1OS0yLjY1MyA1LjQ4NS05LjQ3OSAzLjMxMS0xMC40MTQtMS44OTUtMjEuNDA4LTMwLjA1NC0yMi4wOTItMzMuODQ0LTE3LjgxOS0zMC4zMzEtMi4xNzMgMS4yMzgtMTAuNTE1IDExMy4yNjEtNC45MjkgNS43ODgtMTEuMzc0IDQuMzQ4LTkuNDc4LTcuMjA0LTUuMDMtMTEuNjUyIDUuMDMtMjMuMDI3IDYuMDY2LTMwLjA1MiA0LjkyOC0yMy44ODYgNC40NDktMjkuNjc0IDIuNjU0LTkuODU4LS4xNzctLjY1Ny0yLjE3My4yNzgtMjIuMzcgMzAuNzEtMzQuMDIxIDQ1Ljk3Ny0yNi45MTkgMjguODE1LTYuNDQ1IDIuNTUzLTExLjE3My01Ljc4OSAxLjAzNy0xMC4zMzcgNi4yNDMtOS4yIDM3LjI1Ny00Ny4zOTIgMjIuNDctMjkuMzcxIDE0LjUwOC0xNi45NjEtLjEwMS0yLjQ1MWgtLjg1OWwtOTguOTU0IDY0LjI1MS0xNy42MTggMi4yNzUtNy41ODMtNy4xMDMuOTM2LTExLjY1MiAzLjU4OS0zLjc5MSAyOS43NDktMjAuNDc0LS4xMDEuMTAyLjAyNC4xMDF6Ii8+PC9zdmc+" alt="Claude" />
			<span class="btn-text">Claude Code<span class="label-sub">Normal</span></span>
		</button>
		<button class="launch-btn" id="launchYolo">
			<img class="btn-icon" src="data:image/svg+xml;base64,PHN2ZyB2ZXJzaW9uPSIxLjIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDUxMiA1MTAiIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEwIj4KCTxzdHlsZT4KCQkuczAgeyBmaWxsOiAjZTIzZDNkIH0gCgkJLnMxIHsgZmlsbDogI2ZjZjJlZSB9IAoJPC9zdHlsZT4KCTxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xhc3M9InMwIiBkPSJtMTE1LjYxIDBoMjgwLjc4YzYzLjU4IDAgMTE1LjYxIDUyLjAzIDExNS42MSAxMTUuNjF2Mjc4LjQyYzAgNjMuNTgtNTIuMDMgMTE1LjYxLTExNS42MSAxMTUuNjFoLTI4MC43OGMtNjMuNTggMC0xMTUuNjEtNTIuMDMtMTE1LjYxLTExNS42MXYtMjc4LjQyYzAtNjMuNTggNTIuMDMtMTE1LjYxIDExNS42MS0xMTUuNjF6Ii8+Cgk8cGF0aCBjbGFzcz0iczEiIGQ9Im0xNDIuMjcgMzE2LjYybDczLjY2LTQxLjMzIDEuMjMtMy41OS0xLjIzLTEuOTloLTMuNTlsLTEyLjMxLTAuNzYtNDIuMDktMS4xNC0zNi41LTEuNTItMzUuMzYtMS44OS04Ljg5LTEuOS04LjM0LTEwLjk5IDAuODYtNS40OSA3LjQ4LTUuMDMgMTAuNzEgMC45NCAyMy42OSAxLjYyIDM1LjUzIDIuNDUgMjUuNzkgMS41MiAzOC4xOSAzLjk2aDYuMDZsMC44Ni0yLjQ1LTIuMDctMS41MS0xLjYyLTEuNTItMzYuNzctMjQuOTItMzkuODEtMjYuMzQtMjAuODYtMTUuMTctMTEuMjctNy42OC01LjY5LTcuMi0yLjQ1LTE1LjczIDEwLjI0LTExLjI3IDEzLjc1IDAuOTQgMy41MSAwLjkzIDEzLjkzIDEwLjcyIDI5Ljc1IDIzLjAzIDM4Ljg1IDI4LjYxIDUuNjkgNC43MiAyLjI3LTEuNjEgMC4yOC0xLjE0LTIuNTUtNC4yNy0yMS4xMy0zOC4xOS0yMi41NS0zOC44NS0xMC4wNC0xNi4xLTIuNjUtOS42NmMtMC45My0zLjk3LTEuNjItNy4zLTEuNjItMTEuMzdsMTEuNjYtMTUuODMgNi40NC0yLjA3IDE1LjU1IDIuMDcgNi41NCA1LjY5IDkuNjYgMjIuMDkgMTUuNjQgMzQuNzggMjQuMjcgNDcuMjkgNy4xIDE0LjAzIDMuNzkgMTIuOTkgMS40MiAzLjk3aDIuNDV2LTIuMjdsMS45OS0yNi42NCAzLjY5LTMyLjcxIDMuNTktNDIuMDkgMS4yNC0xMS44NSA1Ljg3LTE0LjIxIDExLjY1LTcuNjggOS4xIDQuMzUgNy40OCAxMC43Mi0xLjA0IDYuOTItNC40NSAyOC45Mi04LjcyIDQ1LjI5LTUuNjggMzAuMzNoMy4zMWwzLjc5LTMuNzkgMTUuMzQtMjAuMzcgMjUuNzgtMzIuMjMgMTEuMzgtMTIuNzkgMTMuMjctMTQuMTMgOC41Mi02LjcyaDE2LjFsMTEuODUgMTcuNjItNS4zMSAxOC4xOS0xNi41OCAyMS4wMy0xMy43NSAxNy44Mi0xOS43MSAyNi41NC0xMi4zMSAyMS4yMyAxLjEzIDEuNyAyLjk0LTAuMjggNDQuNTMtOS40OCAyNC4wNi00LjM1IDI4LjcyLTQuOTMgMTIuOTkgNi4wNyAxLjQyIDYuMTctNS4xMSAxMi42MS0zMC43MSA3LjU4LTM2LjAyIDcuMjEtNTMuNjMgMTIuNjktMC42NiAwLjQ4IDAuNzYgMC45MyAyNC4xNiAyLjI4IDEwLjM0IDAuNTVoMjUuM2w0Ny4xMSAzLjUyIDEyLjMxIDguMTQgNy4zOCA5Ljk2LTEuMjMgNy41OC0xOC45NiA5LjY1LTI1LjU4LTYuMDYtNTkuNy0xNC4yMS0yMC40OC01LjFoLTIuODN2MS42OWwxNy4wNiAxNi42OCAzMS4yNyAyOC4yMyAzOS4xNSAzNi40IDIgOS01LjAzIDcuMS01LjMxLTAuNzYtMzQuNC0yNS44OC0xMy4yNy0xMS42NS0zMC4wNS0yNS4zaC0ydjIuNjVsNi45MyAxMC4xNCAzNi41NyA1NC45NyAxLjkgMTYuODYtMi42NiA1LjQ5LTkuNDcgMy4zMS0xMC40Mi0xLjktMjEuNDEtMzAuMDUtMjIuMDktMzMuODUtMTcuODItMzAuMzMtMi4xNyAxLjI0LTEwLjUyIDExMy4yNi00LjkyIDUuNzktMTEuMzggNC4zNS05LjQ4LTcuMjEtNS4wMy0xMS42NSA1LjAzLTIzLjAyIDYuMDctMzAuMDYgNC45My0yMy44OCA0LjQ1LTI5LjY4IDIuNjUtOS44NS0wLjE4LTAuNjYtMi4xNyAwLjI4LTIyLjM3IDMwLjcxLTM0LjAyIDQ1Ljk3LTI2LjkyIDI4LjgyLTYuNDQgMi41NS0xMS4xOC01Ljc5IDEuMDQtMTAuMzMgNi4yNC05LjIgMzcuMjYtNDcuNCAyMi40Ny0yOS4zNyAxNC41MS0xNi45Ni0wLjEtMi40NWgtMC44NmwtOTguOTYgNjQuMjUtMTcuNjEgMi4yOC03LjU5LTcuMTEgMC45NC0xMS42NSAzLjU5LTMuNzkgMjkuNzUtMjAuNDctMC4xIDAuMXoiLz4KPC9zdmc+" alt="Claude YOLO" />
			<span class="btn-text">Claude Code<span class="label-sub">YOLO</span></span>
		</button>
	</div>
	<script>
		document.getElementById('closeBtn').addEventListener('click', () => window.close());
		document.getElementById('launchClaude').addEventListener('click', () => console.log('__launch:claude'));
		document.getElementById('launchYolo').addEventListener('click', () => console.log('__launch:claude-yolo'));
		const btn = document.getElementById('accordionBtn');
		const extra = document.getElementById('extraContent');
		const COLLAPSED_H = 420;
		const EXPANDED_H = 720;
		btn.addEventListener('click', () => {
			const visible = extra.classList.toggle('visible');
			btn.classList.toggle('open', visible);
			btn.setAttribute('aria-expanded', String(visible));
			console.log('__resize:' + (visible ? EXPANDED_H : COLLAPSED_H));
		});
	</script>
</body>
</html>`;
}

function showDetailsWindow(usage: UsageData) {
	if (win && !win.isDestroyed()) {
		win.focus();
		return;
	}

	const isDark = nativeTheme.shouldUseDarkColors;
	const winWidth = 400;
	const winHeight = 420;

	// Position near the system tray (bottom-right on Windows)
	const trayBounds = tray?.getBounds();
	const display = trayBounds
		? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
		: screen.getPrimaryDisplay();
	const workArea = display.workArea;

	let x: number;
	let y: number;

	if (trayBounds && trayBounds.x > 0) {
		// Center horizontally on the tray icon, clamp to screen
		x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
		x = Math.max(
			workArea.x,
			Math.min(x, workArea.x + workArea.width - winWidth),
		);
		// Place above the taskbar
		y = workArea.y + workArea.height - winHeight;
	} else {
		// Fallback: bottom-right of work area
		x = workArea.x + workArea.width - winWidth - 12;
		y = workArea.y + workArea.height - winHeight;
	}

	win = new BrowserWindow({
		width: winWidth,
		height: winHeight,
		x,
		y,
		resizable: false,
		frame: false,
		transparent: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		roundedCorners: true,
		backgroundColor: isDark ? "#202020" : "#f3f3f3",
		backgroundMaterial: "mica",
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	const html = generateDetailsHtml(usage);
	win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

	win.webContents.on("console-message", (e) => {
		const message = e.message;
		if (message.startsWith("__resize:") && win && !win.isDestroyed()) {
			const newHeight = parseInt(message.split(":")[1], 10);
			if (newHeight > 0) {
				const bounds = win.getBounds();
				const dy = newHeight - bounds.height;
				win.setBounds({
					x: bounds.x,
					y: bounds.y - dy,
					width: bounds.width,
					height: newHeight,
				});
			}
		}
		if (message === "__launch:claude") {
			exec('start cmd /k "claude"');
		}
		if (message === "__launch:claude-yolo") {
			exec('start cmd /k "claude --dangerously-skip-permissions"');
		}
	});

	win.on("blur", () => {
		if (win && !win.isDestroyed()) win.close();
	});

	win.on("closed", () => {
		win = null;
	});
}

function refreshTray() {
	if (!tray) return;
	try {
		const usage = readUsage();
		tray.setToolTip(buildTooltip(usage));
		tray.setContextMenu(buildContextMenu(usage));
	} catch (err) {
		console.error("Failed to read usage:", err);
		tray.setToolTip("Claude Code Usage - Error reading stats");
	}
}

app.whenReady().then(() => {
	if (process.platform === "darwin") app.dock?.hide();

	tray = new Tray(createTrayIcon());
	refreshTray();

	tray.on("click", () => {
		try {
			const usage = readUsage();
			showDetailsWindow(usage);
		} catch {
			// fallback to context menu
		}
	});

	// Watch for file changes from Claude Code sessions
	watchFiles(() => {
		console.log("File change detected, refreshing...");
		refreshTray();
	});

	// Also poll every 30 seconds to update age labels
	refreshInterval = setInterval(refreshTray, 30_000);
});

app.on("window-all-closed", () => {
	// keep running in tray
});

app.on("before-quit", () => {
	if (refreshInterval) clearInterval(refreshInterval);
});
