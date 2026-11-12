# Livy — self-hosted / Deplexo container image
# Multi-stage: build TypeScript + Rust native addon, then run slim.

FROM node:22-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential python3 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY native ./native
RUN npm --prefix native install && npm --prefix native run build || echo "native build skipped — JS fallback active"

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/native/*.node ./native/ 2>/dev/null || true
COPY --from=build /app/native/index.js ./native/ 2>/dev/null || true
COPY --from=build /app/native/index.d.ts ./native/ 2>/dev/null || true
EXPOSE 3000
CMD ["node", "dist/index.js"]
