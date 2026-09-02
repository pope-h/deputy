/**
 * capabilities/zplague — play Zombie Plague, end to end.
 *
 * The first capability, and deliberately not privileged: it reaches the game
 * through the same public surface any third-party agent would use — the
 * contract for actions, the public REST API for discovery and proving, and
 * nothing else. No shared secret, no allowlist, no private endpoint. If it
 * needed one, the claim that outside agents can compete here would be false.
 *
 * A full game is seven steps and this drives six of them: create or join, ask
 * the house for opponents, start, commit a role, vote each round, and nudge a
 * stalled round along. The seventh — `beginActivePhase` — is `onlyBackend` and
 * belongs to the game host. No player calls it, so not calling it is not a
 * limitation.
 *
 * Voting is reasoned when a model is available and heuristic when it is not.
 * The fallback is not a degraded mode to apologise for: it is what keeps a
 * staked seat being played when inference is unavailable.
 */
import type { Address, Hex } from 'viem'
import type { Capability, AgentContext, CapabilityOutcome } from '../../core/types.js'
import { txOpts } from '../../core/config.js'
import { newBudget, budgetExceeded, rollBudget, DAY_MS, type Budget } from '../../wallet/guards.js'
import { GAME_ABI, ERC20_ABI, STATUS, PHASE, PLAYER } from './abi.js'
import { loadRoleProof } from './zk.js'

export interface ZplagueOptions {
  /** PlagueGame address. Mainnet: 0xe157fD2564246Afa41cfAFaDA01a9A6f3e082710 */
  contract: Address
  /** Stake token. Mainnet USDm: 0x765DE816845861e75A25fCA122bb6898B8B1282a */
  stakeToken: Address
  /** Public API, used for room discovery, opponents, and proving. */
  apiBase: string
  /** Highest stake this agent will sit down for, in wei. */
  maxStakeWei: bigint
  /** Open a room when none is available, rather than waiting to be invited. */
  hostWhenEmpty: boolean
  /** Stake to set when hosting. Must be <= maxStakeWei. */
  hostStakeWei: bigint
  /** Seats to open when hosting. Contract allows 4..20; the game needs 3 to start. */
  hostMaxPlayers: number
  /** Games this agent will sit down for per rolling 24h. */
  maxGamesPerDay: number
  /** Total stake this agent may lose per rolling 24h before it stops. 0 = no cap. */
  dailyLossCapWei: bigint
  /** Where the cached role commitment lives. */
  proofCachePath: string
  /**
   * How long to let the model think before voting randomly instead.
   *
   * The runtime's 8s default is far too tight here: a reasoning model with
   * adaptive thinking regularly runs past it, and a timeout still bills for
   * the tokens while producing a random vote — the worst of both. The voting
   * phase is 120s, so there is room to actually wait for the answer.
   */
  voteTimeoutMs: number
}

interface Seat {
  roomId: bigint
  isHost: boolean
  committed: boolean
  votedRound: number
  opponentsRequested: boolean
}

/** Grace after the voting window closes before nudging resolveRound. */
const RESOLVE_GRACE_MS = 20_000

/** How long a hosted room stays open for players. Contract minimum is 60s. */
const HOST_ROOM_EXPIRY_SECS = 3600n

export function zplagueCapability(opts: ZplagueOptions): Capability {
  let seat: Seat | null = null
  let budget: Budget | null = null
  /** Timestamps of games sat down for, trimmed to a rolling 24h. */
  let recentGames: number[] = []

  return {
    name: 'zplague',
    description: 'Plays Zombie Plague, a staked on-chain social deduction game.',

    async isAvailable(): Promise<boolean> {
      return Boolean(opts.contract && opts.stakeToken && opts.apiBase)
    },

    async tick(ctx: AgentContext): Promise<CapabilityOutcome> {
      const stake = await ctx.publicClient.readContract({
        address: opts.stakeToken, abi: ERC20_ABI, functionName: 'balanceOf',
        args: [ctx.identity.address],
      })

      budget ??= newBudget(stake, opts.dailyLossCapWei)
      if (Date.now() - budget.since > DAY_MS) budget = rollBudget(budget, stake)

      // Mid-game the seat is already paid for, so a tripped budget must not
      // strand it: finish the game, then stop sitting down for new ones.
      if (!seat) {
        if (budgetExceeded(budget, stake)) {
          return { kind: 'idle' }
        }
        recentGames = recentGames.filter(t => Date.now() - t < DAY_MS)
        if (recentGames.length >= opts.maxGamesPerDay) return { kind: 'idle' }

        return findSeat(ctx, opts, stake, s => { seat = s; recentGames.push(Date.now()) })
      }

      return playSeat(ctx, opts, seat, () => { seat = null })
    },
  }
}

