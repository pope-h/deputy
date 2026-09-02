/**
 * guards.ts — the money discipline that makes an agent safe to leave running.
 *
 * An autonomous wallet with no limits is a liability, not a feature. Two
 * independent brakes, because they fail differently:
 *
 *   - a GAS FLOOR, so an agent stops before it strands a half-finished action
 *     it cannot pay to complete;
 *   - a LOSS BUDGET, so a losing streak stops the agent rather than draining
 *     the wallet while nobody is watching.
 *
 * Both are advisory to capabilities: the runtime checks them before each tick
 * and skips the capability rather than killing the process, so a topped-up
 * wallet resumes on its own.
 */
import { parseAbi, type Address } from 'viem'
import type { AgentPublicClient } from '../core/config.js'

export interface Budget {
  /** Balance when the agent started, in the asset being risked. */
  opening: bigint
  /** Maximum drawdown from `opening` before work stops. */
  limitWei: bigint
  /** When the window opened; drawdown is measured per rolling window. */
  since: number
}

export const DAY_MS = 24 * 60 * 60 * 1000

export function newBudget(opening: bigint, limitWei: bigint): Budget {
  return { opening, limitWei, since: Date.now() }
}

/** True when the agent has lost more than the budget allows this window. */
export function budgetExceeded(b: Budget, current: bigint): boolean {
  if (b.limitWei === 0n) return false
  const drawdown = b.opening > current ? b.opening - current : 0n
  return drawdown >= b.limitWei
}

/** Re-marks the opening balance; call after a top-up or when the window rolls. */
export function rollBudget(b: Budget, current: bigint): Budget {
  return { opening: current, limitWei: b.limitWei, since: Date.now() }
}

const BALANCE_OF = parseAbi([
  'function balanceOf(address account) external view returns (uint256)',
])

/**
 * True when there is enough of whatever this agent actually pays gas with.
 *
 * With CIP-64 fee abstraction the agent pays in a stablecoin, and its native
 * balance is then irrelevant — checking it anyway would strand a perfectly
 * funded agent below a CELO floor it never needs to cross. So the floor
 * follows the fee currency when one is configured.
 */
export async function hasGas(
  client: AgentPublicClient, address: Address, floorWei: bigint, feeCurrency?: Address,
): Promise<boolean> {
  try {
    const balance = feeCurrency
      ? await client.readContract({
          address: feeCurrency, abi: BALANCE_OF, functionName: 'balanceOf', args: [address],
        })
      : await client.getBalance({ address })
    return balance >= floorWei
  } catch {
    // An RPC that cannot answer is not proof of funds. Refuse rather than
    // start an action the agent may not be able to pay to finish.
    return false
  }
}
