# Livy — persistent streaming runtime (Deplexo / self-hosted).
# Multi-stage build: Bun builder → slim runtime. Native Rust addon is built
# in the builder stage when a Rust toolchain is available; the runtime falls
# back to TypeScript audio handling when the addon is absent.
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN bun run build:ts

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 2333
CMD ["bun", "run", "dist/index.js"]
