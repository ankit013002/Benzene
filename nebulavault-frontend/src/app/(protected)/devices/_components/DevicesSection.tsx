"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { getNormalizedSize } from "@/utils/file-system/NormalizedSize";

interface Device {
  id: string;
  name: string;
  platform: string;
  status: string;
  allocatedBytes: number;
  usedBytes: number;
  lastSeenAt: string | null;
  appVersion: string | null;
  removalReady: boolean;
}

const GB = 1024 * 1024 * 1024;
const REMOVAL_POLL_INTERVAL_MS = 5_000;

interface LoadOptions {
  silent?: boolean;
}

/** Consumer wording, not the internal state name (product §42). */
const STATUS_LABEL: Record<string, string> = {
  online: "Online",
  offline: "Offline",
  pending: "Waiting to connect",
  extended_offline: "Offline for a while",
  suspected_lost: "Not seen recently",
  draining: "Being removed",
};

/** Colour only where it carries meaning; everything else stays greyscale. */
const STATUS_TONE: Record<string, string> = {
  online: "bg-success",
  draining: "bg-warning",
  suspected_lost: "bg-destructive",
};

function formatBytes(bytes: number): string {
  const size = getNormalizedSize(bytes);
  return `${size.value} ${size.unit}`;
}

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never connected";
  return `Last seen ${new Date(lastSeenAt).toLocaleString()}`;
}

export default function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [code, setCode] = useState("");
  const [allocationGb, setAllocationGb] = useState("100");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async ({ silent = false }: LoadOptions = {}): Promise<Device[] | null> => {
    try {
      if (!silent && mountedRef.current) setError(null);
      const devicesRes = await fetch("/api/devices");
      if (!devicesRes.ok) throw new Error("Could not load your devices");

      const nextDevices = ((await devicesRes.json()) as { data?: Device[] }).data ?? [];

      if (mountedRef.current) {
        setDevices(nextDevices);
      }
      return nextDevices;
    } catch (e) {
      if (mountedRef.current && !silent) {
        setError(e instanceof Error ? e.message : "Something went wrong");
        setDevices([]);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const drainingDeviceKey =
    devices?.filter((device) => device.status === "draining").map((device) => device.id).join(",") ?? "";

  useEffect(() => {
    if (!drainingDeviceKey) return;

    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = async () => {
      const nextDevices = await load({ silent: true });
      if (cancelled) return;

      const shouldContinue = nextDevices
        ? nextDevices.some((device) => device.status === "draining")
        : true;
      if (shouldContinue) {
        timeoutId = window.setTimeout(() => void poll(), REMOVAL_POLL_INTERVAL_MS);
      }
    };

    timeoutId = window.setTimeout(() => void poll(), REMOVAL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [drainingDeviceKey, load]);

  const approve = async (action: "approve" | "reject"): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/devices/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          code: code.trim(),
          allocatedBytes: Math.round(Number(allocationGb) * GB),
        }),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "That code was not accepted");
      }
      setNotice(action === "approve" ? "Device added to your vault." : "Request declined.");
      setCode("");
      await load();
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const retire = async (device: Device): Promise<void> => {
    const confirmed = window.confirm(
      `Remove “${device.name}” from your Vault? Benzene will move protected data to other devices, then remove this computer from the Vault and delete only Benzene-managed files on it. This cannot be undone.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/devices/${device.id}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? "Could not start removing that device");
      }
      if (!mountedRef.current) return;
      setNotice(
        `${device.name} is being removed. Benzene will move its protected data, then finish cleanup when the computer is online.`,
      );
      await load();
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-medium tracking-tight">Add a device</h2>
          <p className="text-xs text-muted-foreground">
            Install Benzene on the computer, then enter the code it shows you.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Pairing code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              className="w-40 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm tracking-widest outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Storage to contribute (GB)</span>
            <input
              value={allocationGb}
              onChange={(e) => setAllocationGb(e.target.value)}
              inputMode="numeric"
              className="w-44 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          <button
            type="button"
            onClick={() => void approve("approve")}
            disabled={busy || code.trim() === ""}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            Add to vault
          </button>

          <button
            type="button"
            onClick={() => void approve("reject")}
            disabled={busy || code.trim() === ""}
            className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40"
          >
            Decline
          </button>
        </div>

        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </section>

      <section className="rounded-2xl border border-border bg-card">
        {devices === null ? (
          <p className="p-5 text-sm text-muted-foreground">Loading…</p>
        ) : devices.length === 0 ? (
          <div className="p-5">
            <p className="text-sm">No devices yet.</p>
            <p className="text-xs text-muted-foreground">
              Your vault has no storage until you add a computer.
            </p>
          </div>
        ) : (
          <ul>
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-48">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 rounded-full ${
                        STATUS_TONE[device.status] ?? "bg-muted-foreground"
                      }`}
                    />
                    <span className="text-sm font-medium">{device.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {device.status === "draining" && device.removalReady
                      ? "Finishing removal"
                      : STATUS_LABEL[device.status] ?? device.status} ·{" "}
                    {formatLastSeen(device.lastSeenAt)}
                  </p>
                  {device.status === "draining" && !device.removalReady && (
                    <p className="text-xs text-muted-foreground">
                      Benzene is moving this computer’s data to protected copies elsewhere.
                    </p>
                  )}
                  {device.status === "draining" && device.removalReady && (
                    <p className="text-xs text-muted-foreground">
                      Protection is restored. Benzene is waiting for this computer to come online and finish removing its Benzene data.
                    </p>
                  )}
                </div>

                <div className="text-xs text-muted-foreground">
                  {formatBytes(device.usedBytes)} of {formatBytes(device.allocatedBytes)} used
                </div>

                <button
                  type="button"
                  onClick={() => void retire(device)}
                  disabled={busy || device.status === "draining"}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {device.status === "draining"
                    ? device.removalReady
                      ? "Finishing removal…"
                      : "Removing…"
                    : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
