"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { shouldAllowAccess } from "@/lib/pwa";

/**
 * <PWAGuard> — client-side gate that forces users to install the app
 * before they can access protected pages.
 *
 * If the user is NOT running in standalone (installed) mode AND has no
 * saved bypass flag, they are redirected to /install.
 *
 * Usage:
 *   <PWAGuard><YourPageContent /></PWAGuard>
 *
 * The guard renders nothing while it's deciding, so we avoid a flash
 * of the protected content before the redirect fires.
 */
export default function PWAGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // null = still deciding, true = allowed, false = blocked
  const [decision, setDecision] = useState<null | boolean>(null);

  useEffect(() => {
    // Defer to after mount so we read fresh localStorage / matchMedia state.
    if (shouldAllowAccess()) {
      setDecision(true);
    } else {
      setDecision(false);
      // Use replace so the protected URL doesn't end up in history —
      // the back button won't sneak past the gate.
      router.replace("/install");
    }
  }, [router]);

  // While deciding or after blocking, render nothing.
  if (decision !== true) return null;

  return <>{children}</>;
}
