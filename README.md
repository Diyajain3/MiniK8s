# MiniK8s

A minimal, Kubernetes-inspired **container job orchestrator** built with Node.js. Submit a Docker image through a REST API and MiniK8s will queue it, schedule it, run it as a container, and track its lifecycle in PostgreSQL.

It's a learning project that recreates, in a few hundred lines, the core ideas behind an orchestrator: a **control-plane API**, a **persistent state store**, **reconciliation loops**, and a **container runtime interface**.

---

## Features

- **REST API** to submit container jobs (`POST /job`)
- **Persistent job state** in PostgreSQL via Drizzle ORM, with versioned migrations
- **Three independent control loops** scheduled with BullMQ (Valkey/Redis):
  - **Dispatcher**: promotes `SUBMITTED` jobs to `RUNNABLE`
  - **CRI worker**: pulls the image and starts the container through the Docker Engine API
  - **Watcher**: detects finished containers and records `SUCCEEDED` / `FAILED`
- **Concurrency-safe scheduling** using `SELECT ... FOR UPDATE SKIP LOCKED`, so multiple workers never pick up the same job
- **Local infra in one command** with Docker Compose (Postgres + Valkey)

---

## Architecture

```
                 POST /job
   Client  ───────────────────►  Express API (server.js)
                                        │ INSERT (state = SUBMITTED)
                                        ▼
                               ┌─────────────────┐
                               │   PostgreSQL    │  ◄── source of truth
                               │   jobs table    │
                               └─────────────────┘
                                  ▲      ▲      ▲
        every 2s                  │      │      │                every 10s
   ┌──────────────────┐   ┌───────────────────┐   ┌───────────────────┐
   │ Dispatcher       │   │ CRI worker        │   │ Watcher           │
   │ SUBMITTED →      │   │ RUNNABLE →        │   │ RUNNING →         │
   │ RUNNABLE         │   │ RUNNING           │   │ SUCCEEDED/FAILED  │
   └──────────────────┘   │ (every 5s)        │   └───────────────────┘
            ▲             └─────────┬─────────┘             ▲
            │                       │ dockerode             │
            └─── BullMQ repeatable  ▼ ─── schedulers ───────┘
                 jobs (Valkey)   Docker Engine
```

### Job lifecycle

```
SUBMITTED ──► RUNNABLE ──► RUNNING ──► SUCCEEDED
                              │
                              └──────► FAILED
```

`STOPPED` exists in the schema for future use (manual cancellation).

| State       | Meaning                                                      |
|-------------|--------------------------------------------------------------|
| `SUBMITTED` | Accepted by the API and stored                               |
| `RUNNABLE`  | Picked by the dispatcher, waiting for the runtime            |
| `RUNNING`   | Container created and started                                |
| `SUCCEEDED` | Container exited with code `0`                               |
| `FAILED`    | Image pull / container start failed, or non-zero exit code   |
| `STOPPED`   | Reserved                                                     |

---

## Tech stack

| Layer            | Technology                          |
|------------------|-------------------------------------|
| API              | Node.js, Express 5                  |
| Database         | PostgreSQL, Drizzle ORM / drizzle-kit |
| Queue / schedule | BullMQ on Valkey (Redis-compatible) |
| Container runtime| Docker Engine via `dockerode`       |
| Package manager  | pnpm                                |

---

## Project structure

```
MiniK8s/
├── server.js              # Express API (control plane entrypoint)
├── scheduler.js           # Registers the repeating scheduler jobs
├── queues/
│   ├── queues.js          # BullMQ queue definitions
│   └── workers.js         # Dispatcher, CRI and Watcher workers
├── db/
│   ├── index.js           # Drizzle + pg connection
│   └── schema.js          # `jobs` table and `job_status_enum`
├── drizzle/               # Generated SQL migrations
├── drizzle.config.js      # drizzle-kit configuration
├── docker-compose.yml     # Postgres + Valkey for local dev
└── test-db.js             # Quick DB connectivity check
```

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (Docker Desktop or Engine), used both for the infra and as the job runtime

### 1. Clone and install

```bash
git clone https://github.com/Diyajain3/MiniK8s.git
cd MiniK8s
pnpm install
```

