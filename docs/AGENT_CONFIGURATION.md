# Agent 配置说明

## 架构角色

- 中央控制平面：`Claude Agent SDK`
- 执行通道：`SSHConnector` / `Node Agent`
- 风险判定：`OPA + 本地策略回退`
- 任务模型：`GoalDrivenOrchestrator`

## 核心 Prompt

### 1. 任务规划 Prompt

位置：`backend/app/services/orchestrator.py`

目标：

- 将自然语言请求转为结构化计划
- 输出 `task_type`、`action_type`、`criteria`、`parameters`
- 对危险请求映射为风险动作而不是直接执行

### 2. 连续诊断 Prompt

位置：`backend/app/services/orchestrator.py`

目标：

- 基于 `systemctl status`、`journalctl`、`ss -ltnp` 输出根因分析
- 输出 `recommended_action_type`
- 当无必要修复动作时给出解释性结论

### 3. 结果总结 Prompt

位置：`backend/app/services/orchestrator.py`

目标：

- 把执行结果和验证结果转成自然语言总结
- 面向 Web 用户输出简洁结论

## 工具与能力定义

### 读操作

- `query_disk`
- `search_files`
- `check_port`
- `query_process`
- `discover_services`
- `diagnose_service`

### 写操作

- `create_linux_user`
- `delete_linux_user`
- `restart_service`
- `kill_process`

### 阻断动作

- `delete_path`
- `modify_security_config`
- `bulk_permission_change`

## 多轮上下文

- 所有任务通过 `session_id` 归档
- 规划阶段会读取同一 `session_id` 的最近任务
- 用于多轮任务的上下文延续与结果继承

## 审批闭环

- 写操作默认经过策略判断
- 命中审批策略后进入 `waiting_approval`
- 审批通过后恢复同一任务继续执行
