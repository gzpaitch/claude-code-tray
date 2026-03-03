import { spawn } from "node:child_process";
import * as path from "node:path";
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
	formatTimeUntil,
	generateDetailsHtml,
	getRateLimitBlocks,
	WINDOW_HEIGHT_COLLAPSED,
} from "./details-html";
import { fetchOAuthUsage } from "./oauth-usage";
import {
	buildProgressBar,
	formatTokens,
	getModelShortName,
	getTotalTokens,
	readUsageAsync,
	type UsageData,
	watchFiles,
} from "./usage";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let cachedOAuthRateLimit: UsageData["rateLimit"] = null;

async function refreshOAuthUsage(): Promise<void> {
	const oauth = await fetchOAuthUsage();
	if (oauth) cachedOAuthRateLimit = oauth;
}

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
	const sub = usage.rateLimit?.subscriptionType;
	const title = sub ? `Claude Code (${sub})` : "Claude Code Usage";
	const lines = [title];

	if (usage.rateLimit) {
		const rl = usage.rateLimit;
		const sessionPct = rl.sessionResetPassed
			? "reset"
			: `${Math.round(rl.sessionUsage * 100)}%`;
		const weeklyPct = rl.weeklyResetPassed
			? "reset"
			: `${Math.round(rl.weeklyUsage * 100)}%`;
		const src = rl.source === "oauth" ? "live" : rl.ageLabel;
		lines.push(`Session: ${sessionPct} | Week: ${weeklyPct} (${src})`);
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

type MenuItem = Electron.MenuItemConstructorOptions;

function buildRateLimitMenuItems(usage: UsageData): MenuItem[] {
	const blocks = getRateLimitBlocks(usage.rateLimit);
	if (!blocks || !usage.rateLimit) {
		return [
			{ label: "Rate limits: no data yet", enabled: false },
			{ type: "separator" },
		];
	}

	const rl = usage.rateLimit;
	const staleTag = rl.stale ? ` (${rl.ageLabel})` : "";
	const items: MenuItem[] = [];

	for (const block of blocks) {
		const pct = Math.round(block.usage * 100);
		const countdown =
			block.resetEpoch > Date.now()
				? ` (in ${formatTimeUntil(block.resetEpoch)})`
				: "";
		items.push(
			{ label: block.label, enabled: false },
			{
				label: `  ${buildProgressBar(block.usage, 20)}  ${pct}%`,
				enabled: false,
			},
			{
				label: `  Resets ${block.resetTime}${countdown}${staleTag}`,
				enabled: false,
			},
			{ type: "separator" },
		);
	}

	if (rl.stale) {
		items.push(
			{
				label: `  Data from ${rl.ageLabel} - updates when Claude Code runs`,
				enabled: false,
			},
			{ type: "separator" },
		);
	}

	return items;
}

function buildTodayMenuItems(usage: UsageData): MenuItem[] {
	if (!usage.today) {
		return [{ label: "Today: no activity", enabled: false }];
	}

	const items: MenuItem[] = [
		{
			label: `Today: ${usage.today.messageCount} messages, ${usage.today.sessionCount} sessions`,
			enabled: false,
		},
		{ label: `  ${usage.today.toolCallCount} tool calls`, enabled: false },
	];

	for (const [model, tokens] of Object.entries(usage.todayTokens)) {
		items.push({
			label: `  ${getModelShortName(model)}: ${formatTokens(tokens)} tokens`,
			enabled: false,
		});
	}

	return items;
}

function buildLast7DaysMenuItems(usage: UsageData): MenuItem[] {
	const items: MenuItem[] = [{ label: "Last 7 days:", enabled: false }];
	for (const day of usage.last7Days) {
		items.push({
			label: `  ${day.date.slice(5)}: ${day.messageCount} msgs, ${day.sessionCount} sessions`,
			enabled: false,
		});
	}
	return items;
}

function buildModelTotalsMenuItems(usage: UsageData): MenuItem[] {
	const items: MenuItem[] = [{ label: "All-time by model:", enabled: false }];
	for (const [model, data] of Object.entries(usage.modelUsage)) {
		items.push({
			label: `  ${getModelShortName(model)}: ${formatTokens(getTotalTokens(data))} total tokens`,
			enabled: false,
		});
	}
	return items;
}

function buildAutoStartMenuItem(): MenuItem {
	const loginSettings = app.getLoginItemSettings();
	return {
		label: "Start with Windows",
		type: "checkbox",
		checked: loginSettings.openAtLogin,
		click: (menuItem) => {
			const exePath = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
			app.setLoginItemSettings(
				menuItem.checked
					? { openAtLogin: true, path: exePath }
					: { openAtLogin: false },
			);
		},
	};
}

function buildContextMenu(usage: UsageData): Menu {
	const items: MenuItem[] = [
		{ label: "Claude Code Usage", enabled: false },
		{ type: "separator" },
		...buildRateLimitMenuItems(usage),
		...buildTodayMenuItems(usage),
		{ type: "separator" },
		...buildLast7DaysMenuItems(usage),
		{ type: "separator" },
		...buildModelTotalsMenuItems(usage),
		{ type: "separator" },
		{
			label: `Total: ${usage.totalMessages.toLocaleString()} messages, ${usage.totalSessions} sessions`,
			enabled: false,
		},
		{ type: "separator" },
		{ label: "Details...", click: () => showDetailsWindow(usage) },
		{ label: "Refresh", click: () => refreshTray() },
		buildAutoStartMenuItem(),
		{ type: "separator" },
		{ label: "Quit", click: () => app.quit() },
	];

	return Menu.buildFromTemplate(items);
}

function showDetailsWindow(usage: UsageData) {
	const html = generateDetailsHtml(usage);

	if (win && !win.isDestroyed()) {
		win.webContents.once("did-finish-load", () => {
			if (win && !win.isDestroyed()) {
				win.show();
				win.focus();
			}
		});
		win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		return;
	}

	const winWidth = 400;
	const winHeight = WINDOW_HEIGHT_COLLAPSED;

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
		movable: false,
		frame: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		roundedCorners: true,
		transparent: true,
		hasShadow: false,
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	win.webContents.once("did-finish-load", () => {
		if (win && !win.isDestroyed()) {
			win.show();
			win.focus();
		}
	});
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
		if (message === "__hide") {
			if (win && !win.isDestroyed()) win.hide();
		}
		if (message === "__launch:claude") {
			spawn("cmd", ["/k", "claude"], { detached: true, stdio: "ignore" });
		}
		if (message === "__launch:claude-yolo") {
			spawn("cmd", ["/k", "claude", "--dangerously-skip-permissions"], {
				detached: true,
				stdio: "ignore",
			});
		}
	});

	win.on("blur", () => {
		if (win && !win.isDestroyed()) win.hide();
	});

	win.on("close", (e) => {
		if (win && !win.isDestroyed()) {
			e.preventDefault();
			win.hide();
		}
	});
}

