/**
 * config.ts — environment and chain wiring.
 *
 * Nothing here knows what the agent DOES. Capability-specific settings live
 * with their capability, so adding one never touches this file.
 */
import 'dotenv/config'
import { createPublicClient, createWalletClient, fallback, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo, celoSepolia } from 'viem/chains'
import { toDataSuffix } from '@celo/attribution-tags'

export const NETWORK = (process.env.NETWORK ?? 'mainnet') as 'mainnet' | 'testnet'

// Celo's base fee can rise between estimation and submission, producing
// "max fee per gas less than block base fee" rejections. viem's default adds
// only 20% headroom; doubling it costs nothing (maxFeePerGas is a cap, the
// base fee at inclusion is what's actually paid) and stops the retry churn.
const base = NETWORK === 'mainnet' ? celo : celoSepolia
export const CHAIN = { ...base, fees: { ...base.fees, baseFeeMultiplier: 2 } }

const PRIMARY_RPC = process.env.CELO_RPC_URL ??
  (NETWORK === 'mainnet'
    ? 'https://forno.celo.org'
    : 'https://forno.celo-sepolia.celo-testnet.org')

// Single-homing an agent on one keyed provider means one monthly cap takes it
// off the network entirely. Always fan out.
const FALLBACKS = (process.env.CELO_RPC_FALLBACK_URLS ?? 'https://celo.drpc.org')
  .split(',').map(s => s.trim()).filter(Boolean)

const transport = fallback([PRIMARY_RPC, ...FALLBACKS].map(url => http(url)))

export const publicClient = createPublicClient({ chain: CHAIN, transport })

// Exported so the capability boundary can name the SAME client types this file
// builds. Declaring viem's generic PublicClient/WalletClient there instead
// produces two structurally unrelated types with the same name, and every
// capability fails to typecheck against the client it is actually handed.
export type AgentPublicClient = typeof publicClient

export function walletFor(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey)
  return {
    account,
    client: createWalletClient({ account, chain: CHAIN, transport }),
  }
}

export type AgentWalletClient = ReturnType<typeof walletFor>['client']

/**
 * Optional fee currency. Set to a stablecoin address and the agent pays gas in
 * the same asset it earns, so a wallet never needs a second token topped up by
 * a human. USDm on mainnet: 0x765DE816845861e75A25fCA122bb6898B8B1282a
 */
export const FEE_CURRENCY = (process.env.FEE_CURRENCY_ADDRESS ?? '') as Hex | ''

/** Extra gas options every write shares. */
export const txOpts = FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}

// Attribution. Programs credit the registered tag, not the repo, so a tag
// issued under an earlier project still resolves to the same builder.
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? ''
export const DATA_SUFFIX: Hex = ATTRIBUTION_TAG
  ? toDataSuffix(ATTRIBUTION_TAG)
  : '0x'

/** Minimum native balance before the agent refuses to start work, in wei. */
export const MIN_GAS_WEI = BigInt(process.env.MIN_GAS_WEI ?? '500000000000000000')
