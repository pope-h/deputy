# Deploying Deputy

Deputy runs as its own container stack, deliberately separate from the Zombie
Plague deployment. It reaches the game through the public API and the public
contract — the same surface any third-party agent uses — so it needs no private
path to that backend, and coupling the two would quietly make the "an outside
agent can play here" claim untrue of its own reference implementation.

On the Tencent Lighthouse VPS it lives at `/opt/deputy`, alongside `/opt/plague`.

## First deploy

```bash
# 1. Clone
sudo mkdir -p /opt/deputy && sudo chown $USER:$USER /opt/deputy
git clone https://github.com/pope-h/deputy.git /opt/deputy
cd /opt/deputy

# 2. Secrets — never committed, never echoed
cp .env.example .env
chmod 600 .env
nano .env      # set AGENT_PRIVATE_KEY, ANTHROPIC_API_KEY, ASKBOTS_API_KEY

# 3. Build and start
docker compose up -d --build
docker compose logs -f deputy
```

Expect, within a minute or so:

```
Reasoning: active
[Deputy] starting with 2 capability(ies): zplague, askbots
[Deputy] ERC-8004 agent #9811
```

## ⚠ Only one Deputy may run at a time

Deputy signs from a single wallet. Two processes on the same key race each
other's nonces and can both try to take a seat, so **stop the local one before
starting the container** — and cut over while it holds no seat, or the stake in
that room is abandoned to the absent-vote rule.

```bash
# on the laptop, check it is idle first: "seat": null
cat data/zplague-state.json
pkill -f "src/cli/run.ts"
```

## Required secrets

| Var | Notes |
|---|---|
| `AGENT_PRIVATE_KEY` | Hot wallet. Holds the CELO for gas and the USDm it stakes. |
| `ANTHROPIC_API_KEY` | Without it the agent still plays, using local fallbacks, but AskBots does nothing — a review with no model would be a fabrication. |
| `ASKBOTS_API_KEY` | Must be the env var. The container has no `~/.config/askbots`. |

## The data volume is not optional

`deputydata` holds the cached ZK role proof and the seat + daily game count.
Delete it and the agent re-proves (30–120s of the game's shared prover) and
forgets how many games it has already paid for today — the spend cap resets.

```bash
docker compose down          # keeps the volume
docker compose down -v       # DESTROYS it — re-proves and resets the cap
```

## Funding

One full game costs roughly **0.55 CELO**, dominated by the ZK role commitment
(~2.09M gas), plus the USDm stake. `MIN_GAS_WEI` stops the agent below 0.5 CELO
so it never strands a half-finished action it cannot pay to complete.

Check what it holds:

```bash
docker compose logs deputy | grep -E "gas floor|ERC-8004"
```

## Bandwidth

The VPS is capped at **512 GB/month outbound**. Deputy polls RPC every 5s and
AskBots every 10 minutes, which is modest, but it is a third tenant on a budget
that has been squeezed before. Watch it alongside the rest:

```bash
cd /opt/plague/deploy && python3 egress-watch.py
```

## Updating

```bash
cd /opt/deputy && git pull && docker compose up -d --build
```

The container restarts, reloads its seat from the volume, and resumes the game
it was in.
