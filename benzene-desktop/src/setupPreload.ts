import { contextBridge, ipcRenderer } from "electron";

import type { DesktopSettings } from "./config.js";

contextBridge.exposeInMainWorld("benzeneDesktop", {
  getSettings: (): Promise<DesktopSettings | null> => ipcRenderer.invoke("desktop:get-settings"),
  saveSettings: (settings: DesktopSettings): Promise<{ pairingCode?: string }> =>
    ipcRenderer.invoke("desktop:save-settings", settings),
  openVault: (): Promise<void> => ipcRenderer.invoke("desktop:open-vault"),
  showPairingCode: (): Promise<void> => ipcRenderer.invoke("desktop:show-code"),
});
