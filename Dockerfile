# Stage 1: Build the statically linked Go binary
FROM golang:1.26.3-alpine AS builder

WORKDIR /src

# Install build dependencies
RUN apk add --no-cache git

# Copy dependency files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code files
COPY db.go db_sqlite.go main.go ollama.go ./

# Build statically linked binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o neurollama-bin main.go db.go db_sqlite.go ollama.go

# Stage 2: Runtime image
FROM alpine:latest

WORKDIR /app

# Install security and standard utilities
RUN apk add --no-cache ca-certificates tzdata

# Create data directory for volume persistence
RUN mkdir -p /app/data

# Copy binary and static assets
COPY --from=builder /src/neurollama-bin /app/neurollama-bin
COPY static/ /app/static/
COPY templates/ /app/templates/

# Expose server port
EXPOSE 8811

# Environment variables
ENV GIN_MODE=release

# Health check — polls /healthz; start-period gives the app time to init
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8811/healthz || exit 1

# Run binary
CMD ["/app/neurollama-bin"]
