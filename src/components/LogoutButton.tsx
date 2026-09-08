"use client";

import { useState } from "react";
import { api } from "@/lib/basePath";

/**
 * `className` because this control moved (V03). It used to be a bordered button
 * standing in the header row beside the truck-location pill, which is what the
 * review objected to: on a phone the two competed, and signing out is not a
 * thing anyone does often enough to earn that place. It lives in the account
 * menu now, where it is a row among rows -- so its caller decides what it looks
 * like, and the default is still the button it was for anyone else.
 */
export function LogoutButton({ className = "btn" }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(api("/api/auth/logout"), { method: "POST" });
        // Back to the board, not to a login page: signing out is leaving the
        // account, not leaving the product. The stored location stays -- it was
        // never tied to the session.
        //
        // A document load, not router.replace() + router.refresh(). The board
        // keeps its filters in the URL with a bare `window.history.replaceState`
        // (Board.tsx), which Next patches into an ACTION_RESTORE, and the router
        // treats that as a navigation: it marks whatever action is pending as
        // discarded "so the state is never applied". A refresh still in flight
        // when the board next syncs its URL is thrown away, the logout having
        // already succeeded -- the session is gone but the header still says
        // Dan Driver until the person reloads by hand. A document load cannot be
        // discarded, and it drops the client state a session filled: a revealed
        // phone number lives in the open drawer's React state, which a
        // client-side refresh would have left on screen after signing out.
        window.location.replace(api("/"));
      }}
    >
      Sign out
    </button>
  );
}
