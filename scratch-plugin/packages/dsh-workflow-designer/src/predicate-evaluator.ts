/**
 * Predicate evaluator for branch edges. Plan §6.3: JSONPath left value +
 * comparison operator + value, combined with and/or.
 *
 * Grammar:
 *   predicate := comparison (('and' | 'or') comparison)*
 *   comparison := jsonpath operator value
 *   jsonpath := '$.' field | '$.checks[N].exitCode' | '$.decisions[?(@.key=="name")].value'
 *   operator := '==' | '!=' | 'in'
 *   value := quoted-string | number | comma-list
 *
 * Left values come from the stage's structured submission:
 *   $.status, $.summary, $.changedPaths, $.decisions, $.unresolved
 *   $.checks[].exitCode (from auto-check output)
 *   $.decisions[?(@.key=="name")].value (decision lookup)
 *
 * @module @huawe/dsh-workflow-designer/predicate-evaluator
 */

/** The context for predicate evaluation: the stage's structured output + check results. */
export interface PredicateContext {
  /** The structured submission from the stage. */
  structured: Record<string, unknown> | undefined
  /** The auto-check output (if any). */
  checkOutput: { exitCode: number; stdout: string; stderr: string; timedOut: boolean } | undefined
}

/**
 * Evaluate a predicate expression against the context.
 * Returns true if the predicate matches.
 * @param expression - the predicate string (e.g. `$.status == "complete"`)
 * @param ctx - the structured output + check results
 * @returns true if the predicate matches, false otherwise (including parse errors).
 */
export function evaluatePredicate(expression: string, ctx: PredicateContext): boolean {
  const trimmed = expression.trim()
  if (trimmed === '') return true // empty = unconditional
  try {
    return evaluateOr(trimmed, ctx)
  } catch {
    return false // parse error → false (fail-safe)
  }
}

/** Evaluate `a or b or c` (lowest precedence). */
function evaluateOr(expr: string, ctx: PredicateContext): boolean {
  const parts = splitTopLevel(expr, ' or ')
  for (const part of parts) {
    if (evaluateAnd(part, ctx)) return true
  }
  return parts.length === 0 ? false : false
}

/** Evaluate `a and b and c` (higher precedence than or). */
function evaluateAnd(expr: string, ctx: PredicateContext): boolean {
  const parts = splitTopLevel(expr, ' and ')
  for (const part of parts) {
    if (!evaluateComparison(part.trim(), ctx)) return false
  }
  return true
}

/** Split on a keyword at the top level (not inside quotes). */
function splitTopLevel(expr: string, keyword: string): string[] {
  const parts: string[] = []
  let current = ''
  let inString = false
  let i = 0
  while (i < expr.length) {
    if (expr[i] === '"') { inString = !inString; current += expr[i]; i += 1; continue }
    if (!inString && expr.slice(i, i + keyword.length).toLowerCase() === keyword) {
      parts.push(current)
      current = ''
      i += keyword.length
      continue
    }
    current += expr[i]
    i += 1
  }
  parts.push(current)
  return parts
}

/** Evaluate a single comparison: `$.path operator value`. */
function evaluateComparison(expr: string, ctx: PredicateContext): boolean {
  // Match: <jsonpath> <operator> <value>
  const match = expr.match(/^(\$\S+)\s*(==|!=|in)\s*(.+)$/)
  if (match === null) {
    // No operator — treat as truthy check on the path.
    const value = resolveJsonPath(expr.trim(), ctx)
    return value !== undefined && value !== null && value !== '' && value !== false
  }
  const [, path, operator, valueStr] = match
  if (path === undefined || operator === undefined || valueStr === undefined) return false
  const leftValue = resolveJsonPath(path.trim(), ctx)
  const rightValue = parseValue(valueStr.trim())
  return compareValues(leftValue, operator, rightValue)
}

/** Resolve a JSONPath-like expression against the context. */
function resolveJsonPath(path: string, ctx: PredicateContext): unknown {
  // $.status → structured.status
  // $.checks[0].exitCode → checkOutput.exitCode (first check)
  // $.decisions[?(@.key=="name")].value → find decision with key=name, return value
  const s = ctx.structured ?? {}
  if (path === '$.status') return s.status
  if (path === '$.summary') return s.summary
  if (path === '$.changedPaths') return s.changedPaths
  if (path === '$.decisions') return s.decisions
  if (path === '$.unresolved') return s.unresolved
  // Check output
  if (path === '$.checks[0].exitCode' || path === '$.exitCode') {
    return ctx.checkOutput?.exitCode
  }
  // Decision lookup: $.decisions[?(@.key=="name")].value
  const decisionMatch = path.match(/^\$\.decisions\[\?\(@\.key=="([^"]+)"\)\]\.value$/)
  if (decisionMatch !== null && decisionMatch[1] !== undefined) {
    const key = decisionMatch[1]
    const decisions = s.decisions
    if (Array.isArray(decisions)) {
      const found = (decisions as Array<Record<string, unknown>>).find(d => d.key === key)
      return found?.value
    }
  }
  // Simple field: $.fieldname
  const simpleMatch = path.match(/^\$\.(.+)$/)
  if (simpleMatch !== null && simpleMatch[1] !== undefined) {
    return s[simpleMatch[1]]
  }
  return undefined
}

/** Parse a value string (quoted string, number, or comma-list for `in`). */
function parseValue(raw: string): unknown {
  // Quoted string
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1)
  }
  // Number
  if (/^-?\d+$/.test(raw)) {
    return parseInt(raw, 10)
  }
  // Bare string (for `in` operator, comma-separated)
  return raw
}

/** Compare left and right values using the operator. */
function compareValues(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case '==':
      return String(left) === String(right)
    case '!=':
      return String(left) !== String(right)
    case 'in': {
      // right is a comma-separated list
      const items = String(right).split(',').map(s => s.trim().replace(/^"|"$/g, ''))
      return items.includes(String(left))
    }
    default:
      return false
  }
}
