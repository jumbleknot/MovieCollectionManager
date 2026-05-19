/**
 * Client-side session timeout hook (T-028b)
 * Tracks user activity and calls onTimeout after idle or absolute timeout.
 * Wire onTimeout to the useAuth logout action in login/home screens.
 *
 * Idle timeout:    30 minutes (configurable via idleTimeoutMs)
 * Absolute timeout: 24 hours from session creation (configurable via absoluteTimeoutMs)
 */

import { useEffect, useRef, useCallback } from 'react';

// ─── Default timeouts (must match BFF server-side values) ─────────────────────

const DEFAULT_IDLE_MS = 30 * 60 * 1000;    // 30 minutes
const DEFAULT_ABSOLUTE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Activity events to track ─────────────────────────────────────────────────

const ACTIVITY_EVENTS: string[] = ['touchstart', 'keydown', 'scroll', 'mousedown', 'pointerdown'];

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSessionTimeoutOptions {
  /** Called when either idle or absolute timeout is reached. */
  onTimeout: (reason: 'idle' | 'absolute') => void;
  /** Idle timeout in milliseconds. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  /** Absolute timeout in milliseconds from hook mount. Defaults to 24 hours. */
  absoluteTimeoutMs?: number;
  /** Set to false to disable the hook (e.g., when user is not authenticated). */
  enabled?: boolean;
}

/**
 * Hook that tracks user activity and triggers onTimeout after inactivity
 * or after the absolute session duration.
 *
 * Usage:
 *   useSessionTimeout({ onTimeout: () => logout() });
 */
export function useSessionTimeout({
  onTimeout,
  idleTimeoutMs = DEFAULT_IDLE_MS,
  absoluteTimeoutMs = DEFAULT_ABSOLUTE_MS,
  enabled = true,
}: UseSessionTimeoutOptions): void {
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const absoluteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);

  // Keep onTimeout ref up to date without restarting timers
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      onTimeoutRef.current('idle');
    }, idleTimeoutMs);
  }, [idleTimeoutMs]);

  useEffect(() => {
    if (!enabled) return;

    // Start idle timer
    resetIdleTimer();

    // Start absolute timeout timer
    absoluteTimerRef.current = setTimeout(() => {
      onTimeoutRef.current('absolute');
    }, absoluteTimeoutMs);

    // Register activity listeners to reset idle timer
    const handleActivity = () => resetIdleTimer();

    ACTIVITY_EVENTS.forEach((event) => {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener(event, handleActivity, { passive: true });
      }
    });

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (absoluteTimerRef.current) clearTimeout(absoluteTimerRef.current);

      ACTIVITY_EVENTS.forEach((event) => {
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener(event, handleActivity);
        }
      });
    };
  }, [enabled, resetIdleTimer, absoluteTimeoutMs]);
}
