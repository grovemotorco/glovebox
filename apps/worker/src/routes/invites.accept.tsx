import { createFileRoute } from '@tanstack/react-router'
import { InviteAcceptPage } from '#app-shell'

export const Route = createFileRoute('/invites/accept')({
  ssr: false,
  component: InviteAcceptPage,
})
