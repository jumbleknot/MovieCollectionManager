# Stage 1: Build
FROM rust:alpine3.21@sha256:be16a9d9cccef227ee15132389e0744e354dbedca527b0a048a1671853e3f354 AS build

# Install build dependencies (perl + make needed to compile vendored OpenSSL from source)
RUN apk add --no-cache musl-dev perl make

WORKDIR /app

# Cache dependencies — copy manifests first
COPY Cargo.toml Cargo.lock ./
COPY backend/mc-service/Cargo.toml backend/mc-service/Cargo.toml

# Create a dummy main + lib so cargo can fetch and compile dependencies
RUN mkdir -p backend/mc-service/src && \
    echo 'fn main() {}' > backend/mc-service/src/main.rs && \
    echo '' > backend/mc-service/src/lib.rs && \
    cargo build --release --manifest-path backend/mc-service/Cargo.toml && \
    rm -rf backend/mc-service/src

# Copy real source and build
COPY backend/mc-service/src backend/mc-service/src
RUN touch backend/mc-service/src/main.rs backend/mc-service/src/lib.rs && \
    cargo build --release --manifest-path backend/mc-service/Cargo.toml

# Stage 2: Runtime
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime

# Install runtime dependencies (no openssl needed — binary is statically linked via vendored)
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# Copy binary from build stage
COPY --from=build /app/target/release/mc-service ./mc-service

# Run as non-root user
RUN addgroup -S mcservice && adduser -S mcservice -G mcservice
USER mcservice

EXPOSE 3001

CMD ["./mc-service"]
