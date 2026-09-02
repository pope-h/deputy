/**
 * capabilities/x402 — pay for a resource, per request, in stablecoins.
 *
 * The second capability exists to prove the boundary is real. It shares nothing
 * with zplague except the AgentContext: no game state, no contract, no common
 * helper. If adding it had required touching the core or the other capability,
 * the plug-in claim would have been decoration.
 *
 * It also closes a loop that matters more than the code: an agent that pays for
 * its own inference is funding its own thinking, rather than a human topping up
 * an API key on its behalf.
 *
 * Protocol (x402): request a protected resource → the server answers 402 with
 * payment requirements → sign a payment authorisation → retry with X-PAYMENT.
 * Settlement is performed by the facilitator, so the agent never needs the
 * settlement contract itself.
 */
import { type Address } from 'viem'
import type { Capability, AgentContext, CapabilityOutcome } from '../../core/types.js'

/** Stablecoins the Celo x402 facilitator settles. Decimals differ — 6, not 18. */
export const SETTLEABLE: Record<string, { address: Address; decimals: number }> = {
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
}

export interface X402Options {
  /** The protected resource this agent is willing to buy. */
  resourceUrl: string
  /** Refuse anything dearer than this, in the asset's own base units. */
  maxPriceBaseUnits: bigint
  /** How often to buy, at most. Prevents a loop from draining the wallet. */
  minIntervalMs?: number
  /** What to do with what was bought. Default: log its length. */
  onPurchase?: (body: string, ctx: AgentContext) => void
}

interface PaymentRequirement {
  scheme?: string
  network?: string
  asset?: string
  maxAmountRequired?: string
  payTo?: string
  resource?: string
}

export function x402Capability(opts: X402Options): Capability {
  let lastBoughtAt = 0
  const interval = opts.minIntervalMs ?? 60_000

  return {
    name: 'x402',
    description: 'Buys a paid HTTP resource per request, settling in stablecoins over x402.',

    async isAvailable(): Promise<boolean> {
      return Boolean(opts.resourceUrl) && Date.now() - lastBoughtAt >= interval
    },

    async tick(ctx: AgentContext): Promise<CapabilityOutcome> {
      const probe = await fetch(opts.resourceUrl).catch(() => null)
      if (!probe) return { kind: 'failed', detail: 'resource unreachable' }

      // 200 without payment: nothing to buy. Not a failure — a free resource is
      // a perfectly good outcome, and treating it as an error would back off a
      // capability that is working.
      if (probe.status !== 402) {
        lastBoughtAt = Date.now()
        return { kind: 'idle' }
      }

      const req = await parseRequirements(probe)
      if (!req) return { kind: 'failed', detail: '402 carried no usable payment requirements' }

      const price = BigInt(req.maxAmountRequired ?? '0')
      if (price === 0n) return { kind: 'failed', detail: 'price missing from requirements' }
      // The spend ceiling is the whole reason this is safe to leave running.
      if (price > opts.maxPriceBaseUnits) {
        return { kind: 'idle' }
      }

      const authorization = await signPaymentAuthorization(ctx, req, price)
      if (!authorization) return { kind: 'failed', detail: 'could not sign payment authorization' }

      const paid = await fetch(opts.resourceUrl, {
        headers: { 'X-PAYMENT': authorization },
      }).catch(() => null)

      if (!paid) return { kind: 'failed', detail: 'retry with payment failed' }
      if (paid.status === 402) return { kind: 'failed', detail: 'payment rejected by facilitator' }
      if (!paid.ok) return { kind: 'failed', detail: `resource returned ${paid.status}` }

      const body = await paid.text()
      lastBoughtAt = Date.now()
      opts.onPurchase?.(body, ctx)
      return { kind: 'acted', detail: `bought ${opts.resourceUrl} for ${price} base units` }
    },
  }
}

async function parseRequirements(res: Response): Promise<PaymentRequirement | null> {
  try {
    const body = (await res.json()) as { accepts?: PaymentRequirement[] }
    // Take the first requirement the facilitator can actually settle.
    const settleable = new Set(Object.values(SETTLEABLE).map(s => s.address.toLowerCase()))
    return (body.accepts ?? []).find(a => a.asset && settleable.has(a.asset.toLowerCase()))
        ?? body.accepts?.[0]
        ?? null
  } catch {
    return null
  }
}

/**
 * Sign an EIP-3009 transfer authorization for the facilitator to settle.
 *
 * Uses eth_signTypedData_v4. That method is the one real portability risk here:
 * it is NOT interchangeable with personal_sign, and a wallet can support one
 * without the other — so a signer that cannot produce it must fail loudly
 * rather than silently skip payment.
 */
async function signPaymentAuthorization(
  ctx: AgentContext, req: PaymentRequirement, value: bigint,
): Promise<string | null> {
  const account = ctx.walletClient.account
  if (!account || !req.asset || !req.payTo) return null

  try {
    const now = Math.floor(Date.now() / 1000)
    const message = {
      from: account.address,
      to: req.payTo as Address,
      value,
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + 300),
      nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as `0x${string}`,
    }

    const signature = await ctx.walletClient.signTypedData({
      account,
      domain: { name: 'USD Coin', version: '2', chainId: 42220, verifyingContract: req.asset as Address },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message,
    })

    const payload = {
      x402Version: 1,
      scheme: req.scheme ?? 'exact',
      network: req.network ?? 'celo',
      payload: { signature, authorization: { ...message, value: value.toString(),
        validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString() } },
    }
    return Buffer.from(JSON.stringify(payload)).toString('base64')
  } catch (err) {
    ctx.log(`x402: signing failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
