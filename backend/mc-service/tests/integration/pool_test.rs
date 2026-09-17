//! Item #470 — the leased test-database pool's own behaviour.
//!
//! The rest of the integration suite exercises the pool implicitly: every `test_db()` call in the
//! other three binaries goes through it. These tests pin the properties that suite CANNOT show,
//! because a suite that is passing looks identical whether databases are leased or minted:
//!
//!   * a thread gets the SAME database back, so the namespace count is bounded by thread count
//!     rather than by test count (~3 400 WiredTiger idents per run before this);
//!   * cleaning happens on ACQUIRE, so a test that panicked without reaching `cleanup_db` leaves
//!     nothing for the next test on that thread — which is what removes the leak;
//!   * a crashed run's lease is reclaimable, and a live one is not.
//!
//! Requires MongoDB at `MC_DB_URL`, like the rest of the integration tier.
mod common;

use mongodb::bson::doc;

/// The pool's whole point: a thread reuses one database instead of minting one per test.
#[tokio::test]
async fn two_acquisitions_on_one_thread_return_the_same_database() {
    let first = common::test_db().await;
    let second = common::test_db().await;

    assert_eq!(
        first.name(),
        second.name(),
        "each acquisition minted a new database — that is the ~180-databases-per-run churn item \
         #470 exists to remove. A thread must lease ONE database and reuse it."
    );
}

/// The database must come from the bounded slot pool, not from a fresh UUID per call.
#[tokio::test]
async fn the_leased_database_is_a_pool_slot_not_a_unique_name() {
    let db = common::test_db().await;
    let name = db.name().to_string();

    assert!(
        common::is_pool_slot_name(&name),
        "expected a bounded pool slot name like `mc_test_s0`, got `{name}`. A per-call unique \
         name is what makes the namespace count scale with TEST count instead of THREAD count."
    );
}

/// Cleaning on acquire is what makes a panicking test harmless: it never reaches `cleanup_db`,
/// so the guarantee cannot live on the release side.
#[tokio::test]
async fn rows_left_by_a_panicking_test_are_gone_for_the_next_acquisition() {
    let leaked = {
        let db = common::test_db().await;
        let name = db.name().to_string();

        // A REAL panic, unwinding without ever reaching cleanup_db — the exact shape of the leak.
        let handle = tokio::spawn(async move {
            db.collection::<mongodb::bson::Document>("movies")
                .insert_one(doc! { "title": "left behind by a panic" })
                .await
                .expect("seed insert failed");
            panic!("deliberate panic — a test dying before cleanup_db");
        });
        assert!(handle.await.is_err(), "the task was supposed to panic");
        name
    };

    let next = common::test_db().await;
    assert_eq!(
        next.name(),
        leaked,
        "precondition: the same thread leases the same slot"
    );

    let remaining = next
        .collection::<mongodb::bson::Document>("movies")
        .count_documents(doc! {})
        .await
        .expect("count failed");
    assert_eq!(
        remaining, 0,
        "the panicked test's rows survived into the next acquisition. Cleaning must happen on \
         ACQUIRE — a panicking test never runs its own cleanup."
    );
}

/// Every leased database arrives with the product's indexes, so no test inherits a surprising
/// index state from whichever test used the slot before it.
#[tokio::test]
async fn a_leased_database_arrives_with_the_product_indexes() {
    let db = common::test_db().await;
    let names = db
        .collection::<mongodb::bson::Document>("movies")
        .list_index_names()
        .await
        .expect("list_index_names failed");

    assert!(
        names.iter().any(|n| n == "unique_movie_per_collection"),
        "a leased database must carry the product indexes; got {names:?}. Otherwise a test that \
         does not call create_indexes itself inherits whatever the previous tenant left."
    );

    // The collections index set too — the collection repository relies on it.
    let coll_names = db
        .collection::<mongodb::bson::Document>("movie_collections")
        .list_index_names()
        .await
        .expect("list_index_names failed");
    assert!(
        coll_names.iter().any(|n| n == "unique_name_per_owner"),
        "expected the movie_collections indexes too; got {coll_names:?}"
    );
}

/// A crashed run must not hold its slot for ever, and a live run must not have its slot stolen.
#[tokio::test]
async fn a_stale_lease_is_reclaimable_and_a_fresh_one_is_not() {
    let client = common::pool_client().await;

    // A slot far outside the range the running suite will touch, so this test cannot race it.
    let slot = 9_001;

    common::force_lease_age(&client, slot, common::LEASE_STALE_AFTER * 2).await;
    assert!(
        common::try_claim_slot(&client, slot).await,
        "a lease older than the staleness window must be reclaimable — otherwise a run that was \
         killed (item #468 killed mongod repeatedly) would retire that slot for ever."
    );

    assert!(
        !common::try_claim_slot(&client, slot).await,
        "the lease was just claimed, so it is FRESH — a second claimant must be refused, or two \
         concurrent runs would wipe each other's data mid-test."
    );

    common::release_lease(&client, slot).await;
}

/// A lease belongs to a RUNNING process. The three integration binaries run one after another, so
/// by the time the second starts, the first's leases are held by a dead pid — if those are not
/// reclaimable the slot space is exhausted within a single run (measured: 64 leases held by 3 dead
/// pids, after which the pool fell back to unique names and its own test failed).
#[tokio::test]
async fn a_lease_held_by_a_dead_process_is_reclaimable_immediately() {
    let client = common::pool_client().await;
    let slot = 9_002;

    // A genuinely dead pid: spawn a process, reap it, then claim its identity for the lease.
    let mut child = std::process::Command::new("/bin/true")
        .spawn()
        .expect("could not spawn /bin/true");
    let dead_pid = child.id();
    child.wait().expect("could not reap /bin/true");

    common::force_lease_held_by(&client, slot, dead_pid).await;

    assert!(
        common::try_claim_slot(&client, slot).await,
        "a lease whose holder has exited must be reclaimable at once, without waiting out the \
         {LEASE:?} staleness window — otherwise each binary in a run burns a fresh set of slots.",
        LEASE = common::LEASE_STALE_AFTER
    );

    common::release_lease(&client, slot).await;
}
