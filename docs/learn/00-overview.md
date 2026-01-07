# 00 — The big picture

Before any code: **each layer of this project exists because the layer below it has a
problem.** If you can name the problem, you can explain the layer.

## The ladder

### 1. A Node.js app

`node server.js` and the app is running on your laptop at `localhost:3000`.

**Problem:** it runs *here*. Another machine might have a different Node version, a
different folder layout, a missing file. "Works on my machine" is a real failure mode.

### 2. Docker

A **Dockerfile** is a recipe. Running it produces an **image** — a frozen snapshot of a
filesystem with Node, your code, and the instruction to start it. Anyone with that image
gets byte-for-byte the same thing. A running copy of an image is a **container**.

**Problem:** the `docker run` command grows long. Which port? Which environment
variables? Where does data get stored? That's knowledge living in your head or your
shell history, not in the repo.

### 3. Docker Compose

`docker-compose.yml` writes that down. Ports, environment variables, volumes, health
checks — declared in a file, committed to git. Now `docker compose up` is the whole
setup, and it's reviewable like any other code.

**Problem:** it's still one container on one machine. If it crashes, it's down. If it
gets popular, you can't add more copies. Deploying a new version means stopping the old
one — a gap where the app is offline.

### 4. Kubernetes

You describe the **desired state**: "three copies of this image should be running." A
controller continuously compares that to reality and fixes any difference. A pod dies,
it's replaced. You change the image, it swaps pods one at a time so the app never goes
fully down. You made a mistake, one command puts the old version back.

**Problem:** building and deploying is still you, typing commands, possibly at 2am,
possibly forgetting a step.

### 5. CI/CD (GitHub Actions)

A **workflow** file says: when code lands on `main`, build the image, test it, push it
to a registry, tell Kubernetes to use the new tag. The steps are the same ones you'd
type — written down, so they run identically every time and leave a log.

**Problem:** it's all still on your laptop. Turn it off and the app is gone.

### 6. AWS (ECR and EKS)

**ECR** is a private Docker registry in the cloud — where images live so a cluster can
pull them. **EKS** is Kubernetes with the control plane run by AWS on real servers in
real datacentres. Same manifests, different address.

## The map

```
  your code
      │
      ▼
  Dockerfile ──build──▶ image (taskbar-app:1.1.0)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      docker compose up            kubernetes
      (one container,              (3 replicas + Service
       your laptop)                 + rolling updates)
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                      local cluster              EKS on AWS
                      (Docker Desktop)           (image from ECR)
                                                       ▲
                                                       │
                                          GitHub Actions pipeline
                                          (build → push → roll out)
```

## Vocabulary

Everything here in one place. You'll meet each again in context.

| Term | Meaning |
| --- | --- |
| **Image** | A frozen filesystem + startup command. Built once, run anywhere. |
| **Container** | A running instance of an image. |
| **Registry** | Where images are stored and pulled from. Docker Hub is public; ECR is yours. |
| **Volume** | Storage that lives outside the container, so data survives the container being replaced. |
| **Pod** | The smallest unit Kubernetes runs. For us: one container. |
| **Deployment** | Says how many pods to run and which image; replaces them when the spec changes. |
| **Service** | A stable address in front of a changing set of pods. |
| **ConfigMap** | Configuration values, kept out of the image. |
| **Namespace** | A folder inside the cluster to group related objects. |
| **Manifest** | A YAML file describing a Kubernetes object. |
| **Rolling update** | Replacing pods gradually so the app stays up throughout. |
| **Rollback** | Returning to the previous version of a Deployment. |

## If someone asks

**"Why containers at all?"**
So the thing I tested is exactly the thing that runs. The image contains Node, my code
and its startup command; there's no "did you install the right version" step.

**"Why Kubernetes for one small app? Isn't that overkill?"**
For this app alone, yes — honestly. I used it because it's how the deployment problems
get solved at scale: keeping N copies alive, updating without downtime, rolling back
when an update is bad. The app is deliberately small so the infrastructure is the part
you can see.

**"What would you do differently?"**
For something this size in production I'd reach for a managed container service before a
cluster. The Kubernetes work here was to learn the model — Deployments, Services,
probes, rollouts — not because the app demands it.
