"use client";

import { useRef, useState, type FormEvent } from "react";
import { unlockVaultWithRecoveryKit } from "@/utils/file-system/vaultKey";

interface RecoveryKitUnlockFormProps {
  vaultId: string | null;
  onUnlocked: () => void;
}

/** The selected recovery kit and passphrase exist only for the import attempt. */
export default function RecoveryKitUnlockForm({ vaultId, onUnlocked }: RecoveryKitUnlockFormProps) {
  const [kitFile, setKitFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const clearForm = (): void => {
    setKitFile(null);
    setPassphrase("");
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!vaultId || !kitFile || !passphrase) return;
    const submittedPassphrase = passphrase;
    const submittedFile = kitFile;
    setPassphrase("");
    setKitFile(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
    try {
      await unlockVaultWithRecoveryKit(vaultId, await submittedFile.text(), submittedPassphrase);
      onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this recovery kit.");
    } finally {
      setPassphrase("");
      setKitFile(null);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-4 my-2 rounded-lg border border-border bg-card px-4 py-3">
      <p className="mb-3 text-sm text-muted-foreground">
        Import the current Vault recovery kit to upload and download encrypted files. The key stays in this tab’s memory.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label htmlFor="vault-recovery-kit" className="mb-1 block text-sm">Vault recovery kit</label>
          <input
            ref={fileInput}
            id="vault-recovery-kit"
            type="file"
            accept="application/json,.json"
            className="file-input file-input-bordered file-input-sm w-full"
            disabled={!vaultId}
            onChange={(event) => setKitFile(event.currentTarget.files?.[0] ?? null)}
          />
        </div>
        <div className="min-w-56 flex-1">
          <label htmlFor="vault-recovery-passphrase" className="mb-1 block text-sm">Recovery passphrase</label>
          <input
            id="vault-recovery-passphrase"
            type="password"
            autoComplete="off"
            className="input input-bordered input-sm w-full"
            value={passphrase}
            minLength={16}
            required
            disabled={!vaultId}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
          />
        </div>
        <button type="submit" className="btn btn-sm btn-outline" disabled={!vaultId || !kitFile || passphrase.length < 16}>
          Import recovery kit
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={clearForm}>
          Cancel
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
