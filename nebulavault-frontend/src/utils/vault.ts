export interface VaultSummary {
  name: string;
  rawCapacityBytes: number;
  onlineCapacityBytes: number;
  usedBytes: number;
  deviceCount: number;
  onlineDeviceCount: number;
}

let inFlightRequest: Promise<VaultSummary> | null = null;

/** Keep the sidebar and Vault header from issuing the same request together. */
export function getVaultSummary(): Promise<VaultSummary> {
  if (!inFlightRequest) {
    inFlightRequest = fetch("/api/vault", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load your vault");
        const payload = (await response.json()) as { data?: VaultSummary };
        if (!payload.data) throw new Error("Could not load your vault");
        return payload.data;
      })
      .finally(() => {
        inFlightRequest = null;
      });
  }

  return inFlightRequest;
}
