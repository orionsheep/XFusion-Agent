# 基础监控与管理开源复用评估

更新日期：2026-04-19

## 1. 当前代码问题

### 1.1 AI 还没有真正落地

当前代码里，Claude 只在 `maybe_summarize()` 中尝试做一次摘要提示，并没有真正负责任务规划、工具选择和执行闭环：

- [backend/app/services/platform.py](/Users/mychanging/Desktop/XFusion-Agent/backend/app/services/platform.py:399)
- [backend/app/services/platform.py](/Users/mychanging/Desktop/XFusion-Agent/backend/app/services/platform.py:441)

真正的任务规划仍然是 `_build_plan()` 里的关键词和正则匹配，这只能算规则引擎，不是 AI 运维代理。

### 1.2 基础监控能力过薄

当前主机指标采集只取了少量 CPU / load / 内存 / 根分区信息：

- [backend/app/services/platform.py](/Users/mychanging/Desktop/XFusion-Agent/backend/app/services/platform.py:266)
- [agent/app/main.py](/Users/mychanging/Desktop/XFusion-Agent/agent/app/main.py:61)

这还不具备可用的多机性能监测能力，缺少：

- 历史时序数据
- 告警
- 容器维度资源统计
- 多分区 / 多网卡 / 多磁盘 I/O
- 进程级 / 服务级 drill-down
- 长期存储和对比分析

### 1.3 服务发现也过于简化

当前服务发现只做了：

- `systemd` 前 20 条
- `docker ps`
- `ss -ltnp`

相关代码：

- [backend/app/services/platform.py](/Users/mychanging/Desktop/XFusion-Agent/backend/app/services/platform.py:289)
- [agent/app/main.py](/Users/mychanging/Desktop/XFusion-Agent/agent/app/main.py:83)

这只能算演示级，不适合作为生产级基础能力。

## 2. 结论

不应该继续自研“基础监控 + 基础管理”这一层。

应该把 XFusion-Agent 收敛成：

- `AI 控制平面`
- `任务 / 审批 / 审计 / 统一入口`
- `对现成监控和管理系统的编排层`

也就是说，先把现成开源项目接进来，再在它们之上叠加 Claude Agent。

## 3. 可直接复用的项目

## 3.1 Beszel

仓库：

- https://github.com/henrygd/beszel

官方 README 明确写了：

- 它是轻量级服务器监控平台，带历史数据、Docker 统计和告警
- 架构是 `hub + agent`
- 支持多用户、OAuth/OIDC、API
- MIT License

参考：

- GitHub README: https://github.com/henrygd/beszel

适合复用的点：

- 多机监控
- 历史指标
- Docker / Podman 资源统计
- 告警
- 现成 Dashboard
- agent / hub 架构和你现在的产品方向一致

适配判断：

- 很适合替换我们现在自写的 `metrics` 和一部分 `discover`
- 也适合直接作为第一版监控底座

风险：

- 它更偏监控，不是完整服务器管理台
- 对“用户管理 / systemd 服务管理 / 日志操作”支持有限

结论：

- `推荐作为第一优先级接入`

## 3.2 Cockpit

仓库：

- https://github.com/cockpit-project/cockpit

官方 README 明确写了：

- 它是 Linux 服务器 Web 管理界面
- 能直接做容器、存储、网络、日志等操作
- 能通过 SSH 添加其他主机

参考：

- GitHub README: https://github.com/cockpit-project/cockpit
- 官方文档: https://cockpit-project.org/guide/latest/guide.html

注意事项：

- 官方“Multiple Machines”页面标记为 deprecated，但 README 仍明确说明可以通过 SSH 添加其他机器
- 这意味着 Cockpit 仍然适合作为“专家模式 / 单机管理入口”，但不应成为你的主 Fleet 控制平面

参考：

- https://cockpit-project.org/guide/latest/feature-machines.html

适合复用的点：

- systemd 服务管理
- 用户和系统操作
- 日志查看
- 网络与存储管理
- SSH 跳转式多机访问

适配判断：

- 很适合做“主机详情页 -> 高级管理入口”
- 不适合直接替代你的 AI 中控台

结论：

- `推荐作为服务器管理能力底座`

## 3.3 Portainer CE

仓库：

- https://github.com/portainer/portainer
- Agent: https://github.com/portainer/agent

官方 README 明确写了：

- Portainer CE 用于管理 Docker、Swarm、Kubernetes、ACI
- 提供 GUI 和 API
- 支持 agent 模式
- 社区版为开源项目

参考：

- GitHub README: https://github.com/portainer/portainer

适合复用的点：

