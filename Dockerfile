# Cloud Run deploy image for irg_ftr Node/Prisma backend
FROM node:18-alpine

WORKDIR /app

# Install monorepo deps at the root
COPY package.json ./
COPY backend/package.json ./backend/
COPY shared/package.json  ./shared/

# Workspace install — allow backend + shared
RUN npm install --production=false --workspaces --include-workspace-root || npm install --production=false

COPY backend  ./backend
COPY shared   ./shared

# Prisma generate
RUN cd backend && npx prisma generate

# Build
RUN npm run build:shared  && npm run build:backend

EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
