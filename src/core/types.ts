/**
 * types.ts — the capability boundary.
 *
 * A Deputy is an identity, a wallet, and a way to decide — nothing else. Every
 * thing it can actually DO is a Capability, and the agent core knows nothing
 * about any of them. That is the whole design: playing a social deduction game
 * and paying for an API per request are the same shape to the runtime, so
 * adding a third is writing one file, not editing the agent.
 *
 * The boundary is deliberately narrow. A capability gets a context and answers
 * two questions: can you act, and act once. Anything wider — owning the loop,
 * scheduling itself, reaching into the keys — turns a plug-in into a fork.
 */

import type { Address, Hex } from 'viem'
import type { AgentPublicClient, AgentWalletClient } from './config.js'

export interface AgentIdentity {
  /** ERC-8004 agent id on Celo, once registered. */
  agentId?: string
  address: Address
  /** Human-readable; used in logs and by capabilities that display a name. */
  name: string
}

/** What a capability is handed: everything it may touch, and nothing else. */
export interface AgentContext {
  identity: AgentIdentity
  publicClient: AgentPublicClient
  walletClient: AgentWalletClient
  /**
   * Ask the model a question. Returns null when reasoning is unavailable, so
   * every caller must have a non-LLM answer ready. An agent that stops working
   * when its inference budget runs out is a demo, not an agent.
   */
  reason(req: ReasonRequest): Promise<string | null>
  /** Structured log line, prefixed with the agent name. */
  log(msg: string): void
  /** Attribution suffix appended to every write this agent makes. */
  dataSuffix: Hex
}

export interface ReasonRequest {
  /** Standing instructions — the role the model is playing. */
  system: string
  /** The specific question, including whatever state matters. */
  user: string
  /** Hard ceiling in ms; the caller falls back when exceeded. */
  timeoutMs?: number
  /**
   * Model for this request, overriding the agent default.
   *
   * Capabilities that earn a fixed fee per action have to pick a model the fee
   * can actually pay for — a decision only the capability can make, since only
   * it knows what the action is worth. Reviewing for $0.10 on a premium model
   * costs more than it earns.
   */
  model?: string
}

export type CapabilityOutcome =
  /** Nothing to do right now. Not an error. */
  | { kind: 'idle' }
  /** Did something; `detail` is shown in the log. */
  | { kind: 'acted'; detail: string }
  /** Tried and failed. The runtime backs off this capability, not the agent. */
  | { kind: 'failed'; detail: string }

export interface Capability {
  /** Stable id, used in config and logs. */
  readonly name: string
  /** One line: what this lets the agent do. */
  readonly description: string
  /**
   * Cheap precondition check. Must not act and must not throw — a capability
   * that cannot answer this is treated as unavailable.
   */
  isAvailable(ctx: AgentContext): Promise<boolean>
  /** Do at most one unit of work. Called repeatedly by the runtime. */
  tick(ctx: AgentContext): Promise<CapabilityOutcome>
}
