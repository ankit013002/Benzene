import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  session,
} from "electron";

import {
  pairingCodeFromLog,
  navigationAction,
  validateSettings,
  type DesktopSettings,
} from "./config.js";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const settingsFile = (): string => path.join(app.getPath("userData"), "desktop-settings.json");
const pidFile = (): string => path.join(app.getPath("userData"), "agent.pid");
const logFile = (): string => path.join(app.getPath("userData"), "agent.log");
const agentScript = (): string => app.isPackaged
  ? path.join(process.resourcesPath, "node-agent.cjs")
  : path.join(__dirname, "node-agent.cjs");

let settings: DesktopSettings | undefined;
let mainWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let agentPid: number | undefined;

async function loadSettings(): Promise<DesktopSettings | undefined> {
  try {
    return validateSettings(JSON.parse(await readFile(settingsFile(), "utf8")) as DesktopSettings);
  } catch {
    return undefined;
  }
}

async function saveSettings(next: DesktopSettings): Promise<void> {
  const clean = validateSettings(next);
  const previous = settings;
  const activePid = await runningAgentPid();
  if (activePid && previous && JSON.stringify(previous) !== JSON.stringify(clean)) {
    try {
      process.kill(activePid, "SIGTERM");
    } catch (cause) {
      if (!(cause instanceof Error) || ("code" in cause && cause.code !== "ESRCH")) throw cause;
    }
    for (let attempt = 0; attempt < 25 && getCommandForPid(activePid)?.includes(agentScript()); attempt += 1) {
      await delay(200);
    }
    if (getCommandForPid(activePid)?.includes(agentScript())) {
      throw new Error("The computer's agent is still stopping. Wait a moment and save these settings again.");
    }
    await rm(pidFile(), { force: true });
    agentPid = undefined;
  }
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  await writeFile(settingsFile(), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  settings = clean;
}

function getCommandForPid(pid: number): string | undefined {
  if (process.platform === "win32") {
    const script = '$p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $env:BENZENE_DESKTOP_CHECK_PID); if ($p) { $p.CommandLine }';
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, BENZENE_DESKTOP_CHECK_PID: String(pid) },
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function runningAgentPid(): Promise<number | undefined> {
  try {
    const stored = JSON.parse(await readFile(pidFile(), "utf8")) as { pid?: unknown };
    if (typeof stored.pid !== "number" || !Number.isInteger(stored.pid) || stored.pid < 1) return undefined;
    const command = getCommandForPid(stored.pid);
    const expected = agentScript();
    if (command?.includes(expected)) return stored.pid;
  } catch {
    // A missing or stale pid file simply means the agent needs to be started.
  }
  await rm(pidFile(), { force: true });
  return undefined;
}

async function ensureAgentStarted(): Promise<void> {
  if (!settings) throw new Error("Set up your Vault connection first.");
  const alreadyRunning = await runningAgentPid();
  if (alreadyRunning) {
    agentPid = alreadyRunning;
    return;
  }

  const dataDir = path.join(app.getPath("home"), ".benzene");
  const logDescriptor = openSync(logFile(), "a", 0o600);
  const child = spawn(process.execPath, [agentScript()], {
    cwd: app.getPath("userData"),
    detached: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BENZENE_CONTROL_PLANE_URL: settings.gatewayUrl,
      BENZENE_ALLOCATED_BYTES: String(settings.allocationGb * 1024 ** 3),
      BENZENE_DEVICE_NAME: settings.deviceName,
      BENZENE_DATA_DIR: dataDir,
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });

  try {
    await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
    });
  } finally {
    closeSync(logDescriptor);
  }
  agentPid = child.pid;
  if (!agentPid) throw new Error("The local node agent did not start.");
  await writeFile(pidFile(), `${JSON.stringify({ pid: agentPid })}\n`, { mode: 0o600 });
  child.unref();
}

async function initialSettings(): Promise<DesktopSettings | null> {
  if (settings) return settings;
  return {
    appUrl: "http://localhost:3000",
    gatewayUrl: "http://localhost:8080",
    allocationGb: 100,
    deviceName: hostname() || "Benzene computer",
  };
}

