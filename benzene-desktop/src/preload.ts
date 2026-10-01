import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("benzeneDesktop", {
  loadVaultKey: (vaultId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:load-vault-key", vaultId),
  saveVaultKey: (vaultId: string, keyHex: string): Promise<boolean> =>
    ipcRenderer.invoke("desktop:save-vault-key", vaultId, keyHex),
});
