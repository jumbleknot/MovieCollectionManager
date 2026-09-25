/**
 * Account deleted confirmation route (feature 076 — FR-030).
 *
 * PUBLIC BY NECESSITY, not by oversight. It sits at the route root alongside `auth-callback`,
 * outside `(app)` and `(auth)`, because by the time a user arrives here their session is gone.
 * A guarded route would bounce them to a login screen — which, at the end of a deletion, reads
 * as "it failed".
 *
 * Thin by construction: routes never define screen components (constitution §Frontend App-Layer).
 */

import React from 'react';
import { AccountDeletedScreen } from '@/screens/account-deleted-screen';

export default function AccountDeletedRoute(): React.JSX.Element {
  return <AccountDeletedScreen />;
}
