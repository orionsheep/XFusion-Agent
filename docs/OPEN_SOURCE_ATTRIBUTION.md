# 开源复用与融合说明

本项目的原则是：借鉴开源项目中有效的模块设计、数据结构和交互思路，但对外只呈现 `XFusion Agent` 自己的统一服务，不把第三方控制台当成产品主入口。

## 已吸收的开源设计元素

### 1. 监控内核

借鉴来源：

- `Prometheus / node_exporter`
- `Beszel`

吸收内容：

- 主机指标标准化字段设计
- 周期采样 + 历史曲线的监控模型
- 资源卡片、主机维度摘要和高占用进程视图

在本项目中的落点：

- `backend/app/services/monitoring.py`
- `backend/app/models/entities.py`
- `frontend/src/pages/HostDetailPage.tsx`
- `frontend/src/pages/DashboardPage.tsx`

当前形态：

- 由控制平面和 Node Agent 直接采集并存储
- 监控历史、摘要和图表全部由本项目自己提供

### 2. 策略内核

借鉴来源：

- `OPA`

吸收内容：

- `policy-as-code` 的决策思路
- 结构化输入、结构化风险输出
- `deny-by-default` 和审批门禁

在本项目中的落点：

- `backend/app/services/platform.py`
- `backend/app/services/orchestrator.py`

当前形态：

- 已改为内建策略核心
- 不再把外部策略服务作为产品必要依赖

### 3. 服务与容器资产视图

借鉴来源：

- `Portainer`
- `Cockpit`

吸收内容：

- 按主机展示服务、容器、运行时和状态的管理视图
- 服务发现结果归并到统一资源模型
- 主机详情页的运维视角组织方式

在本项目中的落点：

- `backend/app/services/platform.py`
- `frontend/src/pages/HostDetailPage.tsx`

当前形态：

- 通过 SSH / Node Agent 自己发现 systemd、Docker、Podman、PM2 等服务
- 统一写入本项目自己的 `Service` 模型

## 合规说明

本项目当前交付以“思路吸收 + 自研集成”为主，不直接把上述第三方项目作为对外产品服务。
