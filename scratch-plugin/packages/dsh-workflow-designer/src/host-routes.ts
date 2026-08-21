/**
 * HTTP routes for the workflow-designer Host.
 *
 * Three endpoints under /api/workflow-designer:
 *   GET  /state   — full state snapshot (workflows + tasks + revision)
 *   POST /action  — apply a mutation (create/update/delete workflow/task)
 *   GET  /events  — SSE stream (revision-only; client re-fetches full state)
 *
 * Trust fence: loopback-only (same as dsh-task-board). The browser is
 * same-origin; remote origins get 403.
 *
 * Adapted from dsh-task-board's host-routes.ts pattern.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { WorkflowServiceHandle } from './host-service.ts'
import { WORKFLOW_API_PREFIX, parseActionEnvelope } from './protocol.ts'

/** SSE heartbeat interval. */
const HEARTBEAT_MS = 15_000

/** Write a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Check if the request is from a loopback (same-machine) origin. */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress
  if (addr === undefined) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Trust guard: returns true if the request should be allowed. */
function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: 'forbidden', message: 'loopback only' })
    return false
  }
  return true
}

/** Read the request body as a string. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Build the route list for the workflow-designer Host. */
export function makeWorkflowRoutes(service: WorkflowServiceHandle): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: `${WORKFLOW_API_PREFIX}/state`,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const state = service.snapshot()
        json(res, 200, { ok: true, ...state })
      },
    },
    {
      kind: 'exact',
      path: `${WORKFLOW_API_PREFIX}/action`,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const ct = req.headers['content-type'] ?? ''
        if (!ct.includes('application/json')) { json(res, 415, { ok: false, error: 'json-required' }); return }
        let body: string
        try {
          body = await readBody(req, 256 * 1024)
        } catch {
          json(res, 413, { ok: false, error: 'body-too-large' })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          json(res, 400, { ok: false, error: 'invalid-json' })
          return
        }
        try {
          const envelope = parseActionEnvelope(parsed)
          const state = service.apply(envelope.requestId, envelope.action)
          json(res, 200, { ok: true, ...state })
        } catch (error) {
          json(res, 400, { ok: false, error: 'action-failed', message: String((error as Error).message) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${WORKFLOW_API_PREFIX}/events`,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        })
        const push = (): void => {
          const payload = JSON.stringify(service.eventPayload())
          res.write(`data: ${payload}\n\n`)
        }
        push()
        const unsubscribe = service.subscribe(push)
        const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          unsubscribe()
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    },
  ]
}
