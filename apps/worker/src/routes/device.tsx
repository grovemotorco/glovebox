import { createFileRoute } from '@tanstack/react-router'
import { DevicePage } from '#app-shell'

export const Route = createFileRoute('/device')({
  ssr: false,
  component: DevicePage,
})
