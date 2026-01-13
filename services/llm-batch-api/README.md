# Self-Hosted LLM Batch API

A self-hosted LLM inference service using RunPod, designed as a drop-in replacement for Anthropic's Batch API.

## Prerequisites

- [ ] RunPod account with API access
- [ ] HuggingFace account with Llama-3 access (requires Meta approval)
- [ ] Redis instance (Upstash or self-hosted)
- [ ] Docker Hub account (for custom containers)

## Human Setup Steps

### 1. Set Up RunPod Account

1. **Create account** at [runpod.io](https://runpod.io)
2. **Add credits** - GPU usage is pay-as-you-go
3. **Get API key** - Account → API Keys

### 2. Get HuggingFace Access

1. **Create account** at [huggingface.co](https://huggingface.co)
2. **Request Llama-3 access** at [meta-llama/Meta-Llama-3-70B-Instruct](https://huggingface.co/meta-llama/Meta-Llama-3-70B-Instruct)
   - Fill out Meta's form
   - Wait for approval (usually 1-2 days)
3. **Create access token** - Settings → Access Tokens

### 3. Set Up Redis

**Option A: Upstash (Recommended)**
1. Create account at [upstash.com](https://upstash.com)
2. Create Redis database
3. Copy the connection string

**Option B: Self-hosted on RunPod**
1. Deploy Redis pod on RunPod
2. Note the internal URL

### 4. Create Network Volume

1. RunPod Console → Storage → Create Network Volume
2. Size: 300GB minimum (for model weights)
3. Region: Same as your GPU endpoints
4. Note the volume ID

### 5. Deploy Model Endpoints

See `FULL_SPEC.md` for detailed endpoint configuration.

**Docker Image (Critical):** `runpod/worker-v1-vllm:v2.11.1`

### 6. Deploy Batch API

1. Build and push the batch-api container
2. Deploy as RunPod serverless endpoint
3. Note the endpoint URL

## Environment Variables

### Batch API Service

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | **Yes** | Redis connection string |
| `MISTRAL_BASE_URL` | **Yes** | RunPod Mistral endpoint URL |
| `LLAMA_BASE_URL` | **Yes** | RunPod Llama endpoint URL |
| `PORT` | No | API port (default: 8000) |

### Worker Service

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | **Yes** | Redis connection string |
| `MISTRAL_BASE_URL` | **Yes** | RunPod Mistral endpoint URL |
| `LLAMA_BASE_URL` | **Yes** | RunPod Llama endpoint URL |
| `WORKER_CONCURRENCY` | No | Parallel requests per worker (default: 8) |

### Your Node.js App

| Variable | Required | Description |
|----------|----------|-------------|
| `LOCAL_BATCH_URL` | **Yes** | Batch API base URL |

```bash
# Example .env for your app
LOCAL_BATCH_URL=https://api.runpod.ai/v2/your-batch-endpoint
```

## Overview

This service allows you to:
- Run LLM inference at **50-60% lower cost** than managed APIs
- Process batches in **minutes instead of hours**
- Use hybrid model routing (fast Mistral for simple tasks, Llama 70B for quality)
- Scale independently of your main application

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Node.js App    │────▶│  FastAPI Batch   │────▶│  Redis Queue    │
│  (your app)     │     │  API             │     │                 │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌─────────────────────────────────┼────────┐
                        │                                 │        │
                        ▼                                 ▼        ▼
              ┌──────────────────┐             ┌──────────────────┐
              │  Mistral 7B      │             │  Llama-3 70B     │
              │  (RTX 4090)      │             │  (2x A100 80GB)  │
              │  Fast & cheap    │             │  High quality    │
              └──────────────────┘             └──────────────────┘
```

## Components

### 1. Batch API (FastAPI)

HTTP API that mimics Anthropic's batch endpoints:

- `POST /v1/messages/batches` - Create a new batch
- `GET /v1/messages/batches/{id}` - Get batch status
- `GET /v1/messages/batches/{id}/results` - Get batch results

### 2. Worker

Background process that:
- Pulls batches from Redis queue
- Routes to appropriate model based on stage
- Processes requests with bounded concurrency
- Handles retries and errors

### 3. Model Endpoints (RunPod Serverless)

**Docker Image:** `runpod/worker-v1-vllm:v2.11.1`

> ⚠️ **Important:** Use this exact image. Other vLLM images may fail to initialize on RunPod Serverless.

| Model | GPU | Use Case |
|-------|-----|----------|
| Mistral 7B | RTX 4090 | Fast, cheap - subject lines, email drafts |
| Llama 70B | 2x A100 80GB | High quality - sales intelligence, polish |

### 4. Node.js Adapter

TypeScript client for your Node.js app:

```typescript
import { createBatch, getBatchStatus, getBatchResults } from './llmAdapter';

// Create a batch
const { id } = await createBatch('sales_intel', requests);

// Poll for completion
const status = await getBatchStatus(id);

// Get results when complete
const { results } = await getBatchResults(id);
```

## Directory Structure

```
llm-batch-api/
├── README.md                  # This file
├── FULL_SPEC.md              # Complete implementation spec
├── batch-api/                 # FastAPI service
│   ├── main.py
│   ├── worker.py
│   ├── Dockerfile
│   └── requirements.txt
├── node-adapter/              # TypeScript client
│   ├── llmAdapter.ts
│   └── types.ts
└── deploy/                    # Deployment configs
    ├── runpod-mistral.json
    ├── runpod-llama.json
    └── README.md
```

## Quick Start

See `FULL_SPEC.md` for complete implementation details including:

- RunPod setup instructions
- Docker container configurations
- Environment variables
- Cost estimates
- Testing procedures

## Model Routing

Requests are routed based on the `stage` parameter:

| Stage | Model | Reasoning |
|-------|-------|-----------|
| `sales_intel` | Llama 70B | Complex reasoning for research |
| `subject` | Mistral 7B | Fast, simple task |
| `email` | Mistral 7B | Fast draft generation |
| `polish` | Llama 70B | Quality polish pass |

Override with `metadata.model_hint`:

```json
{
  "stage": "email",
  "requests": [{
    "custom_id": "lead_123",
    "metadata": { "model_hint": "llama-70b" },
    "params": { ... }
  }]
}
```

## Cost Comparison

| Metric | Anthropic Batch | Self-Hosted |
|--------|----------------|-------------|
| Monthly cost (5K leads/day) | ~$2,500 | ~$1,100 |
| Latency | Hours | Minutes |
| Savings | - | **55%** |

## License

MIT
