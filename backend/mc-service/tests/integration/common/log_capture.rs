//! Capturing `tracing` output from a test, safely under `--test-threads > 1` (item #462).
//!
//! # Why this exists, and why the obvious approach is wrong
//!
//! The obvious way to capture log output in one test is
//!
//! ```ignore
//! let _guard = tracing::subscriber::set_default(capturing_subscriber);
//! ```
//!
//! and it works perfectly when that test runs alone. It fails roughly **two runs in three** when
//! anything else in the same binary drives the same code path concurrently, and the failure is
//! silent: the subscriber is installed correctly, but the events simply never arrive.
//!
//! ## The mechanism
//!
//! `tracing` caches each callsite's `Interest` **globally, process-wide**. The first time a
//! `tracing::info!` is evaluated, the answer to "is anyone interested in this callsite?" is computed
//! and cached, and a `never()` verdict short-circuits the callsite from then on.
//!
//! `set_default` installs a dispatcher that is **thread-local**. So when another thread evaluates the
//! same callsite while *its* default is `NoSubscriber` — which is every other test in the binary —
//! the global cache is set to `never()`, and the capturing thread's events are suppressed too. The
//! subscriber is fine; the callsite has been turned off underneath it.
//!
//! Measured on `main`, 2026-09-15 (item #462): `logging_middleware_emits_structured_json` failed 2/3
//! whole-binary runs and passed 3/3 with `--test-threads=1`. A probe confirmed the diagnosis
//! directly — with the capture subscriber installed and `dispatch_is_noop=false`, a **fresh** callsite
//! declared inside the test body was captured while the middleware's `"request completed"` callsite,
//! already evaluated by a concurrent test, was not.
//!
//! This is also why the bug is invisible to CI: `scripts/mc-service-integration-guard.mjs` appends
//! `--test-threads=1`, which is the one configuration where it cannot happen.
//!
//! ## The fix
//!
//! Install ONE **global** subscriber for the test binary, whose writer routes to a **thread-local**
//! buffer. Because a real subscriber is always the global default, no callsite is ever cached as
//! `never()`, so concurrency cannot suppress anything. Isolation between tests comes from the
//! thread-local buffer rather than from a thread-local dispatcher: a test that has installed a buffer
//! captures its own events, and every other thread's events are discarded.
//!
//! `#[tokio::test]` builds a current-thread runtime, so a test's awaited work — including the request
//! the middleware logs — runs on the test's own thread and lands in its own buffer.
//!
//! ```ignore
//! let capture = common::log_capture::capture();
//! // ... drive the request ...
//! let lines = capture.lines();
//! ```

use std::cell::RefCell;
use std::sync::{Arc, Mutex, OnceLock};

type Buffer = Arc<Mutex<Vec<String>>>;

thread_local! {
    /// The buffer this thread's events are written to, if it asked to capture.
    static CAPTURE: RefCell<Option<Buffer>> = const { RefCell::new(None) };
}

/// The global subscriber's writer. Appends to whichever buffer the emitting thread installed, and
/// discards the event when that thread installed none — which is every thread that is not currently
/// capturing, including the noisy neighbours that caused item #462.
struct ThreadLocalWriter;

impl std::io::Write for ThreadLocalWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        CAPTURE.with(|slot| {
            if let Some(buffer) = slot.borrow().as_ref() {
                buffer
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(String::from_utf8_lossy(buf).into_owned());
            }
        });
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Install the process-wide subscriber, once.
///
/// `set_global_default` may only be called once per process, so this is idempotent and every
/// capturing test may call it. It must NOT be a `set_default`: a thread-local dispatcher is precisely
/// what does not fix this.
fn init() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        use tracing_subscriber::layer::SubscriberExt;
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(|| ThreadLocalWriter),
        );
        // A second caller would be a bug in this module, not a test's problem — but another binary
        // in the same process is impossible, so a failure here means init() was bypassed.
        tracing::subscriber::set_global_default(subscriber)
            .expect("log_capture::init must be the only global tracing subscriber in this binary");
    });
}

/// Begin capturing this thread's `tracing` events. Capture stops when the guard is dropped.
pub fn capture() -> CaptureGuard {
    init();
    let buffer: Buffer = Arc::new(Mutex::new(Vec::new()));
    CAPTURE.with(|slot| *slot.borrow_mut() = Some(Arc::clone(&buffer)));
    CaptureGuard { buffer }
}

/// RAII handle to one thread's captured events.
pub struct CaptureGuard {
    buffer: Buffer,
}

impl CaptureGuard {
    /// The raw lines written so far, in order. Each is one JSON document.
    pub fn lines(&self) -> Vec<String> {
        self.buffer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The captured lines parsed as JSON, skipping anything unparseable.
    pub fn json(&self) -> Vec<serde_json::Value> {
        self.lines()
            .iter()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
            .collect()
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        CAPTURE.with(|slot| *slot.borrow_mut() = None);
    }
}
