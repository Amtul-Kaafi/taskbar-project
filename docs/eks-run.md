# Running this on EKS: what actually happened

A record of deploying the taskbar app to a real EKS cluster in `ap-south-1`,
pushing a code change through the pipeline, and rolling it back. The cluster was
deleted afterwards, so this file is the evidence that remains.

Account `344530147162`, region `ap-south-1`, cluster `taskbar-eks`,
Kubernetes 1.34.

## What was provisioned

| Resource | Identifier |
| --- | --- |
| EKS cluster | `taskbar-eks`, Kubernetes 1.34, control plane in `ap-south-1` |
| Node group | 2× t3.small, private subnets, `ap-south-1a` + `ap-south-1b` |
| ECR repository | `344530147162.dkr.ecr.ap-south-1.amazonaws.com/taskbar-app` |
| EFS filesystem | `fs-079f6991f252d4720`, mount targets in both private subnets |
| CI role | `taskbar-github-actions`, assumed via GitHub OIDC, no stored AWS keys |
| Addons | vpc-cni, coredns, kube-proxy, aws-ebs-csi-driver, aws-efs-csi-driver, metrics-server |
| Ingress | AWS Load Balancer Controller v2.13 (installed; see the ELB note below) |

Cluster creation took about 17 minutes.

## Nodes

```
NAME                                             STATUS   VERSION                ZONE
ip-192-168-110-211.ap-south-1.compute.internal   Ready    v1.34.10-eks-cb19647   ap-south-1a
ip-192-168-142-150.ap-south-1.compute.internal   Ready    v1.34.10-eks-cb19647   ap-south-1b
```

## Storage: why EBS did not work

The first deploy left every pod `Pending`:

```
Warning  ProvisioningFailed  storageclass.storage.k8s.io "gp3" not found
Warning  FailedScheduling    0/2 nodes are available: pod has unbound immediate PersistentVolumeClaims
```

Two separate problems:

1. EKS ships only a `gp2` StorageClass. The EBS CSI addon does not create a
   `gp3` class; you have to define it.
2. The real blocker: an EBS volume lives in one availability zone and is
   `ReadWriteOnce`. Three replicas spread across `1a` and `1b` cannot all mount
   it, whatever the StorageClass says. This never surfaced locally because a
   one-node cluster is also one zone.

The overlay now provisions EFS instead — a network filesystem, `ReadWriteMany`,
reachable from every AZ with a mount target, with an access point per claim
pinning ownership to uid/gid 1000 (the unprivileged user in the image).

Proof that all three replicas share one volume — written on a pod in `1b`, read
from a pod in `1a` off its own mount:

```
$ kubectl -n taskbar exec <pod-in-1b> -- node -e "...PUT /api/notes..."
{"text":"Written on pod A in ap-south-1b, stored on EFS, read from pods in 1a.","savedAt":"2026-09-07T22:54:45.759Z"}

$ kubectl -n taskbar exec <pod-in-1a> -- cat /data/notes.json
{
  "text": "Written on pod A in ap-south-1b, stored on EFS, read from pods in 1a.",
  "savedAt": "2026-09-07T22:54:45.759Z"
}

$ kubectl -n taskbar exec <pod-in-1a> -- df -h /data
Filesystem                Size      Used Available Use% Mounted on
127.0.0.1:/               8.0E         0      8.0E   0% /data
```

A read issued in the same second as the write briefly returned empty: EFS is
close-to-open consistent and the attribute cache had not caught up. It resolved
on the next request. Worth knowing before trusting a read-after-write in tests.

## The pipeline run

Push to `main` → build, smoke test, push to ECR, apply the overlay, roll out.

Build job output tag: `1.2.0-7ec299c` (package version + short SHA).

ECR after the run:

```
1.1.0           2026-09-08T03:09:22+05:00
1.2.0-7ec299c   2026-09-08T04:07:39+05:00
```

The rolling update, sampled every 12 seconds while the deploy job ran:

```
[3] deployed=1.1.0         55d595d4f9-94rzf(Running) 55d595d4f9-gpz2x(Running) 55d595d4f9-j2tq9(Running) 7966d46655-t7wls(Running)
[4] deployed=1.2.0-7ec299c 55d595d4f9-94rzf(Running) 7966d46655-7qmx2(ContainerCreating) 7966d46655-pqhf8(Running) 7966d46655-t7wls(Running)
[5] deployed=1.2.0-7ec299c 7966d46655-7qmx2(Running) 7966d46655-pqhf8(Running) 7966d46655-s774c(Running)
```

