# Deputy

**An autonomous on-chain agent with its own identity, its own wallet, and pluggable capabilities.**

A Deputy is not a bot inside an application. It is an independent actor: it holds an
ERC-8004 identity on Celo, controls its own wallet, decides using a language model, pays
its own transaction fees, and enforces its own spending limits. What it can *do* is
plug-in — playing a staked game and buying an API call per request are the same shape to
the runtime.

Built on Celo. Runs unattended.

---

## Why this exists

Most "on-chain agents" are a loop inside a product. Take the product away and there is no
agent — no identity anyone can verify, no wallet it controls, no way to give it a second
job.

Deputy inverts that. The agent is the artifact. Applications are capabilities it acquires.

```
Deputy
├── identity     ERC-8004 registration — a verifiable, permanent id
├── wallet       its own keys, gas floor, and loss budget
├── chain        RPC failover, fee abstraction, attribution
├── reason       language-model decisions, with a breaker
└── capabilities ← the only thing that changes
    ├── zplague  plays a staked social-deduction game
    └── x402     buys a paid HTTP resource in stablecoins
```

The core is ~500 lines and knows nothing about either capability.

---

## What it does today

**Plays Zombie Plague — a whole game, unattended.** It finds an open room and joins it,
or opens one itself and asks the house for opponents through the same public endpoint the
game's own lobby button calls. Then it starts the game, commits its role behind a ZK
commitment, votes each round, and nudges a round along when the voting window has closed
and nobody else has. When a room fills too slowly it expires it and takes the refund.

Voting reasons over the public board — who is alive, who voted for whom — when a model is
available, and falls back to local logic when it is not.

Every one of those is a public call. The contract for actions, the public REST API for
discovery, opponents and proving; no private endpoint, no shared secret, no allowlist.
The one step it never takes is `beginActivePhase`, which is `onlyBackend` and belongs to
the game host — no player calls it. That is what makes "other agents can compete here" a
real claim rather than a courtesy extended to us.

Money has two brakes on it: a cap on stake size and games per day, and a rolling 24h loss
budget that stops it sitting down for new games. A game already paid for always finishes.

**Earns by reviewing other builders' work.** On AskBots it picks up a review
assignment, fetches and probes the actual property — status, latency, headings,
links, missing security headers, and for a repo its languages, licence and
README — then answers the builder's questions from that evidence and gets paid
$0.10 USDT on Celo per accepted review. The anti-bot challenge is arithmetic
inside a 2-second window, evaluated locally in BigInt (a model round-trip would
blow the window, and `eval` would round the products to a wrong answer).

The rule the whole capability rests on: **review only what you actually saw.**
Reviews are graded on whether the text describes *this* property or could be
pasted onto any other, so a model asked about a URL it never fetched writes
fluent, generic, worthless prose. When there is no evidence and no model, the
capability does nothing — an agent with nothing to say should say nothing
rather than fill the box.

**Pays for what it uses.** Over x402, it buys a protected HTTP resource per request and
settles in stablecoins, signing an EIP-3009 authorization the facilitator settles. An
agent that funds its own inference is not one a human keeps topping up.

These two share nothing but the agent context — no common helper, no shared state. Adding
a third capability is one file and one line in `run.ts`.

---

## Design decisions worth knowing

**Every failure degrades, none are fatal.** Reasoning returns `null` rather than throwing,
so every caller must hold a non-LLM answer. A capability that fails is backed off
exponentially, never the agent. An agent that stops when its inference budget runs out is
a demo.

**Two independent money brakes.** A *gas floor* stops the agent before it strands a
half-finished action it cannot pay to complete. A *loss budget* stops it when a losing
streak drains the wallet while nobody is watching. Both are advisory — a topped-up wallet
resumes on its own.

**Identity that cannot drift.** Metadata is registered as a `data:` URI, not `https:`. An
https document can be quietly rewritten after registration, so what a verifier checks
would no longer be what was registered.

**Fee abstraction, optional but native.** Set `FEE_CURRENCY_ADDRESS` and the agent pays
gas in the same stablecoin it earns, so its wallet never needs a second asset a human has
to top up.

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in AGENT_PRIVATE_KEY
npm run register          # claim an ERC-8004 identity (once per wallet)
npm run run
```

Configure capabilities by setting their env vars; unset means the capability is not
loaded. See `.env.example`.

### Running more than one

A Deputy process is exactly one wallet and one identity, and that is deliberate:
an ERC-8004 identity is bound to an address, so an agent sharing a wallet with
seven others is a pool, not an agent. Anyone pointing at it later could not tell
which of them did the thing.

Running several is just running the process several times, one env file each:

```bash
AGENT_NAME=deputy-1 AGENT_PRIVATE_KEY=0x… AGENT_ID=9232 npm run run
AGENT_NAME=deputy-2 AGENT_PRIVATE_KEY=0x… AGENT_ID=9240 npm run run
```

They share nothing — no coordinator, no queue, no common state — so they can sit
at the same table without any of them knowing the others are Deputies. They
compete. Nothing in the runtime treats a fellow Deputy as an ally, and the
zplague capability cannot: it reads the player list from the contract, which
carries addresses and no affiliation.

Each instance needs its own gas and its own stake. `AGENT_ID` is optional and
only labels the logs — identity is proven by the wallet, not the variable.

## Status

Early. The core, both capabilities, and ERC-8004 registration are implemented and
typecheck clean. Nothing here has been run against mainnet yet.

## License

MIT
