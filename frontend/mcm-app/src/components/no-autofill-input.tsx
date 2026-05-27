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
 * Usage: replace TextInput with NoAutoFillInput wherever password manager
 * autofill is undesirable (all forms except the user registration screen).
 *
 *   import { NoAutoFillInput } from '@/components/no-autofill-input';
 *   <NoAutoFillInput ... />
 *
 * The component accepts all standard TextInput props and forwards them verbatim.
 * On web the above data-* attributes are merged into the props before rendering.
 */

import React from 'react';
import { Platform, TextInput } from 'react-native';
import type { TextInputProps } from 'react-native';

/** All standard TextInput props are accepted and forwarded. */
export type NoAutoFillInputProps = TextInputProps;

/**
 * Web-only autofill suppression data attributes.
 * Injected only when Platform.OS === 'web'.
 */
const WEB_AUTOFILL_BLOCK: Record<string, string> = {
  autoComplete: 'off',
  // @ts-expect-error — data-* attributes are valid on web but not in RN types
  'data-form-type': 'other',    // Dashlane
  'data-lpignore': 'true',      // LastPass
  'data-1p-ignore': '',         // 1Password
  'data-bwignore': 'true',      // Bitwarden
};

export function NoAutoFillInput(props: NoAutoFillInputProps): React.JSX.Element {
  const extra = Platform.OS === 'web' ? WEB_AUTOFILL_BLOCK : {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <TextInput {...(extra as any)} {...props} />;
}