// ── Getting a seat ────────────────────────────────────────────────────────────

async function findSeat(
  ctx: AgentContext, opts: ZplagueOptions, balance: bigint, take: (s: Seat) => void,
): Promise<CapabilityOutcome> {
  const res = await fetch(`${opts.apiBase}/api/rooms`).catch(() => null)
  if (!res?.ok) return { kind: 'failed', detail: 'room discovery unavailable' }

  const body = await res.json() as {
    rooms?: { roomId: string; stakeAmount?: string; contractAddress?: string }[]
  }
  const want = opts.contract.toLowerCase()
  const open = (body.rooms ?? []).filter(r => {
    // The lobby can carry rooms from another deployment (a testnet contract, or
    // a previous address). Joining one burns gas on a revert, so match the
    // contract explicitly rather than trusting the list.
    if ((r.contractAddress ?? '').toLowerCase() !== want) return false
    const s = BigInt(r.stakeAmount ?? '0')
    return s > 0n && s <= opts.maxStakeWei && s <= balance
  })

  if (open.length > 0) {
    const roomId = BigInt(open[0].roomId)
    const stake = BigInt(open[0].stakeAmount ?? '0')
    await ensureAllowance(ctx, opts, stake)
    await send(ctx, opts.contract, GAME_ABI, 'joinRoom', [roomId])
    take({ roomId, isHost: false, committed: false, votedRound: 0, opponentsRequested: false })
    return { kind: 'acted', detail: `joined room ${roomId}` }
  }

  if (!opts.hostWhenEmpty) return { kind: 'idle' }
  if (opts.hostStakeWei > balance) {
    return { kind: 'idle' } // cannot afford to host; wait for a top-up
  }

  // createRoom auto-joins and stakes the host, so the allowance must cover it.
  await ensureAllowance(ctx, opts, opts.hostStakeWei)

  // One simulation, used twice: it returns the roomId the call WILL mint and
  // the prepared request. Simulating separately would risk the two disagreeing
  // if another room were created in between.
  const { result: roomId, request } = await ctx.publicClient.simulateContract({
    address: opts.contract, abi: GAME_ABI, functionName: 'createRoom',
    args: [opts.hostMaxPlayers, opts.hostStakeWei, 0n, HOST_ROOM_EXPIRY_SECS],
    account: ctx.walletClient.account!, ...txOpts,
  })
  const hash = await ctx.walletClient.writeContract({
    ...request, dataSuffix: ctx.dataSuffix,
  } as never)
  await ctx.publicClient.waitForTransactionReceipt({ hash })

  take({ roomId, isHost: true, committed: false, votedRound: 0, opponentsRequested: false })
  return { kind: 'acted', detail: `opened room ${roomId} at ${opts.hostStakeWei} wei` }
}

// ── Playing it ────────────────────────────────────────────────────────────────

async function playSeat(
  ctx: AgentContext, opts: ZplagueOptions, seat: Seat, leave: () => void,
): Promise<CapabilityOutcome> {
  const room = await ctx.publicClient.readContract({
    address: opts.contract, abi: GAME_ABI, functionName: 'getRoom', args: [seat.roomId],
  })
  const status = Number(room.status)

  if (status === STATUS.Ended) {
    leave()
    return { kind: 'acted', detail: `room ${seat.roomId} ended` }
  }

  if (status === STATUS.Waiting) return waiting(ctx, opts, seat, room, leave)
  if (status === STATUS.Starting) return starting(ctx, opts, seat, room)
  if (status === STATUS.Active) return active(ctx, opts, seat, room)
  return { kind: 'idle' }
}

