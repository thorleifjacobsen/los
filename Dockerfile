# los: web UI + task worker in one container. Claude Code CLI is baked in and uses the host's login
# (mounted at /home/node/.claude), so the claude-code brain needs no API key.
FROM node:24-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils ca-certificates git ripgrep curl tini \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex opencode-ai \
    && npm cache clean --force

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY web ./web
COPY test ./test
COPY config.example ./config.example
RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node
ENV NODE_ENV=production \
    PORT=7001 \
    LOS_ROOT=/app \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    DISABLE_AUTOUPDATER=1
EXPOSE 7001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/cli/serve.ts"]
