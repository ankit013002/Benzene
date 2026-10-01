import type { DesktopSettings } from "./config.js";

declare global {
  interface Window {
    benzeneDesktop: {
      getSettings(): Promise<DesktopSettings | null>;
      saveSettings(settings: DesktopSettings): Promise<{ pairingCode?: string }>;
      openVault(): Promise<void>;
      showPairingCode(): Promise<void>;
    };
  }
}

const form = document.querySelector<HTMLFormElement>("#setup-form");
const status = document.querySelector<HTMLElement>("#status");
const submit = document.querySelector<HTMLButtonElement>("#submit");

function setInputValue(selector: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (input) input.value = value;
}

function showStatus(message: string, isError = false): void {
  if (!status) return;
  status.textContent = message;
  status.dataset.error = String(isError);
}

void window.benzeneDesktop.getSettings().then((saved) => {
  if (!saved) return;
  setInputValue("#app-url", saved.appUrl);
  setInputValue("#gateway-url", saved.gatewayUrl);
  setInputValue("#allocation-gb", String(saved.allocationGb));
  setInputValue("#device-name", saved.deviceName);
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!submit) return;
  submit.disabled = true;
  showStatus("Connecting this computer to your Vault…");
  try {
    const settings: DesktopSettings = {
      appUrl: (document.querySelector<HTMLInputElement>("#app-url")?.value ?? "").trim(),
      gatewayUrl: (document.querySelector<HTMLInputElement>("#gateway-url")?.value ?? "").trim(),
      allocationGb: Number(document.querySelector<HTMLInputElement>("#allocation-gb")?.value),
      deviceName: (document.querySelector<HTMLInputElement>("#device-name")?.value ?? "").trim(),
    };
    await window.benzeneDesktop.saveSettings(settings);
    showStatus("The node agent is running separately. Opening Devices so you can approve this computer…");
    await window.benzeneDesktop.openVault();
  } catch (cause) {
    showStatus(cause instanceof Error ? cause.message : "Benzene could not start. Check the addresses and try again.", true);
    submit.disabled = false;
  }
});
