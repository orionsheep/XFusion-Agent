# XFusion Agent

XFusion Agent 是一个基于 `goal-driven` 理念构建的 AI 运维控制平面，面向多台 Linux 服务器的纳管、观测、执行、审批和审计。

项目核心目标不是“给服务器加一个聊天框”，而是把以下几件事统一起来：

- `Goal`：用户真正想完成的运维目标
- `Criteria`：判断任务是否成功的明确标准
- `Master Orchestration`：中央控制平面负责任务拆解、审批挂起、结果验收
- `Substrate`：通过 SSH 和 Node Agent 执行结构化动作

## 已实现内容

- FastAPI 后端控制平面
- Claude Agent SDK 接入位和 in-process MCP tools
- Goal-driven 任务编排器
- 主机接入、主机画像、服务发现
- Fleet / Host / Task / Approval / Audit Web 控制台
- Node Agent 示例服务
- OPA 策略文件

## 采用的开源组件

- `anthropics/claude-agent-sdk-python`
- `FastAPI`
- `SQLModel`
- `asyncssh`
- `Ant Design`
- `TanStack Query`
- `Recharts`
- `Open Policy Agent`
- `Vite`

## 目录结构

```text
XFusion-Agent/
├── backend/          # 控制平面后端
├── frontend/         # Web 控制台
├── agent/            # Node Agent 示例实现
├── docs/             # PRD 与文档
├── infra/opa/        # OPA 策略
└── docker-compose.yml
```

## 本地启动

### 1. 后端

```bash
cd /Users/mychanging/Desktop/XFusion-Agent
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install \
  claude-agent-sdk fastapi "uvicorn[standard]" sqlmodel aiosqlite \
  asyncssh psutil "python-jose[cryptography]" "passlib[bcrypt]" \
  pydantic-settings httpx orjson
cp backend/.env.example backend/.env
PYTHONPATH=backend uvicorn app.main:app --reload --port 8000
```

### 2. 前端

```bash
cd /Users/mychanging/Desktop/XFusion-Agent/frontend
npm install
npm run dev
```

### 3. Node Agent

```bash
cd /Users/mychanging/Desktop/XFusion-Agent
. .venv/bin/activate
PYTHONPATH=agent uvicorn app.main:app --reload --port 9001
```

### 4. Docker Compose

```bash
cd /Users/mychanging/Desktop/XFusion-Agent
docker compose up --build
```

## 默认账号

- 用户名：`admin`
- 密码：`admin123`

## 主要页面

- `/` Fleet Dashboard
- `/hosts` 主机与服务纳管
- `/tasks` Goal-driven 任务中心
- `/approvals` 审批中心
- `/audit` 审计日志
- `/settings` 系统设置

## API 概览

- `POST /api/auth/login`
- `GET /api/dashboard/overview`
- `GET /api/hosts`
- `POST /api/hosts`
- `POST /api/hosts/{id}/profile`
- `POST /api/hosts/{id}/discover`
- `POST /api/tasks/execute`
- `GET /api/approvals`
- `POST /api/approvals/{id}`
- `GET /api/audit`
- `POST /api/agents/register`
- `POST /api/agents/heartbeat`

## 当前实现说明

这个版本已经是完整项目骨架和主要业务流的可运行实现，不是“精简 Demo”。但仍有两个现实前提：

- `Claude Agent SDK` 的完整能力需要你在运行环境中配置 Anthropic 凭据
- 真正接管远程 Linux 主机时，需要你提供可用的 SSH 凭据或部署 Node Agent

## 验证结果

已完成的本地验证：

- 后端导入和数据库初始化通过
- 前端 `npm run build` 通过
- 登录、主机创建、任务执行、审批挂起和审计链路通过冒烟验证
