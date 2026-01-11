# Project Brief — Hybrid Mistral + Llama-3-70B on RunPod

**Goal:** Replace Anthropic batch queue for lead personalization by running a hybrid LLM system on RunPod so the pipeline completes in minutes rather than hours. Use **Mistral** for high-throughput/cheap candidate generation and **Llama-3 70B** for strategy-quality stage(s). Expose an **Anthropic-like Batch API** so `batchService` in the existing Node app requires only a small `llmAdapter` swap.

---

## Decisions / Configuration (Final)

### Models & Routing

| Stage | Model | Purpose |
|-------|-------|---------|
| `sales_intel` (Stage 1) | Llama-3 70B | High-quality reasoning for Sales Intelligence Reports |
| `subject` | Mistral-7B-Instruct | Fast subject line generation |
| `email` | Mistral-7B-Instruct | Fast email candidate generation |
| `polish` | Llama-3 70B | Final quality polish of selected emails |

**Routing Logic:** The Batch API routes based on `stage` field, or allows override via `metadata.model_hint`.

### RunPod Products & SKUs

| Component | RunPod Product | GPU SKU | Configuration |
|-----------|---------------|---------|---------------|
| **Mistral 7B** | Serverless (Flex workers) | **24GB RTX 4090 PRO** | Autoscale pool, min=1, FlashBoot enabled |
| **Llama-3 70B** | Serverless (Active workers) | **2x A100 80GB SXM** | Always-on to eliminate cold starts |
| **Batch API** | Serverless or small Pod | CPU-only or minimal GPU | Stateless FastAPI service |
| **Redis** | External or RunPod Pod | N/A | Use Upstash Redis or self-hosted |
| **Storage** | Network Volume | 300GB minimum | Shared `/models` mount for both model pools |

**CRITICAL GPU Note:** Llama-3 70B requires ~140GB VRAM at FP16. A single 80GB GPU will NOT work. You MUST use:
- **2x A100 80GB** (recommended for cost) — ~$5.44/s combined flex rate
- OR **2x H100 80GB** — ~$8.36/s combined flex rate
- OR **4x A40 48GB** — cheaper but more complexity

RunPod Serverless supports multi-GPU workers. Configure via endpoint settings after creation.

### Runtime

- **vLLM** for both Mistral and Llama (required for efficient batching)
- Use RunPod's **vLLM Quick Deploy template** as base
- Enable **FlashBoot** for sub-second cold starts on Mistral
- Enable **Network Volumes** to avoid model re-download on worker spin-up

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Node.js App    │────▶│  FastAPI Batch   │────▶│  Redis Queue    │
│  (batchService) │     │  API (RunPod)    │     │  batches:queue  │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌─────────────────────────────────┼─────────────────────────────────┐
                        │                                 │                                 │
                        ▼                                 ▼                                 ▼
              ┌──────────────────┐             ┌──────────────────┐             ┌──────────────────┐
              │  Worker Process  │             │  Worker Process  │             │  Worker Process  │
              │  (Background)    │             │  (Background)    │             │  (Background)    │
              └────────┬─────────┘             └────────┬─────────┘             └────────┬─────────┘
                       │                                │                                │
         ┌─────────────┴─────────────┐    ┌─────────────┴─────────────┐                  │
         ▼                           ▼    ▼                           ▼                  ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ Mistral 7B      │       │ Mistral 7B      │       │ Llama-3 70B     │       │ Llama-3 70B     │
│ (4090 PRO)      │       │ (4090 PRO)      │       │ (2x A100 80GB)  │       │ (2x A100 80GB)  │
│ Serverless Flex │       │ Serverless Flex │       │ Serverless Act  │       │ Serverless Act  │
└─────────────────┘       └─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## Deliverables Checklist

Create the following artifacts:

1. **`/batch-api/`** — FastAPI Batch API (Dockerized)
   - `main.py` — FastAPI app with batch endpoints
   - `worker.py` — Background worker that processes queue
   - `models.py` — Pydantic models for request/response
   - `config.py` — Environment configuration
   - `Dockerfile` — Container build
   - `requirements.txt` — Python dependencies

2. **`/mistral-container/`** — Mistral vLLM container
   - `Dockerfile` — Based on vLLM, configured for Mistral-7B-Instruct
   - `handler.py` — RunPod serverless handler (if using custom handler)
   - `README.md` — Deployment instructions

