/**
 * capabilities/askbots — earn stablecoins by reviewing other builders' work.
 *
 * A builder funds a project; agents review the property and answer its
 * questions; a passing review pays $0.10 USDT on Celo, instantly, to the wallet
 * on the bot profile. That makes this the clearest thing Deputy does: an agent
 * performing work a human values and being paid for it in stablecoins, with the
 * payout verifiable on-chain.
 *
 * The whole capability rests on one rule: REVIEW ONLY WHAT YOU ACTUALLY SAW.
 * AskBots grades on specificity — whether the text describes THIS property or
 * could be pasted onto any other — and a model asked about a URL it never
 * fetched writes fluent, generic, worthless prose. So every run probes the
 * property first and reasons strictly over that evidence. When there is no
 * evidence and no model, the capability does nothing at all: an agent with
 * nothing to say should say nothing, not fill the box.
 */
import type { Capability, AgentContext, CapabilityOutcome } from '../../core/types.js'
import { probe, digest, type Evidence } from './probe.js'

export interface AskBotsOptions {
  apiKey: string
  /** Base URL. The skill file is authoritative; hosts have moved before. */
  apiBase: string
  /** Stop after this many reviews per rolling 24h, below the account's own cap. */
  maxPerDay: number
  /** Wait this long between reviews. */
  minIntervalMs: number
  /**
   * Answer unpaid projects too. Their budget is spent, so `paid` comes back
   * false — but the review still earns a usefulness RATING, and the daily cap
   * scales with rating. Working for rating while there is no paid work is how
   * you are at 25/day rather than 15/day when funded projects land.
   */
  includeUnpaid: boolean
  /**
   * Model to reason with.
   *
   * This capability earns a fixed $0.10 per accepted review and spends roughly
   * 23k input + 4k output tokens producing one. At Opus 5 rates that is ~$0.22
   * — the agent would lose $0.12 every time it worked. Haiku 4.5 costs ~$0.04
   * and clears the same specificity bar, because the bar is "cite what you
   * observed", not "reason brilliantly". Raise it only if reviews start getting
   * rejected.
   */
  model: string
}

interface Question {
  id: string
  text: string
  type: 'freeform' | 'rating' | 'multiple_choice' | 'multiselect'
  choices?: string[]
}

interface Project {
  _id?: string
  id?: string
  name: string
  propertyType: string
  propertyUrl: string
  status?: string
  questions: Question[]
}

/**
 * HTTP timeout for the challenge answer.
 *
 * NOT the server's 2s answer deadline. That deadline is the server's to
 * enforce; applying it as a client-side abort guarantees failure whenever the
 * round trip alone exceeds it, which from outside the datacentre it routinely
 * does. The answer is computed locally in microseconds before the request is
 * sent, so the only thing this timeout protects against is a hung socket.
 */
const CHALLENGE_HTTP_TIMEOUT_MS = 15_000

export function askbotsCapability(opts: AskBotsOptions): Capability {
  let nextEligibleAt = 0
  let done: number[] = []
  /** Last idle reason logged, so a standing condition is reported once. */
  let quietReason = ''
  /** Projects answered or permanently refused this process; never retried. */
  const seen = new Set<string>()

  return {
    name: 'askbots',
    description: 'Reviews other builders\' projects for USDT on Celo.',

    async isAvailable(): Promise<boolean> {
      if (!opts.apiKey || Date.now() < nextEligibleAt) return false
      done = done.filter(t => Date.now() - t < 24 * 60 * 60 * 1000)
      return done.length < opts.maxPerDay
    },

    async tick(ctx: AgentContext): Promise<CapabilityOutcome> {
      const projects = await list(opts)
      const candidate = projects.find(p => {
        const id = idOf(p)
        if (!id || seen.has(id)) return false
        if (!opts.includeUnpaid && p.status === 'completed') return false
        return Boolean(p.propertyUrl) && p.questions?.length > 0
      })

      if (!candidate) {
        // Say WHY there is nothing to do. A capability that idles silently is
        // indistinguishable from one that is broken, and the difference costs
        // real time to work out from the outside.
        const why = projects.length === 0
          ? 'no assignments available'
          : `${projects.length} project(s) listed, none reviewable`
        if (why !== quietReason) {
          ctx.log(`askbots: idle — ${why}`)
          quietReason = why
        }
        nextEligibleAt = Date.now() + opts.minIntervalMs
        return { kind: 'idle' }
      }
      quietReason = ''

      const id = idOf(candidate)!
      seen.add(id)
      nextEligibleAt = Date.now() + opts.minIntervalMs

      ctx.log(`askbots: reviewing "${candidate.name}" — ${candidate.propertyUrl}`)
      const evidence = await probe(candidate.propertyUrl)

      const answers = await compose(ctx, candidate, evidence, opts.model)
      if (!answers) {
        // No model, or the model would not answer. Submitting anyway means
        // inventing findings about a property, which is the one thing this
        // capability must never do.
        return { kind: 'idle' }
      }

      const submitted = await submit(opts, id, answers)
      if ('rejected' in submitted) {
        return { kind: 'failed', detail: `review rejected (${submitted.flags.join(', ') || submitted.rejected})` }
      }

      // Past this point the review CLEARED the quality gate — a challenge is
      // only issued after it does. Everything that can still go wrong is
      // retryable, and the docs say so: submit again and you get a new
      // challenge. So release the project rather than burning it for the life
      // of the process over a slow round trip.
      let paid: string
      try {
        paid = await solveChallenge(opts, id, submitted)
      } catch (err) {
        seen.delete(id)
        throw err
      }
      done.push(Date.now())
      return { kind: 'acted', detail: paid }
    },
  }
}

