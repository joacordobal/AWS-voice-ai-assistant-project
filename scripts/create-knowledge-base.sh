#!/bin/bash
# Creates a Bedrock Knowledge Base backed by OpenSearch Serverless,
# adds an S3 data source, and starts an ingestion job.
#
# Prerequisites:
#   - source deploy.env   (see deploy.env.template)
#   - OpenSearch collection + vector index already created
#     (run create-opensearch-index.py first)
#   - KB documents uploaded to s3://$KB_S3_BUCKET/procedures/
set -e

: "${AWS_REGION:?set deploy.env first}"
: "${KB_NAME:?}"
: "${KB_ROLE_ARN:?}"
: "${OSS_COLLECTION_ARN:?}"
: "${OSS_INDEX_NAME:?}"
: "${KB_S3_BUCKET:?}"
: "${EMBEDDING_MODEL_ARN:?}"

echo "=== Creating Knowledge Base ==="
KB_RESULT=$(aws bedrock-agent create-knowledge-base \
  --name "$KB_NAME" \
  --description "Voice assistant knowledge base" \
  --role-arn "$KB_ROLE_ARN" \
  --knowledge-base-configuration "{
    \"type\": \"VECTOR\",
    \"vectorKnowledgeBaseConfiguration\": {
      \"embeddingModelArn\": \"$EMBEDDING_MODEL_ARN\"
    }
  }" \
  --storage-configuration "{
    \"type\": \"OPENSEARCH_SERVERLESS\",
    \"opensearchServerlessConfiguration\": {
      \"collectionArn\": \"$OSS_COLLECTION_ARN\",
      \"vectorIndexName\": \"$OSS_INDEX_NAME\",
      \"fieldMapping\": { \"vectorField\": \"embedding\", \"textField\": \"text\", \"metadataField\": \"metadata\" }
    }
  }" \
  --region "$AWS_REGION")

KB_ID=$(echo "$KB_RESULT" | grep -o '"knowledgeBaseId": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "Knowledge Base ID: $KB_ID"

echo "=== Creating S3 data source ==="
DS_RESULT=$(aws bedrock-agent create-data-source \
  --knowledge-base-id "$KB_ID" \
  --name "kb-docs" \
  --data-source-configuration "{
    \"type\": \"S3\",
    \"s3Configuration\": { \"bucketArn\": \"arn:aws:s3:::$KB_S3_BUCKET\", \"inclusionPrefixes\": [\"procedures/\"] }
  }" \
  --region "$AWS_REGION")

DS_ID=$(echo "$DS_RESULT" | grep -o '"dataSourceId": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "Data Source ID: $DS_ID"

echo "=== Starting ingestion job ==="
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --region "$AWS_REGION"

echo ""
echo "Done. Set KNOWLEDGE_BASE_ID=$KB_ID in your webapp .env"
