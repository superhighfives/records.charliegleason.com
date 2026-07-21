# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT (set via `image_build_context: "."` in wrangler.jsonc), so
# the bundle step can reach the shared pure image modules in `src/lib`. sharp is a native
# module installed only in the runtime stage; the build stage just bundles with esbuild.

# --- build: bundle server.ts + the repo's shared pure lib into one JS file ---
FROM node:22-slim AS build
WORKDIR /app
COPY matte-container/package.json matte-container/build.mjs ./matte-container/
COPY matte-container/src ./matte-container/src
COPY src ./src
RUN cd matte-container \
	&& npm install --no-save esbuild@0.24.2 \
	&& node build.mjs

# --- runtime: node + sharp + the bundle ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY matte-container/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/matte-container/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server.js"]
