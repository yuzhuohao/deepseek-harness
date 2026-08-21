/**
 * Package-level runtime invariant. The workflow designer carries no
 * durable session-event relation yet (slice 1 = UI + localStorage MVP, no
 * session log writes). Slice 3 adds the task-runner events; until then,
 * there is no event-relation check to register with `ctx.invariants`.
 */

/** No runtime invariant in this slice: nothing reaches the session log. */
export const reason = 'workflow-designer: UI-only slice — no session events yet'
