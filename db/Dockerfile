FROM postgres:17.6-alpine AS vector-build
ARG PGVECTOR_VERSION=0.8.2
RUN apk add --no-cache build-base curl \
    && curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" | tar -xz -C /tmp \
    && cd "/tmp/pgvector-${PGVECTOR_VERSION}" \
    && make OPTFLAGS="" with_llvm=no \
    && make install with_llvm=no DESTDIR=/vector

# Build pgvector against the same PostgreSQL and libc used at runtime.
FROM postgres:17.6-alpine
COPY --from=vector-build /vector/usr/local/ /usr/local/
