# 04 — Kubernetes, locally

## What this is

Compose runs one container. Kubernetes runs **three copies, keeps them alive, and
replaces them one at a time when the image changes.**

The core idea: you don't tell Kubernetes what to *do*, you tell it what you *want*.
"Three pods of this image should exist." A controller then watches reality and corrects
any difference, forever. Kill a pod and a replacement appears within seconds — not
because anyone reacted, but because reality stopped matching the declaration.

Five files in [`k8s/base/`](../../k8s/base), each describing one object.

## The objects, and why each exists

| File | Object | Its job |
| --- | --- | --- |
| `namespace.yaml` | Namespace | A folder in the cluster, so `taskbar` objects are grouped |
| `configmap.yaml` | ConfigMap | Environment variables, kept out of the image |
| `pvc.yaml` | PersistentVolumeClaim | A request for storage that outlives pods |
| `deployment.yaml` | Deployment | How many pods, which image, how to update them |
| `service.yaml` | Service | A stable address in front of pods that come and go |

## Line by line

### Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: taskbar
```

Every manifest has the same four top-level keys: `apiVersion` (which API version
describes this object), `kind` (what type), `metadata` (name and labels), and usually
`spec` (the desired state). A Namespace needs no spec — it's just a container for other
objects.

Namespaces let you run `kubectl -n taskbar get all` and see only your app, and delete
everything at once with `kubectl delete namespace taskbar`.

### ConfigMap

```yaml
kind: ConfigMap
metadata:
  name: taskbar-config
data:
  PORT: "3000"
  HOST: 0.0.0.0
  DATA_DIR: /data
  TASKBAR_TITLE: Taskbar on Kubernetes
```

The Kubernetes equivalent of the `environment:` block in Compose. Same principle as
before: **configuration lives outside the image**, so one image runs everywhere and only
the ConfigMap differs between environments.

For passwords or API keys you'd use a **Secret** instead — same shape, base64-encoded,
with tighter access controls. Nothing here is sensitive.

A ConfigMap change doesn't reach running pods on its own. You need
`kubectl rollout restart deployment/taskbar` to recreate them with the new values.

### PersistentVolumeClaim

```yaml
kind: PersistentVolumeClaim
metadata:
  name: taskbar-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

A **claim** is a request: "I need 1 GB of storage." Kubernetes finds or provisions actual
storage to satisfy it. The pod references the claim by name and never knows what's behind
it — a local disk here, an EBS volume or EFS filesystem on AWS.

`ReadWriteOnce` means it can be mounted read-write by **one node** at a time. All three
pods share it fine here because there's only one node. On a multi-node, multi-AZ cluster
this becomes a real problem — see [module 06](06-aws.md), where it broke exactly that way.

### Deployment — the important one

```yaml
kind: Deployment
metadata:
  name: taskbar
spec:
  replicas: 3
```

Three pods. Kubernetes maintains that number: kill one and a replacement starts
immediately.

```yaml
  revisionHistoryLimit: 5
```

Keep the last 5 versions of the pod template, so `kubectl rollout undo` has something to
go back to.

```yaml
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
```

**This is what makes zero-downtime updates work.**

- `maxSurge: 1` — allowed to run one *extra* pod during the update (4 total)
- `maxUnavailable: 0` — never allowed to have fewer than 3 *ready*

Together they force the order: start a new pod, wait for it to pass readiness, only then
retire an old one. Repeat. If the new image is broken it never becomes ready, so no old
pod is ever retired — the update stalls and the app keeps serving.

Set `maxUnavailable: 1` instead and Kubernetes could remove a working pod before the
replacement is ready.

```yaml
  selector:
    matchLabels:
      app.kubernetes.io/name: taskbar
  template:
    metadata:
      labels:
        app.kubernetes.io/name: taskbar
```

The Deployment finds its pods by **label**, not by name. The `selector` says which labels
to look for; the `template.metadata.labels` stamps those labels on every pod it creates.
They must match, or the Deployment can't track what it created.

Labels are how everything in Kubernetes is wired together — the Service uses the same
mechanism to find pods.

```yaml
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
```

Same idea as `USER node` in the Dockerfile, enforced by the cluster rather than trusted
from the image. `fsGroup: 1000` makes the mounted volume group-owned by 1000, so the
unprivileged user can write to it — without it, the app gets permission denied on `/data`.

```yaml
      terminationGracePeriodSeconds: 20
```

After SIGTERM, a pod gets 20 seconds to exit before SIGKILL. Our app handles SIGTERM and
exits in about a second.

```yaml
        - name: taskbar
          image: taskbar-app:1.0.0
          imagePullPolicy: IfNotPresent
```

`IfNotPresent` means don't pull if the image is already on the node — which is what lets
a locally built image run in the local cluster with no registry involved. In production
you'd tag every build uniquely and let it pull.

```yaml
          envFrom:
            - configMapRef:
                name: taskbar-config
```

Import *every* key from the ConfigMap as an environment variable. `env:` with individual
entries would let you pick specific ones.

```yaml
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 2
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 15
```

**Two probes, two different questions.** This distinction gets asked about a lot:

| Probe | Question | On failure |
| --- | --- | --- |
| **Readiness** | "Can this pod serve traffic *right now*?" | Removed from the Service — no traffic, but keeps running |
| **Liveness** | "Is this pod broken beyond recovery?" | Pod is killed and restarted |

