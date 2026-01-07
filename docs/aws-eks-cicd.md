# EKS, ECR and the CI/CD pipeline

The local cluster proves the manifests; this is the same application on AWS,
with a pipeline that turns a push to `main` into a rolling update on EKS.

> Nothing here has been applied to a live AWS account from this repository —
> there are no credentials configured, and creating an EKS cluster costs money
> (control plane ~$0.10/hour plus the node group). The files are ready to run;
> the account details below are placeholders.

## The flow

```
git push origin main
        │
        ▼
GitHub Actions  ──(OIDC, no stored keys)──▶  AWS IAM role
        │
        ├─ docker build  ──▶  tag  <version>-<short sha>
        │
        ├─ docker push   ──▶  ECR  <account>.dkr.ecr.<region>.amazonaws.com/taskbar-app
        │
        ├─ aws eks update-kubeconfig      (kubectl now points at the cluster)
        │
        ├─ kubectl apply -k k8s/overlays/eks   (pod template now names the new image)
        │
        ▼
Kubernetes rolling update on EKS: new pods started, readiness checked,
old pods retired one at a time. Failure ⇒ automatic `rollout undo`.
```

## One-time setup

1. **Create the cluster** — `infra/eks-cluster.yaml` is an eksctl config with a
   managed node group across two AZs, IRSA enabled, and the EBS CSI driver addon
   that provisions the PVC:

   ```bash
   eksctl create cluster -f infra/eks-cluster.yaml
   ```

2. **Create the registry** — `infra/ecr-bootstrap.sh` creates the ECR
   repository with scan-on-push and immutable tags, adds a lifecycle rule that
   expires untagged images after 7 days, and prints the values to set on the
   GitHub repository:

   ```bash
   ./infra/ecr-bootstrap.sh
   ```

3. **Create the CI role** — a role GitHub Actions assumes through OIDC, so no
   AWS keys are stored in the repository:

   ```bash
   aws iam create-role --role-name taskbar-github-actions \
     --assume-role-policy-document file://infra/github-oidc-trust-policy.json
   aws iam put-role-policy --role-name taskbar-github-actions \
     --policy-name taskbar-ci --policy-document file://infra/github-actions-policy.json
   ```

   The trust policy pins the role to this repository and to `refs/heads/main`.
   The permission policy allows exactly two things: push to the one ECR
   repository, and describe the one cluster.

4. **Let the role talk to the cluster** — IAM gets you the endpoint; Kubernetes
   RBAC decides what you may do:

   ```bash
   eksctl create iamidentitymapping --cluster taskbar-eks --region us-east-1 \
     --arn arn:aws:iam::ACCOUNT_ID:role/taskbar-github-actions \
     --group system:masters --username github-actions
   ```

5. **Set the repository variables and secret**

   | Name | Kind | Example |
   | --- | --- | --- |
   | `AWS_REGION` | variable | `us-east-1` |
   | `EKS_CLUSTER` | variable | `taskbar-eks` |
   | `AWS_ROLE_ARN` | secret | `arn:aws:iam::ACCOUNT_ID:role/taskbar-github-actions` |

## The pipeline

`.github/workflows/deploy.yml`, triggered by a push to `main` (documentation
changes are ignored) or run by hand:

| Step | What it does |
| --- | --- |
| Work out the image tag | `<package.json version>-<7-char sha>`, e.g. `1.1.0-a1efcf4` — never `latest`, so every deploy is traceable to a commit |
| Assume the deployment role | OIDC token exchanged for short-lived AWS credentials |
| Log in to ECR | Docker credentials for the registry |
| Build and push | `docker build` then `docker push` to ECR |
| Point kubectl at the cluster | `aws eks update-kubeconfig` |
| Point the overlay at the image | Rewrites `newName`/`newTag` in the EKS overlay |
| Apply manifests | `kubectl apply -k k8s/overlays/eks` — the changed pod template starts the rolling update |
| Wait | `kubectl rollout status --timeout=5m` |
| Roll back on failure | `kubectl rollout undo` + status + history, only if a previous step failed |
| Report | Pods and the running image, always |

Because the Deployment uses `maxUnavailable: 0`, a bad image cannot take the
service down: its pods never pass readiness, the rollout stalls with the old
pods still serving, the status step times out, and the rollback step returns the
Deployment to the last good revision.

## Doing it by hand

`infra/push-image.sh` is the same sequence locally — build, tag with version and
sha, push to ECR, update kubeconfig, `kubectl set image`, wait for the rollout.
Useful for a first deploy or when debugging the pipeline.

## What differs from the local cluster

| Concern | Local (Docker Desktop) | EKS |
| --- | --- | --- |
| Image source | Local image, `imagePullPolicy: IfNotPresent` | ECR, pulled by the node's instance role |
| Ingress | NodePort / `port-forward` | `type: LoadBalancer` (NLB), or an Ingress with the AWS Load Balancer Controller |
| Storage class | `standard` (host path) | `gp3` via the EBS CSI driver; EFS if pods must share one volume across AZs |
| Nodes | One control-plane node | Managed node group, 2–4 `t3.small` across two AZs |

## Cost note

Delete the cluster when you are done — the control plane bills by the hour
whether or not anything is deployed:

```bash
eksctl delete cluster -f infra/eks-cluster.yaml
```
