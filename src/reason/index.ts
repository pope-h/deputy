/**
 * reason/index.ts — model-backed decisions, with a breaker.
 *
 * Reasoning is the one part of an agent that costs money per use, so it is the
 * one part guaranteed to fail eventually: credit runs out, a key rotates, a
 * rate limit lands mid-task. Every caller therefore gets `null` rather than an
 * exception, and must have a non-LLM answer ready.
 *
 * The breaker matters as much as the call. A permanently broken credential
 * (bad key, exhausted balance) disables reasoning for the life of the process
 * after one loud log; without that, every future decision pays a full timeout
 * to rediscover the same failure.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { ReasonRequest } from '../core/types.js'

const MODEL = process.env.LLM_MODEL ?? 'claude-opus-5'
const EFFORT = (process.env.LLM_EFFORT ?? 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 8_000)
const MAX_FAILURES = Number(process.env.LLM_MAX_CONSECUTIVE_FAILURES ?? 3)

let client: Anthropic | null = null
let disabled = !process.env.ANTHROPIC_API_KEY
let disabledReason = disabled ? 'no ANTHROPIC_API_KEY' : ''
let failures = 0

function disable(reason: string): void {
  if (disabled) return
  disabled = true
  disabledReason = reason
  console.warn(`[reason] DISABLED (${reason}) — capabilities fall back to local logic.`)
}

export function reasoningStatus(): { active: boolean; reason: string } {
  return { active: !disabled, reason: disabledReason }
}

export async function reason(req: ReasonRequest): Promise<string | null> {
  if (disabled) return null
  try {
    client ??= new Anthropic()
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2048,
        system: req.system,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        messages: [{ role: 'user', content: req.user }],
      },
      { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    )
    let text = ''
    for (const block of res.content) if (block.type === 'text') text += block.text
    failures = 0
    return text.trim() || null
  } catch (err) {
    // Permanent: retrying next tick only buys another timeout.
    if (err instanceof Anthropic.AuthenticationError) {
      disable('authentication failed — check ANTHROPIC_API_KEY'); return null
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      disable('permission denied — key lacks access or credit is exhausted'); return null
    }
    if (err instanceof Anthropic.BadRequestError && /credit|balance|billing/i.test(err.message)) {
      disable('out of credit'); return null
    }
    // Transient: rate limits, timeouts, connection blips.
    failures += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[reason] failed (${failures}/${MAX_FAILURES}): ${msg}`)
    if (failures >= MAX_FAILURES) disable(`${failures} consecutive failures`)
    return null
  }
}