Readiness is what makes rolling updates safe: a new pod gets no traffic until it answers.
Liveness rescues a wedged process.

```yaml
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
```

**Requests** are what the scheduler reserves when choosing a node — a guarantee. **Limits**
are the ceiling. `25m` is 25 millicores, 2.5% of one CPU. Exceed the memory limit and the
container is killed (OOMKilled); exceed the CPU limit and it's throttled rather than
killed.

```yaml
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: taskbar-data
```

Two halves: `volumes` names what's available to the pod, `volumeMounts` says where it
appears inside the container. `/data` is exactly what `DATA_DIR` points at.

### Service

```yaml
kind: Service
metadata:
  name: taskbar
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: taskbar
  ports:
    - name: http
      port: 80
      targetPort: http
```

Pods are disposable — they get new IPs constantly. A Service is the **stable address in
front of them**. It finds pods by that same label selector and load-balances across
whichever ones are currently ready.

`port: 80` is what the Service listens on; `targetPort: http` refers to the container
port *by name*, which is why the Deployment named it `http`.

`ClusterIP` means it's only reachable inside the cluster. The second Service in the same
file is a **NodePort**, exposing port 30080 on the node so you can browse it locally.

### Kustomization

```yaml
namespace: taskbar
resources:
  - namespace.yaml
  - configmap.yaml
  - pvc.yaml
  - deployment.yaml
  - service.yaml
images:
  - name: taskbar-app
    newTag: 1.1.0
```

**Kustomize** is built into `kubectl`. It assembles the manifests and applies changes on
top: stamping the namespace on every object, and rewriting the image tag.

That `images:` block is what CI edits — it changes the tag in one place instead of
sed-ing the Deployment.

## Try it

Requires Kubernetes enabled in Docker Desktop (Settings → Kubernetes → Enable).

**Build the image the cluster will use:**

```bash
docker build -t taskbar-app:1.1.0 .
```

**Deploy everything:**

```bash
kubectl apply -k k8s/base
```

**Watch the pods start:**

```bash
kubectl -n taskbar get pods -w
```

Press Ctrl+C once all three are `Running`.

**See what you created:**

```bash
kubectl -n taskbar get all
```

**Open it:**

```bash
kubectl -n taskbar port-forward svc/taskbar 8080:80
```

Then <http://localhost:8080>. Refresh a few times and watch the pod name in the tray
change — that's the Service load-balancing across three pods.

**Prove self-healing.** Delete a pod and watch a replacement appear:

```bash
kubectl -n taskbar delete pod -l app.kubernetes.io/name=taskbar --field-selector status.phase=Running --wait=false && kubectl -n taskbar get pods -w
```

### The rolling update

Build a new version:

```bash
docker build -t taskbar-app:1.2.0 .
```

Point the Deployment at it:

```bash
kubectl -n taskbar set image deployment/taskbar taskbar=taskbar-app:1.2.0
```

Watch it happen:

```bash
kubectl -n taskbar rollout status deployment/taskbar
```

```
Waiting for deployment "taskbar" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "taskbar" rollout to finish: 2 out of 3 new replicas have been updated...
deployment "taskbar" successfully rolled out
```

One at a time, never below three ready.

### The rollback

See the history:

```bash
kubectl -n taskbar rollout history deployment/taskbar
```

Go back one version:

```bash
kubectl -n taskbar rollout undo deployment/taskbar
```

Or to a specific revision:

```bash
kubectl -n taskbar rollout undo deployment/taskbar --to-revision=1
```

This is the payoff of `revisionHistoryLimit`: the old pod template is still stored, so a
rollback is just a rolling update in reverse.

### Scaling

```bash
kubectl -n taskbar scale deployment/taskbar --replicas=5
```

**Clean up:**

```bash
kubectl delete namespace taskbar
```

## Debugging, when it goes wrong

```bash
kubectl -n taskbar describe pod <pod-name>
```

The **Events** section at the bottom is where the answer usually is — image pull
failures, scheduling problems, probe failures.

```bash
kubectl -n taskbar logs <pod-name>
kubectl -n taskbar logs <pod-name> --previous   # logs from before a crash
kubectl -n taskbar exec -it <pod-name> -- sh    # shell inside the pod
```

## If someone asks

**"What's the difference between a Deployment and a Pod?"**
A Pod is one running instance. A Deployment manages a set of them — keeping the count
right, replacing failures, and handling rolling updates. You almost never create pods
directly.

**"How does a rolling update avoid downtime?"**
`maxUnavailable: 0` and `maxSurge: 1` force new-pod-first ordering, and the readiness
probe gates when a new pod counts as ready. A broken image never becomes ready, so the
old pods are never retired.

**"Readiness vs liveness?"**
Readiness controls traffic, liveness controls restarts. A pod that fails readiness is
pulled from the Service but keeps running; one that fails liveness is killed.

**"What happens if a node dies?"**
Its pods are rescheduled onto surviving nodes. With one node locally there's nowhere to
go — which is why real clusters have several.

**"Why a Service instead of talking to pods directly?"**
Pod IPs change every time a pod is replaced. The Service is a stable name and address
that always points at whichever pods are currently ready.
