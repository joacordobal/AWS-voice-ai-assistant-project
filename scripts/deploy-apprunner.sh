#!/bin/bash
# Builds the web app Docker image, pushes it to ECR, and deploys to App Runner.
# Prerequisites: source deploy.env, Docker running, AWS CLI configured.
set -e

: "${AWS_REGION:?set deploy.env first}"
: "${AWS_ACCOUNT_ID:?}"
: "${ECR_REPO:?}"
: "${APP_RUNNER_SERVICE:?}"
: "${KNOWLEDGE_BASE_ID:?}"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
WEBAPP_DIR="$(dirname "$0")/../webapp"

echo "=== Creating ECR repository (if needed) ==="
aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" 2>/dev/null || echo "Repo exists"

echo "=== Logging in to ECR ==="
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_URI"

echo "=== Building image ==="
docker build -t "${ECR_REPO}:latest" "$WEBAPP_DIR"
docker tag "${ECR_REPO}:latest" "${ECR_URI}:latest"

echo "=== Pushing to ECR ==="
docker push "${ECR_URI}:latest"

echo ""
echo "Image pushed: ${ECR_URI}:latest"
echo ""
echo "Next steps:"
echo "  1. Create IAM roles (see docs/deployment.md)"
echo "  2. Create the App Runner service pointing at this image, port 3000"
echo "  3. Set env vars: AWS_REGION, KNOWLEDGE_BASE_ID, PHOTOS_BUCKET, branding, etc."
echo "  4. To redeploy after changes:"
echo "     aws apprunner start-deployment --service-arn <ARN> --region $AWS_REGION"