function idOf(p: Project): string | undefined {
  return p._id ?? p.id
}

// ── API ───────────────────────────────────────────────────────────────────────

function auth(opts: AskBotsOptions): Record<string, string> {
  return { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' }
}

async function list(opts: AskBotsOptions): Promise<Project[]> {
  const res = await fetch(`${opts.apiBase}/projects`, { headers: auth(opts) })
  if (!res.ok) throw new Error(`projects: HTTP ${res.status}`)
  const body = await res.json() as { projects?: Project[]; notice?: string }
  // The host has moved once already and says so in-band rather than breaking.
  if (body.notice) console.warn(`[askbots] ${body.notice}`)
  return body.projects ?? []
}

interface Challenge { challengeId: string; prompt: string; timeoutMs?: number }

async function submit(
  opts: AskBotsOptions, projectId: string, answers: { questionId: string; answer: string }[],
): Promise<Challenge | { rejected: string; flags: string[] }> {
  const res = await fetch(`${opts.apiBase}/projects/${projectId}/respond`, {
    method: 'POST', headers: auth(opts), body: JSON.stringify({ answers }),
  })
  if (res.status === 422) {
    const b = await res.json().catch(() => ({})) as { error?: string; flags?: string[] }
    return { rejected: b.error ?? 'low quality', flags: b.flags ?? [] }
  }
  if (!res.ok) throw new Error(`respond: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  return await res.json() as Challenge
}

/**
 * The anti-human challenge: arithmetic, answered inside 2 seconds.
 *
 * Evaluated locally with BigInt — asking a model would blow the window, and the
 * challenge exists precisely to prove a machine is at the keyboard.
 */
async function solveChallenge(
  opts: AskBotsOptions, projectId: string, ch: Challenge,
): Promise<string> {
  const answer = evaluateArithmetic(ch.prompt)
  if (answer === null) return `challenge not understood: ${ch.prompt}`

  const t0 = Date.now()
  const res = await fetch(`${opts.apiBase}/projects/${projectId}/verify-challenge`, {
    method: 'POST', headers: auth(opts),
    body: JSON.stringify({ challengeId: ch.challengeId, answer }),
    signal: AbortSignal.timeout(CHALLENGE_HTTP_TIMEOUT_MS),
  })
  const body = await res.json().catch(() => ({})) as
    { passed?: boolean; paid?: boolean; payout?: string; txHash?: string; error?: string }

  const rtt = Date.now() - t0
  if (!body.passed) return `challenge failed after ${rtt}ms: ${body.error ?? `HTTP ${res.status}`}`
  // A 200 is not a payout: once a project's budget is spent it stays open for
  // unpaid judging, which still earns rating.
  return body.paid
    ? `review accepted in ${rtt}ms, paid ${body.payout ?? '0.10'} USDT (${body.txHash ?? 'no hash'})`
    : `review accepted in ${rtt}ms (unpaid — budget spent; earns rating)`
}

/**
 * Evaluate a strictly numeric arithmetic expression in BigInt.
 *
 * Hand-parsed rather than `eval`: the prompt is remote input, and the products
 * involved overflow a double, so `eval` would return a rounded float and fail
 * the check even when the arithmetic was right.
 */
export function evaluateArithmetic(prompt: string): string | null {
  const expr = (/([\d\s()+\-*]+)\s*[=?]/.exec(prompt)?.[1] ?? prompt)
    .replace(/[^\d()+\-*\s]/g, ' ').trim()
  if (!/\d/.test(expr)) return null

  const tokens = expr.match(/\d+|[()+\-*]/g)
  if (!tokens) return null

  let i = 0
  const peek = () => tokens[i]

  // expression := term (('+' | '-') term)*
  const expression = (): bigint => {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++]
      v = op === '+' ? v + term() : v - term()
    }
    return v
  }
  // term := factor ('*' factor)*
  const term = (): bigint => {
    let v = factor()
    while (peek() === '*') { i++; v *= factor() }
    return v
  }
  const factor = (): bigint => {
    if (peek() === '(') { i++; const v = expression(); if (peek() === ')') i++; return v }
    if (peek() === '-') { i++; return -factor() }
    const t = tokens[i++]
    if (!t || !/^\d+$/.test(t)) throw new Error(`unexpected token ${t}`)
    return BigInt(t)
  }

  try {
    const value = expression()
    return i === tokens.length ? value.toString() : null
  } catch {
    return null
  }
}

// ── Composing the review ──────────────────────────────────────────────────────

const SYSTEM = `You review software for other builders on the Celo ecosystem. You are paid only for reviews a builder can act on.

Two things are graded:
- SPECIFICITY: does the text describe THIS property, or could it be pasted onto any other? Cite concrete evidence — the URL, a route, an HTTP status, a latency, a byte count, a heading, a link label, a missing header, a filename in the repo.
- ACTIONABILITY: could the builder fix it without asking a follow-up? A finding plus what to change scores highest. A judgement with no finding scores zero.

Hard rules:
- Use ONLY the evidence provided. You did not see anything else. Never invent a screen, a button, a flow, or a transaction you were not shown.
- If the evidence is thin, say precisely what you could and could not observe, and base the review on that. "The page returned 200 in 292ms but the only link above the fold is 'docs'" is a real finding. Inventing a checkout flow is not.
- Be honest. Builders want real feedback, not flattery.
- No preamble, no sign-off, no markdown headers. Just the answer.`

async function compose(
  ctx: AgentContext, project: Project, ev: Evidence, model: string,
): Promise<{ questionId: string; answer: string }[] | null> {
  const evidence = digest(ev)
  const answers: { questionId: string; answer: string }[] = []

  for (const q of project.questions) {
    if (q.type === 'rating') {
      const n = await askRating(ctx, project, evidence, q, model)
      answers.push({ questionId: q.id, answer: String(n) })
      continue
    }

    if (q.type === 'multiple_choice' || q.type === 'multiselect') {
      const picked = await askChoice(ctx, project, evidence, q, model)
      if (!picked) return null
      answers.push({ questionId: q.id, answer: picked })
      continue
    }

    const text = await ctx.reason({
      system: SYSTEM,
      user: `Property: ${project.propertyUrl} (${project.propertyType})
Project: ${project.name}

EVIDENCE — everything you observed:
${evidence}

QUESTION: ${q.text}

Answer in 2-5 sentences. Name at least one concrete detail from the evidence.`,
      timeoutMs: 60_000,
      model,
    })
    // A freeform answer is the part that is graded. Without a model there is
    // no honest answer to give, so the whole review is abandoned.
    if (!text || text.length < 80) return null
    answers.push({ questionId: q.id, answer: text })
  }

  return answers
}

async function askRating(
  ctx: AgentContext, project: Project, evidence: string, q: Question, model: string,
): Promise<number> {
  const a = await ctx.reason({
    system: SYSTEM,
    user: `Property: ${project.propertyUrl}\n\nEVIDENCE:\n${evidence}\n\nQUESTION: ${q.text}\n\nReply with ONLY an integer 1-10. 1-3 poor, 4-6 adequate, 7-8 good, 9-10 excellent.`,
    timeoutMs: 30_000,
    model,
  })
  const n = Number(/\d+/.exec(a ?? '')?.[0])
  // A neutral 5 is the honest default when the model cannot answer: ratings are
  // not quality-gated, and refusing the whole review over one number would
  // throw away the freeform findings that actually matter.
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5
}

async function askChoice(
  ctx: AgentContext, project: Project, evidence: string, q: Question, model: string,
): Promise<string | null> {
  const choices = q.choices ?? []
  if (choices.length === 0) return null

  const a = await ctx.reason({
    system: SYSTEM,
    user: `Property: ${project.propertyUrl}\n\nEVIDENCE:\n${evidence}\n\nQUESTION: ${q.text}\nOPTIONS:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n${
      q.type === 'multiselect'
        ? 'Reply with the numbers of every option the evidence supports, comma-separated. Pick none that the evidence does not support.'
        : 'Reply with ONLY the number of the single best option.'}`,
    timeoutMs: 30_000,
    model,
  })
  if (!a) return null

  const nums = [...a.matchAll(/\d+/g)].map(m => Number(m[0]))
    .filter(n => n >= 1 && n <= choices.length)
  if (nums.length === 0) return null

  if (q.type === 'multiple_choice') return choices[nums[0] - 1]
  const unique = [...new Set(nums)].map(n => choices[n - 1])
  return JSON.stringify(unique)
}
