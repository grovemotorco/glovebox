import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppShell, DevicePage, InviteAcceptPage } from './components/AppShell.client.tsx'

declare global {
  interface Window {
    __GLOVEBOX_DEV_ROOT__?: Root
  }
}

function DevApp() {
  const path = window.location.pathname
  if (path === '/device') return <DevicePage />
  if (path === '/invites/accept') return <InviteAcceptPage />
  return <AppShell />
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}

const appRoot = window.__GLOVEBOX_DEV_ROOT__ ?? createRoot(root)
window.__GLOVEBOX_DEV_ROOT__ = appRoot

appRoot.render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
)
