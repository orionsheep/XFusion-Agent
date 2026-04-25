import { Suspense, lazy } from 'react'
import { ConfigProvider, Skeleton, theme } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { getStoredToken } from './services/api'

const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })))
const SetupPage = lazy(() => import('./pages/SetupPage').then((module) => ({ default: module.SetupPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const HostsPage = lazy(() => import('./pages/HostsPage').then((module) => ({ default: module.HostsPage })))
const HostDetailPage = lazy(() =>
  import('./pages/HostDetailPage').then((module) => ({ default: module.HostDetailPage })),
)
const FileManagerPage = lazy(() =>
  import('./pages/FileManagerPage').then((module) => ({ default: module.FileManagerPage })),
)
const TasksPage = lazy(() => import('./pages/TasksPage').then((module) => ({ default: module.TasksPage })))
const ApprovalsPage = lazy(() =>
  import('./pages/ApprovalsPage').then((module) => ({ default: module.ApprovalsPage })),
)
const AuditPage = lazy(() => import('./pages/AuditPage').then((module) => ({ default: module.AuditPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!getStoredToken()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 10 }} style={{ padding: 24 }} />
}

function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#0f766e',
          colorBgLayout: '#f3f7f7',
          borderRadius: 0,
          fontFamily: `'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif`,
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="overview" element={<DashboardPage />} />
                <Route path="hosts" element={<HostsPage />} />
                <Route path="hosts/:hostId" element={<HostDetailPage />} />
                <Route path="files" element={<FileManagerPage />} />
                <Route path="tasks" element={<TasksPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  )
}

export default App
