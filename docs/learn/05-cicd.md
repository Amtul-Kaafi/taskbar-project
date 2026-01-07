# 05 — The CI/CD pipeline

## What this is

Everything so far you did by hand: build the image, test it, push it, update the
Deployment. [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) writes
those steps down so they run automatically on every push — the same way, every time,
with a log.

- **CI** (Continuous Integration) — build and test every change automatically.
- **CD** (Continuous Deployment) — ship what passed.

The file has **two jobs**, and the split matters:

| Job | Runs when | Needs AWS? |
| --- | --- | --- |
| `build` | Every push and pull request | No |
| `deploy` | Pushes to `main`, and only if enabled | Yes |

Anyone can fork this repo and the `build` job works for them. Only the deploy half
touches your cloud account.

## Line by line

### Triggers

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - "**.md"
      - "docs/**"
  pull_request:
    branches: [main]
  workflow_dispatch:
```

Three ways this runs:

- **`push`** to `main` — but not for documentation-only changes. No point rebuilding an
  image because a README sentence changed.
- **`pull_request`** — test proposed changes before merging.
- **`workflow_dispatch`** — a "Run workflow" button in the Actions tab, for manual runs.

### Permissions and shared values

```yaml
permissions:
  contents: read

env:
  ECR_REPOSITORY: taskbar-app
  NAMESPACE: taskbar
  DEPLOYMENT: taskbar
  CONTAINER: taskbar
```

`permissions` limits what the workflow's automatic token can do — read the repo, nothing
else. Start minimal and add only what's needed.

`env` values are available to every step, so names aren't repeated across the file.

### The build job

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
```

**`runs-on: ubuntu-latest`** — GitHub gives you a fresh Ubuntu virtual machine for this
job. It's destroyed afterwards, so every run starts from nothing. That's the point:
nothing can depend on leftover state.

**`outputs`** publishes a value for a later job to read — here, the image tag.

```yaml
      - name: Check out
        uses: actions/checkout@v5
```

The VM starts empty — it doesn't even have your code. This clones the repo. `uses:` means
"run someone else's published action"; `@v5` pins the version.

```yaml
      - name: Work out the image tag
        id: meta
        run: |
          VERSION="$(node -p "require('./package.json').version")"
          echo "tag=${VERSION}-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"
```

Builds a tag like `1.1.0-b28e5d1`: the version from `package.json` plus the first 7
characters of the commit SHA.

**Why not `latest`?** Because `latest` doesn't tell you *what's running*. With a
SHA-based tag, the image running in the cluster maps back to exactly one commit. It also
means every build produces a distinct tag, so Kubernetes always sees a genuine change.

Writing to `$GITHUB_OUTPUT` is how a step exports a value — the `id: meta` lets later
steps read it as `steps.meta.outputs.tag`.

```yaml
      - name: Build the image
        run: docker build -t "taskbar-app:${{ steps.meta.outputs.tag }}" .
```

The same `docker build` you run locally.

```yaml
      - name: Smoke test the image
        run: |
          docker run -d --name smoke -p 3000:3000 "taskbar-app:${{ steps.meta.outputs.tag }}"
          for i in $(seq 1 20); do
            if curl -fsS http://localhost:3000/api/health > /tmp/health.json; then
              cat /tmp/health.json; echo
              break
            fi
            sleep 1
          done
          test -s /tmp/health.json
          curl -fsS http://localhost:3000/api/apps > /dev/null
          docker rm -f smoke
```

**The most valuable step in the file.** A build succeeding only proves the image was
assembled — not that it runs. This starts the container and polls the same `/api/health`
endpoint Kubernetes will use as a readiness probe.

The retry loop exists because the container needs a moment to start. `test -s` fails the
job if the file is empty, meaning the app never answered.

If this passes, the image genuinely works. If it fails, nothing reaches production.

```yaml
      - name: Validate the manifests
        run: |
          kubectl kustomize k8s/base > /dev/null
          kubectl kustomize k8s/overlays/eks > /dev/null
```

Catches YAML mistakes at build time rather than at deploy time.

### The deploy job

```yaml
  deploy:
    needs: build
    if: ${{ github.event_name != 'pull_request' && vars.DEPLOY_ENABLED == 'true' }}
```

**`needs: build`** — only runs if `build` succeeded. That's the gate.

**`if:`** has two conditions. Pull requests never deploy — someone else's PR shouldn't
reach your cluster. And `DEPLOY_ENABLED` is a repository variable acting as an on/off
switch, so the workflow doesn't fail when there's no cluster. It's currently `false`,
which is why deploy shows as *skipped*.

```yaml
    permissions:
      id-token: write
      contents: read
```

