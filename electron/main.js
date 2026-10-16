// BloxdForge desktop shell: runs the bundled Next.js standalone server in an
// Electron utility process and shows it in a window.
const { app, BrowserWindow, dialog, desktopCapturer, session, shell, utilityProcess } = require("electron");
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

  server = utilityProcess.fork(path.join(dir, "server.js"), [], {
    cwd: dir,
    serviceName: "BloxdForge Server",
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: HOST,
      PORT: String(PORT),
    },
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on("exit", (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox("BloxdForge", `The app server stopped unexpectedly (code ${code}).\n\nLog: ${logPath}`);
      app.quit();
    }
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
