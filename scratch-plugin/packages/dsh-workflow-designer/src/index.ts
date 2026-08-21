/**
 * Workflow designer Host plugin: registers the file-backed ledger, the
 * task runner (ctx.apiProxy → agent sessions), the HTTP routes
 * (/api/workflow-designer/*), and the service that orchestrates task
 * lifecycle + stage progression.
 *
 * Slice 3: storage + routes + task runner (spawn + poll + advance).
 *
 * Adapted from dsh-task-board's index.ts pattern.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { createWorkflowLedger } from './host-ledger.ts'
import { createWorkflowService } from './host-service.ts'
import { makeWorkflowRoutes } from './host-routes.ts'
import { WorkflowRunner } from './host-runner.ts'

/** Stable cordis plugin name. */
export const name = 'workflow-designer'

/** Services required before the Host surfaces can mount. */
export const inject = ['webServer', 'apiProxy']

/**
 * Host plugin body: create the ledger + runner + service, register routes.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  const ledger = createWorkflowLedger()
  const runner = new WorkflowRunner(ctx.apiProxy)
  const service = createWorkflowService(ledger, runner)
  service.start()

  ctx.effect(() => {
    const routes = makeWorkflowRoutes(service)
    const disposers: Array<() => void> = []
    for (const route of routes) {
      const dispose = ctx.webServer.register(route)
      disposers.push(dispose)
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* route already removed */ }
      }
      service.dispose()
    }
  }, 'workflow-designer: host routes + service')
}
