FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.27-alpine AS build
ARG REVISION=development
ARG BUILT_AT
ARG BUILD_TYPE=development
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/web/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -tags embed \
    -ldflags="-s -w -X ochi/server/internal/product.Revision=${REVISION} -X ochi/server/internal/product.BuiltAt=${BUILT_AT} -X ochi/server/internal/product.BuildType=${BUILD_TYPE}" \
    -o /out/ochi-server ./cmd/server

FROM scratch AS binary
COPY --from=build /out/ochi-server /ochi-server

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates
WORKDIR /app
# Keep the executable's directory writable for the administrator's self-update.
COPY --from=build --chmod=0755 /out/ochi-server ./ochi-server
EXPOSE 8080
ENTRYPOINT ["/app/ochi-server"]
