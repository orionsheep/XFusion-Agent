# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

### Backend
- Create/update venv and install backend deps:
  - `python3 -m venv .venv && . .venv/bin/activate && python -m pip install --upgrade pip`
  - `python -m pip install 'litellm[proxy]' claude-agent-sdk fastapi "uvicorn[standard]" sqlmodel aiosqlite asyncssh psutil "python-jose[cryptography]" "passlib[bcrypt]" pydantic-settings httpx orjson python-multipart`
- Run backend API from repo root:
  - `PYTHONPATH=backend .venv/bin/uvicorn app.main:app --reload --port 8000`
- Alternative module metadata is in `backend/pyproject.toml`, but the README’s manual pip install flow is the documented setup.

### LiteLLM gateway
- Start the local LiteLLM-compatible gateway from repo root:
  - `./infra/scripts/run-litellm-gateway.sh`
- Requires either `MINIMAX_API_KEY` or `ZHIPU_API_KEY`/`ZAI_API_KEY` in the environment.
- The gateway listens on `127.0.0.1:4000` and is the backend’s default LLM endpoint.

### Frontend
- Install deps:
  - `cd frontend && npm install`
- Start dev server:
  - `cd frontend && npm run dev`
- Build production bundle:
  - `cd frontend && npm run build`
- Lint:
  - `cd frontend && npm run lint`
- Run Playwright smoke/e2e tests:
  - `cd frontend && npm run test:e2e`
- Run a single Playwright spec:
  - `cd frontend && npx playwright test tests/<spec>.spec.ts`
- Run one Playwright test by title:
  - `cd frontend && npx playwright test -g "<test name>"`

### Node agent
- Run the sample node-agent service from repo root:
  - `PYTHONPATH=agent .venv/bin/uvicorn app.main:app --reload --port 9001`

### Docker compose
- Start the full local stack:
  - `docker compose up --build`
- Services exposed locally:
  - frontend `:5173`
  - backend `:8000`
  - node-agent `:9001`

### Verification / acceptance
- Backend acceptance / PDF verification script:
  - `./.venv/bin/python scripts/verify_pdf_requirements.py`
- This script logs into the API, exercises task execution, approvals, multi-host execution, context carry-over, and the PDF validation endpoint.

## Architecture overview

### Product shape
XFusion-Agent is an AI operations control plane for Linux hosts. The repository is split into three runtime pieces:
- `backend/`: FastAPI control plane, auth, persistence, orchestration, approvals, audit, monitoring.
- `frontend/`: React + Vite web console for dashboard, hosts, tasks, approvals, audit, settings, and setup/login.
- `agent/`: lightweight remote execution/profile service used as an alternative to direct SSH.

### Backend architecture
- App entrypoint is `backend/app/main.py`.
  - Bootstraps the SQLite database on startup.
  - Starts a background metric collection loop that refreshes host metrics and persists monitoring samples.
  - Mounts a single API router under `/api`.
- `backend/app/api/routes.py` is the main HTTP surface.
  - Handles bootstrap/login/user management.
  - Exposes host profiling/metrics/service discovery endpoints.
  - Exposes task execution, approvals, audit, integrations, monitoring, and runtime model profile endpoints.
- Data model is centralized in `backend/app/models/entities.py` using SQLModel.
  - Core entities: `User`, `Host`, `HostCredential`, `AgentNode`, `Service`, `Task`, `TaskStep`, `Approval`, `AuditLog`, `HostMetricSample`.
  - SQLite is the default datastore (`backend/xfusion.db`).

### Control-plane execution model
The core behavior is a goal-driven task pipeline rather than fixed RPC handlers.
- `backend/app/services/orchestrator.py` turns a natural-language prompt into an `IntentPlan` with:
  - `task_type`
  - `action_type`
  - success criteria
  - execution parameters
- Planning prefers the Claude Agent SDK + LiteLLM gateway path. If unavailable, it falls back to regex/rule-based intent extraction.
- Tasks are grouped by `session_id`, and planning reads recent tasks from the same session so follow-up prompts like “continue” can reuse prior service context.
- Diagnostic flows are multi-step: observe state, analyze likely root cause, optionally recommend/execute a follow-up action, then summarize results back for the UI.

### LLM / gateway integration
- `backend/app/services/claude_runtime.py` wraps Claude Agent SDK calls behind a LiteLLM-compatible gateway.
- Runtime model selection is persisted in `backend/runtime_profile.json` and can be changed through the API/UI.
- Supported validated aliases in repo docs are `MiniMax-M2.7` and `GLM-4.5`.
- The runtime also exposes an MCP server to the planner with control-plane tools such as host listing, selected-host snapshots, and dashboard summary. That means planning is expected to use stored host context rather than inventing system state.

### Execution channels
The backend can act on hosts through two connectors in `backend/app/services/platform.py`:
- `SSHConnector`: direct async SSH execution using stored encrypted credentials.
- `AgentConnector`: HTTP calls to the lightweight remote agent when `host.agent_url` is configured.

`HostInspector` abstracts over those channels for the main read paths:
- host profiling
- metric collection
- service discovery

The sample remote agent in `agent/app/main.py` implements local machine profiling, metrics, and service discovery helpers that mirror the backend inspector’s expectations.

### Safety / approval model
- `PolicyEngine` in `backend/app/services/platform.py` classifies actions by risk.
- Read/diagnostic actions are allowed directly.
- State-changing actions such as user creation/deletion, service restart, and process kill require approval and move tasks into `waiting_approval`.
- Dangerous classes such as path deletion or security-config tampering are blocked outright.
- Approval records and audit events are first-class persisted entities, not transient UI state.

### Monitoring and inventory
- `backend/app/services/monitoring.py` stores normalized host metric samples and serves summary/timeseries data for charts.
- Background collection in `backend/app/main.py` continuously refreshes each managed host.
- Service inventory is persisted as `Service` rows and is populated by discovery logic in `HostInspector` / `ServiceSync`.
- Discovery recognizes multiple runtime styles, including systemd, Docker/Compose, Podman, PM2, supervisor, and Kubernetes-like workloads.

### Frontend architecture
- Frontend entry is `frontend/src/App.tsx`.
- The app is a React Router SPA wrapped with Ant Design theming and TanStack Query.
- `frontend/src/services/api.ts` is the single API client layer:
  - stores JWT token in localStorage
  - injects `Authorization` headers
  - redirects to `/login` on 401s
- Main product routes mirror backend domains: dashboard, hosts, host detail, tasks, approvals, audit, settings, plus `/login` and `/setup`.
- `frontend/src/components/AgentPanel.tsx` is the chat-first task console:
  - keeps an `session_id` in localStorage
  - stores selected host IDs locally
  - polls tasks and runtime model profile
  - submits natural-language task requests to `/tasks/execute`
  - supports browser speech recognition and speech synthesis

## Repo-specific notes
- The README is authoritative for local setup and documents first-login behavior: new instances must visit `/setup` to create the initial admin account.
- The frontend README is still the default Vite template and is not project-specific.
- No existing `CLAUDE.md`, `.cursorrules`, `.cursor/rules/`, or `.github/copilot-instructions.md` guidance was found during this scan.
- Backend tests are not organized as a standard pytest suite in the current repo snapshot; the concrete automated verification path present in-repo is `scripts/verify_pdf_requirements.py` plus Playwright tests under `frontend/tests/`.
