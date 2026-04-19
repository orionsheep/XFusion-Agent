import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input, Modal, Space, Table, Tag, Typography, message } from 'antd'
import { useState } from 'react'
import { decideApproval, fetchApprovals } from '../services/api'

export function ApprovalsPage() {
  const [messageApi, contextHolder] = message.useMessage()
  const queryClient = useQueryClient()
  const [currentApproval, setCurrentApproval] = useState<any>()
  const [reason, setReason] = useState('')

  const { data = [], isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn: fetchApprovals,
    refetchInterval: 5000,
  })

  const mutation = useMutation({
    mutationFn: ({ approvalId, approved }: { approvalId: number; approved: boolean }) =>
      decideApproval(approvalId, approved, reason),
    onSuccess: () => {
      messageApi.success('审批已处理')
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      setCurrentApproval(undefined)
      setReason('')
    },
  })

  return (
    <div className="content-stack">
      {contextHolder}
      <div>
        <h1 className="page-title">审批中心</h1>
        <p className="page-subtitle">所有高风险动作都必须在这里完成最终放行。</p>
      </div>
      <Card>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data}
          columns={[
            { title: '审批单', dataIndex: 'id' },
            { title: '任务', dataIndex: 'task_id' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (value: string) => <Tag color={value === 'pending' ? 'gold' : 'green'}>{value}</Tag>,
            },
            {
              title: '动作',
              render: (_: unknown, record: any) => (
                <Space>
                  <Button disabled={record.status !== 'pending'} onClick={() => setCurrentApproval(record)}>
                    审批
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={Boolean(currentApproval)}
        onCancel={() => setCurrentApproval(undefined)}
        title={`审批 #${currentApproval?.id}`}
        footer={null}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Typography.Paragraph>
            <strong>拟执行动作：</strong>
            <br />
            {JSON.stringify(currentApproval?.action_payload ?? {}, null, 2)}
          </Typography.Paragraph>
          <Input.TextArea
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="填写审批原因或拒绝原因"
          />
          <Space>
            <Button
              type="primary"
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({ approvalId: currentApproval.id, approved: true })
              }
            >
              批准
            </Button>
            <Button
              danger
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({ approvalId: currentApproval.id, approved: false })
              }
            >
              拒绝
            </Button>
          </Space>
        </Space>
      </Modal>
    </div>
  )
}