async function safeReadUsage(): Promise<UsageData | null> {
	try {
		return await readUsageAsync();
	} catch (err) {
		console.error("Failed to read usage:", err);
		return null;
	}
}

async function refreshTray() {
	if (!tray) return;
	const usage = await safeReadUsage();
	if (usage) {
		if (cachedOAuthRateLimit) {
			usage.rateLimit = cachedOAuthRateLimit;
		}
		tray.setToolTip(buildTooltip(usage));
		tray.setContextMenu(buildContextMenu(usage));
	} else {
		tray.setToolTip("Claude Code Usage - Waiting for data");
		const fallbackItems: Electron.MenuItemConstructorOptions[] = [
			{ label: "Claude Code Usage", enabled: false },
			{ type: "separator" },
			{ label: "No stats file found yet.", enabled: false },
			{ label: "Run Claude Code to generate usage data.", enabled: false },
			{ type: "separator" },
			{ label: "Refresh", click: () => refreshTray() },
			{ type: "separator" },
			{ label: "Quit", click: () => app.quit() },
		];
		tray.setContextMenu(Menu.buildFromTemplate(fallbackItems));
	}
}

app.whenReady().then(async () => {
	if (process.platform === "darwin") app.dock?.hide();

	const exePath = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
	if (exePath.includes("node_modules")) {
		// In dev mode, ensure no stale login item is registered
		app.setLoginItemSettings({ openAtLogin: false });
	} else {
		// Enable auto-start by default if not already configured
		const loginSettings = app.getLoginItemSettings();
		if (!loginSettings.openAtLogin) {
			app.setLoginItemSettings({ openAtLogin: true, path: exePath });
		}
	}

	tray = new Tray(createTrayIcon());

	// Fetch live OAuth usage on startup
	await refreshOAuthUsage();
	refreshTray();

	tray.on("click", async () => {
		const usage = await safeReadUsage();
		if (usage) {
			if (cachedOAuthRateLimit) usage.rateLimit = cachedOAuthRateLimit;
			showDetailsWindow(usage);
		}
	});

	// Watch for file changes from Claude Code sessions
	watchFiles(() => {
		console.log("File change detected, refreshing...");
		refreshTray();
	});

	// Poll OAuth every 60s for live data and refresh tray
	refreshInterval = setInterval(async () => {
		await refreshOAuthUsage();
		await refreshTray();
	}, 60_000);
});

app.on("window-all-closed", () => {
	// keep running in tray
});

app.on("before-quit", () => {
	if (refreshInterval) clearInterval(refreshInterval);
	if (win && !win.isDestroyed()) {
		win.removeAllListeners("close");
		win.close();
	}
});
