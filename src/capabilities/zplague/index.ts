/**
 * capabilities/zplague — play Zombie Plague.
 *
 * The first capability, and deliberately not privileged: it reaches the game
 * through the same public surface any third-party agent would use — the
 * contract for actions, the public REST API for discovery, and nothing else.
 * If this needed a private endpoint or a shared secret, the "agents can compete
 * here" claim would be false.
 *
 * Voting is reasoned when a model is available and heuristic when it is not.
 * The fallback is not a degraded mode to apologise for: it is what keeps the
 * agent playing when inference is unavailable.
 */
import { parseAbi, type Address } from 'viem'
import type { Capability, AgentContext, CapabilityOutcome } from '../../core/types.js'
import { txOpts } from '../../core/config.js'

const ABI = parseAbi([
  'function joinRoom(uint256 roomId) external',
  'function castVote(uint256 roomId, address target) external',
  'function getRoom(uint256 roomId) external view returns ((uint256 id, address host, uint8 status, (uint32 minPlayers, uint32 maxPlayers, uint256 stakeAmount, uint32 maxRounds, uint64 roundDurationSecs, uint64 discussionDurationSecs, uint64 votingDurationSecs, uint64 expirySecs, uint256 proofFee) config, address[] players, uint32 currentRound, uint8 currentPhase, uint256 pot, uint64 createdAt, uint64 expiresAt, uint64 startedAt, uint64 phaseStartedAt))',
])

const PHASE_VOTING = 2
const STATUS_ACTIVE = 2

export interface ZplagueOptions {
  /** PlagueGame address. Mainnet: 0xe157fD2564246Afa41cfAFaDA01a9A6f3e082710 */
  contract: Address
  /** Public API used only for room discovery. */
  apiBase: string
  /** Highest stake this agent will sit down for, in wei. */
  maxStakeWei: bigint
}

interface Seat { roomId: bigint; votedRound: number }

export function zplagueCapability(opts: ZplagueOptions): Capability {
  let seat: Seat | null = null

  return {
    name: 'zplague',
    description: 'Plays Zombie Plague, a staked on-chain social deduction game.',

    async isAvailable(): Promise<boolean> {
      return Boolean(opts.contract && opts.apiBase)
    },

    async tick(ctx: AgentContext): Promise<CapabilityOutcome> {
      if (!seat) return findAndJoin(ctx, opts, s => { seat = s })
      return playSeat(ctx, opts, seat, () => { seat = null })
    },
  }
}

async function findAndJoin(
  ctx: AgentContext, opts: ZplagueOptions, take: (s: Seat) => void,
): Promise<CapabilityOutcome> {
  const res = await fetch(`${opts.apiBase}/api/rooms`).catch(() => null)
  if (!res?.ok) return { kind: 'failed', detail: 'room discovery unavailable' }

  const body = (await res.json()) as { rooms?: { roomId: string; stakeAmount?: string }[] }
  const candidates = (body.rooms ?? []).filter(r => {
    const stake = BigInt(r.stakeAmount ?? '0')
    return stake > 0n && stake <= opts.maxStakeWei
  })
  if (candidates.length === 0) return { kind: 'idle' }

  const target = candidates[0]
  const roomId = BigInt(target.roomId)
  const { request } = await ctx.publicClient.simulateContract({
    address: opts.contract, abi: ABI, functionName: 'joinRoom',
    args: [roomId], account: ctx.walletClient.account!, ...txOpts,
  })
  await ctx.walletClient.writeContract({ ...request, dataSuffix: ctx.dataSuffix } as never)
  take({ roomId, votedRound: 0 })
  return { kind: 'acted', detail: `joined room ${roomId}` }
}

async function playSeat(
  ctx: AgentContext, opts: ZplagueOptions, seat: Seat, leave: () => void,
): Promise<CapabilityOutcome> {
  const room = await ctx.publicClient.readContract({
    address: opts.contract, abi: ABI, functionName: 'getRoom', args: [seat.roomId],
  })

  if (Number(room.status) !== STATUS_ACTIVE) {
    if (Number(room.status) === 3) { leave(); return { kind: 'acted', detail: `room ${seat.roomId} ended` } }
    return { kind: 'idle' }
  }
  if (Number(room.currentPhase) !== PHASE_VOTING) return { kind: 'idle' }

  const round = Number(room.currentRound)
  if (seat.votedRound >= round) return { kind: 'idle' }
  seat.votedRound = round // claim before awaiting, so a slow decision cannot double-vote

  const self = ctx.identity.address.toLowerCase()
  const others = room.players.filter(p => p.toLowerCase() !== self)
  if (others.length === 0) return { kind: 'idle' }

  const target = await chooseTarget(ctx, others, round)
  const { request } = await ctx.publicClient.simulateContract({
    address: opts.contract, abi: ABI, functionName: 'castVote',
    args: [seat.roomId, target], account: ctx.walletClient.account!, ...txOpts,
  })
  await ctx.walletClient.writeContract({ ...request, dataSuffix: ctx.dataSuffix } as never)
  return { kind: 'acted', detail: `voted ${target} in round ${round}` }
}

/** Reasoned when a model answers; random otherwise. Never blocks on the model. */
async function chooseTarget(
  ctx: AgentContext, candidates: readonly Address[], round: number,
): Promise<Address> {
  const fallback = candidates[Math.floor(Math.random() * candidates.length)]

  const answer = await ctx.reason({
    system: 'You are a player in a staked social deduction game. Reply with ONLY the number of the player you vote to eliminate.',
    user: `Round ${round}. Candidates:\n${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    timeoutMs: 8_000,
  })
  if (!answer) return fallback

  const n = Number(/\d+/.exec(answer)?.[0])
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return fallback
  return candidates[n - 1]
}
