# taskbar-project

A simple desktop-style **taskbar** application built on Node.js — no npm dependencies, no build step.

A small Node HTTP server serves a browser desktop shell: a Start menu, draggable app windows,
per-window taskbar buttons with minimize/restore, and a live clock in the tray.

## Run it

```bash
npm start
```

Then open <http://localhost:3000>. Set `PORT` to use a different port.

## What's in it

| Path | Purpose |
| --- | --- |
| `server.js` | Zero-dependency HTTP server: static files from `public/`, plus `GET /api/apps` |
| `apps.json` | The list of apps shown in the Start menu |
| `public/index.html` | Desktop, taskbar and start-menu markup |
| `public/style.css` | Taskbar, window and start-menu styling |
| `public/app.js` | Window manager: open, focus, drag, minimize, close |

## Built-in apps

- **Notes** — a scratch text area
- **Clock** — large ticking clock and full date
- **Calculator** — left-to-right arithmetic (no `eval`)
- **About** — what this project is

## Adding an app

1. Add an entry to `apps.json` with an `id`, `name`, `icon` and `kind`.
2. Add a matching body builder to `BODIES` in `public/app.js` that returns a DOM node.

Unknown kinds fall back to the About panel, so a new entry never breaks the desktop.

## License

MIT
