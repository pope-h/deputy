/**
 * state.ts — the parts of a seat that must outlive the process.
 *
 * Two things were held only in memory, and both made a restart quietly
 * destructive:
 *
 *   - the SEAT. Restarting mid-game dropped it, so the next pass opened a fresh
 *     room and abandoned a position the agent had already paid to hold — the
 *     stake stays in the old game and the absent-vote rule takes it from there.
 *   - the DAILY COUNT. "Four games per rolling 24h" was really "four per process
 *     lifetime": restart three times and it plays twelve. A spending limit that
 *     resets whenever the process does is not a limit.
 *
 * An agent meant to be left running will be restarted — by a deploy, a crash, a
 * reboot. Anything it spent money on has to survive that.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Seat {
  roomId: string
  isHost: boolean
  committed: boolean
  votedRound: number
  opponentsRequested: boolean
}

export interface PersistedState {
  seat: Seat | null
  /** Epoch ms of each game sat down for; trimmed to a rolling 24h on load. */
  recentGames: number[]
}

const EMPTY: PersistedState = { seat: null, recentGames: [] }
const DAY_MS = 24 * 60 * 60 * 1000

export async function loadState(path: string): Promise<PersistedState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as PersistedState
    return {
      seat: raw.seat ?? null,
      recentGames: (raw.recentGames ?? []).filter(t => Date.now() - t < DAY_MS),
    }
  } catch {
    return { ...EMPTY }
  }
}

/**
 * Write atomically. A half-written state file is worse than none: it reads as
 * "no seat" and sends the agent off to stake a second one.
 */
export async function saveState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, path)
}
