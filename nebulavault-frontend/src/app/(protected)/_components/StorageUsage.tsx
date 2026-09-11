"use client";

import React, { useEffect, useState } from "react";

import { getNormalizedSize } from "@/utils/file-system/NormalizedSize";
import { getVaultSummary, type VaultSummary } from "@/utils/vault";

interface ProtectionSummary {
  mode: string;
  desiredReplicas: number;
  singleCopy: boolean;
  totalObjects: number;
  state: "healthy" | "degraded" | "at_risk" | "unprotected" | "empty";
}

const PROTECTION_LABEL: Record<ProtectionSummary["state"], string> = {
  healthy: "Protected",
  degraded: "Restoring protection",
  at_risk: "At risk",
  unprotected: "Not protected",
  empty: "Nothing stored yet",
};

/**
 * Colour is spent only where it carries meaning. Everything else in Benzene is
 * greyscale, so a coloured dot here reads as a status rather than decoration.
 */
const PROTECTION_TONE: Record<ProtectionSummary["state"], string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  at_risk: "bg-destructive",
  unprotected: "bg-destructive",
  empty: "bg-muted-foreground",
};

function formatBytes(bytes: number): string {
  const size = getNormalizedSize(bytes);
  return `${size.value} ${size.unit}`;
}

/**
 * The Vault header: how much storage the user's own devices contribute, how
 * much is in use, and whether it is safe.
 *
 * Capacity comes from the devices themselves rather than a fixed quota — the
 * whole premise is that the user already owns the storage.
 */
const StorageUsage = () => {
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [protection, setProtection] = useState<ProtectionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [protectionLoadFailed, setProtectionLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const [vaultResult, protectionResult] = await Promise.allSettled([
        getVaultSummary(),
        fetch("/api/protection", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error("Could not load protection status");
          return (await response.json()) as { data?: ProtectionSummary };
        }),
      ]);

      if (cancelled) return;

      if (vaultResult.status === "fulfilled") {
        setVault(vaultResult.value);
      } else {
        setError(
          vaultResult.reason instanceof Error
            ? vaultResult.reason.message
            : "Could not load your vault",
        );
      }

      if (protectionResult.status === "fulfilled") {
        setProtection(protectionResult.value.data ?? null);
      } else {
        setProtectionLoadFailed(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const capacity = vault?.rawCapacityBytes ?? 0;
  const used = vault?.usedBytes ?? 0;
  const percentUsed = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  const state = protection?.state ?? "empty";
  const protectionLabel = protectionLoadFailed
    ? "Protection unavailable"
    : PROTECTION_LABEL[state];
  const protectionTone = protectionLoadFailed
    ? "bg-muted-foreground"
    : PROTECTION_TONE[state];

  return (
    <section className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium tracking-tight text-foreground">
            {vault?.name ?? "Your Vault"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {vault
              ? `${vault.onlineDeviceCount} of ${vault.deviceCount} device${
                  vault.deviceCount === 1 ? "" : "s"
                } online`
              : error
                ? "Vault unavailable"
                : "Loading…"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${protectionTone}`}
          />
          <span className="text-xs text-muted-foreground">
            {protectionLabel}
          </span>
        </div>
      </header>

      <div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-all duration-500"
            style={{ width: `${percentUsed}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>{formatBytes(used)} used</span>
          <span>{formatBytes(capacity)} contributed</span>
        </div>
      </div>

      {/*
        Capacity on devices that are currently asleep cannot be written to, so
        it is reported separately rather than folded into one number.
      */}
      {vault && vault.onlineCapacityBytes < vault.rawCapacityBytes && (
        <p className="text-xs text-muted-foreground">
          {formatBytes(vault.onlineCapacityBytes)} available right now — the rest is
          on devices that are offline.
        </p>
      )}

      {protection?.singleCopy && (
        <p className="text-xs text-destructive">
          Maximum Capacity keeps a single copy. If that device fails, those files
          are gone permanently.
        </p>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
};

export default StorageUsage;
