# 06 — AWS: ECR and EKS

## What this is

Everything so far ran on your laptop. This module is the same app on AWS: the image in a
cloud registry, the cluster on real servers, deployed by the pipeline.

Two services do the work:

| Service | Local equivalent | What it is |
| --- | --- | --- |
| **ECR** (Elastic Container Registry) | Your local image store | A private Docker registry in your AWS account |
| **EKS** (Elastic Kubernetes Service) | Docker Desktop's cluster | Kubernetes with the control plane managed by AWS |

The key point for an interview: **the manifests barely change.** Same Deployment, same
Service, same ConfigMap. Kubernetes is the portability layer — that's the whole argument
for using it.

## The pieces

### ECR — where images live

Locally, `docker build` puts the image in your machine's image store and the cluster
reads it from there. On AWS the cluster is elsewhere, so the image needs somewhere both
sides can reach.

[`infra/ecr-bootstrap.sh`](../../infra/ecr-bootstrap.sh) creates it with two settings
worth knowing:

- **`scanOnPush=true`** — scan each pushed image for known vulnerabilities.
- **`IMMUTABLE` tags** — a tag, once pushed, can't be overwritten. So
  `taskbar-app:1.1.0-b28e5d1` always means one exact image. This is why unique tags
  matter: with mutable `latest`, "what's running?" has no reliable answer.

A lifecycle policy deletes untagged images after 7 days so storage doesn't creep up.

### EKS — the managed cluster

[`infra/eks-cluster.yaml`](../../infra/eks-cluster.yaml) is read by `eksctl`, which turns
it into CloudFormation stacks:

```yaml
managedNodeGroups:
  - name: taskbar-workers
    instanceType: t3.small
    desiredCapacity: 2
    privateNetworking: true
    availabilityZones: ["ap-south-1a", "ap-south-1b"]
```

- **Control plane** — the Kubernetes brain (API server, scheduler, etcd). AWS runs it,
  patches it, and keeps it available. You never see the machines. This is what the
  $0.10/hour buys.
- **Node group** — EC2 instances that actually run your pods. These are yours.
- **Private networking** — nodes sit in private subnets with no public IPs, reaching the
  internet through a NAT gateway. Standard production shape.
- **Two availability zones** — physically separate datacentres. If one fails, pods run in
  the other. This detail causes the storage problem below.

Creation took about **17 minutes**.

## What actually broke

This is the most valuable part of the project to talk about, because it's the part you
can't get from a tutorial. Three things failed on the real cluster that worked perfectly
locally.

### 1. Storage: EBS is single-AZ

Every pod sat `Pending`:

```
Warning  FailedScheduling  0/2 nodes are available: pod has unbound immediate PersistentVolumeClaims
```

An **EBS volume lives in one availability zone and is ReadWriteOnce** — mountable by one
node at a time. Three replicas spread across `1a` and `1b` cannot all mount the same
volume. No StorageClass tweak fixes that; it's physics of the service.

It never appeared locally because a one-node cluster is also one zone.

**Fix:** switch to **EFS**, a network filesystem that's `ReadWriteMany` and reachable from
every AZ that has a mount target. The EKS overlay provisions an access point per claim,
pinning ownership to uid/gid 1000 so the unprivileged container user can write.

Proved by writing a note from a pod in `1b` and reading it from a pod in `1a`.

**The lesson worth stating:** single-node local clusters hide every distributed-systems
problem. The topology is the thing that changed, not the YAML.

### 2. LoadBalancer Services need a controller now

`type: LoadBalancer` stayed `<pending>` forever. Kubernetes **removed the in-tree AWS
cloud provider** in recent versions, so nothing in the cluster knows how to create an
AWS load balancer by default. You have to install the AWS Load Balancer Controller.

Even after installing it, this account's ELB quota blocked creation — so the app was
reached with `kubectl port-forward` instead.

**Lesson:** `type: LoadBalancer` is not magic. Something has to translate it into a cloud
resource, and on modern EKS that something is an add-on you install.

### 3. OIDC: the documented subject claim was wrong

The pipeline's AWS authentication failed with `AccessDenied`, even though the trust
policy exactly matched the documented format:

```
repo:Amtul-Kaafi/taskbar-project:ref:refs/heads/main
```

