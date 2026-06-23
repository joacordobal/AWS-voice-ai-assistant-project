# Voice AI Assistant for Frontline Workers

**A real-time, voice-to-voice AI assistant built with Amazon Nova 2 Sonic, Bedrock Knowledge Bases, and pluggable CRM / contact-center integrations**

---

## Why This Repo Exists

Frontline workers — store clerks, field technicians, warehouse staff, front-desk agents — hit dozens of edge cases a day. The answer is usually buried in a manual nobody has time to read, or it means stopping work to call a manager.

This project is a **voice-first AI assistant** they can simply *talk to*. It pulls answers from a knowledge base of your own procedures, files support tickets in your CRM, analyzes photos of equipment or products, and escalates to a supervisor with a real phone call — all from a phone browser, hands-free.

It started as an industry-specific demo and was generalized into a **reusable accelerator**. Everything that ties it to a particular company or industry lives in a single config file and a `.env`, so you can adapt it to your own use case without touching the core code.

This repo documents:

- **What it does** — a working voice assistant powered entirely by AWS services
- **How the pieces fit together** — Nova 2 Sonic + RAG + tool calling + your backend systems
- **Every gotcha I solved** — stream event ordering, speculative-text deduplication, silence keepalives, SDK migrations, and WebSocket-through-App-Runner issues

The architecture applies to **any industry** where a frontline worker needs hands-free access to knowledge and actions.

---

## What It Does

A worker opens the web app on their phone and can:

