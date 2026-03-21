Add Excalidraw icon libraries to the MCP server.

## How it works

Libraries are `.excalidrawlib` files served as static assets. On startup, `App.tsx` fetches each file listed in the `LIBRARY_FILES` array and loads them into the Excalidraw canvas via `excalidrawAPI.updateLibrary()`.

## Steps

1. **Download libraries** — run the [download-libraries](./download-libraries.md) command to populate `library_cache/`.

2. **Register and rebuild**:
   ```bash
   bash scripts/register_libraries.sh
   ```
   This copies all `.excalidrawlib` files from `library_cache/` into `mcp_excalidraw/frontend/public/libraries/`, registers any new ones in the `LIBRARY_FILES` array in `App.tsx`, and rebuilds the frontend. Safe to re-run.

## Currently installed libraries

### Cloud & infra

| Library file | Content |
|---|---|
| `cloud.excalidrawlib` | Generic cloud architecture icons |
| `aws-serverless-icons-v2.excalidrawlib` | AWS Lambda, API Gateway, DynamoDB, S3, etc. |
| `gcp-icons.excalidrawlib` | Google Cloud Platform services |
| `microsoft-365-icons.excalidrawlib` | Azure / Microsoft 365 services |
| `hashicorp.excalidrawlib` | Terraform, Vault, Consul, Nomad |
| `kubernetes-icons-set.excalidrawlib` | Kubernetes pods, services, deployments, ingress |

### Dev tools & languages

| Library file | Content |
|---|---|
| `technology-logos.excalidrawlib` | git, Docker, Kafka, Kubernetes, Terraform, Spring, Kotlin, Redis, Neo4J, Azure |
| `icons.excalidrawlib` | shell, programming language logos (rust, java, python, go, swift, dart, etc.), file types |
| `microsoft-fabric-architecture-icons.excalidrawlib` | GIT, GitHub, DevOps, DevOps Pipeline, Repo, Branch, VS Code, plus Fabric/data icons |
| `it-logos.excalidrawlib` | GitLab, Argo CD, Flux CD, Kafka, VSCode, Vercel, Nx, Angular, React, Svelte, Vue |
| `drwnio.excalidrawlib` | Nginx, RabbitMQ, load balancer, reverse proxy, server, database, Docker, Redis, Postgres |
| `go-icons.excalidrawlib` | Go gopher icons |

### Architecture & diagramming

| Library file | Content |
|---|---|
| `hexagonal-architecture.excalidrawlib` | Hexagonal / ports-and-adapters architecture shapes |
| `uml-library-activity-diagram.excalidrawlib` | UML activity diagram — swimlanes, decision boxes, fork/join |
| `data-flow.excalidrawlib` | Data flow diagram shapes (processes, stores, external entities) |

### Data & observability

| Library file | Content |
|---|---|
| `data-science.excalidrawlib` | Python ML ecosystem — Jupyter, pandas, TensorFlow |
| `db-eng.excalidrawlib` | Database infrastructure — Oracle, cloud/on-prem DB, backup & recovery |
| `redis-grafana.excalidrawlib` | Redis, Grafana, Prometheus, RedisGraph, RedisTimeSeries |

## Browse more libraries

Full catalog: <https://libraries.excalidraw.com>
Source repo: <https://github.com/excalidraw/excalidraw-libraries/tree/main/libraries>

## Key files

- **Library cache**: `library_cache/`
- **Static assets**: `mcp_excalidraw/frontend/public/libraries/`
- **Loading logic**: `mcp_excalidraw/frontend/src/App.tsx` — `LIBRARY_FILES` array + `loadLibraries()` function
- **Registration script**: `scripts/register_libraries.sh` + `patches/patch-app-libraries.mjs`