type Room = Awaited<ReturnType<typeof readRoom>>
async function readRoom(ctx: AgentContext, contract: Address, roomId: bigint) {
  return ctx.publicClient.readContract({
    address: contract, abi: GAME_ABI, functionName: 'getRoom', args: [roomId],
  })
}

/** Waiting: fill the table, then start. Only the host can do either. */
async function waiting(
  ctx: AgentContext, opts: ZplagueOptions, seat: Seat, room: Room, leave: () => void,
): Promise<CapabilityOutcome> {
  const players = room.players.length
  const needed = Number(room.config.minPlayers)

  if (Date.now() / 1000 >= Number(room.expiresAt)) {
    // Nobody came. expireRoom is permissionless and refunds every stake,
    // including ours — leaving it unclaimed just strands the money.
    await send(ctx, opts.contract, GAME_ABI, 'expireRoom', [seat.roomId])
    leave()
    return { kind: 'acted', detail: `room ${seat.roomId} expired with ${players} player(s); stakes refunded` }
  }

  if (!seat.isHost) return { kind: 'idle' } // the host starts it, not us

  if (players < needed && !seat.opponentsRequested) {
    // Ask the house pool for opponents through the same public, unauthenticated
    // endpoint the lobby's own button calls. Failing here is not fatal: humans
    // can still join, and the room stands until it expires.
    const want = Number(room.config.maxPlayers) - players
    const res = await fetch(`${opts.apiBase}/api/bots/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: seat.roomId.toString(), count: want }),
    }).catch(() => null)

    seat.opponentsRequested = true
    const queued = res?.ok ? ((await res.json()) as { queued?: number }).queued ?? 0 : 0
    return { kind: 'acted', detail: queued > 0
      ? `requested ${queued} opponent(s) for room ${seat.roomId}`
      : `no opponents available for room ${seat.roomId}; waiting for players` }
  }

  if (players >= needed) {
    await send(ctx, opts.contract, GAME_ABI, 'startGame', [seat.roomId])
    return { kind: 'acted', detail: `started room ${seat.roomId} with ${players} players` }
  }

  return { kind: 'idle' }
}

/** Starting: commit a role, then wait for the game host to open round 1. */
async function starting(
  ctx: AgentContext, opts: ZplagueOptions, seat: Seat, _room: Room,
): Promise<CapabilityOutcome> {
  if (seat.committed) return { kind: 'idle' }

  // Trust the chain over local state: a commitment that landed but whose
  // receipt we missed must not be submitted twice.
  const me = await ctx.publicClient.readContract({
    address: opts.contract, abi: GAME_ABI, functionName: 'getPlayer',
    args: [seat.roomId, ctx.identity.address],
  })
  if (me.roleCommitted) {
    seat.committed = true
    return { kind: 'idle' }
  }

  const { commitment, proofHex } = await loadRoleProof(opts.proofCachePath, opts.apiBase)
  await send(ctx, opts.contract, GAME_ABI, 'submitRoleCommitment',
    [seat.roomId, commitment, proofHex])
  seat.committed = true
  return { kind: 'acted', detail: `committed role in room ${seat.roomId}` }
}

/** Active: vote once per round, and unstick a round whose window has closed. */
async function active(
  ctx: AgentContext, opts: ZplagueOptions, seat: Seat, room: Room,
): Promise<CapabilityOutcome> {
  if (Number(room.currentPhase) !== PHASE.Voting) return { kind: 'idle' }

  const round = Number(room.currentRound)
  const states = await Promise.all(room.players.map(p =>
    ctx.publicClient.readContract({
      address: opts.contract, abi: GAME_ABI, functionName: 'getPlayer', args: [seat.roomId, p],
    })))

  const self = ctx.identity.address.toLowerCase()
  const me = states.find(s => s.addr.toLowerCase() === self)

  if (me && Number(me.status) !== PLAYER.Eliminated && seat.votedRound < round && !me.hasVotedThisRound) {
    seat.votedRound = round // claim before awaiting, so a slow decision cannot double-vote
    const alive = states.filter(s =>
      Number(s.status) !== PLAYER.Eliminated && s.addr.toLowerCase() !== self)
    if (alive.length === 0) return { kind: 'idle' }

    const { target, source } = await chooseTarget(ctx, alive, round, opts.voteTimeoutMs)
    await send(ctx, opts.contract, GAME_ABI, 'castVote', [seat.roomId, target])
    // Record HOW the vote was decided. A reasoned vote and a fallback vote are
    // indistinguishable on-chain, so without this the claim "the agent reasons"
    // cannot be checked — by a judge, or by us.
    return { kind: 'acted', detail: `voted ${target} in round ${round} [${source}]` }
  }

  // Liveness only. resolveRound has NO time gate on-chain, so calling it early
  // would cut the round short for everyone still deciding — gate on the voting
  // window having actually closed.
  const closesAt = (Number(room.phaseStartedAt) + Number(room.config.votingDurationSecs)) * 1000
  if (Date.now() > closesAt + RESOLVE_GRACE_MS) {
    await send(ctx, opts.contract, GAME_ABI, 'resolveRound', [seat.roomId])
    return { kind: 'acted', detail: `resolved round ${round} in room ${seat.roomId}` }
  }

  return { kind: 'idle' }
}

// ── Deciding ──────────────────────────────────────────────────────────────────

interface PlayerView { addr: Address; status: number; voteTarget: Address; hasVotedThisRound: boolean }

/** How a vote was decided — reported so the claim can be audited. */
type VoteSource = 'reasoned' | 'fallback:no-model' | 'fallback:unparsable'

/**
 * Reasoned when a model answers, random otherwise. Never blocks on the model.
 *
 * The prompt carries only what any player can see on-chain: who is alive and
 * who they voted for. Votes are public in `PlayerState.voteTarget`, so this is
 * shared information, not an edge bought with an API key.
 */
async function chooseTarget(
  ctx: AgentContext, alive: readonly PlayerView[], round: number, timeoutMs: number,
): Promise<{ target: Address; source: VoteSource }> {
  const fallback = alive[Math.floor(Math.random() * alive.length)].addr

  const board = alive.map((p, i) => {
    const voted = p.hasVotedThisRound && p.voteTarget !== '0x0000000000000000000000000000000000000000'
      ? ` — voted for ${short(p.voteTarget)}`
      : ' — has not voted yet'
    return `${i + 1}. ${short(p.addr)}${voted}`
  }).join('\n')

  const answer = await ctx.reason({
    system: 'You are a player in a staked on-chain social deduction game. Infected players win by surviving; clean players win by voting them out. Reply with ONLY the number of the player you vote to eliminate.',
    user: `Round ${round}. You are ${short(ctx.identity.address)}. Living players and their public votes this round:\n${board}`,
    timeoutMs,
  })
  if (!answer) return { target: fallback, source: 'fallback:no-model' }

  const n = Number(/\d+/.exec(answer)?.[0])
  if (!Number.isInteger(n) || n < 1 || n > alive.length) {
    return { target: fallback, source: 'fallback:unparsable' }
  }
  return { target: alive[n - 1].addr, source: 'reasoned' }
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ── Chain helpers ─────────────────────────────────────────────────────────────

/**
 * Approve the game to move our stake, if it cannot already.
 *
 * Approves ten games' worth rather than an unlimited allowance: an autonomous
 * wallet running unattended should not leave a blanket claim on its balance
 * standing, and re-approving every game would cost a transaction each time.
 */
async function ensureAllowance(
  ctx: AgentContext, opts: ZplagueOptions, amount: bigint,
): Promise<void> {
  const current = await ctx.publicClient.readContract({
    address: opts.stakeToken, abi: ERC20_ABI, functionName: 'allowance',
    args: [ctx.identity.address, opts.contract],
  })
  if (current >= amount) return
  await send(ctx, opts.stakeToken, ERC20_ABI, 'approve', [opts.contract, amount * 10n])
}

/** Simulate, then send with attribution. Simulation surfaces a revert before it costs gas. */
async function send(
  ctx: AgentContext, address: Address, abi: readonly unknown[], functionName: string, args: unknown[],
): Promise<Hex> {
  const { request } = await ctx.publicClient.simulateContract({
    address, abi, functionName, args,
    account: ctx.walletClient.account!, ...txOpts,
  } as never)
  const hash = await ctx.walletClient.writeContract({
    ...(request as object), dataSuffix: ctx.dataSuffix,
  } as never)
  await ctx.publicClient.waitForTransactionReceipt({ hash })
  return hash
}
