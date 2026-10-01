# ap

Windows tray app that reads the login tokens already stored by Codex, Claude Code, Cursor, and Antigravity, then shows each service's current usage limits.

## Run

```
npm install
npm run dev
```

The app lives in the system tray. Click the icon for the popup. It polls every 5 minutes and never refreshes or rewrites tokens.

## Package

```
npm run build:win
```

Produces a Windows NSIS installer under `release/`.

## Open at login

Use the checkbox in the popup, or the tray context menu.
