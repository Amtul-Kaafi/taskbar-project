#!/usr/bin/env bash
# One-time AWS setup: create the ECR repository the pipeline pushes to and
# print the values the workflow needs. Safe to re-run.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
ECR_REPOSITORY="${ECR_REPOSITORY:-taskbar-app}"
CLUSTER_NAME="${CLUSTER_NAME:-taskbar-eks}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> Creating ECR repository ${ECR_REPOSITORY} in ${AWS_REGION}"
aws ecr describe-repositories --repository-names "${ECR_REPOSITORY}" --region "${AWS_REGION}" >/dev/null 2>&1 \
  || aws ecr create-repository \
       --repository-name "${ECR_REPOSITORY}" \
       --region "${AWS_REGION}" \
       --image-scanning-configuration scanOnPush=true \
       --image-tag-mutability IMMUTABLE >/dev/null

echo "==> Expiring untagged images after 7 days"
aws ecr put-lifecycle-policy \
  --repository-name "${ECR_REPOSITORY}" \
  --region "${AWS_REGION}" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"expire untagged","selection":{"tagStatus":"untagged","countType":"sinceImagePushed","countUnit":"days","countNumber":7},"action":{"type":"expire"}}]}' >/dev/null

cat <<SUMMARY

Registry:   ${REGISTRY}
Repository: ${REGISTRY}/${ECR_REPOSITORY}
Cluster:    ${CLUSTER_NAME}

Set these on the GitHub repository (Settings > Secrets and variables > Actions):
  variable AWS_REGION     = ${AWS_REGION}
  variable EKS_CLUSTER    = ${CLUSTER_NAME}
  secret   AWS_ROLE_ARN   = arn:aws:iam::${ACCOUNT_ID}:role/taskbar-github-actions

Grant that role access to the cluster:
  eksctl create iamidentitymapping \
    --cluster ${CLUSTER_NAME} --region ${AWS_REGION} \
    --arn arn:aws:iam::${ACCOUNT_ID}:role/taskbar-github-actions \
    --group system:masters --username github-actions
SUMMARY
