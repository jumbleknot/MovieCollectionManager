//! Shared test helpers for mc-service integration tests.
//!
//! Each test must call `test_db()` to get an isolated database instance.
//! The database name includes the test name to prevent interference between
//! concurrent test runs (when `--test-threads > 1`).
//!
//! Requires: `MC_DB_URL` env var or `.env.local` with a valid MongoDB URL.
//!
//! Each binary uses a different subset of these helpers, so unused-item warnings
//! here are structural rather than a signal of dead code.
#![allow(dead_code)]

/// Real-credential helper (feature 046) — ROPC token minting against Keycloak.
pub mod auth;

/// `tracing` capture that survives `--test-threads > 1` (item #462).
pub mod log_capture;

use std::cell::RefCell;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum_keycloak_auth::instance::KeycloakAuthInstance;
use mongodb::{bson::doc, options::ClientOptions, Client, Database};
use uuid::Uuid;

/// How long to wait for Keycloak OIDC discovery before failing a test outright.
const JWKS_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Lease this test's database, emptied and indexed, ready to use (item #470).
///
/// Isolation is unchanged from the caller's point of view — a test still gets a database nobody
/// else is writing to. What changed is the bookkeeping: the database is now leased from a bounded
/// pool for the duration of the test and reset on ACQUIRE, rather than minted per call and dropped
/// on release. Calling this twice within one test returns the same database.
///
/// See the pool section at the end of this file for why the cleaning moved to the acquire side,
/// and why the slot is released by a thread-local destructor rather than by `cleanup_db`.
pub async fn test_db() -> Database {
    let client = connect().await;
    let name = lease_for_this_test(&client).await;
    let db = client.database(&name);
    reset(&db).await;
    db
}

/// Historically dropped the test database; now a deliberate no-op.
///
/// DO NOT make this drop or wipe again. Dropping would destroy the leased database and the next
/// acquire would recreate ~19 WiredTiger idents — reinstating exactly the churn item #470 removed.
/// Wiping would be redundant work, because `test_db` already resets on acquire.
///
/// It is kept, rather than deleted, because the guarantee genuinely moved rather than disappearing
/// and the 148 call sites read correctly either way: a test that ends by calling this still leaves
/// a clean database for the next tenant — just by a different mechanism. Removing the calls would
/// be a 148-site diff for no behavioural gain, and would lose the marker showing where each test
/// considers itself finished.
pub async fn cleanup_db(_db: &Database) {}

