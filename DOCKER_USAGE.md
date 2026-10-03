# Docker Usage Guide

This document provides comprehensive instructions for running the Autotask MCP Server using Docker.

## Summit fork release boundary

Summit builds this fork with Node **22.23.1**, pinned in `.nvmrc` and both
Docker stages by the reviewed base digest. `npm ci --ignore-scripts` and
production pruning run without dependency lifecycle scripts. Local validation
must use that runtime; Node 20/26 and a different Node 22 patch are not release
validation substitutes. Actions' own JavaScript runtime is separate.

Local builds require an existing approved package-read credential in
`NODE_AUTH_TOKEN`. Docker receives it only through the `github_token` BuildKit
secret mount. Do not pass credentials as build arguments or write them into
the build context. `.npmrc` is excluded from the image context. Compose uses
the same environment-backed build secret; it is not a runtime secret.

The `Fork Container Validation` workflow runs source checks, production audit,
Gitleaks, source CycloneDX SBOM, exact-runtime/non-root/HTTP image smoke tests,
and HIGH/CRITICAL fixable vulnerability plus secret scans before image SBOM
generation. Findings fail closed; retained secret-scan evidence contains only
metadata, never raw matches or code excerpts.

The draft `Fork Image Publish (GHCR only)` workflow reuses those gates. Its
only write path is a separately approved manual dispatch from `main` with:

- `source_sha`: the exact 40-character current merged `main` SHA;
- `image_tag`: a never-reused `sha-<full-source-sha>` tag, optionally suffixed
  `-r<run-number>` after a failed attempt; and
- `confirm_publish`: `PUBLISH_DDEPUY2015_AUTOTASK_MCP`.

It records the source, base digest, run, pushed digest, sanitized scans,
CycloneDX SBOM, maximum-mode BuildKit provenance, and verified keyless
signature/attestations. The provenance predicate uses its canonical URI to preserve BuildKit source
extensions. After cryptographic verification, decoded signed content must
still match the reviewed source, base and exact image digest before the
release record can claim provenance verification.
A pushed but failed/unverified image is not deployable;
do not overwrite its tag or treat publication as successful. The known
single-operator model is not independent reviewer enforcement.

**Proposed permission requiring separate activation approval:** `id-token:
write` is confined to the manually gated Sigstore signing job. `packages:
write` already exists for GHCR push. PR validation has only content/package/PR
read access. No Azure login, federation, role grant, deployment, credential
rotation, npm release, or MCP Registry publication is included.

The upstream image examples below are historical/general usage, not Summit
production release instructions. Azure rollout remains a separately approved
digest-only operation under `summit-mcp-ops`, including zero-traffic probes,
canary, metadata-only logs, and exact revision rollback. These build changes
do not activate auth PR #2 or close SMP-007/SMP-008. The existing restored
Autotask revision remains the rollback anchor until a separately approved
rollout succeeds.

## Quick Start

### Pull from GitHub Container Registry

```bash
docker pull ghcr.io/wyre-ai/autotask-mcp:latest
```

### Run with Environment Variables

```bash
docker run -d \
  --name autotask-mcp \
  -e AUTOTASK_USERNAME="your-api-user@company.com" \
  -e AUTOTASK_SECRET="your-secret-key" \
  -e AUTOTASK_INTEGRATION_CODE="your-integration-code" \
  -e LOG_LEVEL="info" \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

### Run with Environment File

Create a `.env` file:
```bash
AUTOTASK_USERNAME=your-api-user@company.com
AUTOTASK_SECRET=your-secret-key
AUTOTASK_INTEGRATION_CODE=your-integration-code
LOG_LEVEL=info
LOG_FORMAT=json
```

Run with env file:
```bash
docker run -d \
  --name autotask-mcp \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

## Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3.8'

