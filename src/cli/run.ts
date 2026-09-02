/**
 * run.ts — start a Deputy.
 *
 * Capabilities are assembled here, not discovered: an agent's abilities should
 * be something a human chose and can read in one screen, not something that
 * varies with what happens to be installed.
 */
import { Agent } from '../core/agent.js'
import { zplagueCapability } from '../capabilities/zplague/index.js'
import { x402Capability } from '../capabilities/x402/index.js'
import { reasoningStatus } from '../reason/index.js'
import type { Address, Hex } from 'viem'

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex | undefined
if (!PRIVATE_KEY) {
  console.error('AGENT_PRIVATE_KEY is required.')
  process.exit(1)
}

const capabilities = []

if (process.env.ZPLAGUE_CONTRACT) {
  capabilities.push(zplagueCapability({
    contract: process.env.ZPLAGUE_CONTRACT as Address,
    apiBase: process.env.ZPLAGUE_API ?? 'https://api.zplague.xyz',
    maxStakeWei: BigInt(process.env.ZPLAGUE_MAX_STAKE_WEI ?? '10000000000000000'),
  }))
}

if (process.env.X402_RESOURCE_URL) {
  capabilities.push(x402Capability({
    resourceUrl: process.env.X402_RESOURCE_URL,
    maxPriceBaseUnits: BigInt(process.env.X402_MAX_PRICE ?? '10000'), // 0.01 USDC
    minIntervalMs: Number(process.env.X402_MIN_INTERVAL_MS ?? 300_000),
    onPurchase: (body, ctx) => ctx.log(`x402: received ${body.length} bytes`),
  }))
}

if (capabilities.length === 0) {
  console.error('No capabilities configured. Set ZPLAGUE_CONTRACT and/or X402_RESOURCE_URL.')
  process.exit(1)
}

const agent = new Agent({
  name: process.env.AGENT_NAME ?? 'deputy',
  privateKey: PRIVATE_KEY,
  capabilities,
})

const r = reasoningStatus()
console.log(`Reasoning: ${r.active ? 'active' : `off (${r.reason}) — capabilities use local fallbacks`}`)

process.on('SIGINT', () => { agent.stop(); process.exit(0) })
process.on('SIGTERM', () => { agent.stop(); process.exit(0) })

await agent.run()
