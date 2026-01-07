# Running the taskbar on Kubernetes

The same image that Compose runs is deployed here by a Deployment, exposed by a
Service, configured by a ConfigMap and backed by a PersistentVolumeClaim.

```bash
kubectl apply -k k8s/base
kubectl -n taskbar rollout status deployment/taskbar
kubectl -n taskbar port-forward svc/taskbar 8081:80
# http://localhost:8081
```

## What is in `k8s/base`

| File | Object | Why it is there |
| --- | --- | --- |
| `namespace.yaml` | Namespace `taskbar` | Keeps the app's objects out of `default` |
| `configmap.yaml` | ConfigMap `taskbar-config` | `PORT`, `HOST`, `DATA_DIR`, `TASKBAR_TITLE` — config lives outside the image |
| `pvc.yaml` | PersistentVolumeClaim `taskbar-data` | 1Gi for notes, so they outlive any pod |
| `deployment.yaml` | Deployment `taskbar` | 3 replicas, `RollingUpdate` with `maxSurge: 1` / `maxUnavailable: 0`, probes, resource requests and limits, non-root security context |
| `service.yaml` | Services `taskbar`, `taskbar-nodeport` | Stable ClusterIP address plus a NodePort for local browsing |

`k8s/overlays/eks` reuses that base and changes only what differs in AWS: a
LoadBalancer Service and a `gp3` volume.

## Replicas and the Service

Three pods sit behind one ClusterIP. The Service picks pods by label, not by
address, so pods can be replaced without the address changing:

```
$ kubectl -n taskbar exec deploy/taskbar -- node -e '...GET http://taskbar/api/config...'
served by pod: taskbar-654ddcb9d9-qbdn5 | title: Taskbar on Kubernetes
served by pod: taskbar-654ddcb9d9-wz5gj | title: Taskbar on Kubernetes
served by pod: taskbar-654ddcb9d9-qbdn5 | title: Taskbar on Kubernetes
served by pod: taskbar-654ddcb9d9-wz5gj | title: Taskbar on Kubernetes
```

The title comes from the ConfigMap, so it proves configuration reached the
container. Scaling is a one-liner:

```
$ kubectl -n taskbar scale deployment/taskbar --replicas=5
deployment.apps/taskbar scaled
NAME      DESIRED   READY
taskbar   5         5

$ kubectl -n taskbar scale deployment/taskbar --replicas=3
NAME      DESIRED   READY
taskbar   3         3
```

## Rolling update

`maxUnavailable: 0` means Kubernetes adds a new pod, waits for its readiness
probe, and only then retires an old one. Capacity never dips below three.

```
$ kubectl -n taskbar set image deployment/taskbar taskbar=taskbar-app:1.1.0
deployment.apps/taskbar image updated

$ kubectl -n taskbar rollout status deployment/taskbar
Waiting for deployment "taskbar" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "taskbar" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "taskbar" rollout to finish: 1 old replicas are pending termination...
deployment "taskbar" successfully rolled out

$ kubectl -n taskbar get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image,READY:.status.containerStatuses[0].ready
NAME                      IMAGE               READY
taskbar-5fcff857d-22cnr   taskbar-app:1.1.0   true
taskbar-5fcff857d-lddnk   taskbar-app:1.1.0   true
taskbar-5fcff857d-t29kk   taskbar-app:1.1.0   true
```

`GET /api/health` reported `1.1.0` afterwards, and `undefined` before — the
1.0.0 image predates the version field, which is what made the change visible.

## Rollback

Every applied pod template is kept as a revision (`revisionHistoryLimit: 5`),
so undoing is one command and does not need the old image tag to be known:

```
$ kubectl -n taskbar rollout history deployment/taskbar
REVISION  CHANGE-CAUSE
1         <none>
2         set image to taskbar-app:1.1.0

$ kubectl -n taskbar rollout undo deployment/taskbar
deployment.apps/taskbar rolled back

$ kubectl -n taskbar rollout status deployment/taskbar
deployment "taskbar" successfully rolled out

$ kubectl -n taskbar get deployment taskbar -o jsonpath='{.spec.template.spec.containers[0].image}'
taskbar-app:1.0.0
```

Roll back to a specific revision with `--to-revision=N`. Annotate a change so
the history is readable:

```bash
kubectl -n taskbar annotate deployment/taskbar \
  kubernetes.io/change-cause="set image to taskbar-app:1.1.0" --overwrite
```

## Configuration changes

The ConfigMap is mounted as environment variables, which are read once at
process start, so a value change needs new pods:

```bash
kubectl -n taskbar edit configmap taskbar-config
kubectl -n taskbar rollout restart deployment/taskbar
```

That restart is itself a rolling update, so it causes no downtime.

## Storage

Notes are written to `/data`, backed by the PVC. Deleting a pod does not lose
them — the ReplicaSet creates a replacement, which mounts the same volume:

```
$ curl -X PUT localhost:8081/api/notes -d '{"text":"Written on Kubernetes, stored on the PVC."}'
{"text":"Written on Kubernetes, stored on the PVC.","savedAt":"..."}

$ kubectl -n taskbar delete pod taskbar-5fcff857d-5szps
pod "taskbar-5fcff857d-5szps" deleted

$ curl -s localhost:8081/api/notes
{"text":"Written on Kubernetes, stored on the PVC.","savedAt":"..."}
```

`ReadWriteOnce` is fine on one node. Across AZs on EKS, either give each pod its
own volume (StatefulSet) or use EFS with `ReadWriteMany`.

## Health probes

- **readiness** — `/api/health`, every 5s. Gates Service membership and the
  rolling update: a pod that never becomes ready blocks the rollout instead of
  taking traffic, and the previous version keeps serving.
- **liveness** — `/api/health`, every 15s. Restarts a wedged container.

## Cleanup

```bash
kubectl delete -k k8s/base          # keeps the PVC's data unless the namespace goes
kubectl delete namespace taskbar    # removes everything, volume included
```
