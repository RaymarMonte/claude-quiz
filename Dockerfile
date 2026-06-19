# claude-quiz MCP server — runs via tsx (no build step), so tsx must be present
# at runtime; install dev deps too. The image stays tiny (5 small deps).
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. Use the npm lockfile (project is npm-centric).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# App source.
COPY . .

ENV NODE_ENV=production
# Fly's proxy connects to this port; the app reads PORT (default 8787).
ENV PORT=8787
EXPOSE 8787

# Run Node directly (not via `npm start`) so it's PID 1: receives Fly's SIGTERM for
# graceful stop and streams logs unbuffered. Uses the same tsx loader as `npm test`.
CMD ["node", "--import", "tsx", "src/server.ts"]
