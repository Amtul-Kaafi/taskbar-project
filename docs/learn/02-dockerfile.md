# 02 — The Dockerfile

## What this is

[`Dockerfile`](../../Dockerfile) is the recipe for building the image. Each instruction
adds a **layer** — a saved filesystem change stacked on the one before. Docker caches
layers, so a rebuild only redoes the steps after whatever changed.

The whole file is 31 lines. Here it is, in order.

## Line by line

### FROM — the starting point

```dockerfile
FROM node:22-alpine
```

Start from the official Node 22 image built on Alpine Linux. **Alpine** is a minimal
distribution — about 5 MB, versus ~350 MB for a Debian base. The tradeoff is that it uses
`musl` instead of `glibc`, which occasionally breaks native modules. We have no
dependencies, so that risk is zero here.

`node:22` is pinned to a major version deliberately. `node:latest` would mean a rebuild
months from now could silently jump to a different Node version.

### ENV — defaults baked into the image

```dockerfile
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
```

These become environment variables inside every container from this image. They're
**defaults, not fixed values** — Compose or Kubernetes can override any of them.

One `ENV` with backslash continuations rather than four separate `ENV` lines, because
each instruction creates a layer. Fewer layers, smaller image.

### WORKDIR — where commands run

```dockerfile
WORKDIR /app
```

Sets the working directory for everything after it, creating it if needed. Without this,
`COPY server.js ./` would land in `/`.

### COPY then RUN — the caching trick

```dockerfile
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
```

This looks redundant — why not copy everything at once? Because of **layer caching**.

Docker reuses a cached layer if its inputs haven't changed. By copying only
`package.json` first and installing against it, the install layer is only invalidated
when `package.json` changes. Edit `server.js` and the install layer is reused.

Copy everything first instead, and every code edit re-runs `npm install`. It's the single
most common Dockerfile mistake.

`--omit=dev` skips devDependencies. `--no-audit --no-fund` suppresses noise that would
otherwise clutter build logs.

### COPY — the application code

```dockerfile
COPY server.js apps.json ./
COPY public ./public
```

Named files rather than `COPY . .`, so nothing unexpected ends up in the image. The
`.dockerignore` file provides a second layer of protection — it excludes `.git`, `.env`,
`node_modules`, `k8s/`, `docs/` and more from the build context entirely.

Keeping secrets out of images matters because **anyone with the image can read every
layer**, including files you deleted in a later step.

### RUN — making the volume writable

```dockerfile
RUN mkdir -p "$DATA_DIR" && chown -R node:node "$DATA_DIR" /app
```

The `node` base image ships a non-root user called `node` (UID 1000). Since the app will
run as that user, it needs to own the directories it writes to. This must happen *before*
`USER node`, because `chown` requires root.

### USER — dropping root

```dockerfile
USER node
```

Everything after this — including the app itself — runs as an unprivileged user. By
default containers run as root, and a container escape then means root on the host. This
is one line, and it's the highest-value security line in the file.

### EXPOSE and VOLUME — documentation

```dockerfile
EXPOSE 3000
VOLUME ["/data"]
```

Neither actually *does* anything at runtime. `EXPOSE` documents which port the app
listens on — you still need `-p 3000:3000` to publish it. `VOLUME` marks `/data` as
intended for external storage.

Both are metadata: tools and humans read them to understand how the image is meant to be
run.

### HEALTHCHECK — is it actually working?

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

Docker runs this command inside the container on a schedule. Exit 0 means healthy,
anything else unhealthy — which is what `docker ps` reports as `(healthy)`.

| Flag | Meaning |
| --- | --- |
| `--interval=30s` | Run the check every 30 seconds |
| `--timeout=3s` | A check taking longer than this counts as a failure |
| `--start-period=5s` | Grace period at startup where failures don't count |
| `--retries=3` | Three consecutive failures before marking unhealthy |

The check is written in Node rather than `curl` because Alpine doesn't include curl, and
adding it would grow the image for the sake of one command. Node is already there.

**A running process is not the same as a working app.** The process can be alive while
the server is wedged. The healthcheck tests the thing users actually depend on.

### CMD — what to run

```dockerfile
CMD ["node", "server.js"]
```

The default command when a container starts.

The bracket form is **exec form**: it runs `node` directly as PID 1. The alternative,
`CMD node server.js`, is *shell form* — it runs `/bin/sh -c "node server.js"`, making the
shell PID 1. That matters because the shell doesn't forward signals to its child, so
SIGTERM never reaches Node and every shutdown takes the full grace period before a kill.

Always use exec form for the main process.

## Try it

Build the image:

```bash
docker build -t taskbar-app:demo .
```

Run it:

```bash
docker run -d --name demo -p 3000:3000 taskbar-app:demo
```

Check that it's healthy and running as the right user:

```bash
docker ps --filter name=demo
```

```bash
docker exec demo whoami
```

That prints `node`, not `root` — proof the `USER` line is doing its job.

Look at the layers the build produced:

```bash
docker history taskbar-app:demo
```

Clean up:

```bash
docker rm -f demo
```

## If someone asks

**"Why Alpine?"**
Size. ~150 MB total versus ~1 GB for the full Node image. Faster to push, faster to pull
onto a node, smaller attack surface.

**"Why copy package.json separately?"**
Layer caching. Dependencies only reinstall when `package.json` changes, not on every code
edit.

**"Why run as non-root?"**
Defence in depth. If the app is compromised, the attacker is an unprivileged user in a
container rather than root.

**"What's the difference between CMD and ENTRYPOINT?"**
`CMD` is the default command and is easy to override — `docker run image sh` replaces it.
`ENTRYPOINT` is the fixed part, with `CMD` supplying default arguments. For a single
service, `CMD` alone is fine.

**"Why not multi-stage?"**
Multi-stage builds shine when you have a build step whose tooling you don't want to
ship — compiling TypeScript, bundling a frontend. This app has no build step, so a second
stage would add complexity and save nothing.
