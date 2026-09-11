"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppSelector } from "@/app/store/hooks";
import { getNormalizedSize } from "@/utils/file-system/NormalizedSize";
import { logout } from "@/utils/auth/handlers/LogoutHandler";
import { getVaultSummary, type VaultSummary } from "@/utils/vault";

const SideBarAccountSection = () => {
  const router = useRouter();
  const user = useAppSelector((state) => state.user);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [vaultLoadFailed, setVaultLoadFailed] = useState(false);

  const displayName = user.name?.trim() || user.email || "Benzene user";
  const displayEmail = user.email || "Email unavailable";
  const avatarInitial = (user.name?.trim() || user.email || "B")
    .charAt(0)
    .toUpperCase();
  const usedSize = getNormalizedSize(vault?.usedBytes ?? 0);
  const capacitySize = getNormalizedSize(vault?.rawCapacityBytes ?? 0);
  const pct =
    vault && vault.rawCapacityBytes > 0
      ? Math.min(100, Math.round((vault.usedBytes / vault.rawCapacityBytes) * 100))
      : 0;

  useEffect(() => {
    let cancelled = false;

    const loadVault = async () => {
      try {
        const summary = await getVaultSummary();
        if (!cancelled) setVault(summary);
      } catch {
        if (!cancelled) setVaultLoadFailed(true);
      }
    };

    void loadVault();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSignOut = async () => {
    setIsSigningOut(true);
    setSignOutError(null);
    const didSignOut = await logout();
    if (didSignOut) {
      router.replace("/");
      router.refresh();
    } else {
      setSignOutError("Couldn’t sign out. Check your connection and try again.");
      setIsSigningOut(false);
    }
  };

  return (
    <div className="mt-auto sticky bottom-0 inset-x-0 bg-sidebar/80 backdrop-blur-md border-t border-border shadow-card p-3">
      <div className="h-px w-full bg-border mb-3" />

      <div className="flex items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-card font-semibold text-foreground"
          aria-hidden="true"
        >
          {avatarInitial}
        </div>

        <div className="min-w-0">
          <div className="font-medium leading-5 text-foreground truncate" title={displayName}>
            {displayName}
          </div>
          <div className="text-xs text-muted-foreground truncate" title={displayEmail}>
            {displayEmail}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm ml-auto shrink-0 text-foreground hover:text-foreground/90"
          onClick={onSignOut}
          disabled={isSigningOut}
          aria-busy={isSigningOut}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      {signOutError && (
        <p className="mt-2 text-xs text-error" role="alert">
          {signOutError}
        </p>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        {vault ? (
          <>
            <div className="mb-1 flex justify-between gap-2">
              <span>
                {usedSize.value} {usedSize.unit} used / {capacitySize.value}{" "}
                {capacitySize.unit} contributed
              </span>
              <span>{pct}%</span>
            </div>
            <div
              className="relative h-2 w-full overflow-hidden rounded-full bg-bz-surface/60 border border-bz-border"
              role="progressbar"
              aria-label="Vault storage used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="absolute inset-0 bg-primary/10" />
              <div
                className="relative h-full rounded-full shadow-glow-sm bg-primary"
                style={{ width: `${pct}%` }}
              />
              <div
                className="pointer-events-none absolute inset-0 rounded-full bg-primary-foreground/30 animate-shimmer w-full"
                style={{ transform: "translateX(-100%)" }}
              />
            </div>
            <div className="mt-1">
              {vault.onlineDeviceCount} of {vault.deviceCount}{" "}
              {vault.deviceCount === 1 ? "device" : "devices"} online
            </div>
          </>
        ) : (
          <span>{vaultLoadFailed ? "Storage details unavailable" : "Storage from your devices"}</span>
        )}
      </div>
    </div>
  );
};

export default SideBarAccountSection;
