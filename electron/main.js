// BloxdForge desktop shell: runs the bundled Next.js standalone server in an
// Electron utility process and shows it in a window.
const { app, BrowserWindow, Menu, dialog, desktopCapturer, session, shell, utilityProcess } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// The port is fixed on purpose: IndexedDB and localStorage are keyed by origin,
// so a different port would hide the user's saved projects and settings.
// Use the IP literal rather than "localhost" so the app's HSTS header is ignored.
const HOST = "127.0.0.1";
const PORT = Number(process.env.BLOXDFORGE_PORT) || 38917;
const ORIGIN = `http://${HOST}:${PORT}`;
const START_PATH = "/studio";
const ASSETS_ZIP = "BloxdForge-Assets.zip";
const ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);

let server = null;
let mainWindow = null;
let quitting = false;

function serverDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "..", "dist-server");
}

// Workshop assets are too large to sign and notarize inside the app, so they're
// installed separately (BloxdForge-Assets.zip). Unpackaged runs use the repo copy.
function assetsDir() {
  return app.isPackaged
    ? path.join(app.getPath("userData"), "assets")
    : path.join(__dirname, "..", "data", "assets");
}

function assetsInstalled() {
  return fs.existsSync(path.join(assetsDir(), "manifest.json"));
}

// Checks where the zip usually is: the mounted BloxdForge DMG, Downloads, Desktop.
function findAssetsZip() {
  let volumes = [];
  try {
    volumes = fs.readdirSync("/Volumes").map((name) => path.join("/Volumes", name));
  } catch {
    // No /Volumes; fall through to the user folders.
  }
  return [...volumes, app.getPath("downloads"), app.getPath("desktop")]
    .map((dir) => path.join(dir, ASSETS_ZIP))
    .find((file) => fs.existsSync(file));
}

// Extracts into a staging folder first so a failed or partial install never
// replaces a working one.
async function extractAssets(zipPath) {
  const target = assetsDir();
  const staging = `${target}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/ditto", ["-x", "-k", zipPath, staging], (err) => (err ? reject(err) : resolve()));
    });
    const extracted = path.join(staging, "assets");
    if (!fs.existsSync(path.join(extracted, "manifest.json"))) {
      throw new Error(`${path.basename(zipPath)} is not a BloxdForge workshop assets archive.`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(extracted, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function showStatusWindow(message) {
  const win = new BrowserWindow({
    width: 420,
    height: 120,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    backgroundColor: "#0a0a0a",
    title: "BloxdForge",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const html = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#ddd;font:14px -apple-system,sans-serif">${message}</body>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

async function installAssets(zipPath) {
  const status = showStatusWindow("Installing workshop assets\u2026 this takes a minute or two.");
  try {
    await extractAssets(zipPath);
    return true;
  } catch (err) {
    dialog.showErrorBox("BloxdForge", `Couldn't install workshop assets.\n\n${err.message || err}`);
    return false;
  } finally {
    status.destroy();
  }
}

// On launch, offers to install the assets zip if it's lying around (for example
// on the DMG it came with) and the assets aren't installed yet.
async function offerAssetsInstall() {
  if (!app.isPackaged || assetsInstalled()) return;
  const zipPath = findAssetsZip();
  if (!zipPath) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Install", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Install workshop assets?",
    detail: `Found ${zipPath}.\n\nThis copies about 4 GB and takes a minute or two. Without the assets, the workshop loads files from the internet. You can also install them later from File > Install Workshop Assets.`,
  });
  if (response === 0) await installAssets(zipPath);
}

// File > Install Workshop Assets: the server caches the asset list, so it's
// restarted after installing.
async function importAssets() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Install Workshop Assets",
    defaultPath: findAssetsZip() ?? app.getPath("downloads"),
    filters: [{ name: "BloxdForge workshop assets", extensions: ["zip"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return;
  await stopServer();
  await installAssets(filePaths[0]);
  startServer();
  try {
    await waitForServer(30000);
  } catch (err) {
    dialog.showErrorBox("BloxdForge", String(err.message || err));
    app.quit();
    return;
  }
  if (mainWindow) mainWindow.reload();
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          // Unpackaged runs read the repo's data/assets, which this would overwrite.
          { label: "Install Workshop Assets\u2026", enabled: app.isPackaged, click: () => importAssets() },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${ORIGIN}${START_PATH}`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Server did not start on ${ORIGIN}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function startServer() {
  const dir = serverDir();
  const logPath = path.join(app.getPath("logs"), "server.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: "w" });

  const proc = utilityProcess.fork(path.join(dir, "server.js"), [], {
    cwd: dir,
    serviceName: "BloxdForge Server",
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: HOST,
      PORT: String(PORT),
      BLOXDFORGE_ASSETS_DIR: assetsDir(),
    },
  });
  server = proc;
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  proc.on("exit", (code) => {
    // stopServer() clears `server` first, so a deliberate stop isn't reported.
    if (server !== proc) return;
    server = null;
    if (!quitting) {
      dialog.showErrorBox("BloxdForge", `The app server stopped unexpectedly (code ${code}).\n\nLog: ${logPath}`);
      app.quit();
    }
  });
}

function stopServer() {
  const proc = server;
  if (!proc) return Promise.resolve();
  server = null;
  return new Promise((resolve) => {
    proc.once("exit", resolve);
    proc.kill();
  });
}

function isAppUrl(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") shell.openExternal(url);
  } catch {
    // Ignore malformed URLs.
  }
}

function configureSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Screen recording (Play and Recorder pages). Prefers the macOS system picker.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0a0a0a",
    title: "BloxdForge",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const { webContents } = mainWindow;
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow" };
    openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${ORIGIN}${START_PATH}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (!(await isPortFree(PORT))) {
      dialog.showErrorBox(
        "BloxdForge",
        `Port ${PORT} is already in use by another program, so BloxdForge can't start.`,
      );
      app.quit();
      return;
    }
    configureSession();
    buildMenu();
    await offerAssetsInstall();
    startServer();
    try {
      await waitForServer(30000);
    } catch (err) {
      dialog.showErrorBox("BloxdForge", String(err.message || err));
      app.quit();
      return;
    }
    createWindow();
    app.on("activate", () => {
      if (!mainWindow) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    if (server) server.kill();
  });
}
