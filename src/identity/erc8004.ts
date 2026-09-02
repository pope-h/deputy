/**
 * erc8004.ts — on-chain identity.
 *
 * What separates an agent from a script is that someone can point at it: a
 * registered id, a stable address, and metadata that cannot be edited after
 * the fact. That is the whole reason this module exists — the agent works
 * fine without it, but nobody can verify what worked.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { AgentPublicClient, AgentWalletClient } from '../core/config.js'

/** ERC-8004 Identity Registry, Celo mainnet. */
export const IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'

const ABI = parseAbi([
  'function register(string agentURI) external returns (uint256 agentId)',
  'function agentIdOf(address owner) external view returns (uint256)',
])

export interface AgentMetadata {
  name: string
  description: string
  image?: string
  services: { name: string; endpoint: string }[]
  source?: string
}

/**
 * Build a content-addressed agentURI.
 *
 * `data:` rather than `https:` on purpose: an https metadata document can be
 * silently rewritten after registration, so the thing a verifier checks would
 * no longer be the thing that was registered. A data URI cannot drift.
 */
export function buildAgentUri(meta: AgentMetadata): string {
  const doc = {
    // The spec URI, not the legacy `"type": "Agent"`, which trips validators.
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    ...meta,
  }
  return `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString('base64')}`
}

export async function existingAgentId(
  client: AgentPublicClient, owner: Address,
): Promise<string | undefined> {
  try {
    const id = await client.readContract({
      address: IDENTITY_REGISTRY, abi: ABI, functionName: 'agentIdOf', args: [owner],
    })
    return id && id > 0n ? id.toString() : undefined
  } catch {
    return undefined
  }
}

export async function register(
  publicClient: AgentPublicClient,
  walletClient: AgentWalletClient,
  meta: AgentMetadata,
  opts: { dataSuffix?: Hex; feeCurrency?: Address } = {},
): Promise<{ agentId: string; hash: Hex }> {
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account')

  const existing = await existingAgentId(publicClient, account.address)
  if (existing) {
    return { agentId: existing, hash: '0x' as Hex }
  }

  const uri = buildAgentUri(meta)
  const { result, request } = await publicClient.simulateContract({
    address: IDENTITY_REGISTRY, abi: ABI, functionName: 'register',
    args: [uri], account,
    ...(opts.feeCurrency ? { feeCurrency: opts.feeCurrency } : {}),
  })
  const hash = await walletClient.writeContract({
    ...request,
    ...(opts.dataSuffix ? { dataSuffix: opts.dataSuffix } : {}),
  } as Parameters<typeof walletClient.writeContract>[0])
  await publicClient.waitForTransactionReceipt({ hash })
  return { agentId: result.toString(), hash }
}

/** Where a registered agent can be inspected by a human. */
export function scanUrl(agentId: string): string {
  return `https://8004scan.io/agents/celo/${agentId}`
}

// Encoding helper kept for callers that batch or relay their own transactions.
export function encodeRegister(meta: AgentMetadata): Hex {
  return encodeFunctionData({ abi: ABI, functionName: 'register', args: [buildAgentUri(meta)] })
}