services:
  autotask-mcp:
    image: ghcr.io/wyre-ai/autotask-mcp:latest
    container_name: autotask-mcp
    restart: unless-stopped
    environment:
      - AUTOTASK_USERNAME=${AUTOTASK_USERNAME}
      - AUTOTASK_SECRET=${AUTOTASK_SECRET}
      - AUTOTASK_INTEGRATION_CODE=${AUTOTASK_INTEGRATION_CODE}
      - LOG_LEVEL=info
      - LOG_FORMAT=json
      - NODE_ENV=production
    volumes:
      - autotask-logs:/app/logs
    healthcheck:
      test: ["CMD", "node", "-e", "console.log('Health check passed')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  autotask-logs:
    driver: local
```

Run with Docker Compose:
```bash
docker-compose up -d
```

## Building from Source

### Build Locally

```bash
# Clone the repository
git clone https://github.com/DDePuy2015/autotask-mcp.git
cd autotask-mcp

# Build the Docker image
docker build --secret id=github_token,env=NODE_AUTH_TOKEN -t autotask-mcp:local .
```

### Build with Custom Tags

```bash
# Build with version tag
docker build --secret id=github_token,env=NODE_AUTH_TOKEN -t autotask-mcp:v1.0.1 .

# Build with build arguments
docker build \
  --secret id=github_token,env=NODE_AUTH_TOKEN \
  --build-arg VERSION=1.0.1 \
  --build-arg COMMIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  -t autotask-mcp:custom .
```

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AUTOTASK_USERNAME` | Autotask API username | `user@company.com` |
| `AUTOTASK_SECRET` | Autotask API secret key | `your-secret-key` |
| `AUTOTASK_INTEGRATION_CODE` | Autotask integration code | `your-integration-code` |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | Log format: `json`, `simple` |
| `NODE_ENV` | `production` | Node.js environment |
| `AUTOTASK_TIMEOUT` | `30000` | API timeout in milliseconds |
| `AUTOTASK_RETRY_ATTEMPTS` | `3` | Number of retry attempts |

## Using with MCP Clients

### Claude Desktop Configuration (stdio via Docker)

The Docker image defaults to HTTP transport. For Claude Desktop (which uses stdio), you must override the transport and entrypoint:

```json
{
  "mcpServers": {
    "autotask": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "MCP_TRANSPORT=stdio",
        "--env-file", "/path/to/your/.env",
        "--entrypoint", "node",
        "ghcr.io/wyre-ai/autotask-mcp:latest",
        "dist/entry.js"
      ]
    }
  }
}
```

Or with inline credentials:

```json
{
  "mcpServers": {
    "autotask": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "AUTOTASK_USERNAME=your-user@company.com",
        "-e", "AUTOTASK_SECRET=your-secret",
        "-e", "AUTOTASK_INTEGRATION_CODE=your-code",
        "--entrypoint", "node",
        "ghcr.io/wyre-ai/autotask-mcp:latest",
        "dist/entry.js"
      ]
    }
  }
}
```

**Why `--entrypoint node` and `dist/entry.js`?** The default CMD runs `dist/index.js` in HTTP mode. For stdio, `entry.js` provides the stdout guard that prevents library output from corrupting the MCP JSON-RPC channel.

### Using Named Container (HTTP transport)

For a persistent HTTP-based MCP server:

```bash
# Start the container (HTTP transport, default)
docker run -d \
  --name autotask-mcp-server \
  -p 8080:8080 \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest

# Verify health
curl http://localhost:8080/health
```

## Container Management

### View Logs

```bash
# View all logs
docker logs autotask-mcp

# Follow logs in real-time
docker logs -f autotask-mcp

# View last 100 lines
docker logs --tail 100 autotask-mcp
```

### Health Checks

```bash
# Check container health
docker inspect autotask-mcp | grep -A 10 '"Health"'

# Manual health check
docker exec autotask-mcp node -e "console.log('Health check passed')"
```

### Resource Monitoring

```bash
# Monitor resource usage
docker stats autotask-mcp

# View container details
docker inspect autotask-mcp
```

## Troubleshooting

### Common Issues

#### Container Exits Immediately
```bash
# Check logs for errors
docker logs autotask-mcp

# Common causes:
# - Missing required environment variables
# - Invalid Autotask credentials
# - Network connectivity issues
```

#### Permission Errors
```bash
# Ensure proper file permissions
chmod 644 .env

# Check if user has Docker permissions
sudo usermod -aG docker $USER
```

#### Memory Issues
```bash
# Run with memory limits
docker run -d \
  --name autotask-mcp \
  --memory=512m \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

### Debug Mode

Run container in debug mode:

```bash
docker run -it --rm \
  --env-file .env \
  -e LOG_LEVEL=debug \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

### Interactive Debugging

```bash
# Start container with shell
docker run -it --rm \
  --env-file .env \
  --entrypoint /bin/sh \
  ghcr.io/wyre-ai/autotask-mcp:latest

# Inside container, run manually
node dist/index.js
```

## Security Considerations

### Environment Variables
- Never include credentials in Dockerfiles
- Use Docker secrets in production environments
- Rotate API credentials regularly

### Network Security
```bash
# Run on custom network
docker network create autotask-network

docker run -d \
  --name autotask-mcp \
  --network autotask-network \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

### Read-Only Container
```bash
docker run -d \
  --name autotask-mcp \
  --read-only \
  --tmpfs /tmp \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

## Production Deployment

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: autotask-mcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: autotask-mcp
  template:
    metadata:
      labels:
        app: autotask-mcp
    spec:
      containers:
      - name: autotask-mcp
        image: ghcr.io/wyre-ai/autotask-mcp:latest
        env:
        - name: AUTOTASK_USERNAME
          valueFrom:
            secretKeyRef:
              name: autotask-credentials
              key: username
        - name: AUTOTASK_SECRET
          valueFrom:
            secretKeyRef:
              name: autotask-credentials
              key: secret
        - name: AUTOTASK_INTEGRATION_CODE
          valueFrom:
            secretKeyRef:
              name: autotask-credentials
              key: integration-code
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

### Docker Swarm

```yaml
version: '3.8'

services:
  autotask-mcp:
    image: ghcr.io/wyre-ai/autotask-mcp:latest
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    environment:
      - LOG_LEVEL=info
      - NODE_ENV=production
    secrets:
      - autotask_username
      - autotask_secret
      - autotask_integration_code

secrets:
  autotask_username:
    external: true
  autotask_secret:
    external: true
  autotask_integration_code:
    external: true
```

## Updates and Maintenance

### Updating the Container

```bash
# Pull latest version
docker pull ghcr.io/wyre-ai/autotask-mcp:latest

# Stop and remove old container
docker stop autotask-mcp
docker rm autotask-mcp

# Start new container
docker run -d \
  --name autotask-mcp \
  --env-file .env \
  ghcr.io/wyre-ai/autotask-mcp:latest
```

### Backup and Restore

```bash
# Backup logs volume
docker run --rm -v autotask-logs:/data -v $(pwd):/backup \
  alpine tar czf /backup/autotask-logs-backup.tar.gz -C /data .

# Restore logs volume
docker run --rm -v autotask-logs:/data -v $(pwd):/backup \
  alpine tar xzf /backup/autotask-logs-backup.tar.gz -C /data
```

For more information, see the main [README.md](README.md) or visit the [GitHub repository](https://github.com/DDePuy2015/autotask-mcp).
