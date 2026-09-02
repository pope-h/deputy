/**
 * register.ts — claim an ERC-8004 identity for this agent's wallet.
 *
 * Run once per wallet. Registration is idempotent: an already-registered
 * address returns its existing id rather than minting a second one.
 */
import { publicClient, walletFor, DATA_SUFFIX, FEE_CURRENCY } from '../core/config.js'
import { register, scanUrl } from '../identity/erc8004.js'
import type { Address, Hex } from 'viem'

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex | undefined
if (!PRIVATE_KEY) {
  console.error('AGENT_PRIVATE_KEY is required.')
  process.exit(1)
}

const name = process.env.AGENT_NAME ?? 'Deputy'
const { client } = walletFor(PRIVATE_KEY)

const { agentId, hash } = await register(publicClient, client, {
  name,
  description: 'An autonomous on-chain agent with its own wallet and pluggable capabilities. Plays staked games and pays for its own services in stablecoins on Celo.',
  services: [
    { name: 'zplague', endpoint: 'https://zplague.xyz' },
  ],
  source: process.env.AGENT_SOURCE_URL ?? '',
}, {
  dataSuffix: DATA_SUFFIX === '0x' ? undefined : DATA_SUFFIX,
  feeCurrency: FEE_CURRENCY ? (FEE_CURRENCY as Address) : undefined,
})

console.log(`\n${name} → ERC-8004 agent #${agentId}`)
console.log(hash === '0x' ? '(already registered)' : `tx: ${hash}`)
console.log(scanUrl(agentId))
