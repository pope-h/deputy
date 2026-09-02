/**
 * agent.ts — the runtime.
 *
 * Holds an identity and a wallet, and drives whatever capabilities it was
 * handed. It does not know what any of them do, which is the point: the loop
 * below is the same whether the agent is playing a game, paying for inference,
 * or doing something not written yet.
 *
 * Failure policy: a capability that fails is BACKED OFF, never fatal. One bad
 * integration must not take an agent off the network, because the whole value
 * of leaving one running is that it keeps running.
 */
import type { Address, Hex } from 'viem'
import type { Capability, AgentContext, AgentIdentity, CapabilityOutcome } from './types.js'
import { publicClient, walletFor, DATA_SUFFIX, MIN_GAS_WEI, FEE_CURRENCY } from './config.js'
import { hasGas } from '../wallet/guards.js'
import { reason } from '../reason/index.js'
import { isRegistered } from '../identity/erc8004.js'

/** Backoff after a capability fails, doubling to a ceiling. */
const BACKOFF_BASE_MS = 15_000
const BACKOFF_MAX_MS = 10 * 60 * 1000

interface Slot {
  cap: Capability
  failures: number
  nextEligibleAt: number
}

export interface AgentOptions {
  name: string
  privateKey: Hex
  capabilities: Capability[]
  /** Delay between loop passes. */
  tickMs?: number
}

export class Agent {
  private readonly slots: Slot[]
  private readonly ctx: AgentContext
  private readonly tickMs: number
  private stopped = false

  constructor(opts: AgentOptions) {
    const { account, client } = walletFor(opts.privateKey)
    this.tickMs = opts.tickMs ?? 5_000
    this.slots = opts.capabilities.map(cap => ({ cap, failures: 0, nextEligibleAt: 0 }))

    const identity: AgentIdentity = { address: account.address, name: opts.name }
    this.ctx = {
      identity,
      publicClient,
      walletClient: client,
      reason,
      log: (msg: string) => console.log(`[${opts.name}] ${msg}`),
      dataSuffix: DATA_SUFFIX,
    }
  }

  get address(): Address { return this.ctx.identity.address }
  get context(): AgentContext { return this.ctx }

  /**
   * Confirm this wallet holds an ERC-8004 identity.
   *
   * The registry has no address → agentId getter, so the id itself must come
   * from config (it is returned once, by register()). balanceOf answers the
   * part that can be checked on-chain.
   */
  async loadIdentity(): Promise<void> {
    const configured = process.env.AGENT_ID
    try {
      const registered = await isRegistered(publicClient, this.ctx.identity.address)
      if (registered) {
        this.ctx.identity.agentId = configured
        this.ctx.log(configured ? `ERC-8004 agent #${configured}` : 'ERC-8004 identity held (set AGENT_ID to name it)')
      } else {
        this.ctx.log('no ERC-8004 identity — run `npm run register`')
      }
    } catch (err) {
      // Distinguish a failed read from an absent identity. Reporting an RPC
      // error as "not registered" is how a duplicate mint starts.
      this.ctx.log(`identity check failed (${err instanceof Error ? err.message : String(err)}) — continuing`)
    }
  }

  stop(): void { this.stopped = true }

  async run(): Promise<void> {
    this.ctx.log(`starting with ${this.slots.length} capability(ies): ${this.slots.map(s => s.cap.name).join(', ')}`)
    await this.loadIdentity()

    while (!this.stopped) {
      // Gas floor is checked once per pass rather than per capability: it is
      // a property of the agent, and re-querying per capability multiplies RPC
      // calls for an answer that cannot differ between them.
      const funded = await hasGas(
        publicClient, this.ctx.identity.address, MIN_GAS_WEI,
        FEE_CURRENCY ? (FEE_CURRENCY as Address) : undefined,
      )
      if (!funded) {
        this.ctx.log(`below gas floor (${FEE_CURRENCY ? 'fee currency' : 'native CELO'}) — idling until topped up`)
        await sleep(60_000)
        continue
      }

      for (const slot of this.slots) {
        if (this.stopped) break
        if (Date.now() < slot.nextEligibleAt) continue
        await this.tickOne(slot)
      }
      await sleep(this.tickMs)
    }
  }

  private async tickOne(slot: Slot): Promise<void> {
    let outcome: CapabilityOutcome
    try {
      if (!(await slot.cap.isAvailable(this.ctx))) return
      outcome = await slot.cap.tick(this.ctx)
    } catch (err) {
      outcome = { kind: 'failed', detail: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.kind === 'acted') {
      slot.failures = 0
      this.ctx.log(`${slot.cap.name}: ${outcome.detail}`)
      return
    }
    if (outcome.kind === 'failed') {
      slot.failures += 1
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (slot.failures - 1), BACKOFF_MAX_MS)
      slot.nextEligibleAt = Date.now() + wait
      this.ctx.log(`${slot.cap.name} failed (${slot.failures}), backing off ${Math.round(wait / 1000)}s: ${outcome.detail}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