/// Block until Keycloak OIDC discovery has **succeeded**, or the timeout expires.
///
/// Why this exists (PRD-McServiceHttpAuthzIntegration §3.1a): `axum-keycloak-auth`
/// 0.8.3's `KeycloakAuthService::poll_ready` asserts `discovery.is_pending()` while
/// `discovery.version() == 0`, but `KeycloakAuthInstance::new` only sets that
/// `pending` flag *inside* a `tokio::spawn`. On the current-thread runtime that
/// `#[tokio::test]` uses, nothing yields between constructing the router and the
/// first request, so the discovery task has never been polled and the assert fires.
/// That is what got the HTTP auth tests `#[ignore]`d — it read as JWKS "flakiness"
/// but is a deterministic ordering bug.
///
/// Waiting for `is_operational()` drives `version()` past 0, after which the assert
/// branch is never taken again for the life of the process.
///
/// Gating on *success* rather than merely yielding is deliberate: `version` is
/// incremented even when discovery ends in `Err`, so a service pointed at a dead
/// Keycloak still reports ready and still answers 401 to an unauthenticated
/// request. Without this gate the whole auth-negative suite would pass green with
/// no identity provider at all — see the two guards at the end of `health_test.rs`
/// (`unauthenticated_401_is_returned_even_when_keycloak_is_unreachable` and
/// `readiness_gate_reports_not_operational_for_unreachable_keycloak`).
pub async fn wait_until_operational(instance: &KeycloakAuthInstance, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if instance.is_operational().await {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The single place a test router is constructed.
///
/// Every public builder below delegates here, so the `wait_until_operational`
/// assertion cannot be forgotten by one of them and silently let the suite pass
/// green against a dead Keycloak. Do not copy this body — add a delegating
/// wrapper instead.
async fn build_test_app_inner() -> (axum::Router, Arc<KeycloakAuthInstance>, Database) {
    let db = test_db().await;

    // MC_SERVICE_PORT is irrelevant here (nothing binds); KEYCLOAK_* must be reachable.
    let config = mc_service::config::Config::from_env().unwrap_or_else(|e| {
        // Item #227: this used to say only "ensure .env.local exists", which names the missing
        // input but not the command that supplies it — and until that item no command did. On
        // 2026-08-22 the resulting `Missing("MC_DB_URL")` was read as "the Rust tier is broken"
        // on a branch whose Rust tree was byte-identical to main (25 passed / 16 failed; 7 of
        // the 16 were this file, 9 were the absent replica-set MongoDB below). Naming the fix
        // here keeps the two apart at the moment of failure, the way check-sast-findings.mjs
        // names which lever clears a finding.
        panic!(
            "Missing test configuration ({e:?}) — backend/mc-service/.env.local is absent or \
             incomplete.\n  Fix:  node scripts/gen-dev-env.mjs   (writes it; gitignored)\n  \
             Vars: docs/runbooks/local-dev.md, \"mc-service env vars\"\n\
             This is a CONFIGURATION failure, not a code failure. Distinct from the \
             http_authz_test::* cases, which need the local replica-set MongoDB up \
             (`pnpm nx up infrastructure-as-code`)."
        )
    });

    // The router takes the database by value; the handle is needed by tests that
    // seed or inspect rows, so clone it — a `Database` handle is a cheap, shared
    // reference to the same client and points at the same database.
    let (app, auth_instance) = mc_service::api::router::build_with_auth_handle(db.clone(), &config)
        .await
        .expect("Router build failed");

    assert!(
        wait_until_operational(&auth_instance, JWKS_READY_TIMEOUT).await,
        "Keycloak OIDC discovery did not become operational within {:?} — is Keycloak \
         reachable at {}? Refusing to run: without JWKS the auth tests would pass for \
         the wrong reason.",
        JWKS_READY_TIMEOUT,
        config.keycloak_url
    );

    (app, auth_instance, db)
}

/// Build the real Axum router against a fresh test database, with JWKS discovery
/// already complete.
///
/// Shared by every HTTP-level integration test so the readiness gate cannot be
/// forgotten in one binary and silently reintroduce the `is_pending()` panic.
pub async fn build_test_app() -> axum::Router {
    build_test_app_inner().await.0
}

/// As [`build_test_app`], but also hands back the auth instance for tests that need
/// to assert on discovery state itself.
pub async fn build_test_app_with_auth_instance() -> (axum::Router, Arc<KeycloakAuthInstance>) {
    let (app, auth_instance, _db) = build_test_app_inner().await;
    (app, auth_instance)
}

/// As [`build_test_app`], but also hands back a handle to **the database the router
/// is wired to**.
///
/// Needed by tests that must seed a row no HTTP path can create — a collection owned
/// by a *foreign* subject, since every write handler stamps `owner_id = token.subject`
/// — or that assert on what was actually persisted rather than on what the response
/// echoed back. The handle must come from here rather than from a second `test_db()`
/// call: `test_db()` mints a uniquely-named database per call, so a separate handle
/// would point at an empty one the router never touches.
pub async fn build_test_app_with_db() -> (axum::Router, Database) {
    let (app, _auth_instance, db) = build_test_app_inner().await;
    (app, db)
}

// ─── The leased test-database pool (item #470) ────────────────────────────────────────────────
//
// WHAT THIS REPLACES. `test_db()` used to mint `mc_test_<uuid>` per call and `cleanup_db` dropped
// it. With ~180 tests across the binaries, each database carrying 2 collections and ~17 indexes,
// that was ~3 400 WiredTiger idents created and unlinked PER RUN — and a test that panicked never
// reached `cleanup_db`, so it leaked its database (52 stale ones after one aborted session; a
// mongod restart once had to reconcile 62 512 orphaned idents before reporting healthy).
//
// THE INVERSION THAT MATTERS: cleaning happens on ACQUIRE, not on release. A panicking test never
// runs its own cleanup, so a release-side guarantee cannot hold; an acquire-side one always does,
// because the next tenant of the slot wipes before it starts. That is also why the 148 existing
// `cleanup_db` call sites did not need to change — see `cleanup_db` below.
//
// A slot is leased for the life of the PROCESS, not per test: the thread→slot map below claims
// once per thread. Every `test_db()` call refreshes the lease, so each test doubles as a free
// heartbeat and no timer is needed (the longest binary run measured under item #468 was 85 s,
// against a 600 s staleness window).

/// How long a lease may go unrefreshed before another run may reclaim its slot.
pub const LEASE_STALE_AFTER: Duration = Duration::from_secs(600);

/// Database holding the lease bookkeeping. Never carries test data.
const POOL_DB: &str = "mc_test_pool";
const LEASES: &str = "leases";

/// Upper bound on slots. Comfortably above any plausible `--test-threads`; when every slot is held
/// by a LIVE process we fall back to a unique name (see `test_db`), so this is a soft ceiling.
const MAX_SLOTS: u32 = 64;

/// `mc_test_s<slot>` — the leased databases. Matching this shape is what distinguishes a pooled
/// database from the old per-call unique name.
fn slot_db_name(slot: u32) -> String {
    format!("mc_test_s{slot}")
}

/// True when `name` is a bounded pool slot rather than a per-call unique name.
pub fn is_pool_slot_name(name: &str) -> bool {
    name.strip_prefix("mc_test_s")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before the epoch")
        .as_millis() as i64
}

/// Build a client from `MC_DB_URL`, loading the dev env files the same way the suite always has.
async fn connect() -> Client {
    let _ = dotenvy::from_filename("backend/mc-service/.env.local");
    let _ = dotenvy::dotenv();

    let url =
        std::env::var("MC_DB_URL").unwrap_or_else(|_| "mongodb://localhost:27017".to_string());

    let mut opts = ClientOptions::parse(&url).await.expect("Invalid MC_DB_URL");
    opts.app_name = Some("mc-service-integration-tests".to_string());
    Client::with_options(opts).expect("MongoDB client creation failed")
}

/// A client pointed at the lease bookkeeping, for the pool's own tests.
pub async fn pool_client() -> Client {
    connect().await
}

fn leases(client: &Client) -> mongodb::Collection<mongodb::bson::Document> {
    client.database(POOL_DB).collection(LEASES)
}

/// This machine's identity, so a lease is only judged by liveness on the host that created it.
fn this_host() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Is `pid` a live process on THIS host?
///
/// Linux-only, which is the whole surface that runs this tier (devcontainer and CI runner). On
/// anything else this answers "alive" and the staleness window is the only reclaim path — slower,
/// never wrong.
fn pid_is_alive(pid: u32) -> bool {
    if cfg!(not(target_os = "linux")) {
        return true;
    }
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Backdate a slot's lease to a named holder, so liveness handling can be tested directly.
pub async fn force_lease_held_by(client: &Client, slot: u32, pid: u32) {
    let _ = leases(client)
        .update_one(
            doc! { "_id": slot as i64 },
            doc! { "$set": { "pid": pid as i64, "host": this_host(), "at": now_ms() } },
        )
        .upsert(true)
        .await;
}

/// Claim `slot` if it is free or its lease has gone stale. True when this caller now holds it.
///
/// Two steps rather than an upsert, because the distinction is the whole point: an `insert_one`
/// that hits the `_id` duplicate-key error proves someone else has the slot, and only then do we
/// ask whether their lease has expired. An upsert would silently take a LIVE slot on a race.
pub async fn try_claim_slot(client: &Client, slot: u32) -> bool {
    let now = now_ms();
    let host = this_host();
    let mine = doc! { "pid": std::process::id() as i64, "host": &host, "at": now };

    let fresh =
        doc! { "_id": slot as i64, "pid": std::process::id() as i64, "host": &host, "at": now };
    if leases(client).insert_one(fresh).await.is_ok() {
        return true;
    }

    // Taken — by whom, and are they still running?
    //
    // A lease belongs to a LIVE PROCESS, so a dead holder is reclaimable at once. That is the
    // common case, not an edge one: the integration binaries run one after another, so every
    // lease the previous binary took is held by an exited pid by the time the next one starts.
    // Without this the slot space is exhausted inside a single run — measured: 64 leases held by
    // 3 dead pids, after which the pool fell back to unique names.
    //
    // The staleness window remains as the backstop for a holder we cannot judge: a lease created
    // on another host, or a pid whose liveness we could not read.
    let holder = leases(client)
        .find_one(doc! { "_id": slot as i64 })
        .await
        .ok()
        .flatten();

    let reclaimable = match holder {
        None => true, // vanished between the insert and the read — treat as free
        Some(ref d) => {
            let same_host = d.get_str("host").map(|h| h == host).unwrap_or(false);
            let pid = d.get_i64("pid").unwrap_or(0) as u32;
            let dead_here = same_host && !pid_is_alive(pid);
            let stale = d.get_i64("at").unwrap_or(0) < now - LEASE_STALE_AFTER.as_millis() as i64;
            dead_here || stale
        }
    };
    if !reclaimable {
        return false;
    }

    // Re-assert the same predicate in the update, so two processes racing to reclaim the SAME
    // abandoned slot cannot both win: whoever writes first changes `at`, and the loser's filter
    // no longer matches.
    let was = holder
        .as_ref()
        .and_then(|d| d.get_i64("at").ok())
        .unwrap_or(0);
    leases(client)
        .update_one(
            doc! { "_id": slot as i64, "at": was },
            doc! { "$set": mine },
        )
        .await
        .map(|r| r.matched_count == 1)
        .unwrap_or(false)
}

/// Refresh the lease we already hold, so a long-running binary is never reclaimed under us.
async fn refresh_lease(client: &Client, slot: u32) {
    let _ = leases(client)
        .update_one(
            doc! { "_id": slot as i64 },
            doc! { "$set": { "at": now_ms(), "pid": std::process::id() as i64, "host": this_host() } },
        )
        .await;
}

/// Backdate a slot's lease by `age`, so staleness handling can be tested without waiting.
pub async fn force_lease_age(client: &Client, slot: u32, age: Duration) {
    let backdated = now_ms() - age.as_millis() as i64;
    let _ = leases(client)
        .update_one(
            doc! { "_id": slot as i64 },
            // host deliberately absent: an unjudgeable holder, so this exercises the STALENESS
            // backstop rather than the liveness path.
            doc! { "$set": { "at": backdated, "pid": 0i64 }, "$unset": { "host": "" } },
        )
        .upsert(true)
        .await;
}

/// Drop a slot's lease outright.
pub async fn release_lease(client: &Client, slot: u32) {
    let _ = leases(client).delete_one(doc! { "_id": slot as i64 }).await;
}

/// Slots this process has leased from MongoDB and is not currently using.
///
/// WHY A FREE LIST AND NOT A `ThreadId` MAP. The first cut keyed slots by thread, on the
/// assumption that libtest pools its workers. It does not — libtest spawns a NEW THREAD PER TEST
/// and `--test-threads` caps how many run at once, so a thread key is a test key in disguise.
/// Measured: 41 tests produced 39 slots. What is actually bounded is CONCURRENCY, so the slot must
/// be held for the duration of a test and handed back, not owned by a thread identity.
static FREE_SLOTS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();

fn free_slots() -> &'static Mutex<Vec<u32>> {
    FREE_SLOTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Returns its slot to the free list when the test's thread exits.
///
/// This is what makes a panicking test cost nothing. Rust unwinds on panic, the test's thread ends,
/// and thread-local destructors run — so the slot comes back without any test calling anything.
/// A release that depended on `cleanup_db` would be skipped by exactly the tests that most need it.
struct SlotGuard(u32);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Ok(mut free) = free_slots().lock() {
            free.push(self.0);
        }
    }
}

thread_local! {
    /// The slot this test is using. One per thread, and libtest gives each test its own thread,
    /// so this is effectively one per test — released when the test ends, however it ends.
    static HELD: RefCell<Option<SlotGuard>> = const { RefCell::new(None) };
}

/// The database name for this test: whatever slot it already holds, else one taken from the free
/// list, else a slot newly leased from MongoDB.
///
/// The fallback matters: if every slot is held by a LIVE process, we degrade to the old per-call
/// unique name rather than sharing a database with a running test. That makes this change strictly
/// no worse than the behaviour it replaces, even under concurrent runs.
async fn lease_for_this_test(client: &Client) -> String {
    if let Some(slot) = HELD.with(|h| h.borrow().as_ref().map(|g| g.0)) {
        return slot_db_name(slot);
    }

    if let Some(slot) = free_slots().lock().ok().and_then(|mut f| f.pop()) {
        HELD.with(|h| *h.borrow_mut() = Some(SlotGuard(slot)));
        refresh_lease(client, slot).await;
        return slot_db_name(slot);
    }

    for slot in 0..MAX_SLOTS {
        if try_claim_slot(client, slot).await {
            HELD.with(|h| *h.borrow_mut() = Some(SlotGuard(slot)));
            return slot_db_name(slot);
        }
    }

    format!("mc_test_{}", Uuid::new_v4().simple())
}

/// Empty the leased database and ensure the product's indexes, so every test starts from the same
/// state regardless of what the previous tenant of this slot did.
///
/// Deleting documents rather than dropping the database is the point: a drop unlinks ~19
/// WiredTiger idents and the next acquire recreates them, which is the churn being removed.
/// `mc-service` owns exactly two collections, so this is two statements — and `create_indexes` is
/// idempotent, which is why 21 of the 23 test files can keep calling it themselves.
async fn reset(db: &Database) {
    for coll in ["movies", "movie_collections"] {
        db.collection::<mongodb::bson::Document>(coll)
            .delete_many(doc! {})
            .await
            .unwrap_or_else(|e| panic!("could not clear {coll} in {}: {e}", db.name()));
    }
    mc_service::adapters::mongodb::indexes::create_indexes(db)
        .await
        .unwrap_or_else(|e| panic!("index creation failed for {}: {e}", db.name()));
}