`id-token: write` lets the job request an **OIDC token** — the mechanism that replaces
stored AWS keys. More on that below.

```yaml
      - name: Assume the deployment role
        uses: aws-actions/configure-aws-credentials@v5
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
```

**No AWS keys are stored in this repository.** Instead:

1. GitHub gives the job a short-lived signed token describing *what it is* — this repo,
   this branch, this workflow.
2. The action sends that token to AWS.
3. AWS checks it against the IAM role's trust policy, which says which repo and branch
   are allowed.
4. AWS returns temporary credentials that expire in an hour.

Nothing long-lived exists to leak. If the repo is deleted, the access dies with it.

```yaml
      - name: Log in to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push the image
        run: |
          IMAGE="$REGISTRY/$ECR_REPOSITORY:$TAG"
          docker build -t "$IMAGE" .
          docker push "$IMAGE"
```

ECR is a private registry, so Docker has to authenticate first. Then the image is tagged
with the full registry path — `344530147162.dkr.ecr.ap-south-1.amazonaws.com/taskbar-app:1.1.0-b28e5d1`
— and pushed.

```yaml
      - name: Point kubectl at the cluster
        run: aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "$AWS_REGION"
```

Writes a kubeconfig so `kubectl` knows where the cluster is and how to authenticate.

```yaml
      - name: Point the EKS overlay at the image just pushed
        run: |
          sed -i "s|newName: .*|newName: $REGISTRY/$ECR_REPOSITORY|" k8s/overlays/eks/kustomization.yaml
          sed -i "s|newTag: .*|newTag: $TAG|" k8s/overlays/eks/kustomization.yaml
          kubectl kustomize k8s/overlays/eks | grep "image:"
```

Rewrites the image reference in the overlay. The `grep` prints the result into the log,
so the run itself records which image was deployed.

```yaml
      - name: Apply manifests and trigger the rolling update
        run: |
          kubectl apply -k k8s/overlays/eks
          kubectl -n "$NAMESPACE" annotate "deployment/$DEPLOYMENT" kubernetes.io/change-cause="${{ github.sha }} by ${{ github.actor }}" --overwrite
```

`kubectl apply` sends the desired state to the cluster. Kubernetes notices the pod
template changed and starts a rolling update — **CI doesn't orchestrate the update, it
just declares the new state.**

The annotation records who deployed what, and shows up in `kubectl rollout history`.

```yaml
      - name: Wait for the rolling update
        run: kubectl -n "$NAMESPACE" rollout status "deployment/$DEPLOYMENT" --timeout=5m
```

Without this, the job would go green the moment `apply` returned — before knowing whether
the pods actually started. This blocks until all pods are ready, or fails after 5
minutes.

```yaml
      - name: Roll back if the update did not become ready
        if: failure()
        run: |
          kubectl -n "$NAMESPACE" rollout undo "deployment/$DEPLOYMENT"
          kubectl -n "$NAMESPACE" rollout status "deployment/$DEPLOYMENT" --timeout=5m
          kubectl -n "$NAMESPACE" rollout history "deployment/$DEPLOYMENT"
```

**`if: failure()`** — only runs if an earlier step failed. Automatic rollback: a bad
deploy returns to the previous version without anyone waking up.

Worth saying out loud: because `maxUnavailable: 0`, the old pods were still serving the
whole time. The rollback is tidying up, not rescuing an outage.

```yaml
      - name: Report what is running
        if: always()
        run: |
          kubectl -n "$NAMESPACE" get pods -o wide || true
```

`if: always()` runs whether things passed or failed, leaving the final state in the log
for debugging.

## Try it

```bash
gh workflow run "build and deploy" --ref main
```

```bash
gh run list --limit 3
```

```bash
gh run view --log
```

Or just push a change and watch the Actions tab.

## If someone asks

**"What triggers the pipeline?"**
A push to `main`, a pull request, or a manual run. Documentation-only pushes are skipped.

**"How do you authenticate to AWS without storing keys?"**
OIDC. GitHub issues a short-lived signed token identifying the repo and branch; AWS
trusts it via the role's trust policy and returns temporary credentials. Nothing
long-lived is stored.

**"How does the pipeline know the deployment succeeded?"**
`kubectl rollout status` blocks until every pod is ready or the timeout expires. Pods only
become ready when the readiness probe passes, so success means the app is actually
answering.

**"What if the deploy fails?"**
`if: failure()` triggers `rollout undo`. And because `maxUnavailable: 0`, the previous
version never stopped serving.

**"Why tag images with the commit SHA?"**
So a running image maps to exactly one commit, and every build is a distinct tag. `latest`
is ambiguous and can make Kubernetes think nothing changed.
