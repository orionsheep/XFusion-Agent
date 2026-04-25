import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  List,
  Modal,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd'
import { CheckCircleFilled, MinusCircleOutlined } from '@ant-design/icons'
import { ExpandablePanelCard } from '../components/ExpandablePanelCard'
import type { ProviderInfo } from '../services/api'
import {
  API_BASE_URL,
  changePassword,
  collectMonitoringSnapshots,
  createUser,
  deleteProviderKey,
  deleteUser,
  fetchCurrentUser,
  fetchIntegrations,
  fetchPdfValidation,
  fetchProviders,
  fetchUsers,
  resetUserPassword,
  updateRuntimeLlmProfile,
  updateUser,
  upsertProviderKey,
} from '../services/api'

const roleOptions = [
  { value: 'admin', label: 'admin' },
  { value: 'operator', label: 'operator' },
  { value: 'approver', label: 'approver' },
]

export function SettingsPage() {
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()
  const [createForm] = Form.useForm()
  const [passwordForm] = Form.useForm()
  const [resetForm] = Form.useForm()
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const [createUserOpen, setCreateUserOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<any | null>(null)
  const [selectedGatewayModel, setSelectedGatewayModel] = useState<string>()

  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: fetchIntegrations,
  })
  const gatewayProvider = data?.providers?.find((provider: any) => provider.key === 'claude-sdk-gateway')
  const { data: runtimeProfile, isLoading: loadingRuntimeProfile } = useQuery({
    queryKey: ['runtime-llm-profile'],
    queryFn: fetchRuntimeLlmProfile,
  })
  const { data: validation } = useQuery({
    queryKey: ['pdf-validation'],
    queryFn: fetchPdfValidation,
  })
  const { data: currentUser, isLoading: loadingCurrentUser } = useQuery({
    queryKey: ['current-user'],
    queryFn: fetchCurrentUser,
  })
  const isAdmin = currentUser?.role === 'admin'
  const { data: users = [], isLoading: loadingUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    enabled: Boolean(isAdmin),
  })

  const { data: providers = [], refetch: refetchProviders } = useQuery<ProviderInfo[]>({
    queryKey: ['providers'],
    queryFn: fetchProviders,
  })

  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})

  const upsertKeyMutation = useMutation({
    mutationFn: ({ name, key }: { name: string; key: string }) => upsertProviderKey(name, key),
    onSuccess: (_, { name }) => {
      messageApi.success(`${name} Key 已保存`)
      setKeyInputs((prev) => ({ ...prev, [name]: '' }))
      refetchProviders()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? 'Key 保存失败')
    },
  })

  const deleteKeyMutation = useMutation({
    mutationFn: (name: string) => deleteProviderKey(name),
    onSuccess: (_, name) => {
      messageApi.success(`${name} Key 已删除`)
      refetchProviders()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? 'Key 删除失败')
    },
  })

  const invalidateAuthState = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] })
    queryClient.invalidateQueries({ queryKey: ['current-user'] })
  }

  useEffect(() => {
    if (runtimeProfile?.active?.claude_model) {
      setSelectedGatewayModel(runtimeProfile.active.claude_model)
    }
  }, [runtimeProfile?.active?.claude_model])

  const syncMutation = useMutation({
    mutationFn: collectMonitoringSnapshots,
    onSuccess: () => {
      messageApi.success('已采集全量主机监控快照')
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '采集快照失败')
    },
  })

  const updateRuntimeProfileMutation = useMutation({
    mutationFn: ({ modelAlias, provider }: { modelAlias: string; provider?: string }) =>
      updateRuntimeLlmProfile(modelAlias, provider),
    onSuccess: () => {
      messageApi.success('模型切换已生效')
      queryClient.invalidateQueries({ queryKey: ['runtime-llm-profile'] })
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '模型切换失败')
    },
  })

  const createUserMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      messageApi.success('账号已创建')
      setCreateUserOpen(false)
      createForm.resetFields()
      invalidateAuthState()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '账号创建失败')
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: number; payload: Record<string, unknown> }) => updateUser(userId, payload),
    onSuccess: () => {
      messageApi.success('账号已更新')
      invalidateAuthState()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '账号更新失败')
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ userId, newPassword }: { userId: number; newPassword: string }) => resetUserPassword(userId, newPassword),
    onSuccess: () => {
      messageApi.success('密码已重置')
      setResetTarget(null)
      resetForm.resetFields()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '密码重置失败')
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      messageApi.success('账号已删除')
      invalidateAuthState()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '账号删除失败')
    },
  })

  const changePasswordMutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) =>
      changePassword(currentPassword, newPassword),
    onSuccess: () => {
      messageApi.success('密码已更新')
      setChangePasswordOpen(false)
      passwordForm.resetFields()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '修改密码失败')
    },
  })

  if (isLoading || loadingCurrentUser || loadingRuntimeProfile) {
    return <Skeleton active paragraph={{ rows: 12 }} />
  }

  return (
    <div className="page-shell">
      {contextHolder}
      <div className="page-shell__header">
        <h1 className="page-title">系统设置</h1>
        <p className="page-subtitle">运行配置、账号登录、权限与内建能力模块状态。</p>
      </div>

      <div className="page-shell__body">
        <ExpandablePanelCard className="panel-card resizable-card" title="平台配置与运行状态" fullscreenLabel="平台配置与运行状态">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="运行配置">
                <div className="panel-subcard__content">
                  <Descriptions bordered column={1}>
                    <Descriptions.Item label="前端 API 地址">{API_BASE_URL}</Descriptions.Item>
                    <Descriptions.Item label="中央编排">Claude Agent SDK + LiteLLM Gateway + Goal-driven Orchestrator</Descriptions.Item>
                    <Descriptions.Item label="上游模型">
                      {runtimeProfile?.active?.gateway_provider ?? gatewayProvider?.stats?.provider ?? 'minimax'} / {runtimeProfile?.active?.gateway_model ?? gatewayProvider?.stats?.model ?? 'MiniMax-M2.7'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Gateway">
                      {gatewayProvider?.stats?.base_url ?? 'http://127.0.0.1:4000'}
                    </Descriptions.Item>
                    <Descriptions.Item label="执行通道">SSH / Node Agent / Hybrid</Descriptions.Item>
                    <Descriptions.Item label="风控">内建策略引擎 + 审批门禁</Descriptions.Item>
                    <Descriptions.Item label="登录模式">首次初始化管理员 + 本地账号体系</Descriptions.Item>
                  </Descriptions>
                  <div style={{ marginTop: 16 }}>
                    <Typography.Text strong>模型自由切换</Typography.Text>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Select
                        style={{ width: 220 }}
                        value={selectedGatewayModel}
                        options={(runtimeProfile?.available_models ?? []).map((model: string) => ({ value: model, label: model }))}
                        onChange={setSelectedGatewayModel}
                      />
                      <Button
                        type="primary"
                        disabled={!isAdmin || !selectedGatewayModel || selectedGatewayModel === runtimeProfile?.active?.claude_model}
                        loading={updateRuntimeProfileMutation.isPending}
                        onClick={() => {
                          if (!selectedGatewayModel) return
                          const provider = selectedGatewayModel.startsWith('GLM') ? 'zhipu' : selectedGatewayModel.startsWith('MiniMax') ? 'minimax' : undefined
                          updateRuntimeProfileMutation.mutate({ modelAlias: selectedGatewayModel, provider })
                        }}
                      >
                        切换模型
                      </Button>
                    </div>
                    <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                      当前支持的 gateway aliases 会直接从 LiteLLM 读取。切换后新任务立即按新模型执行，无需重启后端。
                    </Typography.Paragraph>
                  </div>
                </div>
              </Card>

              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="当前账号"
                extra={
                  <Button onClick={() => setChangePasswordOpen(true)}>
                    修改密码
                  </Button>
                }
              >
                <div className="panel-subcard__content">
                  <Descriptions bordered column={1}>
                    <Descriptions.Item label="用户名">{currentUser?.username}</Descriptions.Item>
                    <Descriptions.Item label="角色">
                      <Tag color={currentUser?.role === 'admin' ? 'red' : currentUser?.role === 'approver' ? 'gold' : 'blue'}>
                        {currentUser?.role}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="状态">
                      <Tag color={currentUser?.is_active ? 'green' : 'default'}>
                        {currentUser?.is_active ? 'active' : 'inactive'}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="创建时间">{currentUser?.created_at ?? 'N/A'}</Descriptions.Item>
                  </Descriptions>
                </div>
              </Card>
            </div>

            <div className="panel-subgrid panel-subgrid--2">
              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="账号与权限"
                extra={
                  isAdmin ? (
                    <Button type="primary" onClick={() => setCreateUserOpen(true)}>
                      新建账号
                    </Button>
                  ) : null
                }
              >
                <div className="panel-subcard__content">
                  {isAdmin ? (
                    loadingUsers ? (
                      <Skeleton active paragraph={{ rows: 6 }} />
                    ) : (
                      <List
                        dataSource={users}
                        renderItem={(user: any) => (
                          <List.Item
                            actions={[
                              <Select
                                key="role"
                                size="small"
                                value={user.role}
                                options={roleOptions}
                                onChange={(value) => updateUserMutation.mutate({ userId: user.id, payload: { role: value } })}
                                style={{ width: 110 }}
                              />,
                              <Switch
                                key="active"
                                size="small"
                                checked={user.is_active}
                                checkedChildren="启用"
                                unCheckedChildren="停用"
                                onChange={(checked) =>
                                  updateUserMutation.mutate({ userId: user.id, payload: { is_active: checked } })
                                }
                              />,
                              <Button key="reset" size="small" onClick={() => setResetTarget(user)}>
                                重置密码
                              </Button>,
                              <Button
                                key="delete"
                                size="small"
                                danger
                                disabled={user.id === currentUser?.id}
                                onClick={() => deleteUserMutation.mutate(user.id)}
                              >
                                删除
                              </Button>,
                            ]}
                          >
                            <List.Item.Meta
                              title={
                                <Space wrap>
                                  <Typography.Text strong>{user.username}</Typography.Text>
                                  <Tag color={user.role === 'admin' ? 'red' : user.role === 'approver' ? 'gold' : 'blue'}>
                                    {user.role}
                                  </Tag>
                                  <Tag color={user.is_active ? 'green' : 'default'}>
                                    {user.is_active ? 'active' : 'inactive'}
                                  </Tag>
                                </Space>
                              }
                              description={`创建时间 ${user.created_at}`}
                            />
                          </List.Item>
                        )}
                      />
                    )
                  ) : (
                    <Typography.Paragraph>
                      当前账号不是管理员，只能修改自己的密码，不能管理其它用户。
                    </Typography.Paragraph>
                  )}
                </div>
              </Card>

              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="内建动作"
                extra={
                  <Button loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                    采集全部主机快照
                  </Button>
                }
              >
                <div className="panel-subcard__content">
                  <List
                    dataSource={data?.actions ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta title={item.title} description={item.description} />
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>

            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="内建模块状态">
                <div className="panel-subcard__content">
                  <List
                    dataSource={data?.providers ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta
                          title={item.name}
                          description={
                            <Typography.Paragraph style={{ marginBottom: 0 }}>
                              {item.description}
                              <br />
                              <Typography.Text type="secondary">
                                {Object.entries(item.stats ?? {})
                                  .map(([key, value]) => `${key}: ${value}`)
                                  .join(' · ') || 'first-party module'}
                              </Typography.Text>
                            </Typography.Paragraph>
                          }
                        />
                        <Tag color={item.status?.reachable ? 'green' : 'default'}>
                          {item.status?.reachable ? 'active' : 'inactive'}
                        </Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="PDF 要求覆盖">
                <div className="panel-subcard__content">
                  <List
                    dataSource={validation?.items ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta title={item.requirement} description={item.evidence} />
                        <Tag color={item.status === 'pass' ? 'green' : 'gold'}>{item.status}</Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>

            <div className="panel-subgrid panel-subgrid--2">
              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="AI 模型配置"
              >
                <div className="panel-subcard__content">
                  <Typography.Text type="secondary">
                    为每个 Provider 配置你自己的 API Key，配置后可在 Agent 面板切换模型。
                  </Typography.Text>
                  <List
                    dataSource={providers}
                    renderItem={(provider: ProviderInfo) => (
                      <List.Item
                        actions={[
                          <Button
                            key="save"
                            size="small"
                            type="primary"
                            disabled={!keyInputs[provider.provider_name]}
                            loading={upsertKeyMutation.isPending}
                            onClick={() =>
                              upsertKeyMutation.mutate({
                                name: provider.provider_name,
                                key: keyInputs[provider.provider_name] ?? '',
                              })
                            }
                          >
                            保存
                          </Button>,
                          provider.is_configured ? (
                            <Button
                              key="delete"
                              size="small"
                              danger
                              loading={deleteKeyMutation.isPending}
                              onClick={() => deleteKeyMutation.mutate(provider.provider_name)}
                            >
                              删除
                            </Button>
                          ) : null,
                        ].filter(Boolean) as React.ReactNode[]}
                      >
                        <List.Item.Meta
                          avatar={
                            provider.is_configured ? (
                              <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
                            ) : (
                              <MinusCircleOutlined style={{ color: '#d9d9d9', fontSize: 16 }} />
                            )
                          }
                          title={provider.provider_name}
                          description={
                            <Input.Password
                              size="small"
                              placeholder={provider.is_configured ? '已配置，输入新值可覆盖' : '粘贴 API Key'}
                              value={keyInputs[provider.provider_name] ?? ''}
                              onChange={(e) =>
                                setKeyInputs((prev) => ({
                                  ...prev,
                                  [provider.provider_name]: e.target.value,
                                }))
                              }
                              style={{ maxWidth: 300 }}
                            />
                          }
                        />
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>
          </div>
        </ExpandablePanelCard>
      </div>

      <Modal
        open={createUserOpen}
        title="新建账号"
        onCancel={() => setCreateUserOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createUserMutation.isPending}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(values) => {
            if (values.password !== values.confirmPassword) {
              messageApi.error('两次输入的密码不一致')
              return
            }
            createUserMutation.mutate({
              username: values.username,
              password: values.password,
              role: values.role,
              is_active: values.is_active,
            })
          }}
          initialValues={{ role: 'operator', is_active: true }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true }, { min: 3 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="is_active" label="启用状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={changePasswordOpen}
        title="修改当前账号密码"
        onCancel={() => setChangePasswordOpen(false)}
        onOk={() => passwordForm.submit()}
        confirmLoading={changePasswordMutation.isPending}
      >
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={(values) => {
            if (values.newPassword !== values.confirmPassword) {
              messageApi.error('两次输入的新密码不一致')
              return
            }
            changePasswordMutation.mutate({
              currentPassword: values.currentPassword,
              newPassword: values.newPassword,
            })
          }}
        >
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(resetTarget)}
        title={resetTarget ? `重置 ${resetTarget.username} 的密码` : '重置密码'}
        onCancel={() => setResetTarget(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={resetPasswordMutation.isPending}
      >
        <Form
          form={resetForm}
          layout="vertical"
          onFinish={(values) => {
            if (!resetTarget) return
            if (values.newPassword !== values.confirmPassword) {
              messageApi.error('两次输入的新密码不一致')
              return
            }
            resetPasswordMutation.mutate({ userId: resetTarget.id, newPassword: values.newPassword })
          }}
        >
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
