import { useQuery } from '@tanstack/react-query'
import { Card, Descriptions, List, Skeleton, Tag, Typography } from 'antd'
import { API_BASE_URL, fetchIntegrations } from '../services/api'

export function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: fetchIntegrations,
  })

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 12 }} />
  }

  return (
    <div className="content-stack">
      <div>
        <h1 className="page-title">系统设置</h1>
        <p className="page-subtitle">当前运行配置，以及 Beszel / Cockpit / Portainer / Prometheus 的统一接入信息。</p>
      </div>

      <Card title="运行配置">
        <Descriptions bordered column={1}>
          <Descriptions.Item label="前端 API 地址">{API_BASE_URL}</Descriptions.Item>
          <Descriptions.Item label="中央编排">Claude Agent SDK + Goal-driven Orchestrator</Descriptions.Item>
          <Descriptions.Item label="执行通道">SSH / Node Agent / Hybrid</Descriptions.Item>
          <Descriptions.Item label="风控">本地策略引擎 + OPA 策略文件</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="开源底座接入状态">
        <List
          dataSource={data?.providers ?? []}
          renderItem={(item: any) => (
            <List.Item>
              <List.Item.Meta
                title={item.name}
                description={
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    {item.description}
                    {item.url ? (
                      <>
                        <br />
                        <Typography.Text code>{item.url}</Typography.Text>
                      </>
                    ) : null}
                  </Typography.Paragraph>
                }
              />
              <Tag color={item.status?.reachable ? 'green' : item.status?.configured ? 'gold' : 'default'}>
                {item.status?.reachable ? 'reachable' : item.status?.configured ? 'configured' : 'unconfigured'}
              </Tag>
            </List.Item>
          )}
        />
      </Card>

      <Card title="部署模板">
        <List
          dataSource={data?.deployment_templates ?? []}
          renderItem={(item: any) => (
            <List.Item>
              <List.Item.Meta
                title={item.title}
                description={<Typography.Text code>{item.command}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Card title="V1.1 已交付模块">
        <List
          dataSource={[
            '用户登录与基础角色控制',
            '主机纳管与环境画像',
            '服务自动发现与统一展示',
            'Goal-driven 任务中心',
            '审批中心与审计日志',
            'Beszel / Prometheus / Portainer 统一集成入口',
            'Cockpit / Node Exporter / Beszel Agent 安装脚本模板',
          ]}
          renderItem={(item) => <List.Item>{item}</List.Item>}
        />
      </Card>

      <Card title="注意事项">
        <Typography.Paragraph>
          Claude Agent SDK 仍然是中央控制平面的编排层。基础监控与管理能力已经开始切换为开源底座模式，
          当前项目负责统一入口、审批、审计和 AI 任务编排，而不再重复造监控和管理轮子。
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
