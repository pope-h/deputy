/**
 * abi.ts — the public surface of PlagueGame this capability uses.
 *
 * Everything here is callable by anyone. There is deliberately no entry that
 * needs a privileged signer: `beginActivePhase` is `onlyBackend` and belongs to
 * the game host, not to a player, so an agent never calls it and never needs to.
 */
import { parseAbi } from 'viem'

export const GAME_ABI = parseAbi([
  // ── Writes a player makes for itself ──
  'function createRoom(uint32 maxPlayers, uint256 stakeAmount, uint256 proofFee, uint64 expirySecs) external returns (uint256 roomId)',
  'function joinRoom(uint256 roomId) external',
  'function startGame(uint256 roomId) external',
  'function submitRoleCommitment(uint256 roomId, bytes32 commitment, bytes zkProof) external',
  'function castVote(uint256 roomId, address target) external',
  // Permissionless liveness nudges — anyone may call these.
  'function resolveRound(uint256 roomId) external',
  'function expireRoom(uint256 roomId) external',

  // ── Reads ──
  'function getRoom(uint256 roomId) external view returns ((uint256 id, address host, uint8 status, (uint32 minPlayers, uint32 maxPlayers, uint256 stakeAmount, uint32 maxRounds, uint64 roundDurationSecs, uint64 discussionDurationSecs, uint64 votingDurationSecs, uint64 expirySecs, uint256 proofFee) config, address[] players, uint32 currentRound, uint8 currentPhase, uint256 pot, uint64 createdAt, uint64 expiresAt, uint64 startedAt, uint64 phaseStartedAt))',
  'function getPlayer(uint256 roomId, address player) external view returns ((address addr, uint8 status, bytes32 roleCommitment, uint256 staked, address voteTarget, uint64 joinedAt, bool freeProofUsed, uint32 proofsSubmittedTotal, bool pendingInfectionNextRound, bool hasProofThisRound, bool hasVotedThisRound, bool roleCommitted))',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
])

/** RoomStatus enum, PlagueGame.sol:63 */
export const STATUS = { Waiting: 0, Starting: 1, Active: 2, Ended: 3 } as const
/** RoundPhase enum, PlagueGame.sol:64 */
export const PHASE = { Infection: 0, Discussion: 1, Voting: 2, Reveal: 3, Ended: 4 } as const
/** PlayerStatus enum, PlagueGame.sol:65 */
export const PLAYER = { Clean: 0, Infected: 1, Eliminated: 2 } as const
