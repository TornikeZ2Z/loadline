"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/basePath";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(api("/api/auth/logout"), { method: "POST" });
        // Back to the board, not to a login page: signing out is leaving the
        // account, not leaving the product. The stored location stays -- it was
        // never tied to the session.
        router.replace("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