3. **`/llama-container/`** — Llama-3 70B vLLM container
   - `Dockerfile` — Based on vLLM, configured for 2-GPU tensor parallelism
   - `handler.py` — RunPod serverless handler
   - `README.md` — Deployment instructions

4. **`/node-adapter/`** — Node.js llmAdapter
   - `llmAdapter.ts` — TypeScript adapter with createBatch, getBatchStatus, getBatchResults
   - `types.ts` — TypeScript interfaces

5. **`/deploy/`** — Deployment scripts and configs
   - `runpod-mistral-endpoint.json` — Serverless endpoint config
   - `runpod-llama-endpoint.json` — Serverless endpoint config
   - `deploy.sh` — Deployment script with placeholders
   - `README.md` — Full deployment walkthrough

6. **`/tests/`** — Test suite
   - `smoke_test.py` — Basic functionality tests
   - `load_test.py` — Performance benchmarks
   - `test_config.yaml` — Test configuration

---

## 1 — API Contract (Exact Request/Response Shapes)

These shapes mirror Anthropic's Batch API so `processBatchResults` requires zero changes.

### `POST /v1/messages/batches`

**Request:**
```json
{
  "stage": "sales_intel",
  "requests": [
    {
      "custom_id": "lead_abc123_sales_intel",
      "params": {
        "system": "You are a sales intelligence analyst...",
        "messages": [
          {"role": "user", "content": "Analyze this lead: ..."}
        ],
        "max_tokens": 2048,
        "temperature": 0.2
      },
      "metadata": {
        "model_hint": "llama-70b",
        "leadId": "abc123",
        "accountId": "acct_xyz"
      }
    }
  ]
}
```

**Response:**
```json
{
  "id": "batch_a1b2c3d4e5f6"
}
```

### `GET /v1/messages/batches/{batchId}`

**Response:**
```json
{
  "id": "batch_a1b2c3d4e5f6",
  "processing_status": "processing",
  "counts": {
    "total": 100,
    "succeeded": 45,
    "errored": 0,
    "pending": 55
  },
  "created_at": "2025-01-07T10:00:00Z",
  "updated_at": "2025-01-07T10:05:00Z"
}
```

**Valid `processing_status` values:** `collected` | `submitted` | `processing` | `ended`

### `GET /v1/messages/batches/{batchId}/results`

**Response:**
```json
{
  "results": [
    {
      "custom_id": "lead_abc123_sales_intel",
      "status": "succeeded",
      "message": {
        "content": [
          {"type": "text", "text": "## Sales Intelligence Report\n\n..."}
        ]
      },
      "usage": {
        "input_tokens": 512,
        "output_tokens": 1024
      },
      "error": null
    },
    {
      "custom_id": "lead_def456_sales_intel",
      "status": "errored",
      "message": null,
      "usage": null,
      "error": {
        "type": "model_error",
        "message": "Output validation failed"
      }
    }
  ]
}
```

**CRITICAL:** Preserve `custom_id` format exactly. The existing `processBatchResults` function parses this to update lead records.

---

## 2 — FastAPI Batch API Specification

### File: `batch-api/main.py`

