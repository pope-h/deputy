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
  // The registry is an ERC-721 but NOT enumerable: tokenOfOwnerByIndex reverts,
  // and there is no agentOf/agentIdOf getter (both revert on mainnet — verified
  // against 0x8004…a432). So there is NO on-chain address → agentId lookup.
  // balanceOf answers the question that actually matters — does this address
  // hold an agent identity — and it works for any address, not just ours.
  'function balanceOf(address owner) external view returns (uint256)',
  'function ownerOf(uint256 agentId) external view returns (address)',
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

/** True when this address holds an ERC-8004 agent identity. */
export async function isRegistered(
  client: AgentPublicClient, owner: Address,
): Promise<boolean> {
  const balance = await client.readContract({
    address: IDENTITY_REGISTRY, abi: ABI, functionName: 'balanceOf', args: [owner],
  })
  return balance > 0n
}

/** Confirm a known agent id belongs to this address. */
export async function ownsAgent(
  client: AgentPublicClient, owner: Address, agentId: string,
): Promise<boolean> {
  try {
    const holder = await client.readContract({
      address: IDENTITY_REGISTRY, abi: ABI, functionName: 'ownerOf', args: [BigInt(agentId)],
    })
    return holder.toLowerCase() === owner.toLowerCase()
  } catch {
    return false
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

  // Guard against a duplicate mint. This MUST NOT be a swallowed try/catch: a
  // failed read is not evidence of "not registered", and treating it as such
  // mints a second identity for a wallet that already has one.
  if (await isRegistered(publicClient, account.address)) {
    throw new Error(
      `${account.address} already holds an ERC-8004 identity. ` +
      'Registering again would mint a duplicate. Pass AGENT_ID to use the existing one.',
    )
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
