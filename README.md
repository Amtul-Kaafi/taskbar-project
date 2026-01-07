# taskbar-project

A simple desktop-style **taskbar** application built on Node.js — no npm dependencies, no build step —
packaged as a Docker image, run with Docker Compose, and deployed to Kubernetes (locally and
on EKS) by a GitHub Actions pipeline.

A small Node HTTP server serves a browser desktop shell: a Start menu, draggable app windows,
per-window taskbar buttons with minimize/restore, and a live clock in the tray. Notes are
persisted to a named volume, so they survive the container being replaced.

## Run with Docker Compose

```bash
docker compose up -d --build
```

| URL | What it is |
| --- | --- |
| <http://localhost:3000> | The app |
| <http://localhost:3000/api/health> | Health JSON, used by the container healthcheck |

Stop the stack, keeping saved notes:

```bash
docker compose down
```

Stop it and throw the notes away too:

```bash
docker compose down -v
```

## Run without Docker

```bash
npm start
```

## Container layout

```
host :3000 ──> web (node) ──> taskbar-data volume at /data
```

- **web** — the Node app, built from the `Dockerfile`, published as `taskbar-app:1.1.0`.
  Runs as the unprivileged `node` user with a `HEALTHCHECK` against `/api/health`.
- **taskbar-data** — a named volume mounted at `/data`. Notes live there, not in the container's
  own filesystem, so `docker compose down` and back up keeps them.
- `apps.json` is bind-mounted read-only, so editing it on the host changes the Start menu.

## Environment configuration

Compose reads `.env` if it is present. Copy the sample and edit:

```bash
cp .env.example .env
```

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_PORT` | `3000` | Host port mapped to the app container |
| `TASKBAR_TITLE` | `Taskbar` | Browser tab title, reported by `GET /api/config` |
| `PORT` | `3000` | Port the Node server binds inside the container |
| `HOST` | `0.0.0.0` | Bind address — must not be `127.0.0.1` in a container |
| `DATA_DIR` | `/data` | Where notes are written; the volume mount point |
| `APPS_FILE` | `/app/apps.json` | Start-menu definition |

A one-off override without touching any file:

```bash
TASKBAR_TITLE="My Desktop" docker compose up -d --force-recreate web
```

## Storage

- **Named volume `taskbar-data` → `/data`** — the Notes app writes `notes.json` here through
  `PUT /api/notes`. It survives `docker compose down`, container recreation and image rebuilds.
- **Bind mount `./apps.json` → `/app/apps.json:ro`** — edit the Start menu on the host and
  restart the service; the file is read-only inside the container.

Inspect what is stored:

```bash
docker compose exec web cat /data/notes.json
```

## Kubernetes

The same image, deployed the way it would be in production: a Deployment with
three replicas behind a Service, configuration in a ConfigMap, notes on a
PersistentVolumeClaim.

```bash
kubectl apply -k k8s/base
kubectl -n taskbar rollout status deployment/taskbar
kubectl -n taskbar port-forward svc/taskbar 8081:80   # http://localhost:8081
```

Rolling update, and undoing one:

```bash
kubectl -n taskbar set image deployment/taskbar taskbar=taskbar-app:1.1.0
kubectl -n taskbar rollout status deployment/taskbar
kubectl -n taskbar rollout history deployment/taskbar
kubectl -n taskbar rollout undo deployment/taskbar
```

`maxSurge: 1` with `maxUnavailable: 0` means a new pod has to pass its readiness
probe before an old one is retired, so capacity never drops and a broken image
stalls the rollout instead of taking the app down.

Full walkthrough with real command output: [docs/kubernetes.md](docs/kubernetes.md).

## AWS: EKS, ECR and CI/CD

`k8s/overlays/eks` layers the AWS differences onto the same base — a
LoadBalancer Service and a `gp3` volume. `infra/` holds the eksctl cluster
config, the ECR bootstrap script and the IAM policies for a GitHub Actions role
that authenticates with OIDC rather than stored keys.

A push to `main` runs `.github/workflows/deploy.yml`, which builds the image,
tags it `<version>-<short sha>`, pushes it to ECR, applies the EKS overlay so the
Deployment names the new image, waits for the rolling update, and rolls back
automatically if the new pods never become ready.

Setup steps, the IAM model and the local equivalent script:
[docs/aws-eks-cicd.md](docs/aws-eks-cicd.md).

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | `{ status, version, host, uptime }` — used by the healthcheck and by readiness/liveness probes |
| `GET` | `/api/config` | `{ title, version, host, dataDir, node }` — which container or pod served you |
| `GET` | `/api/apps` | Start-menu entries, read from `apps.json` |
| `GET` | `/api/notes` | `{ text, savedAt }` from the volume |
| `PUT` | `/api/notes` | Body `{ "text": "..." }`, written atomically |

## What's in it

| Path | Purpose |
| --- | --- |
| `server.js` | Zero-dependency HTTP server: static files, JSON API, graceful SIGTERM |
| `Dockerfile` | Image build: `node:22-alpine`, non-root user, healthcheck |
| `docker-compose.yml` | One service, one named volume, one bind mount |
| `k8s/base/` | Namespace, ConfigMap, PVC, Deployment, Services |
| `k8s/overlays/eks/` | AWS differences: LoadBalancer Service, `gp3` volume |
| `infra/` | eksctl cluster config, ECR bootstrap, IAM policies, manual push script |
| `.github/workflows/deploy.yml` | Build, tag, push to ECR, roll out on EKS |
| `docs/` | Kubernetes walkthrough and the AWS/CI-CD write-up |
| `apps.json` | The list of apps shown in the Start menu |
| `public/` | Desktop markup, styling, and the window manager |

## Built-in apps

- **Notes** — text saved to the volume, so it survives restarts
- **Clock** — large ticking clock and full date
- **Calculator** — left-to-right arithmetic (no `eval`)
- **About** — shows the app version and the container or pod that served the page

## Adding an app

1. Add an entry to `apps.json` with an `id`, `name`, `icon` and `kind`.
2. Add a matching body builder to `BODIES` in `public/app.js` that returns a DOM node.

Unknown kinds fall back to the About panel, so a new entry never breaks the desktop.

## License

MIT
