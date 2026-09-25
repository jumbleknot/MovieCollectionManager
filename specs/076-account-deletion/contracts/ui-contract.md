# UI contract: account deletion

**Feature**: 076-account-deletion · **Date**: 2026-09-24

Follows feature 062's settings contract. `testID` values are **stable external-contract selectors**,
exempt from the constitution's behaviour-descriptive-identifier rule under its carve-out for E2E
selectors, and must not be renamed without updating the E2E suite.

---

## 1. The new settings area

One row added to `SETTINGS_AREAS` in `components/settings/settings-nav.tsx`, which documents the
extension contract: "Adding an area is one row plus a route and a screen; no other area changes."

```
{ key: 'account', label: 'Account', href: `${SETTINGS_GROUP}/account`, testID: 'settings-nav-account' }
```

Placed **last** among the non-admin entries. No `adminOnly` flag — every user can delete their own
account, including an administrator who is not the last one.

| Element | testID |
|---|---|
| Nav entry | `settings-nav-account` |

---

## 2. Screen: Settings → Account

`app/(app)/settings/account.tsx` is a thin route (routes never define screen components);
`screens/settings/account-settings-screen.tsx` holds the content. Reports `settings.account` /
depth 0 to the screen-label vocabulary, matching the sibling areas.

### Layout

A single "Delete account" danger section. The screen has no other purpose — profile lives on the
landing area.

| Element | testID | Notes |
|---|---|---|
| Section container | `account-danger-zone` | |
| Delete button | `account-delete-button` | Opens the confirmation. Destructive styling from the design system; no bespoke colours. |
| Confirmation dialog | `account-delete-dialog` | |
| Confirm button | `account-delete-confirm` | Starts the round trip |
| Cancel button | `account-delete-cancel` | Closes; nothing happens |
| Error banner | `account-delete-error` | Rendered from the `?error=` query parameter |

### FR-003: the dialog must state what is and is not destroyed

Two lists, both visible before the user can confirm. The second is not a footnote:

> **This will permanently delete:** your collections and the movies in them, your backup
> destinations and their saved credentials, your backup schedules and run history, your assistant
> settings, and your account.
>
> **This will not touch:** the backup files at your own storage. They belong to you and stay where
> they are. You keep your storage credentials; what you lose is this app's ability to reach them.

### FR-004: not reachable in one click

Two deliberate acts — the button, then the dialog's confirm. The dialog's default/focused control is
Cancel.

### Error states, from `?error=`

| Value | Message |
|---|---|
| `reauth` | "We could not confirm it was you. Your account has not been deleted." |
| `expired` | "That request timed out. Start again from Settings." |
| `failed` | "Your account was **not** deleted. Please try again." |

Every message says the account still exists. FR-028 forbids reporting partial success, and a user
who is unsure whether they still have an account is the outcome to avoid.

**No progress indicator beyond a spinner.** The deletion runs server-side to completion regardless
of the client (FR-032), so a percentage would imply a cancellability that does not exist.

---

## 3. Public screen: account deleted

`/account-deleted`, reached only by redirect from the callback. **Must be a public route**: the user
has no session by the time they arrive, so a guarded route would bounce them to login — which reads
as "your deletion failed".

| Element | testID |
|---|---|
| Container | `account-deleted-confirmation` |
| Return-to-home link | `account-deleted-home` |

States that the account and its data are gone, and — closing the loop on the dialog's promise — that
files at the user's own storage were left alone.

---

## 4. Navigation

```
Settings → Account ──[Delete]──▶ dialog ──[Confirm]──▶ identity provider (re-authenticate)
                                                            │
                          ┌─────────────────────────────────┴───────────┐
                          ▼                                             ▼
                  /account-deleted                      /settings/account?error=…
                  (public, no session)                  (still signed in, nothing destroyed)
```

The only path to destruction runs through the identity provider. There is no in-app confirmation
that completes a deletion by itself.

---

## 5. Platform parity

| Surface | Web | Android |
|---|---|---|
| Settings → Account area | Yes | Yes |
| Dialog and its two lists | Yes | Yes |
| Step-up round trip | Yes | **Deferred** — see plan.md Structure Decision |

Android renders the area and the dialog, but the step-up redirect requires the client-initiated
flow described in research R10. Until that lands, the Android confirm path must **fail closed** with
a clear message rather than silently doing nothing or, worse, deleting without a step-up.
