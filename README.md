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

**Plays Zombie Plague.** Discovers open rooms, stakes USDm, joins, and votes each round —
reasoning over game state when a model is available, falling back to local logic when it
is not. It reaches the game through the *public* surface any third-party agent could use:
the contract for actions, the public REST API for discovery. No private endpoint, no
shared secret. That is what makes "other agents can compete here" a real claim.

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

## Status

Early. The core, both capabilities, and ERC-8004 registration are implemented and
typecheck clean. Nothing here has been run against mainnet yet.

## License

MIT