```python
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Literal
import uuid
import json
import os
import redis
from datetime import datetime

app = FastAPI(title="SocialBloom Batch API", version="1.0.0")

# Config from environment
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.environ.get("DATABASE_URL")  # Supabase connection
MISTRAL_BASE_URL = os.environ.get("MISTRAL_BASE_URL")
LLAMA_BASE_URL = os.environ.get("LLAMA_BASE_URL")

r = redis.from_url(REDIS_URL, decode_responses=True)

# --- Pydantic Models ---

class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str

class RequestParams(BaseModel):
    system: str
    messages: List[Message]
    max_tokens: int = 2048
    temperature: float = 0.2

class RequestMetadata(BaseModel):
    model_hint: Optional[Literal["mistral", "llama-70b"]] = None
    leadId: Optional[str] = None
    accountId: Optional[str] = None

class BatchRequest(BaseModel):
    custom_id: str
    params: RequestParams
    metadata: Optional[RequestMetadata] = None

class CreateBatchPayload(BaseModel):
    stage: Literal["sales_intel", "subject", "email", "polish"]
    requests: List[BatchRequest]

class BatchStatusResponse(BaseModel):
    id: str
    processing_status: Literal["collected", "submitted", "processing", "ended"]
    counts: dict
    created_at: str
    updated_at: str

# --- Routing Logic ---

def get_model_for_request(stage: str, metadata: Optional[RequestMetadata]) -> str:
    """Determine which model to use based on stage and optional override."""
    if metadata and metadata.model_hint:
        return metadata.model_hint
    
    # Default routing by stage
    routing = {
        "sales_intel": "llama-70b",
        "subject": "mistral",
        "email": "mistral",
        "polish": "llama-70b"
    }
    return routing.get(stage, "mistral")

# --- Endpoints ---

@app.post("/v1/messages/batches")
async def create_batch(payload: CreateBatchPayload, background_tasks: BackgroundTasks):
    batch_id = f"batch_{uuid.uuid4().hex[:12]}"
    now = datetime.utcnow().isoformat() + "Z"
    
    # Prepare batch metadata
    batch_meta = {
        "id": batch_id,
        "stage": payload.stage,
        "processing_status": "collected",
        "counts": {
            "total": len(payload.requests),
            "succeeded": 0,
            "errored": 0,
            "pending": len(payload.requests)
        },
        "created_at": now,
        "updated_at": now
    }
    
    # Prepare individual requests with routing
    requests_with_routing = []
    for req in payload.requests:
        model = get_model_for_request(payload.stage, req.metadata)
        requests_with_routing.append({
            "custom_id": req.custom_id,
            "params": req.params.dict(),
            "metadata": req.metadata.dict() if req.metadata else {},
            "model": model,
            "status": "pending"
        })
    
    # Store in Redis
    r.set(f"batch:{batch_id}:meta", json.dumps(batch_meta))
    r.set(f"batch:{batch_id}:requests", json.dumps(requests_with_routing))
    r.lpush("batches:queue", batch_id)
    
    return {"id": batch_id}

@app.get("/v1/messages/batches/{batch_id}")
async def get_batch_status(batch_id: str):
    meta_raw = r.get(f"batch:{batch_id}:meta")
    if not meta_raw:
        raise HTTPException(status_code=404, detail="Batch not found")
    
    return json.loads(meta_raw)

@app.get("/v1/messages/batches/{batch_id}/results")
async def get_batch_results(batch_id: str):
    results_raw = r.get(f"batch:{batch_id}:results")
    if not results_raw:
        # Check if batch exists but isn't done
        meta_raw = r.get(f"batch:{batch_id}:meta")
        if meta_raw:
            meta = json.loads(meta_raw)
            if meta["processing_status"] != "ended":
                raise HTTPException(status_code=400, detail="Batch not yet complete")
        raise HTTPException(status_code=404, detail="Results not found")
    
    return {"results": json.loads(results_raw)}

@app.get("/healthz")
async def health_check():
    """Aggregated health status."""
    try:
        r.ping()
        redis_ok = True
    except:
        redis_ok = False
    
    return {
        "status": "healthy" if redis_ok else "degraded",
        "redis": redis_ok,
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }

@app.get("/ready")
async def readiness_check():
    """Returns 200 only when fully ready to accept traffic."""
    try:
        r.ping()
        return {"ready": True}
    except:
        raise HTTPException(status_code=503, detail="Not ready")
```

### File: `batch-api/worker.py`