async function readPairingCode(): Promise<string | undefined> {
  try {
    return pairingCodeFromLog(await readFile(logFile(), "utf8"));
  } catch {
    return undefined;
  }
}

function appRoute(route: string): string {
  if (!settings) throw new Error("Vault connection is not configured.");
  return new URL(route, `${settings.appUrl}/`).toString();
}

function createMainWindow(route = "/devices"): void {
  if (!settings) return;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: "Benzene",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const action = navigationAction(url, settings?.appUrl ?? "");
    if (action === "internal") void mainWindow?.loadURL(url);
    if (action === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const action = navigationAction(url, settings?.appUrl ?? "");
    if (action !== "internal") {
      event.preventDefault();
      if (action === "external") void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    const action = navigationAction(url, settings?.appUrl ?? "");
    if (action !== "internal") {
      event.preventDefault();
      if (action === "external") void shell.openExternal(url);
    }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  void mainWindow.loadURL(appRoute(route));
  installMenu();
}

function showPairingCode(): void {
  void readPairingCode().then(async (code) => {
    const parent = mainWindow ?? setupWindow;
    if (!code) {
      const options: Electron.MessageBoxOptions = {
        type: "info",
        title: "Computer is connecting",
        message: "Benzene has not received a pairing code yet.",
        detail: "Keep this app open while the computer contacts your Vault, then check again.",
      };
      if (parent) await dialog.showMessageBox(parent, options);
      else await dialog.showMessageBox(options);
      return;
    }
    const options: Electron.MessageBoxOptions = {
      type: "info",
      title: "Add this computer",
      message: `Pairing code: ${code}`,
      detail: "In the Devices page, enter this code to approve the computer. The code expires and can be used once.",
      buttons: ["Copy code", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
    const choice = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (choice.response === 0) clipboard.writeText(code);
  });
}

function openSetupWindow(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 650,
    resizable: false,
    title: "Set up Benzene",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const setupDocument = path.resolve(app.getAppPath(), "src", "setup.html");
  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (navigationAction(url, settings?.appUrl ?? "") === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  setupWindow.webContents.on("will-navigate", (event, url) => {
    let targetPath: string | undefined;
    try {
      targetPath = fileURLToPath(url);
    } catch {
      // Malformed and non-file URLs cannot be allowed to inherit the setup preload.
    }
    if (targetPath !== setupDocument) event.preventDefault();
  });
  setupWindow.on("closed", () => { setupWindow = undefined; });
  void setupWindow.loadURL(pathToFileURL(setupDocument).toString());
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Benzene",
      submenu: [
        { label: "Vault", click: () => mainWindow?.loadURL(appRoute("/files")) },
        { label: "Devices", click: () => mainWindow?.loadURL(appRoute("/devices")) },
        { label: "Show pairing code", click: showPairingCode },
        { type: "separator" },
        { label: "Connection settings…", click: openSetupWindow },
        { role: "quit" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("desktop:get-settings", initialSettings);
ipcMain.handle("desktop:save-settings", async (_event, input: DesktopSettings) => {
  await saveSettings(input);
  await ensureAgentStarted();
  return { pairingCode: await readPairingCode() };
});
ipcMain.handle("desktop:open-vault", () => {
  if (!settings) throw new Error("Save your connection settings first.");
  setupWindow?.close();
  if (!mainWindow) createMainWindow();
  else void mainWindow.loadURL(appRoute("/devices"));
});
ipcMain.handle("desktop:show-code", showPairingCode);

app.whenReady().then(async () => {
  if (!gotLock) return;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  settings = await loadSettings();
  if (!settings) {
    openSetupWindow();
    return;
  }
  try {
    await ensureAgentStarted();
    createMainWindow();
    if (await readPairingCode()) showPairingCode();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The local node agent could not start.";
    await dialog.showErrorBox("Benzene could not start", message);
    openSetupWindow();
  }
});

app.on("second-instance", () => {
  mainWindow?.show();
  setupWindow?.show();
});

app.on("before-quit", () => {
  // The detached agent intentionally survives so closing or restarting the UI
  // does not interrupt storage participation.
});
