"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  acknowledgeRecoveryKitSaved,
  createVaultRecoveryKit,
  hasDesktopKeyBridge,
  isVaultKeyPersisted,
  isVaultRecoveryAcknowledged,
  loadUnlockedVaultKey,
  unlockVaultWithRecoveryKit,
} from "@/utils/file-system/vaultKey";

interface RecoveryKitUnlockFormProps {
  vaultId: string | null;
  onUnlocked: (persisted: boolean) => void;
}

/** Recovery kit contents and passphrases stay in the current renderer only. */
export default function RecoveryKitUnlockForm({ vaultId, onUnlocked }: RecoveryKitUnlockFormProps) {
  const [kitFile, setKitFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [createPassphrase, setCreatePassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [desktopBridgeAvailable, setDesktopBridgeAvailable] = useState(false);
  const [recoveryKitReady, setRecoveryKitReady] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setDesktopBridgeAvailable(hasDesktopKeyBridge()), []);
  useEffect(() => {
    if (!vaultId) return;
    let active = true;
    void loadUnlockedVaultKey(vaultId).then((key) => {
      if (active && key) {
        setAcknowledged(isVaultRecoveryAcknowledged(vaultId));
        onUnlocked(isVaultKeyPersisted(vaultId));
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not restore the saved Vault key.");
    });
    return () => { active = false; };
  }, [vaultId, onUnlocked]);

  const clearForm = (): void => {
    setKitFile(null);
    setPassphrase("");
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!vaultId || !kitFile || !passphrase || busy) return;
    const submittedPassphrase = passphrase;
    const submittedFile = kitFile;
    setPassphrase("");
    setKitFile(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
    setBusy(true);
    try {
      const persisted = await unlockVaultWithRecoveryKit(vaultId, await submittedFile.text(), submittedPassphrase);
      setAcknowledged(isVaultRecoveryAcknowledged(vaultId));
      setRecoveryKitReady(false);
      onUnlocked(persisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this recovery kit.");
    } finally {
      setPassphrase("");
      setKitFile(null);
      setBusy(false);
    }
  };

  const exportKit = async (): Promise<void> => {
    if (!vaultId || busy) return;
    if (createPassphrase.length < 16 || createPassphrase.trim().length === 0) {
      setError("Use a unique recovery passphrase with at least 16 characters; six random words are recommended.");
      return;
    }
    if (createPassphrase !== confirmPassphrase) {
      setError("The recovery passphrases do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const kit = await createVaultRecoveryKit(vaultId, createPassphrase);
      const blob = new Blob([kit], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `benzene-vault-recovery-${vaultId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setRecoveryKitReady(true);
      setAcknowledged(false);
      setCreatePassphrase("");
      setConfirmPassphrase("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the recovery kit.");
    } finally {
      setBusy(false);
    }
  };

  const confirmSavedKit = async (): Promise<void> => {
    if (!vaultId || busy || !recoveryKitReady) return;
    setBusy(true);
    setError(null);
    try {
      const persisted = await acknowledgeRecoveryKitSaved(vaultId);
      setAcknowledged(true);
      setRecoveryKitReady(false);
      onUnlocked(persisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the recovery kit.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-4 my-2 rounded-lg border border-border bg-card px-4 py-3">
      <p className="mb-3 text-sm text-muted-foreground">
        Create or import this Vault’s recovery kit before uploading encrypted files.
        {desktopBridgeAvailable
          ? " This desktop app saves the key through the operating system’s secure storage."
          : " The key stays in this browser tab’s memory and must be imported again after a reload."}
      </p>
      <div className="mb-4 rounded-md border border-border p-3">
        <h2 className="mb-2 text-sm font-semibold">Create or export recovery kit</h2>
        <p className="mb-3 text-xs text-muted-foreground">Choose a unique passphrase with at least 16 characters. Keep it separate from the downloaded JSON file.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="create-vault-recovery-passphrase" className="mb-1 block text-sm">New recovery passphrase</label>
            <input id="create-vault-recovery-passphrase" type="password" autoComplete="new-password" className="input input-bordered input-sm w-full" value={createPassphrase} minLength={16} disabled={!vaultId || busy} onChange={(event) => setCreatePassphrase(event.currentTarget.value)} />
          </div>
          <div className="min-w-56 flex-1">
            <label htmlFor="confirm-vault-recovery-passphrase" className="mb-1 block text-sm">Confirm passphrase</label>
            <input id="confirm-vault-recovery-passphrase" type="password" autoComplete="new-password" className="input input-bordered input-sm w-full" value={confirmPassphrase} minLength={16} disabled={!vaultId || busy} onChange={(event) => setConfirmPassphrase(event.currentTarget.value)} />
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={!vaultId || busy || createPassphrase.length < 16 || confirmPassphrase.length < 16} onClick={() => void exportKit()}>
            {busy ? "Preparing recovery kit…" : "Download encrypted recovery kit"}
          </button>
        </div>
        {recoveryKitReady && !acknowledged && <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">The recovery file was downloaded. Uploads remain disabled until you confirm you saved it safely.</p>
          <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => void confirmSavedKit()}>I saved the recovery kit safely</button>
        </div>}
        {acknowledged && <p role="status" className="mt-2 text-sm text-muted-foreground">Recovery kit confirmed for this session. Encrypted uploads are enabled.</p>}
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="vault-recovery-kit" className="mb-1 block text-sm">Vault recovery kit</label>
            <input ref={fileInput} id="vault-recovery-kit" type="file" accept="application/json,.json" className="file-input file-input-bordered file-input-sm w-full" disabled={!vaultId || busy} onChange={(event) => setKitFile(event.currentTarget.files?.[0] ?? null)} />
          </div>
          <div className="min-w-56 flex-1">
            <label htmlFor="vault-recovery-passphrase" className="mb-1 block text-sm">Recovery passphrase</label>
            <input id="vault-recovery-passphrase" type="password" autoComplete="off" className="input input-bordered input-sm w-full" value={passphrase} minLength={16} required disabled={!vaultId || busy} onChange={(event) => setPassphrase(event.currentTarget.value)} />
          </div>
          <button type="submit" className="btn btn-sm btn-outline" disabled={!vaultId || !kitFile || passphrase.length < 16 || busy}>Import recovery kit</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={clearForm}>Cancel</button>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      </form>
    </section>
  );
}
