# 03 — Docker Compose

## What this is

The Dockerfile says how to *build* the image. [`docker-compose.yml`](../../docker-compose.yml)
says how to *run* it: which ports, which environment variables, which storage, and how to
tell whether it's healthy.

Without it you'd type this every time, and remember it correctly every time:

```bash
docker run -d --name taskbar-web -p 3000:3000 \
  -e PORT=3000 -e HOST=0.0.0.0 -e DATA_DIR=/data -e TASKBAR_TITLE=Taskbar \
  -v taskbar-data:/data -v "$PWD/apps.json:/app/apps.json:ro" \
  --restart unless-stopped taskbar-app:1.1.0
```

Compose turns that into `docker compose up`, and puts the knowledge in git.

## Line by line

### Project name

```yaml
name: taskbar
```

Prefixes everything Compose creates: the network becomes `taskbar_default`, the volume
`taskbar_taskbar-data`. Without it, Compose uses the folder name — so renaming the folder
would orphan your volumes.

### The service

```yaml
services:
  web:
    build:
      context: .
    image: taskbar-app:1.1.0
    container_name: taskbar-web
    restart: unless-stopped
```

- **`web`** is the service name. With more services, this is also the DNS hostname others
  would use to reach it.
- **`build.context: .`** — build from the Dockerfile in this directory. Having both
  `build` and `image` means "build it, and tag the result `taskbar-app:1.1.0`."
- **`container_name`** pins the container's name instead of letting Compose generate
  `taskbar-web-1`. Convenient for `docker logs taskbar-web`.
- **`restart: unless-stopped`** — restart automatically if it crashes or the machine
  reboots, but stay stopped if you deliberately stopped it.

### Environment configuration

```yaml
    env_file:
      - path: .env
        required: false
    environment:
      PORT: "3000"
      HOST: "0.0.0.0"
      DATA_DIR: /data
      TASKBAR_TITLE: ${TASKBAR_TITLE:-Taskbar}
```

Two mechanisms:

**`env_file`** reads `.env` if it exists. `required: false` means no error when it
doesn't, so the project works on a fresh clone. `.env` is gitignored — that's where local
overrides and, in a bigger project, secrets would go.

**`environment`** sets variables directly. `${TASKBAR_TITLE:-Taskbar}` is shell-style
substitution: use the `TASKBAR_TITLE` from your shell or `.env`, otherwise `Taskbar`.

`PORT: "3000"` is quoted because YAML would otherwise read it as a number, and
environment variables must be strings.

### Ports

```yaml
    ports:
      - "${APP_PORT:-3000}:3000"
```

`HOST_PORT:CONTAINER_PORT`. The left side is your laptop, the right side is inside the
container. They don't have to match — `APP_PORT=8080` would make it
`http://localhost:8080` while the app still listens on 3000 internally.

### Volumes — the two kinds

```yaml
    volumes:
      # Named volume: notes written to /data outlive the container.
      - taskbar-data:/data
      # Bind mount: edit apps.json on the host, restart, new Start menu.
      - ./apps.json:/app/apps.json:ro
```

This is worth understanding properly, because it's the same distinction Kubernetes makes.

| | Named volume | Bind mount |
| --- | --- | --- |
| Written as | `taskbar-data:/data` | `./apps.json:/app/apps.json` |
| Stored | Docker manages it | A path on your machine |
| Used for | Data the app produces | Config you want to edit live |
| Survives `down` | Yes | It's your file, so yes |
| Portable | Yes | No — depends on host paths |

`:ro` mounts `apps.json` read-only. The app only reads it, so there's no reason to allow
writes.

### Healthcheck

```yaml
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
```

The same check as in the Dockerfile, repeated here with a faster interval — 10 seconds
locally instead of 30, so you see status change quickly while developing. A healthcheck
defined here overrides the image's.

### Volume declaration

```yaml
volumes:
  taskbar-data:
```

Named volumes have to be declared at the top level before a service can use one. The
empty value means default settings.

## Try it

Start it:

```bash
docker compose up -d
```

Watch it become healthy:

```bash
docker compose ps
```

```
SERVICE   STATUS                   PORTS
web       Up 10 seconds (healthy)  0.0.0.0:3000->3000/tcp
```

**Prove the volume works.** Save a note in the app at <http://localhost:3000> (Start →
Notes → type → Save), then destroy the container completely and bring it back:

```bash
docker compose down && docker compose up -d
```

Reopen Notes. The text is still there — it was never in the container.

**Prove environment config works**, with no rebuild:

```bash
TASKBAR_TITLE="Kafi's Desktop" docker compose up -d --force-recreate
```

```bash
curl -s http://localhost:3000/api/config
```

The title changed. Same image, different configuration.

**See the logs:**

```bash
docker compose logs -f web
```

**Stop it, keeping notes:**

```bash
docker compose down
```

**Stop it and delete the data too** — note the `-v`:

```bash
docker compose down -v
```

## If someone asks

**"What does Compose actually give you over `docker run`?"**
The run configuration becomes a file in the repo — reviewable, versioned, identical for
everyone. And it scales to multiple services without the commands becoming unmanageable.

**"What's the difference between a volume and a bind mount?"**
A named volume is managed by Docker and is the right choice for data the app produces. A
bind mount maps a specific host path in, and is for config or code you want to edit
live.

**"Why doesn't `docker compose down` delete my data?"**
Named volumes deliberately outlive containers — that's their entire purpose. `down -v`
removes them explicitly.

**"How would you add a database?"**
A second service with its own image and volume, and the app would reach it by service
name — `postgres:5432` — over Compose's default network, with `depends_on` to control
start order.