```python
import os
import json
import time
import redis
import httpx
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
MISTRAL_BASE_URL = os.environ.get("MISTRAL_BASE_URL")
LLAMA_BASE_URL = os.environ.get("LLAMA_BASE_URL")
WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "8"))
MAX_RETRIES = 3

r = redis.from_url(REDIS_URL, decode_responses=True)

def get_model_endpoint(model: str) -> str:
    if model == "llama-70b":
        return f"{LLAMA_BASE_URL}/v1/chat/completions"
    return f"{MISTRAL_BASE_URL}/v1/chat/completions"

def call_model(request: dict) -> dict:
    """Call the appropriate model endpoint and return result."""
    endpoint = get_model_endpoint(request["model"])
    
    payload = {
        "model": request["model"],
        "messages": [
            {"role": "system", "content": request["params"]["system"]},
            *request["params"]["messages"]
        ],
        "max_tokens": request["params"]["max_tokens"],
        "temperature": request["params"]["temperature"]
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            with httpx.Client(timeout=120.0) as client:
                response = client.post(endpoint, json=payload)
                response.raise_for_status()
                data = response.json()
                
                return {
                    "custom_id": request["custom_id"],
                    "status": "succeeded",
                    "message": {
                        "content": [
                            {"type": "text", "text": data["choices"][0]["message"]["content"]}
                        ]
                    },
                    "usage": {
                        "input_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                        "output_tokens": data.get("usage", {}).get("completion_tokens", 0)
                    },
                    "error": None
                }
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                return {
                    "custom_id": request["custom_id"],
                    "status": "errored",
                    "message": None,
                    "usage": None,
                    "error": {
                        "type": "model_error",
                        "message": str(e)
                    }
                }
            time.sleep(2 ** attempt)  # Exponential backoff

def process_batch(batch_id: str):
    """Process a single batch."""
    print(f"Processing batch: {batch_id}")
    
    # Update status to processing
    meta_raw = r.get(f"batch:{batch_id}:meta")
    meta = json.loads(meta_raw)
    meta["processing_status"] = "processing"
    meta["updated_at"] = datetime.utcnow().isoformat() + "Z"
    r.set(f"batch:{batch_id}:meta", json.dumps(meta))
    
    # Get requests
    requests_raw = r.get(f"batch:{batch_id}:requests")
    requests = json.loads(requests_raw)
    
    results = []
    succeeded = 0
    errored = 0
    
    # Process with bounded concurrency
    with ThreadPoolExecutor(max_workers=WORKER_CONCURRENCY) as executor:
        future_to_req = {executor.submit(call_model, req): req for req in requests}
        
        for future in as_completed(future_to_req):
            result = future.result()
            results.append(result)
            
            if result["status"] == "succeeded":
                succeeded += 1
            else:
                errored += 1
            
            # Update counts periodically
            meta["counts"]["succeeded"] = succeeded
            meta["counts"]["errored"] = errored
            meta["counts"]["pending"] = len(requests) - succeeded - errored
            meta["updated_at"] = datetime.utcnow().isoformat() + "Z"
            r.set(f"batch:{batch_id}:meta", json.dumps(meta))
    
    # Save results and mark complete
    r.set(f"batch:{batch_id}:results", json.dumps(results))
    meta["processing_status"] = "ended"
    meta["updated_at"] = datetime.utcnow().isoformat() + "Z"
    r.set(f"batch:{batch_id}:meta", json.dumps(meta))
    
    print(f"Batch {batch_id} complete: {succeeded} succeeded, {errored} errored")

def main():
    """Main worker loop."""
    print("Worker started, waiting for batches...")
    
    while True:
        # Blocking pop from queue
        result = r.brpop("batches:queue", timeout=5)
        
        if result:
            _, batch_id = result
            try:
                process_batch(batch_id)
            except Exception as e:
                print(f"Error processing batch {batch_id}: {e}")
                # Mark batch as errored
                meta_raw = r.get(f"batch:{batch_id}:meta")
                if meta_raw:
                    meta = json.loads(meta_raw)
                    meta["processing_status"] = "ended"
                    meta["counts"]["errored"] = meta["counts"]["total"]
                    meta["counts"]["pending"] = 0
                    r.set(f"batch:{batch_id}:meta", json.dumps(meta))

if __name__ == "__main__":
    main()
```

### File: `batch-api/Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Default to running the API (override CMD for worker)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### File: `batch-api/requirements.txt`

```
fastapi==0.109.0
uvicorn==0.27.0
redis==5.0.1
httpx==0.26.0
pydantic==2.5.3
```

### File: `batch-api/docker-compose.yml` (for local testing)

