#!/usr/bin/env bash
# Manual equivalent of what the pipeline does: build, tag, push to ECR and
# point the running Deployment at the new image.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
ECR_REPOSITORY="${ECR_REPOSITORY:-taskbar-app}"
CLUSTER_NAME="${CLUSTER_NAME:-taskbar-eks}"
NAMESPACE="${NAMESPACE:-taskbar}"

VERSION="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse --short HEAD)"
TAG="${VERSION}-${SHA}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}:${TAG}"

echo "==> Logging in to ECR"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> Building ${IMAGE}"
docker build -t "${IMAGE}" .

echo "==> Pushing"
docker push "${IMAGE}"

echo "==> Updating kubeconfig for ${CLUSTER_NAME}"
aws eks update-kubeconfig --name "${CLUSTER_NAME}" --region "${AWS_REGION}"

echo "==> Rolling out"
kubectl -n "${NAMESPACE}" set image deployment/taskbar "taskbar=${IMAGE}"
kubectl -n "${NAMESPACE}" annotate deployment/taskbar \
  kubernetes.io/change-cause="manual push ${TAG}" --overwrite
kubectl -n "${NAMESPACE}" rollout status deployment/taskbar --timeout=5m
