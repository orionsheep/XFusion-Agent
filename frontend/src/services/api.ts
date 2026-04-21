import axios from 'axios'

export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api'

const TOKEN_KEY = 'xfusion_token'

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setStoredToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export const api = axios.create({
  baseURL: API_BASE_URL,
})

api.interceptors.request.use((config) => {
  const token = getStoredToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      clearStoredToken()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login')
      }
    }
    return Promise.reject(error)
  },
)

export async function login(username: string, password: string) {
  const { data } = await api.post('/auth/login', { username, password })
  setStoredToken(data.access_token)
  return data
}

export async function fetchAuthStatus() {
  const { data } = await api.get('/auth/status')
  return data
}

export async function bootstrapAdmin(username: string, password: string) {
  const { data } = await api.post('/auth/bootstrap', { username, password })
  setStoredToken(data.access_token)
  return data
}

export async function fetchCurrentUser() {
  const { data } = await api.get('/auth/me')
  return data
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const { data } = await api.post('/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
  return data
}

export async function fetchUsers() {
  const { data } = await api.get('/users')
  return data
}

export async function createUser(payload: Record<string, unknown>) {
  const { data } = await api.post('/users', payload)
  return data
}

export async function updateUser(userId: number, payload: Record<string, unknown>) {
  const { data } = await api.patch(`/users/${userId}`, payload)
  return data
}

export async function resetUserPassword(userId: number, newPassword: string) {
  const { data } = await api.post(`/users/${userId}/reset-password`, { new_password: newPassword })
  return data
}

export async function deleteUser(userId: number) {
  const { data } = await api.delete(`/users/${userId}`)
  return data
}

export async function fetchOverview() {
  const { data } = await api.get('/dashboard/overview')
  return data
}

export async function fetchHosts() {
  const { data } = await api.get('/hosts')
  return data
}

export async function createHost(payload: Record<string, unknown>) {
  const { data } = await api.post('/hosts', payload)
  return data
}

export async function fetchHost(hostId: number) {
  const { data } = await api.get(`/hosts/${hostId}`)
  return data
}

export async function profileHost(hostId: number) {
  const { data } = await api.post(`/hosts/${hostId}/profile`)
  return data
}

export async function fetchHostMetrics(hostId: number) {
  const { data } = await api.post(`/hosts/${hostId}/metrics`)
  return data
}

export async function discoverHost(hostId: number) {
  const { data } = await api.post(`/hosts/${hostId}/discover`)
  return data
}

export async function fetchServices() {
  const { data } = await api.get('/services')
  return data
}

export async function fetchTasks() {
  const { data } = await api.get('/tasks')
  return data
}

export async function fetchTask(taskId: number) {
  const { data } = await api.get(`/tasks/${taskId}`)
  return data
}

export async function executeTask(payload: Record<string, unknown>) {
  const { data } = await api.post('/tasks/execute', payload)
  return data
}

export async function fetchApprovals() {
  const { data } = await api.get('/approvals')
  return data
}

export async function decideApproval(approvalId: number, approved: boolean, reason?: string) {
  const { data } = await api.post(`/approvals/${approvalId}`, { approved, reason })
  return data
}

export async function fetchAudit() {
  const { data } = await api.get('/audit')
  return data
}

export async function fetchPdfValidation() {
  const { data } = await api.get('/validation/pdf')
  return data
}

export async function fetchIntegrations() {
  const { data } = await api.get('/integrations')
  return data
}

export async function fetchRuntimeLlmProfile() {
  const { data } = await api.get('/runtime/llm-profile')
  return data
}

export async function updateRuntimeLlmProfile(modelAlias: string, provider?: string) {
  const { data } = await api.put('/runtime/llm-profile', { model_alias: modelAlias, provider })
  return data
}

export async function collectMonitoringSnapshots() {
  const { data } = await api.post('/monitoring/collect')
  return data
}

export async function fetchHostMonitoringSummary(hostId: number) {
  const { data } = await api.get(`/monitoring/hosts/${hostId}/summary`)
  return data
}

export async function fetchHostMonitoringTimeseries(hostId: number, hours = 6) {
  const { data } = await api.get(`/monitoring/hosts/${hostId}/timeseries`, { params: { hours } })
  return data
}
