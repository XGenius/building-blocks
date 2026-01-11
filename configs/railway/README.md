# Railway Configuration Templates

Configuration files for deploying to Railway.

## Files

- `railway.json.example` - JSON format (recommended for most apps)
- `railway.toml.example` - TOML format (for services needing custom build)

## Usage

Copy the appropriate file to your project root:

```bash
cp railway.json.example ../../railway.json
# or
cp railway.toml.example ../../railway.toml
```

## Key Settings

### Build

| Setting | Description |
|---------|-------------|
| `builder` | "NIXPACKS" (auto-detect), "DOCKERFILE", or "RAILPACK" |
| `buildCommand` | Custom build command (optional) |

### Deploy

| Setting | Description |
|---------|-------------|
| `startCommand` | Command to start your app |
| `restartPolicyType` | "ON_FAILURE", "ALWAYS", or "NEVER" |
| `restartPolicyMaxRetries` | Max restart attempts |
| `healthcheckPath` | HTTP path for health checks |

## Common Patterns

### Node.js with Migrations

```json
{
  "deploy": {
    "startCommand": "npm run build && npm run db:migrate && npm run start"
  }
}
```

### Docker Service

```toml
[build]
builder = "dockerfile"
```

### Multiple Replicas

Configure in Railway dashboard or via `railway.toml`:

```toml
[deploy]
numReplicas = 2
```
