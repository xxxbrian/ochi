FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /server ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /server /usr/local/bin/server
EXPOSE 8080
ENTRYPOINT ["server"]
