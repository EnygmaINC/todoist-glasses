# Todoist Glance

A glanceable **Todoist "Today" list for Meta Ray-Ban Display glasses**. Shows today's and overdue tasks sorted by priority, with pop-up reminders before each task is due — all driven by D-pad navigation on a 600×600 additive display.

**Live app:** https://enygmainc.github.io/todoist-glasses/

## Features

- **Today view only** — fetches Todoist's `overdue | today` filter, nothing else.
- **Priority-first sort** — p1 tasks on top; within a priority, today's tasks rank above overdue ones, soonest time first.
- **Due badges** — the due time when the task has one, `Today` for all-day tasks, a short date for overdue all-day tasks, nothing when undated.
- **Overdue highlight** — gently pulsating red row background (toggleable in Settings).
- **Reminder popups** — a modal pops up before each timed task is due; lead time is configurable (at due time / 5 / 10 / 15 / 30 minutes). Dismissals persist per due timestamp, so rescheduled tasks remind again.
- **Auto-refresh** — off by default; 15 min / 30 min / 1 hour intervals in Settings.
- **Live header** — task count and current time at glanceable size.

## Setup

### Requirements

- Meta Ray-Ban Display glasses on firmware **v125+**, paired with the Meta AI app **v272+**
- Developer Mode enabled: Meta AI app → Settings → App Info → tap the version number 5 times → Enable
- A Todoist account and its API token: Todoist → Settings → Integrations → Developer

### One-time token setup

The glasses have no text input, so the token arrives via URL once and is then stored in the device's `localStorage`:

```
https://enygmainc.github.io/todoist-glasses/?token=YOUR_TODOIST_TOKEN
```

Open that URL once in the browser on the device that will run the app. The token is saved locally and immediately stripped from the URL. Each device (glasses, desktop) needs its own one-time token'd open.

> **Treat the token'd URL like a password.** The Todoist API token grants full account access. It travels only inside TLS, but it can land in browser history and host access logs. Revoke/regenerate it anytime in Todoist settings if you suspect exposure. The token never appears in this repository — the hosted files are static and your task data flows directly between the browser and `api.todoist.com`.

### Running on the glasses

Plug the plain URL (no token) into the Meta AI app as a web app and launch it from the glasses. On-device controls:

| Input | Action |
|-------|--------|
| D-pad / arrow keys | Move focus (wraps around) |
| Enter / tap | Activate focused element |
| Escape / back | Previous screen, or dismiss a reminder popup |

## Development

Plain HTML/CSS/JS — no build step, no dependencies.

```
index.html            screens: Today list, task detail, settings, token setup
styles.css            dark additive-display theme, focus states, pulse animation
app.js                D-pad navigation, Todoist API layer, sorting, reminders
favicon.png           128x128 generated icon
manifest.webmanifest  web app manifest
```

Test locally by opening `index.html` in a browser at 600×600 (DevTools responsive mode) and driving it with arrow keys + Enter. Pure black is transparent on the additive display, so the page background is `#000000` while UI surfaces use dark grays.

### API notes

- Talks to Todoist's **unified v1 API** (`/api/v1/tasks/filter?query=...`) with an automatic fallback to **REST v2** (`/rest/v2/tasks?filter=...`) — the working base is probed once and cached.
- The two generations format due dates differently: v2 uses a separate `due.datetime` for timed tasks, v1 embeds the time in `due.date` (`"2026-07-10T15:00:00"`). All due handling goes through `dueStamp()` / `hasDueTime()` in `app.js`, which normalize both shapes.
- Todoist Sync-API *view options* only affect Todoist's own clients, so sorting is done in the app.

### Deployment

Hosted on **GitHub Pages** from the `main` branch — every push redeploys in about a minute. Any static HTTPS host works; the glasses require a publicly accessible HTTPS URL (plain HTTP and localhost won't load).
