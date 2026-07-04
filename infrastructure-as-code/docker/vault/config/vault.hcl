# Production dormant Vault config — feature 025 (US3, research R6).
# REAL Vault (NOT -dev): integrated raft storage on a persistent volume, internal-only listener.
# Deployed UNINITIALIZED + SEALED; the compose healthcheck overrides (uninitcode/sealedcode=200) make
# that dormant state report "healthy" to Komodo. Do NOT run `vault operator init` — adoption is a
# future, out-of-scope concern. No secret lives here (a dormant Vault has no root token).

ui = false

listener "tcp" {
  address     = "0.0.0.0:8200"
  # Internal-only (backend-network, no published port); edge/mesh TLS is a later adoption concern.
  tls_disable = 1
}

storage "raft" {
  path    = "/vault/data"
  node_id = "vault-prod-1"
}

api_addr     = "http://vault-service:8200"
cluster_addr = "http://vault-service:8201"