Four pods exist at step 3: `maxSurge: 1` adds a new one before any old one goes,
and `maxUnavailable: 0` means old pods only retire once new ones pass readiness.
A broken image therefore cannot take the running version down — the rollout
stalls with the old pods still serving.

## Rollback

```
$ kubectl -n taskbar rollout history deployment/taskbar
REVISION  CHANGE-CAUSE
1         <none>
2         7ec299c11b1ce6300255fbc5dc27ebc5c791e635 by Amtul-Kaafi

$ kubectl -n taskbar exec <pod> -- ...GET /api/health
{"status":"ok","version":"1.2.0","host":"taskbar-7966d46655-7qmx2","uptime":44}

$ kubectl -n taskbar rollout undo deployment/taskbar
deployment.apps/taskbar rolled back
deployment "taskbar" successfully rolled out

$ kubectl -n taskbar get deployment taskbar -o jsonpath='{...image}'
344530147162.dkr.ecr.ap-south-1.amazonaws.com/taskbar-app:1.1.0

$ kubectl -n taskbar exec <pod> -- ...GET /api/health
{"status":"ok","version":"1.1.0","host":"taskbar-55d595d4f9-2r8dx","uptime":25}
```

The application reports the version it is serving, so the rollback is confirmed
by the app rather than only by kubectl. A second `rollout undo` rolled forward
to `1.2.0-7ec299c` again, which is where the cluster finished.

## Three things that bit, and the fixes

**LoadBalancer Services need a controller now.** Kubernetes removed the in-tree
AWS cloud provider, so on 1.34 a `type: LoadBalancer` Service sits at
`<pending>` forever unless the AWS Load Balancer Controller is installed. The
Service logged `EnsuringLoadBalancer` once and nothing after. Installing the
controller (IAM policy + IRSA service account + Helm chart) is now a required
step, not an optional upgrade. Guides written before 1.31 omit it.

**This AWS account cannot create load balancers.** With the controller running,
the NLB request was refused at the account level:

```
OperationNotPermitted: This AWS account currently does not support creating
load balancers. For more information, please contact AWS Support.
```

A new-account restriction that only AWS Support can lift, unrelated to IAM or
configuration. The app was reached with `kubectl port-forward` instead.

**GitHub OIDC subject claims contain immutable IDs.** The deploy job failed with
`Not authorized to perform sts:AssumeRoleWithWebIdentity` against a trust policy
written the way every guide shows. Widening the subject to
`repo:Amtul-Kaafi/taskbar-project:*` still failed. CloudTrail had the answer:

```
principalId: ...:repo:Amtul-Kaafi@148440954/taskbar-project@1360546420:ref:refs/heads/main
```

GitHub issues `repo:OWNER@OWNERID/REPO@REPOID:ref:...`, so the plain
`repo:OWNER/REPO:...` pattern matches nothing. Matching the real claim fixed it,
and the run went green in 2m2s. When an OIDC trust policy is denied, read the
actual claim out of CloudTrail rather than trusting the documented shape.

## Teardown

Delete the Service before the cluster — an orphaned load balancer holds ENIs and
blocks VPC deletion.

```bash
kubectl -n taskbar delete svc taskbar taskbar-nodeport
kubectl delete namespace taskbar          # releases the EFS-backed PVC
eksctl delete cluster -f infra/eks-cluster.yaml --disable-nodegroup-eviction
aws efs delete-mount-target --mount-target-id <each>
aws efs delete-file-system --file-system-id fs-079f6991f252d4720
aws ec2 delete-security-group --group-id <efs sg>
```

ECR, the OIDC provider and the CI role are effectively free and were kept.

Verify nothing survives:

```bash
aws eks list-clusters --region ap-south-1
aws elbv2 describe-load-balancers --region ap-south-1
aws ec2 describe-volumes --region ap-south-1 --filters Name=status,Values=available
aws cloudformation list-stacks --region ap-south-1 --stack-status-filter CREATE_COMPLETE
```
