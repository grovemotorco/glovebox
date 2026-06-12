import { createFileRoute } from '@tanstack/react-router'
import { Sidebar } from '../components/Sidebar.tsx'
import { EditorView } from '../components/EditorView.tsx'
import { CommandBar } from '../components/CommandBar.tsx'
import { SettingsModal } from '../components/SettingsModal.tsx'

// @ts-expect-error route tree types not generated for prototype app
export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <EditorView />
      <CommandBar />
      <SettingsModal />
    </div>
  )
}
