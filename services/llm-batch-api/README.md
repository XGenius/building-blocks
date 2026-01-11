# Self-Hosted LLM Batch API

A self-hosted LLM inference service using RunPod, designed as a drop-in replacement for Anthropic's Batch API.

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
