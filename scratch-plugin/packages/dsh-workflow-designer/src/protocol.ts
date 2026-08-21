/**
 * Workflow-designer Host protocol: API prefix, schema version, and the
 * action union that the client sends via POST /api/workflow-designer/action.
 *
 * Adapted from dsh-task-board's protocol.ts pattern.
 */

/** API route prefix for all workflow-designer Host endpoints. */
export const WORKFLOW_API_PREFIX = '/api/workflow-designer'

/** On-disk schema version; mismatch rejects the file (no silent migration pre-release). */
export const WORKFLOW_SCHEMA_VERSION = 1

/** The full Host state snapshot returned by GET /state and carried by SSE. */
export interface WorkflowHostState {
  schemaVersion: number
  revision: number
  workflows: unknown[]
  tasks: unknown[]
  presets?: Array<{ id: string; name: string; description: string; isDefault: boolean; broken?: string }> | undefined
}

/** The cheap SSE payload (revision only — client re-fetches full state). */
export interface WorkflowEventPayload {
  revision: number
}

/** Action kinds the client can send via POST /action. */
export type WorkflowAction =
  | { kind: 'create-workflow'; workflowId: string; name: string; workspaceId: string; description: string }
  | { kind: 'update-workflow'; workflowId: string; patch: Record<string, unknown> }
  | { kind: 'delete-workflow'; workflowId: string }
  | { kind: 'archive-workflow'; workflowId: string }
  | { kind: 'set-stages'; workflowId: string; stages: unknown[] }
  | { kind: 'create-task'; taskId: string; workflowId: string; taskInputs: Record<string, string> }
  | { kind: 'cancel-task'; taskId: string }
  | { kind: 'delete-task'; taskId: string }
  | { kind: 'approve-stage'; taskId: string; nodeId: string }
  | { kind: 'reject-stage'; taskId: string; nodeId: string; comment: string }
  | { kind: 'retry-from-stage'; taskId: string; nodeId: string }

/** The envelope the client sends: a client-generated requestId + the action. */
export interface ActionEnvelope {
  requestId: string
  action: WorkflowAction
}

/** Parse and validate an unknown value as an ActionEnvelope. Throws on malformed. */
export function parseActionEnvelope(value: unknown): ActionEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new Error('workflow-designer: action body must be a JSON object')
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.requestId !== 'string') {
    throw new Error('workflow-designer: action.requestId must be a string')
  }
  if (typeof obj.action !== 'object' || obj.action === null) {
    throw new Error('workflow-designer: action.action must be an object')
  }
  const action = obj.action as Record<string, unknown>
  if (typeof action.kind !== 'string') {
    throw new Error('workflow-designer: action.action.kind must be a string')
  }
  return { requestId: obj.requestId, action: action as unknown as WorkflowAction }
}
