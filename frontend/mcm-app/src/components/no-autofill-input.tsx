/**
 * NoAutoFillInput — TextInput that suppresses password manager autofill on web.
 *
 * On native mobile, password managers operate at the OS level via Autofill
 * frameworks (iOS) and Autofill service (Android) — HTML attributes have no
 * effect. No wrapping is needed on native; this component passes props through
 * unchanged.
 *
 * On web (React Native Web), HTML input elements respect the following hints:
 *   - autocomplete="off"         — standard browser hint (often ignored by PMs)
 *   - data-form-type="other"     — Dashlane suppression
 *   - data-lpignore="true"       — LastPass suppression
 *   - data-1p-ignore=""          — 1Password suppression
 *   - data-bwignore="true"       — Bitwarden suppression
 *
 * Password fields (`secureTextEntry` → `<input type="password">`):
 *   The browser's BUILT-IN password manager (Chrome/Edge) IGNORES autocomplete="off"
 *   on a password-type field — it will still autofill saved passwords and offer to save.
 *   The only value it honours to suppress that is autocomplete="new-password". So for a
 *   secureTextEntry field we emit `new-password` instead of `off` (alongside the data-*
 *   ignores, which third-party PMs honour on password fields). Used for the assistant's
 *   API-key fields, which are secrets a password manager must never capture or fill.
 *   A caller can still override `autoComplete` explicitly (it wins over this default).
 *
 * Chrome native autofill note:
 *   Chrome ignores autocomplete="off" for fields it recognises as personal-name
 *   fields (e.g. placeholder "Director name", nearby label "Directors").  Passing
 *   `webName` sets the HTML `name` attribute to a non-standard value (e.g.
 *   "director-entry") that Chrome does not match to any contact-data pattern,
 *   disabling its name-autofill heuristic for that specific field.
 *
 * Usage: replace TextInput with NoAutoFillInput wherever password manager
 * autofill is undesirable (all forms except the user registration screen).
 *
 *   import { NoAutoFillInput } from '@/components/no-autofill-input';
 *   <NoAutoFillInput ... />
 *   // For name-like fields, additionally suppress Chrome's contact autofill:
 *   <NoAutoFillInput webName="director-entry" ... />
 *
 * The component accepts all standard TextInput props and forwards them verbatim.
 * On web the above data-* attributes are merged into the props before rendering.
 */

import React, { useRef, useLayoutEffect } from 'react';
import { Platform, TextInput } from 'react-native';
import type { TextInputProps } from 'react-native';

/** All standard TextInput props are accepted and forwarded. */
export type NoAutoFillInputProps = TextInputProps & {
  /**
   * On web: sets the HTML `name` attribute to this value, preventing Chrome
   * from applying its personal-name autofill heuristic to the field.
   * Use for director / actor / any "name" fields where Chrome offers unwanted
   * contact-data suggestions despite autocomplete="off".
   * Has no effect on native (iOS/Android).
   */
  webName?: string;
};

/**
 * Web-only autofill suppression data attributes (the third-party PM ignores).
 * Injected only when Platform.OS === 'web'. The `autoComplete` value is chosen per field
 * (see WEB_AUTOFILL_BLOCK below) because password fields need a different token.
 */
// data-* keys are string-typed and need no ts-expect-error since Record<string, string>
// accepts any string key.  The cast to `any` in the spread is on the call site.
const WEB_PM_IGNORES: Record<string, string> = {
  'data-form-type': 'other',    // Dashlane
  'data-lpignore': 'true',      // LastPass
  'data-1p-ignore': '',         // 1Password
  'data-bwignore': 'true',      // Bitwarden
};

export function NoAutoFillInput({
  webName,
  ...props
}: NoAutoFillInputProps): React.JSX.Element {
  const inputRef = useRef<TextInput>(null);

  // RNW's TextInput does not forward unknown props (like `name`) to the
  // underlying <input> DOM element via React's prop system. Set it
  // imperatively via setNativeProps so Chrome's name-field autofill heuristic
  // cannot match this field.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !webName) return;
    inputRef.current?.setNativeProps?.({ name: webName });
  }, [webName]);

  // Chrome's built-in PM ignores autocomplete="off" on a password field; only
  // "new-password" suppresses it. Non-secret fields keep "off".
  const autoComplete = props.secureTextEntry ? 'new-password' : 'off';
  const extra =
    Platform.OS === 'web'
      ? {
          autoComplete,
          ...WEB_PM_IGNORES,
          ...(webName ? { name: webName } : {}),
        }
      : {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <TextInput ref={inputRef} {...(extra as any)} {...props} />;
}
