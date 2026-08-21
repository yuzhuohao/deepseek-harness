/**
 * Browser-side HTTP client for the workflow-designer Host.
 *
 * Three operations:
 *   fetchState() — GET /api/workflow-designer/state → full snapshot
 *   postAction(requestId, action) — POST /api/workflow-designer/action → mutated snapshot
 *   subscribeToEvents(onRevision) — GET /api/workflow-designer/events (SSE) → revision deltas
 *
 * Falls back gracefully: if the Host is unavailable (running outside
 * dsh web), all operations return undefined and the store falls back to
 * localStorage.
 *
 * @module @huawe/dsh-workflow-designer/client/host-api
 */
import type { WorkflowAction, WorkflowHostState } from '../protocol.ts'
import { WORKFLOW_API_PREFIX } from '../protocol.ts'

/** Fetch the full state from the Host. Returns undefined on failure. */
export async function fetchState(): Promise<WorkflowHostState | undefined> {
  try {
    const resp = await fetch(`${WORKFLOW_API_PREFIX}/state`, { headers: { accept: 'application/json' } })
    if (!resp.ok) return undefined
    const body = await resp.json() as { ok: boolean } & Partial<WorkflowHostState>
    if (!body.ok) return undefined
    return {
      schemaVersion: body.schemaVersion ?? 0,
      revision: body.revision ?? 0,
      workflows: body.workflows ?? [],
      tasks: body.tasks ?? [],
      presets: body.presets ?? [],
    }
  } catch {
    return undefined
  }
}

/** Send a mutation to the Host. Returns the mutated state, or undefined on failure. */
export async function postAction(requestId: string, action: WorkflowAction): Promise<WorkflowHostState | undefined> {
  try {
    const resp = await fetch(`${WORKFLOW_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ requestId, action }),
    })
    if (!resp.ok) return undefined
    const body = await resp.json() as { ok: boolean } & Partial<WorkflowHostState>
    if (!body.ok) return undefined
    return {
      schemaVersion: body.schemaVersion ?? 0,
      revision: body.revision ?? 0,
      workflows: body.workflows ?? [],
      tasks: body.tasks ?? [],
      presets: body.presets ?? [],
    }
  } catch {
    return undefined
  }
}

/** Subscribe to SSE revision events. Returns a disposer. */
export function subscribeToEvents(onRevision: (revision: number) => void): () => void {
  let disposed = false
  let source: EventSource | undefined
  try {
    source = new EventSource(`${WORKFLOW_API_PREFIX}/events`)
    source.onmessage = (event) => {
      if (disposed) return
      try {
        const payload = JSON.parse(event.data as string) as { revision: number }
        onRevision(payload.revision)
      } catch {
        // Malformed frame — drop; the next fetch resyncs.
      }
    }
    source.onerror = () => {
      // The browser auto-reconnects EventSource; nothing to do here.
    }
  } catch {
    // EventSource unavailable — no live updates.
  }
  return () => {
    disposed = true
    source?.close()
    source = undefined
  }
}
