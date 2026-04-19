import { useQuery } from '@tanstack/react-query'
import { Card, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { fetchAudit } from '../services/api'

export function AuditPage() {
  const { data = [], isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: fetchAudit,
  })

  return (
    <div className="content-stack">
      <div>
        <h1 className="page-title">审计日志</h1>
        <p className="page-subtitle">所有关键行为都在这里留存时间线和上下文。</p>
      </div>
      <Card>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data}
          columns={[
            { title: 'ID', dataIndex: 'id' },
            { title: '事件', dataIndex: 'event_type', render: (value: string) => <Tag>{value}</Tag> },
            { title: '任务', dataIndex: 'task_id' },
            { title: '主机', dataIndex: 'host_id' },
            {
              title: '时间',
              dataIndex: 'created_at',
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '详情',
              dataIndex: 'payload_json',
              render: (value: unknown) => (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', maxWidth: 480 }}>{JSON.stringify(value, null, 2)}</pre>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