**CloudTrail had the answer.** Looking at the actual `AssumeRoleWithWebIdentity` event
showed GitHub was sending immutable numeric IDs:

```
repo:Amtul-Kaafi@148440954/taskbar-project@1360546420:ref:refs/heads/main
```

Those numbers are the user and repository IDs — they don't change if the account or repo
is renamed, which is precisely the point.

**Lesson:** when a trust policy rejects a token, don't re-read the docs — read the actual
claim in CloudTrail. The token tells you what it really contains.

## The overlay: local vs AWS

The differences between local and AWS Kubernetes live in
[`k8s/overlays/eks/`](../../k8s/overlays/eks) rather than being edited into the base:

```yaml
resources:
  - ../../base
  - storageclass-efs.yaml

patches:
  - path: service-lb.yaml
    target:
      kind: Service
      name: taskbar
  - path: pvc-efs.yaml
    target:
      kind: PersistentVolumeClaim
      name: taskbar-data

images:
  - name: taskbar-app
    newName: 344530147162.dkr.ecr.ap-south-1.amazonaws.com/taskbar-app
    newTag: 1.1.0
```

`resources: - ../../base` pulls in all five base manifests unchanged, then the overlay
applies three differences on top:

1. **Image** — `newName` points at ECR instead of the local image store
2. **Storage** — a `patch` swaps the PVC to the EFS StorageClass, `ReadWriteMany`
3. **Service** — a `patch` turns the `taskbar` Service into `type: LoadBalancer`

A **patch** modifies an object from the base; `target:` selects which one by kind and
name. That's the value of the overlay pattern: the base is never edited, so local and AWS
can't drift apart.

Deployment, ConfigMap, replicas, probes, rollout strategy: identical. Being able to point
at that and say "these three things are what differ between my laptop and AWS" is a
strong answer.

## The full pipeline run

What happened end to end when a code change was pushed:

1. Version bumped to `1.2.0`, committed, pushed to `main`
2. GitHub Actions started; `build` job built and smoke-tested the image
3. `deploy` job exchanged its OIDC token for temporary AWS credentials
4. Image pushed to ECR as `1.2.0-<sha>`
5. Overlay rewritten to that tag, `kubectl apply -k` sent it to the cluster
6. Kubernetes rolled pods one at a time — new pod ready, old pod retired, repeat
7. `kubectl rollout status` confirmed success

Then a deliberate rollback with `kubectl rollout undo`, back to 1.1.0, same rolling
mechanism in reverse.

The full transcript is in [`docs/eks-run.md`](../eks-run.md).

## Cost, and the discipline around it

| Resource | Rate |
| --- | --- |
| EKS control plane | $0.10/hour — never free tier |
| 2× t3.small | ~$0.042/hour |
| NAT gateway | ~$0.045/hour |
| **Total** | **~$0.20/hour** |

The cluster ran about 78 minutes: **roughly $0.35**.

Two habits worth mentioning, because they're what separates someone who has used cloud
from someone who has only read about it:

- A **$5 budget alert** was set before creating anything.
- The cluster was **deleted the same session**, then verified — clusters, EC2, load
  balancers, NAT gateways, EBS volumes, EFS, Elastic IPs, CloudFormation stacks, all
  confirmed gone. Left running, that cluster would be ~$150/month.

ECR, the IAM role and the OIDC provider were kept — all effectively free, and they mean
recreating the cluster needs no re-setup.

## If someone asks

**"What's the difference between EKS and running Kubernetes yourself?"**
AWS runs the control plane — API server, scheduler, etcd — across AZs, patched and backed
up. You manage the worker nodes and your workloads. You pay $0.10/hour not to be
responsible for etcd.

**"How did your image get from GitHub to the cluster?"**
The pipeline built it, tagged it with the version plus commit SHA, pushed it to ECR, then
updated the Deployment's image. Kubernetes pulled from ECR using the node role's
permissions and rolled the pods.

**"What was the hardest part?"**
Storage. EBS is single-AZ and ReadWriteOnce, so three replicas across two zones couldn't
share one volume — it worked locally only because one node is one zone. Moving to EFS
fixed it. It taught me that a local cluster hides every topology problem.

**"How do you keep cloud costs under control?"**
Budget alert before creating anything, and delete what you're not using. I tore the
cluster down the same session and verified each resource type was gone rather than
assuming the delete command caught everything.