- Docker 服务管理
- 容器、镜像、卷、网络、Stack 管理
- 多环境管理

适配判断：

- 对你“导入服务器后自动识别已部署服务”这件事很有帮助
- 特别适合那些已经大量跑 Docker / Compose 的主机

限制：

- 它解决的是容器管理，不是整机性能监控
- 它不能代替 Cockpit 或 Beszel

结论：

- `推荐作为容器管理子系统`

## 3.4 Prometheus + node_exporter

仓库：

- node_exporter: https://github.com/prometheus/node_exporter
- 文档: https://prometheus.io/docs/guides/node-exporter/

官方文档明确写了：

- Node Exporter 暴露大量硬件和内核相关指标
- 是单个静态二进制
- 默认在 `:9100` 暴露 `/metrics`
- 适合由 Prometheus 抓取

适合复用的点：

- 标准化主机指标
- 对接 Prometheus / Grafana / Alertmanager
- 给 AI 提供标准 PromQL 查询入口

适配判断：

- 非常适合作为“标准观测协议层”
- 但它本身不提供管理界面，也不负责系统管理

结论：

- `适合作为标准指标出口，不适合作为完整产品界面`

## 3.5 Netdata

仓库：

- https://github.com/netdata/netdata

官方 README 明确写了：

- 它是实时基础设施监控平台
- 每秒采集
- 自动发现
- 自带告警和异常检测
- Cloud 可选

参考：

- GitHub README: https://github.com/netdata/netdata

但也要注意官方仓库里的许可证说明：

- Agent 是 GPLv3+
- UI 和 Cloud 有闭源部分

适合复用的点：

- 更强的实时可观测性
- 更深的 drill-down
- 进程 / 网络 / 集成覆盖更广

不适合直接作为主底座的原因：

- 许可证和产品边界比 Beszel 复杂
- 如果你希望整个系统“更干净地完全开源自控”，它没有 Beszel 轻

结论：

- `可作为深度观测增强项，不建议作为第一优先级核心底座`

## 3.6 openEuler A-Ops / gala-gopher

文档与来源：

- A-Ops 文档: https://docs.openeuler.org/en/docs/22.03_LTS/docs/A-Ops/aops-framework-manual.html
- gala-gopher 介绍: https://www.openeuler.org/en/blog/20240122-gala/20240122-gala.html

官方文档说明：

- A-Ops 有 manager / database / cli / web 等完整组件
- gala-gopher 基于 eBPF 做全栈可观测性
- 源码主要在 Gitee

适合复用的点：

- openEuler 环境的深度诊断
- eBPF 级别的观测
- 和比赛场景高度契合

限制：

- 更偏 openEuler 生态
- 集成复杂度高
- 不适合作为跨 Ubuntu / CentOS / openEuler 的统一第一层底座

结论：

- `推荐作为 openEuler 专项增强，不建议先拿它做全平台统一底座`

## 4. 推荐方案

## 4.1 最推荐的组合

### 监控层

- `Beszel`

### 服务器管理层

- `Cockpit`

### 容器管理层

- `Portainer CE`

### 标准指标层

- `Prometheus + node_exporter`

### openEuler 深度增强

- `A-Ops / gala-gopher`

## 4.2 为什么是这个组合

因为它刚好把你要的能力拆成了最自然的四层：

- `Beszel` 解决多机性能监测、历史数据、告警
- `Cockpit` 解决整机管理、日志、systemd、网络、存储
- `Portainer` 解决 Docker / Compose 类服务管理
- `Prometheus / node_exporter` 解决统一指标标准和未来 AI 查询语义

而 `XFusion-Agent` 自己只保留：

- 统一入口
- 资产模型
- AI 任务理解
- 审批 / 审计
- 跨系统编排

## 5. 对当前项目的改造建议

### 5.1 应该停止继续自研的部分

- 自写 `metrics()` 采集逻辑
- 自写简化版服务发现作为主方案
- 自写整套服务器管理 GUI

### 5.2 应该保留的部分

- 主机资产模型
- 任务中心
- 审批中心
- 审计日志
- AI 编排入口

### 5.3 第一阶段重构顺序

1. 先接 `Beszel`
2. 再接 `Cockpit`
3. 对 Docker 主机补 `Portainer`
4. 之后再把 Claude Agent 真正接到这些系统的 API / 页面动作层

## 6. 最终判断

如果目标是“尽量充分利用开源项目”，那当前项目的正确方向不是继续补自研监控细节，而是：

- 把 `Beszel + Cockpit + Portainer` 当现成底座接进来
- 把 `XFusion-Agent` 收敛成 AI 控制平面

这是现在最现实、最快、也最接近你真实目标的路线。
