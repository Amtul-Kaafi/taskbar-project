# 01 — The application

## What this is

A single file, [`server.js`](../../server.js), that does two jobs:

1. **Serves static files** from `public/` — the HTML, CSS and JavaScript that draw the
   desktop in your browser.
2. **Answers a small JSON API** under `/api/` — health, config, the app list, and saving
   notes.

It uses **no npm packages at all**. Not Express, nothing. Just Node's built-in `http`
module. That was deliberate: with zero dependencies, `npm install` has nothing to fetch,
the image builds in seconds, and there's no dependency vulnerability surface to explain.

The browser side (`public/app.js`) is a small window manager: it opens windows, drags
them, minimises them, and draws the taskbar. It's not the interesting part of this
project — treat it as "the thing being deployed."

## Line by line

### Configuration comes from the environment

```js
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TITLE = process.env.TASKBAR_TITLE || 'Taskbar';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
```

Every setting reads an environment variable and falls back to a default. This is the
single most important thing about making an app container-friendly: **the same image can
behave differently depending on how it's started.** Compose sets these one way,
Kubernetes another, and neither needs a rebuild.

`HOST` defaults to `0.0.0.0`, not `127.0.0.1`. Inside a container, `127.0.0.1` means
"only reachable from inside this container" — the port mapping would connect to nothing.
`0.0.0.0` means "listen on all interfaces."

### The health endpoint

```js
if (pathname === '/api/health') {
  return sendJson(res, 200, {
    status: 'ok',
    version: VERSION,
    host: os.hostname(),
    uptime: Math.round(process.uptime())
  });
}
```

Small, but load-bearing. Four different things call it:

| Caller | Why |
| --- | --- |
| Docker `HEALTHCHECK` | Marks the container healthy or unhealthy |
| Kubernetes readiness probe | Decides whether this pod should receive traffic |
| Kubernetes liveness probe | Restarts the pod if it stops answering |
| The CI smoke test | Proves the image actually starts before shipping it |

`os.hostname()` returns the container ID in Docker and the **pod name** in Kubernetes.
That's how the badge in the taskbar tray can show you which pod served the page — useful
during a rolling update, when you can refresh and watch the name change.

### Notes are written to DATA_DIR

```js
async function writeNotes(text) {
  const payload = { text, savedAt: new Date().toISOString() };
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = NOTES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, NOTES_FILE);
  return payload;
}
```

This is the app's only state, and it exists so there's something real to attach storage
to. `DATA_DIR` is `/data` in a container, which is where the volume gets mounted — so
notes survive the container being destroyed and recreated.

Writing to a temp file and renaming is the standard safe-write pattern: `rename` is
atomic, so a crash mid-write can't leave a half-written file.

### Shutting down cleanly

```js
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
```

When Docker or Kubernetes stops a container, it sends **SIGTERM** and waits before
killing it forcibly. Handling that signal means the app closes its connections and exits
promptly instead of being killed after a timeout.

This matters during rolling updates: a pod that exits in a second makes the update quick;
one that ignores SIGTERM adds a 20–30 second stall to every single pod replacement.

## Try it

Run it without any containers:

```bash
npm start
```

Open <http://localhost:3000>, then check the API directly:

```bash
curl -s http://localhost:3000/api/health
```

```json
{"status":"ok","version":"1.1.0","host":"YOUR-PC","uptime":12}
```

Now try overriding the config, with no code change:

```bash
TASKBAR_TITLE="My Desktop" npm start
```

The browser tab title changes. That's the same mechanism Compose and Kubernetes use.

## If someone asks

**"Why no framework?"**
The app is a demo target for infrastructure work. Zero dependencies means the image is
small, the build is fast, and nothing in the deployment story is hidden behind a
framework's magic.

**"How does the app know which pod it's on?"**
`os.hostname()` inside a container returns the container ID; in Kubernetes the pod name
is set as the hostname. `/api/config` returns it, and the UI shows it in the tray.

**"Where does it store data?"**
One JSON file under `DATA_DIR`, which is a mounted volume. The app deliberately doesn't
know or care whether that's a Docker named volume, a Kubernetes PersistentVolumeClaim,
or an EFS filesystem on AWS — it just writes to a path.
