# AI Hackathon 2026 PDF 验收矩阵

面向文档：[AI_Hackathon_2026.pdf](/Users/mychanging/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_iwbpxmmak6pn12_9c9d/temp/drag/AI_Hackathon_2026.pdf)

## 基础能力

| PDF 要求 | 项目实现 | 验证方式 |
|---|---|---|
| 可运行或可交互的工具实现 | Web 控制台 + FastAPI 后端 + Node Agent | 访问 `http://127.0.0.1:5173`，登录后可见 Dashboard/Hosts/Tasks/Approvals/Audit |
| 磁盘使用情况监测 | `query_disk` 动作 + 主机页资源快照 + Prometheus 摘要 | `scripts/verify_pdf_requirements.py` |
| 文件或目录检索 | `search_files` 动作 | `scripts/verify_pdf_requirements.py` |
| 进程及端口状态查询 | `query_process` / `check_port` 动作 | `scripts/verify_pdf_requirements.py` |
| 普通用户创建与删除 | `create_linux_user` / `delete_linux_user` + 审批流 | `scripts/verify_pdf_requirements.py` |
| 意图解析能力 | Claude Agent SDK 规划层输出结构化任务计划 | 任务详情页 `AI 计划` 面板 |
| 任务执行能力 | SSH / Node Agent 双通道执行 | 真实 Linux 主机任务执行 |
| 自然语言反馈能力 | Claude 总结 + 任务步骤 + 审计日志 | 任务详情页、审计页 |

## 进阶能力

| PDF 要求 | 项目实现 | 验证方式 |
|---|---|---|
| 高风险/敏感操作识别 | OPA + 本地策略引擎识别 `delete_path` / `modify_security_config` / `bulk_permission_change` | 提交 `删除 /etc/passwd` |
| 风险预警及二次确认 | `Approval` 模型 + 审批中心 | 创建/删除用户任务 |
| 操作范围限制与截断 | 文件检索路径裁剪 + 危险路径阻断 | 任务结果中的 `blast_radius` |
| 拒绝不合理或非法高风险指令 | `delete_path` 等直接失败 | `scripts/verify_pdf_requirements.py` |
| 行为可解释 | `plan_explanation`、`policy.reason`、`result_json.summary` | 任务详情页和审计页 |

## 探索能力

| PDF 要求 | 项目实现 | 验证方式 |
|---|---|---|
| 语音输入/语音对话 | Tasks 页面浏览器语音识别 + 语音播报结果 | Tasks 页面按钮 `语音输入` / `语音播报结论` |
| 多轮对话上下文 | `session_id` + 最近任务上下文注入 Claude 规划层 | 同一 session 多次下发任务 |
| 去命令行化体验 | Dashboard / Host Detail / Tasks / Approvals / Audit | Web UI 直接操作 |
| 多步连续任务编排 | `diagnose_service` 的 observe/analyze/act/verify 流程 | `scripts/verify_pdf_requirements.py` |

## 自动验证

运行：

```bash
cd /Users/mychanging/Desktop/XFusion-Agent
./.venv/bin/python scripts/verify_pdf_requirements.py
```

该脚本会对真实已纳管主机执行：

- 磁盘查询
- 文件检索
- 端口查询
- 进程查询
- 高风险阻断
- 用户创建/删除审批闭环
- 连续诊断任务
