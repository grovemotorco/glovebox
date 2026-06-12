import { Route as rootRouteImport } from './routes/__root.tsx'
import { Route as IndexRouteImport } from './routes/index.tsx'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)

export const routeTree = rootRouteImport._addFileChildren({
  IndexRoute,
})