```yaml
version: '3.8'

services:
  batch-api:
    build: .
    ports:
      - "8000:8000"
    environment:
      - REDIS_URL=redis://redis:6379
      - MISTRAL_BASE_URL=http://mistral:8080
      - LLAMA_BASE_URL=http://llama:8080
    depends_on:
      - redis

  worker:
    build: .
    command: python worker.py
    environment:
      - REDIS_URL=redis://redis:6379
      - MISTRAL_BASE_URL=http://mistral:8080
      - LLAMA_BASE_URL=http://llama:8080
      - WORKER_CONCURRENCY=8
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

---

## 3 — Model Container Specifications

### Mistral Container

**Use RunPod's vLLM Quick Deploy template.** Do not build a custom container unless necessary.

**Serverless Endpoint Configuration (`runpod-mistral-endpoint.json`):**

```json
{
  "name": "socialbloom-mistral-7b",
  "template": "vllm",
  "gpuType": "NVIDIA RTX 4090",
  "gpuCount": 1,
  "volumeSize": 50,
  "networkVolumeId": "<YOUR_NETWORK_VOLUME_ID>",
  "env": {
    "MODEL_NAME": "mistralai/Mistral-7B-Instruct-v0.3",
    "HF_TOKEN": "<YOUR_HF_TOKEN>",
    "VLLM_ARGS": "--max-model-len 8192 --gpu-memory-utilization 0.9"
  },
  "scalerType": "QUEUE_DELAY",
  "scalerValue": 1,
  "minWorkers": 1,
  "maxWorkers": 10,
  "flashboot": true,
  "idleTimeout": 60
}
```

### Llama-3 70B Container

**CRITICAL: Must configure for 2-GPU tensor parallelism.**

**Serverless Endpoint Configuration (`runpod-llama-endpoint.json`):**

```json
{
  "name": "socialbloom-llama70b",
  "template": "vllm",
  "gpuType": "NVIDIA A100 80GB SXM",
  "gpuCount": 2,
  "volumeSize": 200,
  "networkVolumeId": "<YOUR_NETWORK_VOLUME_ID>",
  "env": {
    "MODEL_NAME": "meta-llama/Meta-Llama-3-70B-Instruct",
    "HF_TOKEN": "<YOUR_HF_TOKEN>",
    "VLLM_ARGS": "--tensor-parallel-size 2 --max-model-len 8192 --gpu-memory-utilization 0.9"
  },
  "scalerType": "QUEUE_DELAY",
  "scalerValue": 1,
  "minWorkers": 1,
  "maxWorkers": 3,
  "flashboot": true,
  "idleTimeout": 0,
  "workerType": "active"
}
```

**Key differences from Mistral config:**
- `gpuCount: 2` — Required for 70B model
- `--tensor-parallel-size 2` — Splits model across GPUs
- `workerType: "active"` — Always-on workers (30% discount, no cold starts)
- `idleTimeout: 0` — Never scale down (keeps model warm)
- Larger `volumeSize` for 70B model weights

---

## 4 — Node.js llmAdapter

### File: `server/services/llmAdapter.ts`

```typescript
/**
 * LLM Adapter for RunPod Batch API
 * 
 * Drop-in replacement for Anthropic batch calls.
 * Requires LOCAL_BATCH_URL environment variable.
 */

import fetch from 'node-fetch';

const BASE_URL = process.env.LOCAL_BATCH_URL;

if (!BASE_URL) {
  console.warn('WARNING: LOCAL_BATCH_URL not set. LLM adapter will fail.');
}

// Types matching Anthropic's batch API response shape
export interface BatchRequest {
  custom_id: string;
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    max_tokens?: number;
    temperature?: number;
  };
  metadata?: {
    model_hint?: 'mistral' | 'llama-70b';
    leadId?: string;
    accountId?: string;
  };
}

export interface BatchStatus {
  id: string;
  processing_status: 'collected' | 'submitted' | 'processing' | 'ended';
  counts: {
    total: number;
    succeeded: number;
    errored: number;
    pending: number;
  };
  created_at: string;
  updated_at: string;
}

export interface BatchResult {
  custom_id: string;
  status: 'succeeded' | 'errored';
  message: {
    content: Array<{ type: 'text'; text: string }>;
  } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  error: {
    type: string;
    message: string;
  } | null;
}

export interface BatchResultsResponse {
  results: BatchResult[];
}

/**
 * Create a new batch of LLM requests.
 * 
 * @param stage - The processing stage (determines model routing)
 * @param requests - Array of batch requests
 * @returns Promise with batch ID
 */
export async function createBatch(
  stage: 'sales_intel' | 'subject' | 'email' | 'polish',
  requests: BatchRequest[]
): Promise<{ id: string }> {
  const response = await fetch(`${BASE_URL}/v1/messages/batches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ stage, requests }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create batch: ${response.status} ${error}`);
  }

  return response.json() as Promise<{ id: string }>;
}

/**
 * Get the current status of a batch.
 * 
 * @param batchId - The batch ID returned from createBatch
 * @returns Promise with batch status
 */
