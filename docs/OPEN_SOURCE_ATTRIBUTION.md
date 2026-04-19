# 开源复用与融合说明

本项目不是简单给开源项目留入口，而是吸收并融合了其中关键实现元素。

## 已融合的开源元素

### 1. Prometheus / node_exporter

- 用途：主机监控指标的标准化抓取与时序查询
- 融合位置：
  - `backend/app/services/monitoring.py`
  - `infra/prometheus/prometheus.yml`
  - `infra/prometheus/file_sd/node_exporters.json`
- 融合方式：
  - 直接采用 `file_sd` 目标生成模式
  - 在控制平面中直接调用 Prometheus API
  - 使用 node_exporter 常见 PromQL 计算 CPU / Memory / Filesystem 指标

### 2. OPA

- 用途：策略即代码的风险阻断
- 融合位置：
  - `infra/opa/policies/xfusion.rego`
  - `backend/app/services/platform.py`
- 融合方式：
  - 通过 OPA HTTP API 输出结构化 `decision`
  - 控制平面直接消费 OPA 判定结果
  - 本地策略作为回退，保证无 OPA 时不失效

### 3. Beszel

- 用途：多机监控体验、资源视图和轻量化 Agent/Hub 思路
- 融合位置：
  - `docker-compose.yml`
  - `frontend/src/pages/DashboardPage.tsx`
  - `frontend/src/pages/HostDetailPage.tsx`
- 融合方式：
  - 保留 Beszel 作为现成监控底座
  - 同时把其“主机资源卡片、进程视图、轻量节点采集”思路融合到本项目页面和 Agent 指标结构中

### 4. Cockpit

- 用途：主机级管理和 systemd/logs/network/storage 的交互模式
- 融合位置：
  - `backend/app/services/platform.py`
  - `frontend/src/pages/HostDetailPage.tsx`
- 融合方式：
  - 吸收其主机详情页与服务管理视角
  - 在本项目里统一展示服务、指标、外部入口和执行动作

### 5. Portainer

- 用途：容器服务识别和运行状态视图
- 融合位置：
  - `backend/app/services/platform.py`
  - `frontend/src/pages/HostDetailPage.tsx`
- 融合方式：
  - 将容器发现纳入统一 `Service` 模型
  - 在控制平面中统一呈现 Docker/Podman 服务

## 协议与合规

- OPA：Apache-2.0
- Prometheus / node_exporter：Apache-2.0
- Beszel：MIT
- Cockpit：LGPL-2.1 / MIT 风格组件混合，以官方仓库为准
- Portainer CE：Zlib

项目交付时应保留各自原始仓库链接与协议说明，不复制其大段源码到仓库中，而是基于协议允许的方式融合能力、配置与设计模式。
