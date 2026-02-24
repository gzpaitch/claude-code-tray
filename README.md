# Claude Code Tray

System tray app for Windows that monitors your Claude Code usage in real time.

## Features

- **Rate limits** — Session (5h) and weekly (7d) usage with progress bars and reset times
- **Today's activity** — Messages, sessions, tool calls, and tokens by model
- **Last 7 days** — Daily breakdown (expandable accordion)
- **All-time stats** — Token usage by model with input/output/cache breakdown
- **Quick launch** — Open Claude Code (Normal or YOLO mode) directly from the details window
- **Auto-refresh** — Watches `~/.claude/` files for changes + polls every 30s
- **Win11 Fluent UI** — Mica material, dark/light theme support
- **Tray-anchored window** — Opens right above the taskbar
- **Custom icons** — Supports custom tray icon and .exe icon

## Data Sources

The app reads two files from `~/.claude/`:

| File | Content | Updated when |
|---|---|---|
| `stats-cache.json` | Activity, tokens, sessions | After each Claude Code session |
| `rate-limit-cache.json` | Session/weekly rate limits | During interactive Claude Code sessions |

> **Note:** Rate limit data is only updated by interactive Claude Code sessions (not `-p` mode). When data is older than 5 minutes, a yellow "stale" badge is shown.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9

## Setup

```bash
git clone <repo-url>
cd claude-code-tray
pnpm install
```

## Development

Run in development mode (compiles and launches):

```bash
pnpm start
```

Build only (TypeScript compilation):

```bash
pnpm run build
```

## Building the .exe

To generate a portable executable:

```bash
pnpm run dist
```

The output will be at:

```
release/Claude Code Tray <version>.exe
```

This is a **portable .exe** — no installation required. Just double-click to run.

## Custom Icons

Place your icon files in the `assets/` folder:

| File | Purpose | Format |
|---|---|---|
| `icon.ico` | .exe icon (Explorer, taskbar) | ICO with 16, 24, 32, 48, 64, 128, 256px |
| `tray-icon.png` | System tray icon | PNG, 32x32, transparent background |

If `tray-icon.png` is not found, a fallback circle icon is used.

## Project Structure

```
claude-code-tray/
  assets/
    icon.ico             # .exe icon (multi-resolution)
    tray-icon.png        # System tray icon
    claude-logo.svg      # Logo for Normal mode button
    claude-logo-yolo.svg # Logo for YOLO mode button
  src/
    main.ts              # Electron app: tray, menu, details window, launch buttons
    usage.ts             # Reads and parses Claude Code stats/rate-limit files
  dist/                  # Compiled JS (gitignored)
  release/               # Packaged .exe output (gitignored)
  package.json
  tsconfig.json
```