1. **Talk to the assistant** — natural voice conversation, no typing required (responds in the user's language)
2. **Get procedure guidance** — the assistant searches a knowledge base and answers conversationally (RAG)
3. **Upload a photo** — snap a picture of broken equipment or a damaged item; the assistant analyzes it and responds by voice
4. **Create a CRM ticket** — the assistant looks up the worker by phone, then files a support case
5. **Escalate to a supervisor** — the assistant triggers an outbound phone call via Amazon Connect

Everything happens in one continuous voice conversation. Works in **demo mode out of the box** — CRM and Connect integrations are optional.

---

## Architecture Overview

![Architecture Overview](docs/architecture/images/architecture-overview.png)
*Complete AWS architecture — voice/photo/text from a phone browser flows through App Runner, Amazon Nova 2 Sonic, a Bedrock Knowledge Base, and pluggable CRM / Amazon Connect integrations.*

More diagrams (per-layer detail and step-by-step flows) live in [`docs/architecture/`](docs/architecture/).

---

## How It Works

1. **Worker speaks** — the browser captures microphone audio (16kHz PCM) and streams it over WebSocket
2. **Server bridges to Bedrock** — maintains a bidirectional stream with Nova 2 Sonic, forwarding audio both ways
3. **AI orchestration** — Nova 2 Sonic transcribes, reasons, and decides when to call a tool
4. **Tools execute** — the server runs the requested tool (KB search, CRM lookup/create, Connect callback) and returns the result
5. **Natural response** — Nova 2 Sonic speaks the answer back in real time, with on-screen transcription

---

## Project Structure

| Path | Description |
|------|-------------|
| `webapp/src/config.ts` | **All branding, prompts, and personalization** — driven by env vars |
| `webapp/src/server.ts` | Express + Socket.IO server, photo analysis, `/api/config` endpoint |
| `webapp/src/client.ts` | Nova 2 Sonic bidirectional streaming client |
| `webapp/src/tools.ts` | 4 AI tools: search_knowledge_base, lookup_contact, create_ticket, escalate_call |
| `webapp/src/consts.ts` | Model IDs, tool schemas, audio config |
| `webapp/public/` | Mobile-first UI (branding loaded dynamically from `/api/config`) |
| `webapp/Dockerfile` | Container build for App Runner |
| `kb-content/` | Sample knowledge base documents (replace with your own) |
| `lambda/connect-callback/` | Amazon Connect outbound-call Lambda (env-driven) |
| `scripts/` | Deployment helpers (Knowledge Base, OpenSearch index, App Runner) |

---

## Quick Start (Local, Demo Mode)

```bash
cd webapp
npm install
cp .env.template .env        # set AWS_REGION and KNOWLEDGE_BASE_ID
npm run dev                  # http://localhost:3000
```

You need AWS credentials with access to Bedrock (Nova 2 Sonic + Nova Lite) and a Bedrock Knowledge Base. CRM and Connect integrations are optional — without them the assistant runs in demo mode.

---

## Customize for Your Industry

Everything industry-specific is configurable via environment variables — no code changes:

```bash
ASSISTANT_NAME="Field Support"
BRAND_NAME="ACME"
BRAND_COLOR="#0F62FE"
ACCENT_COLOR="#FFB000"
GREETING="Hey! 👋"
VOICE_ID="matthew"
SUGGESTIONS="🔧|Equipment issue|Diagnose a fault;;📋|Log a job|Create a work order;;📞|Call dispatch|Reach a supervisor"
# Optional: override the whole system prompt
SYSTEM_PROMPT="You are a field-service assistant for technicians..."
```

Then replace the documents in `kb-content/` with your own procedures and sync them to your Knowledge Base.

**Example adaptations:** field service, healthcare, logistics, hospitality, retail, telecom.

---

## AWS Services Used

| Service | Purpose |
|---------|---------|
| Amazon Nova 2 Sonic | Real-time speech-to-speech + tool calling |
| Amazon Nova Lite | Multimodal image analysis |
| Amazon Bedrock Knowledge Bases | RAG over your procedures |
| OpenSearch Serverless | Vector store for the knowledge base |
| Amazon Titan Embeddings | Document embeddings |
| AWS App Runner | Containerized web app hosting with automatic HTTPS |
| Amazon ECR | Docker image registry |
| Amazon S3 | Photo storage + knowledge base documents |
| AWS Lambda | CRM integration + Connect callback |
| Amazon Connect | Outbound voice callback to supervisors (optional) |
| Amazon SNS | Escalation notifications (optional) |

---

## Voices

Amazon Nova Sonic supports multiple voices. Set `VOICE_ID` in `.env`:

| Voice ID | Language |
|----------|----------|
| `matthew`, `tiffany` | English (US) |
| `amy` | English (UK) |
| `lupe`, `carlos` | Spanish |
| `ambre`, `florian` | French |
| `beatrice`, `lorenzo` | Italian |
| `greta`, `lennart` | German |

---

## Gotchas Solved

Things that cost hours and aren't obvious from the docs:

- **Nova 2 Sonic event ordering** — `sessionStart` → `promptStart` → `systemPrompt` → `audioStart` must be queued in exact order *before* the stream opens
- **Tool schema format** — `inputSchema.json` must be a **stringified** JSON, not an object
- **Speculative vs Final text** — Nova Sonic emits each response twice (a real-time `SPECULATIVE` pass and a `FINAL` pass); render only one to avoid duplicate bubbles
- **55-second timeout** — the stream dies without audio; send silence frames every 200ms when the user is on text mode
- **Node 18 Lambda runtime** — `aws-sdk` v2 is gone; use `@aws-sdk/client-*` v3
- **WebSocket through App Runner** — have Socket.IO use `polling` first, then upgrade to `websocket`

---

## Deploy to AWS — Step-by-Step Setup Guide

This section walks you through everything you need to configure in AWS to get the assistant running in the cloud. The app runs locally in demo mode with minimal setup, but a full deployment requires the following manual steps.

### Prerequisites

- AWS Account with admin access
- AWS CLI v2 configured (`aws configure`)
- Node.js 18+ and npm
- Docker (for App Runner deployment)
- Region: `us-east-1` recommended (full model availability)

---

### Step 1: Enable Model Access in Bedrock (Console)

Nova 2 Sonic and Nova Lite are not enabled by default. You must request access:

1. Open the **Amazon Bedrock** console → **Model access** (left menu)
2. Click **Manage model access**
3. Enable:
   - `Amazon Nova 2 Sonic` (speech-to-speech)
   - `Amazon Nova Lite` (multimodal, for photo analysis)
   - `Amazon Titan Embed Text v2` (for Knowledge Base embeddings)
4. Wait for access to be granted (usually instant for Amazon models)

**Why manual:** AWS requires explicit opt-in for foundation models. This cannot be automated via CLI.

---

### Step 2: Create an S3 Bucket for Knowledge Base Documents

```bash
aws s3 mb s3://YOUR-KB-BUCKET-NAME --region us-east-1
```

Then upload your procedure documents:

```bash
aws s3 sync kb-content/ s3://YOUR-KB-BUCKET-NAME/procedures/
```

Replace the sample documents in `kb-content/` with your own procedures first.

---

### Step 3: Create OpenSearch Serverless Collection (Console + Script)

The Knowledge Base needs a vector store. OpenSearch Serverless provides this.

**In the AWS Console:**

1. Open **Amazon OpenSearch Service** → **Serverless** → **Collections**
2. Click **Create collection**:
   - Name: `voice-assistant-kb`
   - Type: **Vector search**
3. For **Encryption**: use AWS owned key
4. For **Network**: Public access (simplest for dev)
5. For **Data access policy**: create a policy that grants access to your IAM user/role AND the KB role (you'll create the KB role next)

**After the collection is Active**, create the vector index:

Go to the **Indexes** tab → **Create index**:
- Index name: `voice-assistant-index`
- Vector field: name=`embedding`, engine=`faiss`, dimensions=`1024`, distance=`Euclidean`
- Metadata fields: `text` (String, filterable), `metadata` (String, filterable)

**Why manual:** OpenSearch Serverless collections require encryption/network/access policies that are tightly coupled. The console wizard handles the dependencies. The vector index can alternatively be created via the script in `scripts/create-opensearch-index.py`.

---

### Step 4: Create the IAM Role for the Knowledge Base

The Knowledge Base needs a role that allows Bedrock to access S3 and OpenSearch:

```bash
# Create the role
aws iam create-role \
  --role-name voice-assistant-kb-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "bedrock.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach permissions (replace YOUR-BUCKET and YOUR-ACCOUNT-ID)
aws iam put-role-policy \
  --role-name voice-assistant-kb-role \
  --policy-name KBPermissions \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0"},
      {"Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket"], "Resource": ["arn:aws:s3:::YOUR-BUCKET", "arn:aws:s3:::YOUR-BUCKET/*"]},
      {"Effect": "Allow", "Action": "aoss:APIAccessAll", "Resource": "*"}
    ]
  }'
```

---

### Step 5: Create the Knowledge Base (Script)

Once OpenSearch and the role exist, use the provided script:

```bash
cd scripts
cp deploy.env.template deploy.env
# Edit deploy.env with your values (account ID, bucket, collection ARN, etc.)
source deploy.env
bash create-knowledge-base.sh
```

This creates the KB, adds the S3 data source, and runs the first sync. Note the **Knowledge Base ID** from the output — you'll need it for the `.env`.

---

### Step 6: Create an S3 Bucket for Photo Uploads (Optional)

If you want photo analysis:

```bash
aws s3 mb s3://YOUR-PHOTOS-BUCKET --region us-east-1
```

Configure CORS on the bucket to allow browser uploads:

```bash
aws s3api put-bucket-cors --bucket YOUR-PHOTOS-BUCKET --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }]
}'
```

---

### Step 7: Deploy the Web App to AWS App Runner (Script)

```bash
source deploy.env
bash deploy-apprunner.sh
```

This builds the Docker image, pushes to ECR, and gives you instructions for creating the App Runner service. You'll need to:

1. Create IAM roles for App Runner (ECR access + instance role with Bedrock/S3/Lambda permissions)
2. Create the App Runner service in the console or CLI pointing to the ECR image, port 3000
3. Set the environment variables (Knowledge Base ID, bucket names, optional Lambda ARNs)

The service gives you an HTTPS URL like `https://xxxxx.awsapprunner.com` — accessible from any phone browser.

---

### Step 8: (Optional) CRM Integration

To connect to a CRM like Salesforce:

1. Deploy a Lambda that interfaces with your CRM (the repo expects a Salesforce CTI Adapter-style Lambda that accepts `{ Details: { Parameters: { sf_operation, ... } } }`)
2. Set `CRM_LAMBDA_ARN` in the App Runner environment variables
3. Without this, the app runs in demo mode (tools return mock responses)

---

### Step 9: (Optional) Amazon Connect Escalation

To enable real phone callbacks to supervisors:

1. You need an existing Amazon Connect instance with a contact flow for outbound calls
2. Deploy the Lambda in `lambda/connect-callback/` with environment variables for your Connect instance (CONTACT_FLOW_ID, INSTANCE_ID, QUEUE_ID, SOURCE_PHONE_NUMBER)
3. Set `CONNECT_CALLBACK_LAMBDA_ARN` in the App Runner environment variables
4. Without this, escalation runs in demo mode

---

### What You Get at Each Stage

| After Step... | What works |
|---|---|
| Steps 1-5 | `npm run dev` locally with voice + KB search |
| Step 6 | Photo upload and analysis |
| Step 7 | Full app running in the cloud, accessible from phones |
| Step 8 | CRM ticket creation with real contact lookup |
| Step 9 | Outbound phone calls to supervisors |

You can stop at any step and have a working assistant — each integration is additive.

---

## License

MIT

## Built With

Designed and built end-to-end as a Solution Architect accelerator, pair-programmed with Kiro (AI IDE).
