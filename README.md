# XFusion-Agent

面向 Linux 服务器的 AI 运维控制平面。目标不是把一堆第三方控制台拼在一起，而是把监控、服务发现、策略门禁、任务编排和审计统一收敛成 `XFusion Agent` 自己的一套服务。

## 当前能力

- Claude Agent SDK 中央编排
- Goal-driven 任务状态机
- SSH / Node Agent 双通道执行
- 内建监控内核：资源快照、历史曲线、高占用进程
- 内建服务资产模型：systemd / Docker / Podman / PM2
- 内建策略核心：风险识别、审批挂起、危险动作阻断
- Web 控制台：Dashboard / Hosts / Tasks / Approvals / Audit / Settings
- 浏览器语音输入与结果播报

## 目录结构

```text
XFusion-Agent/
├── backend/          # 控制平面后端
├── frontend/         # Web 控制台
├── agent/            # Node Agent 示例实现
├── docs/             # PRD、验收矩阵、Agent 配置
├── infra/            # 策略与安装脚本
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

这会拉起：

- `backend`
- `frontend`
- `node-agent`

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
- `POST /api/hosts/{id}/metrics`
- `POST /api/hosts/{id}/discover`
- `POST /api/tasks/execute`
- `GET /api/tasks/{id}`
- `GET /api/approvals`
- `POST /api/approvals/{id}`
- `GET /api/audit`
- `GET /api/integrations`
- `POST /api/monitoring/collect`
- `GET /api/monitoring/hosts/{id}/summary`
- `GET /api/monitoring/hosts/{id}/timeseries`
- `GET /api/validation/pdf`

## 验证命令

后端自动验收：

```bash
cd /Users/mychanging/Desktop/XFusion-Agent
./.venv/bin/python scripts/verify_pdf_requirements.py
```

前端烟测：

```bash
cd /Users/mychanging/Desktop/XFusion-Agent/frontend
npx playwright test --config=playwright.config.ts
```

## 文档

- [docs/PRD.md](/Users/mychanging/Desktop/XFusion-Agent/docs/PRD.md)
- [docs/PDF_ACCEPTANCE_MATRIX.md](/Users/mychanging/Desktop/XFusion-Agent/docs/PDF_ACCEPTANCE_MATRIX.md)
- [docs/AGENT_CONFIGURATION.md](/Users/mychanging/Desktop/XFusion-Agent/docs/AGENT_CONFIGURATION.md)
- [docs/OPEN_SOURCE_ATTRIBUTION.md](/Users/mychanging/Desktop/XFusion-Agent/docs/OPEN_SOURCE_ATTRIBUTION.md)

## 说明

当前版本对外已经收敛为一体化服务；借鉴过的开源项目只体现在内部设计和模块实现思路里，不再作为产品主界面上的独立服务出现。