### 2. Start Postgres and Valkey

```bash
docker compose up -d
```

This starts:

- PostgreSQL on `localhost:5433` (db `dev`, user `admin`, password `admin`)
- Valkey on `localhost:6379`

### 3. Configure environment

Create a `.env` file in the project root:

```env
DATABASE_URL=postgres://admin:admin@localhost:5433/dev
```

Check the connection:

```bash
node test-db.js
```

### 4. Run migrations

```bash
pnpm db:migrate
```

### 5. Start the API and the workers

In two terminals:

```bash
# Terminal 1: API on http://localhost:8000
pnpm dev

# Terminal 2: scheduler + workers
pnpm worker
```

> **Docker socket note:** `queues/workers.js` currently connects to the Docker Engine through the Windows named pipe (`\\.\pipe\docker_engine`). On Linux/macOS, change it to the Unix socket:
>
> ```js
> const docker = new Docker({ socketPath: "/var/run/docker.sock" });
> ```

---

## API

### `GET /`

Health check.

```json
{ "message": "Server is up and running" }
```

### `POST /job`

Submit a new job.

| Field   | Type   | Required | Description                                    |
|---------|--------|----------|------------------------------------------------|
| `image` | string | yes      | Docker image (`nginx`, `alpine:3.20`, ...). `:latest` is assumed if no tag is given |
| `cmd`   | string | no       | Command to run (stored with the job)           |

```bash
curl -X POST http://localhost:8000/job \
  -H "Content-Type: application/json" \
  -d '{"image": "alpine:3.20"}'
```

Response:

```json
{ "jobId": "3f6c1b2e-8d4a-4c1e-9b7a-1d2e3f4a5b6c" }
```

### Watching a job progress

The worker logs show each transition, and you can inspect state directly:

```bash
pnpm db:studio          # Drizzle Studio UI
docker ps               # the running container
```

---

## Database schema

`jobs` table:

| Column         | Type                | Notes                                   |
|----------------|---------------------|-----------------------------------------|
| `id`           | `uuid`              | Primary key, generated by the database  |
| `image`        | `text`              | Required                                |
| `cmd`          | `text`              | Optional                                |
| `container_id` | `text`              | Set while the container exists          |
| `state`        | `job_status_enum`   | Defaults to `SUBMITTED`                 |
| `created_at`   | `timestamp`         | Defaults to `now()`                     |
| `updated_at`   | `timestamp`         | Updated automatically                   |

---

## Scripts

| Script             | Description                                  |
|--------------------|----------------------------------------------|
| `pnpm dev`         | Run the API with nodemon                     |
| `pnpm worker`      | Run the scheduler and workers with nodemon   |
| `pnpm db:generate` | Generate a migration from `db/schema.js`     |
| `pnpm db:migrate`  | Apply migrations                             |
| `pnpm db:studio`   | Open Drizzle Studio                          |

---

## How it works

1. The API inserts a row into `jobs` with state `SUBMITTED`.
2. `scheduler.js` registers three BullMQ repeatable jobs (every 2s, 5s and 10s).
3. Each tick, the matching worker runs a short transaction that locks rows with `FOR UPDATE SKIP LOCKED`, so several worker processes can run in parallel without double-processing a job.
4. The CRI worker pulls the image if it's missing locally, creates the container, stores its `container_id`, and starts it.
5. The watcher inspects every `RUNNING` container and, once it has exited, records the final state and removes the container.

---

## Roadmap

- [ ] Run the user-supplied `cmd` inside the container (currently stored but not executed)
- [ ] Capacity-aware scheduling (the dispatcher has a `TODO` for compute availability)
- [ ] Job cancellation (`STOPPED`) and `GET /job/:id` / list endpoints
- [ ] Retries and backoff for failed jobs
- [ ] Log streaming from containers
- [ ] Resource limits (CPU / memory) per job
- [ ] Multi-node scheduling across several Docker hosts
- [ ] Cross-platform Docker socket configuration via env var
- [ ] Tests and CI

---

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first to discuss what you'd like to change.

## License

Released under the [MIT License](./LICENSE).
