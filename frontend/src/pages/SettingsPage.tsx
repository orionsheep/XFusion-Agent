import { Card, Descriptions, List, Typography } from 'antd'
import { API_BASE_URL } from '../services/api'

export function SettingsPage() {
  return (
    <div className="content-stack">
      <div>
        <h1 className="page-title">系统设置</h1>
        <p className="page-subtitle">当前实现的核心边界、依赖和运行入口。</p>
      </div>

      <Card title="运行配置">
        <Descriptions bordered column={1}>
          <Descriptions.Item label="前端 API 地址">{API_BASE_URL}</Descriptions.Item>
          <Descriptions.Item label="中央编排">Claude Agent SDK + Goal-driven Orchestrator</Descriptions.Item>
          <Descriptions.Item label="执行通道">SSH / Node Agent / Hybrid</Descriptions.Item>
          <Descriptions.Item label="风控">本地策略引擎 + OPA 策略文件</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="V1.0 已交付模块">
        <List
          dataSource={[
            '用户登录与基础角色控制',
            '主机纳管与环境画像',
            '服务自动发现与统一展示',
            'Goal-driven 任务中心',
            '审批中心与审计日志',
            'Node Agent 样例服务',
          ]}
          renderItem={(item) => <List.Item>{item}</List.Item>}
        />
      </Card>

      <Card title="注意事项">
        <Typography.Paragraph>
          Claude Agent SDK 需要在运行环境中可用，并在配置好 Anthropic 凭据后才能启用完整 AI 规划能力。
          当前版本已将 SDK 依赖和工具接入位留在后端。
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
