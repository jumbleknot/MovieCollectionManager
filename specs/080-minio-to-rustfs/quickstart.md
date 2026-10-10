# Quickstart: reproduce the 080 measurements and run the rehearsal

Run in the dev container from the worktree. Every scratch resource is prefixed `s080-` and removed at
the end. Never point any of this at a real volume name — `docker run -v <name>:` **creates** a missing
volume silently (feature 070, trap 1).

## Prerequisites

- Docker reachable (`docker version`).
- `REGISTRY_HOST` set (only to pull the currently deployed MinIO for seeding):
  `M=${REGISTRY_HOST}/jumbleknot/minio@sha256:8054a7ce1af3d5f57e508de5f17885ae7892234ac465d1d9cb8e8977358a06a2`
- `R=rustfs/rustfs:1.0.1` (or the T004 pin).

## 1. The image (research R4)

```sh
docker image inspect $R --format '{{json .Config}}'
docker run --rm --entrypoint sh $R -c 'id; which curl wget; ls -lnd /data /logs'
docker run --rm --entrypoint cat $R /entrypoint.sh     # read it: it never chowns an existing dir
```

Expect `uid=10001`, curl + wget, `/data` and `/logs` `10001:10001` mode 0750.

## 2. Seed a MinIO drive, copy it, start RustFS (research R5, R6)

```sh
docker network create s080; docker volume create s080-minio
docker run -d --name s080-minio --network s080 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=s080secretpw123 \
  -v s080-minio:/data $M server /data
# wait: docker exec s080-minio mc ready local
docker exec s080-minio sh -c 'mc alias set local http://localhost:9000 minio s080secretpw123 && mc mb local/langfuse &&
  echo small > /tmp/s && mc cp /tmp/s local/langfuse/events/a/s.txt &&
  head -c 90000000 /dev/urandom > /tmp/big && mc cp /tmp/big local/langfuse/media/big.bin && md5sum /tmp/s /tmp/big'
docker stop s080-minio
docker run --rm -v s080-minio:/data:ro --entrypoint cat $M /data/.minio.sys/format.json   # "xl-single"

docker volume create s080-rfs
docker run --rm --user 0:0 -v s080-minio:/src:ro -v s080-rfs:/dst --entrypoint sh $R \
  -c 'cp -a /src/. /dst/ && chown -R "$(id -u rustfs):$(id -g rustfs)" /dst && find /dst ! -user rustfs | wc -l'   # 0
docker run -d --name s080-rfs --network s080 -e RUSTFS_ACCESS_KEY=langfuse -e RUSTFS_SECRET_KEY=s080newsecret \
  -e RUSTFS_OBS_LOG_DIRECTORY= -v s080-rfs:/data $R
docker run --rm --network s080 --entrypoint sh $M -c \
  'mc alias set r http://s080-rfs:9000 langfuse s080newsecret && mc ls -r r/langfuse && mc cat r/langfuse/media/big.bin | md5sum'
```

Expect identical MD5s, `.rustfs.sys` beside `.minio.sys` in the copy, and the **original** volume
unchanged.

## 3. The uid trap (research R5)

```sh
docker volume create s080-fresh
docker run --rm --user 1000:1000 -e RUSTFS_ACCESS_KEY=a -e RUSTFS_SECRET_KEY=bbbbbbbb -v s080-fresh:/data $R
# → [FATAL] Server runtime failed: Io error: Permission denied (os error 13)
```

## 4. Health and bucket init (research R7, R8)

```sh
for p in /health /health/ready /minio/health/live; do docker exec s080-rfs curl -s -o /dev/null -w "$p %{http_code}\n" localhost:9000$p; done
docker run --rm --network s080 -e K=langfuse -e S=s080newsecret --entrypoint sh $R -c \
  'printf "user = \"%s:%s\"\n" "$K" "$S" | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -o /dev/null -w "%{http_code}\n" -X PUT http://s080-rfs:9000/langfuse'
# 200 — on an existing bucket too
```

## 5. The full rehearsal (T008/T009)

```sh
MCM_REQUIRE_LIVE_STACK=1 node --test scripts/__tests__/object-store-migration.rehearsal.mjs
```

Read the counts: 0 failed, **0 skipped**.

## Teardown

```sh
docker rm -f s080-minio s080-rfs 2>/dev/null
docker volume rm s080-minio s080-rfs s080-fresh 2>/dev/null
docker network rm s080 2>/dev/null
```
