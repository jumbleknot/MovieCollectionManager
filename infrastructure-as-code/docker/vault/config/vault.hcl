# Production dormant Vault config — feature 025 (US3, research R6).
# REAL Vault (NOT -dev): integrated raft storage on a persistent volume, internal-only listener.
# Deployed UNINITIALIZED + SEALED; the compose healthcheck overrides (uninitcode/sealedcode=200) make
# that dormant state report "healthy" to Komodo. Do NOT run `vault operator init` — adoption is a
# future, out-of-scope concern. No secret lives here (a dormant Vault has no root token).

ui = false

# #PROD disable_mlock is REQUIRED here for two reasons: (1) it is the recommended setting for integrated
# raft storage — BoltDB uses memory-mapped files, which mlock does not play well with; (2) the prod
# docker daemon has a finite memlock rlimit, so Vault's mlockall fails ("Failed to lock memory: cannot
# allocate memory") even with CAP_IPC_LOCK. Raft persists to disk regardless, so mlock's swap-protection
# is moot. NOTE: the compose STILL sets cap_add: IPC_LOCK — the vault entrypoint requires it (without it
# vault double-starts → "address already in use"); disable_mlock just stops the actual mlockall call.
disable_mlock = true

listener "tcp" {
  address     = "0.0.0.0:8200"
  # Internal-only (backend-network, no published port); edge/mesh TLS is a later adoption concern.
  tls_disable = 1
}

# #PROD path = /vault/file (NOT /vault/data): the hashicorp/vault image runs Vault as the non-root
# `vault` user (uid 100) and ships /vault/{config,file,logs} owned by vault, but NOT /vault/data. An
# external volume mounted at /vault/data lands root-owned (path absent from the image) → vault can't
# create vault.db ("permission denied"); mounted at the vault-owned /vault/file, an empty volume
# inherits vault:vault ownership → writable, no root/chown needed. (Verified against the image.)
storage "raft" {
  path    = "/vault/file"
  node_id = "vault-prod-1"
}

api_addr     = "http://vault-service:8200"
cluster_addr = "http://vault-service:8201"
