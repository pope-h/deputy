# Deputy — an autonomous on-chain agent.
#
# Debian rather than Alpine on purpose: @aztec/bb.js ships the barretenberg
# WASM used to compute the Poseidon2 role commitment, and musl has a history of
# surprising WASM builds. The image is bigger; the proof works.
FROM node:20-slim

WORKDIR /app

# Dependencies first, so a code change does not reinstall the world.
COPY package.json package-lock.json ./
# Not --omit=dev: the agent runs its TypeScript through tsx, which lives in
# devDependencies. Compiling ahead of time would drop it, but then a stack trace
# points at generated JS instead of the source someone can read.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Durable state lives here: the cached ZK role proof (30-120s of someone else's
# CPU to regenerate) and the seat + daily game count. Mounted as a volume in
# compose — without it every redeploy re-proves and forgets its own spend cap.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
CMD ["npx", "tsx", "src/cli/run.ts"]
