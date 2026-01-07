# Learn this project

Seven short modules. Read them in order — each one only assumes what came before.

| # | Module | What you'll be able to explain |
| --- | --- | --- |
| 00 | [The big picture](00-overview.md) | Why each layer exists and what problem it solves |
| 01 | [The application](01-the-app.md) | What the app is and how it serves pages |
| 02 | [The Dockerfile](02-dockerfile.md) | Every line of the image build |
| 03 | [Docker Compose](03-compose.md) | Running the container with config and storage |
| 04 | [Kubernetes, locally](04-kubernetes-local.md) | Deployments, Services, replicas, rolling updates, rollbacks |
| 05 | [The CI/CD pipeline](05-cicd.md) | What runs on a push and why |
| 06 | [AWS: ECR and EKS](06-aws.md) | The cloud versions of the registry and the cluster |

## How each module is laid out

**What this is** — one paragraph in plain language.

**Line by line** — every block of the file quoted, with what it does and why it's there.

**Try it** — commands to run, with the output you should see.

**If someone asks** — the questions you're likely to get, and short answers.

## The one-sentence version

> A small Node.js web app, packaged into a Docker image, run locally with Compose,
> deployed to Kubernetes as three replicas behind a Service, and shipped by a GitHub
> Actions pipeline that builds the image, pushes it to AWS ECR, and lets Kubernetes
> roll it out one pod at a time.

If you can say that and then answer "why?" at each step, you understand the project.