export async function getBatchStatus(batchId: string): Promise<BatchStatus> {
  const response = await fetch(`${BASE_URL}/v1/messages/batches/${batchId}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get batch status: ${response.status} ${error}`);
  }

  return response.json() as Promise<BatchStatus>;
}

/**
 * Get the results of a completed batch.
 * 
 * @param batchId - The batch ID returned from createBatch
 * @returns Promise with batch results
 */
export async function getBatchResults(batchId: string): Promise<BatchResultsResponse> {
  const response = await fetch(`${BASE_URL}/v1/messages/batches/${batchId}/results`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get batch results: ${response.status} ${error}`);
  }

  return response.json() as Promise<BatchResultsResponse>;
}

/**
 * Poll for batch completion with exponential backoff.
 * 
 * @param batchId - The batch ID to poll
 * @param maxWaitMs - Maximum time to wait (default 30 minutes)
 * @returns Promise that resolves when batch is complete
 */
export async function waitForBatch(
  batchId: string,
  maxWaitMs: number = 30 * 60 * 1000
): Promise<BatchStatus> {
  const startTime = Date.now();
  let delay = 1000; // Start with 1 second
  const maxDelay = 30000; // Cap at 30 seconds

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getBatchStatus(batchId);
    
    if (status.processing_status === 'ended') {
      return status;
    }

    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, maxDelay);
  }

  throw new Error(`Batch ${batchId} did not complete within ${maxWaitMs}ms`);
}
```

### Integration in `batchService.ts`

Replace the Anthropic batch calls with adapter calls. Minimal changes required:

```typescript
// BEFORE (Anthropic)
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();

async function submitBatch(stage: string, requests: any[]) {
  const batch = await anthropic.messages.batches.create({
    requests: requests.map(r => ({
      custom_id: r.custom_id,
      params: { model: 'claude-3-sonnet', ...r.params }
    }))
  });
  return batch.id;
}

// AFTER (RunPod adapter)
import { createBatch, getBatchStatus, getBatchResults, waitForBatch } from './llmAdapter';

async function submitBatch(stage: string, requests: any[]) {
  const batch = await createBatch(stage, requests);
  return batch.id;
}

// processBatchResults stays the same - response shape is identical
```

---

## 5 — Deployment Instructions

### Prerequisites

1. **RunPod Account** with API key
2. **HuggingFace Account** with access to Llama-3-70B (requires Meta approval)
3. **Redis Instance** (Upstash recommended, or self-hosted)
4. **Docker Hub** or private registry access

### Step 1: Create Network Volume

```bash
# Via RunPod console or API
# Create a 300GB network volume in your preferred region
# Note the volume ID for endpoint configs
```

### Step 2: Deploy Mistral Serverless Endpoint

1. Go to RunPod Console → Serverless → New Endpoint
2. Select "vLLM" template
3. Configure:
   - GPU: RTX 4090 (24GB)
   - GPU Count: 1
   - Network Volume: Attach your volume
   - Environment Variables:
     ```
     MODEL_NAME=mistralai/Mistral-7B-Instruct-v0.3
     HF_TOKEN=<your_token>
     VLLM_ARGS=--max-model-len 8192 --gpu-memory-utilization 0.9
     ```
4. Scaling:
   - Min Workers: 1
   - Max Workers: 10
   - FlashBoot: Enabled
   - Idle Timeout: 60 seconds
5. Save endpoint and note the URL

### Step 3: Deploy Llama-3 70B Serverless Endpoint

1. Go to RunPod Console → Serverless → New Endpoint
2. Select "vLLM" template
3. Configure:
   - GPU: A100 80GB SXM
   - **GPU Count: 2** (CRITICAL)
   - Network Volume: Attach same volume
   - Environment Variables:
     ```
     MODEL_NAME=meta-llama/Meta-Llama-3-70B-Instruct
     HF_TOKEN=<your_token>
     VLLM_ARGS=--tensor-parallel-size 2 --max-model-len 8192 --gpu-memory-utilization 0.9
     ```
4. Scaling:
   - Worker Type: **Active** (always-on)
   - Min Workers: 1
   - Max Workers: 3
   - FlashBoot: Enabled
   - Idle Timeout: 0 (never scale down)
5. Save endpoint and note the URL

### Step 4: Deploy Batch API

Option A: RunPod Serverless (recommended)
```bash
# Build and push container
docker build -t your-registry/batch-api:latest ./batch-api
docker push your-registry/batch-api:latest

# Deploy via RunPod console as CPU-only serverless endpoint
```

Option B: RunPod Pod (dedicated)
```bash
# Deploy as always-on pod with CPU only
# More predictable but higher base cost
```

### Step 5: Deploy Worker

```bash
# Workers run alongside the API
# Scale worker replicas based on expected batch volume
# Each worker handles WORKER_CONCURRENCY requests in parallel
```

### Step 6: Configure Node App

Add to `.env`:
```
LOCAL_BATCH_URL=https://api.runpod.ai/v2/<your-batch-api-endpoint>
```

### Step 7: Smoke Test

```bash
# Test the full pipeline
curl -X POST https://your-batch-api/v1/messages/batches \
  -H "Content-Type: application/json" \
  -d '{
    "stage": "subject",
    "requests": [{
      "custom_id": "test_001",
      "params": {
        "system": "Generate a subject line.",
        "messages": [{"role": "user", "content": "Write a subject for an email about AI."}],
        "max_tokens": 100
      }
    }]
  }'

# Poll for completion
curl https://your-batch-api/v1/messages/batches/<batch_id>

# Get results
curl https://your-batch-api/v1/messages/batches/<batch_id>/results
```

---

## 6 — Environment Variables Reference

### Batch API

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection string |
| `DATABASE_URL` | No | Supabase/Postgres for persistent batch storage |
| `MISTRAL_BASE_URL` | Yes | RunPod Mistral endpoint URL |
| `LLAMA_BASE_URL` | Yes | RunPod Llama endpoint URL |
| `PORT` | No | API port (default: 8000) |

### Worker

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection string |
| `MISTRAL_BASE_URL` | Yes | RunPod Mistral endpoint URL |
| `LLAMA_BASE_URL` | Yes | RunPod Llama endpoint URL |
| `WORKER_CONCURRENCY` | No | Parallel requests per worker (default: 8) |

### Node App

| Variable | Required | Description |
|----------|----------|-------------|
| `LOCAL_BATCH_URL` | Yes | Batch API base URL |

---

## 7 — Testing & Acceptance Criteria

### Unit Tests

```python
# tests/test_batch_api.py
import pytest
from fastapi.testclient import TestClient
from batch_api.main import app

client = TestClient(app)

def test_create_batch():
    response = client.post("/v1/messages/batches", json={
        "stage": "subject",
        "requests": [{
            "custom_id": "test_001",
            "params": {
                "system": "Test system prompt",
                "messages": [{"role": "user", "content": "Test"}],
                "max_tokens": 100
            }
        }]
    })
    assert response.status_code == 200
    assert "id" in response.json()
    assert response.json()["id"].startswith("batch_")

def test_get_batch_status():
    # Create batch first
    create_resp = client.post("/v1/messages/batches", json={...})
    batch_id = create_resp.json()["id"]
    
    # Check status
    status_resp = client.get(f"/v1/messages/batches/{batch_id}")
    assert status_resp.status_code == 200
    assert status_resp.json()["processing_status"] in ["collected", "submitted", "processing", "ended"]

def test_health_check():
    response = client.get("/healthz")
    assert response.status_code == 200
```

### Performance Targets

| Metric | Mistral 7B | Llama-3 70B |
|--------|------------|-------------|
| Median latency (512 tokens) | ≤ 3s | ≤ 15s |
| P95 latency (512 tokens) | ≤ 8s | ≤ 30s |
| Throughput (concurrent) | 20 req/s | 5 req/s |

### End-to-End Test

Process a 100-lead batch through all stages:
1. `sales_intel` (Llama) → should complete in ~10 minutes
2. `subject` (Mistral) → should complete in ~2 minutes
3. `email` (Mistral) → should complete in ~3 minutes
4. Verify all `custom_id` values match and `processBatchResults` parses correctly

### Acceptance Checklist

- [ ] Batch API returns correct response shapes matching Anthropic
- [ ] `custom_id` preserved exactly through entire pipeline
- [ ] Stage-based routing works (sales_intel → Llama, subject → Mistral)
- [ ] `model_hint` override works
- [ ] Worker retries failed requests up to 3 times
- [ ] Worker handles model endpoint failures gracefully
- [ ] Health endpoints return correct status
- [ ] Node `llmAdapter` integrates with zero changes to `processBatchResults`
- [ ] FlashBoot enabled on Mistral endpoint (cold start < 1s)
- [ ] Llama endpoint stays warm (no cold starts)

---

## 8 — Rollout Plan

### Phase 1: Staging (Days 1-3)
1. Deploy all components to staging environment
2. Run smoke tests against staging
3. Process 100-lead test batch
4. Verify output quality matches Anthropic baseline

### Phase 2: Canary (Days 4-5)
1. Route 1% of production leads to new pipeline
2. Compare:
   - Output quality (manual review of 20 samples)
   - Latency (should be significantly faster)
   - Error rates
3. Fix any issues discovered

### Phase 3: Gradual Rollout (Days 6-10)
1. Increase to 10% traffic
2. Monitor for 24 hours
3. Increase to 50% traffic
4. Monitor for 24 hours
5. Increase to 100% traffic

### Rollback Plan

If issues are detected at any stage:

```bash
# Immediate rollback - point back to Anthropic
# In .env:
# LOCAL_BATCH_URL=<anthropic_batch_url>  # or unset to use Anthropic SDK directly

# Or toggle via feature flag in batchService:
const USE_LOCAL_LLM = process.env.USE_LOCAL_LLM === 'true';
```

No database migrations required. Batches are stateless and can be reprocessed.

---

## 9 — Cost Estimate

### Monthly Cost (Moderate Usage: ~50 batches/day, 100 leads/batch)

| Component | Rate | Est. Monthly |
|-----------|------|--------------|
| Mistral 4090 (flex) | $1.10/s | ~$300 |
| Llama 2xA100 (active) | $4.35/s × 2 = $8.70/s | ~$800 |
| Network Volume 300GB | $0.05/GB | $15 |
| Redis (Upstash) | Variable | ~$20 |
| **Total** | | **~$1,135/mo** |

### Comparison to Anthropic Batch API

Anthropic batch pricing: ~$3/1M input tokens, ~$15/1M output tokens

For 5,000 leads/day × 4 stages × ~2K tokens average:
- Anthropic: ~$2,000-3,000/mo
- RunPod self-hosted: ~$1,100/mo
- **Savings: 50-60%**

Plus: **Significantly faster turnaround** (minutes vs hours)

---

## 10 — Notes for Implementation

### Preserve Existing Behavior

1. **`custom_id` format**: Keep exactly as `lead_{leadId}_{stage}`. The `processBatchResults` function parses this.

2. **JSON schema validation**: If you currently validate Stage 1 (sales_intel) output with JSON schema, implement the same validation in the worker and mark as `errored` if invalid.

3. **Two-pass pattern**: The architecture supports generating many candidates with Mistral, then using Llama for polishing selected ones. Implement as separate batches if needed.

### Model Selection Notes

- **Mistral 7B Instruct v0.3** is recommended for its instruction-following quality
- **Llama-3 70B Instruct** requires HuggingFace access (apply via Meta)
- Consider **AWQ 4-bit quantization** for Llama if you want to reduce to single GPU (quality trade-off)

### Redis Considerations

- Use **Upstash** for managed Redis with pay-per-request pricing
- Or deploy Redis on RunPod Pod for lower latency
- Batch data expires after 24 hours (implement TTL on keys)

### Monitoring

Implement these metrics from day 1:
- Queue depth (`batches:queue` length)
- Batch latency (created_at → ended)
- Success/error rates per model
- Model endpoint health
- Worker throughput

---

## Quick Reference: File Locations

```
/
├── batch-api/
│   ├── main.py           # FastAPI application
│   ├── worker.py         # Background queue worker
│   ├── models.py         # Pydantic models
│   ├── config.py         # Environment config
│   ├── Dockerfile
│   ├── requirements.txt
│   └── docker-compose.yml
├── server/
│   └── services/
│       └── llmAdapter.ts # Node.js adapter
├── deploy/
│   ├── runpod-mistral-endpoint.json
│   ├── runpod-llama-endpoint.json
│   └── README.md
└── tests/
    ├── test_batch_api.py
    └── test_integration.py
```

---

**END OF SPECIFICATION**

When complete, the agent should deliver:
1. All source files listed above
2. Working Docker containers pushed to registry
3. RunPod endpoints deployed and accessible
4. Node adapter integrated (PR or branch)
5. Test suite passing
6. Documentation for ongoing operations
