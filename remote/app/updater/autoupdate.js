"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupAutoUpdate = void 0;
// Self-update for this app: the same updater the Arena Link app uses (see updater.ts), wired up with the few things this app has to say:
// whether something is live right now, and how to stop it cleanly before the installer replaces the files.
//
// Where releases come from: the Arena Link directory (the portal publishes the installers there). The address and access key are built in,
// so a fresh install needs no setup. To change them, or to choose when updates install, put any of these in
// "update-config.json" in the app's data folder (%APPDATA%\<app name>):
//   { "directory": "http://main:8002,http://backup:8002", "key": "...", "updateMode": "idle" | "ask" | "off", "updateWindow": {"from":"02:00","to":"05:00"} }
const electron_1 = require("electron");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const updater_1 = require("./updater");
const DEFAULT_DIRECTORY = 'http://5.78.236.254:8002';
const DEFAULT_KEY = '5jpmzaedzkm5';
function readCfg() {
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(path.join(electron_1.app.getPath('userData'), 'update-config.json'), 'utf8'));
    }
    catch { /* none: use the built-in values */ }
    // Default 'ask': installing needs administrator approval (Windows asks), so an unattended computer must not start it by itself. The window shows
    // "Update ready - Install now"; a connected viewer can approve the Windows prompt through the elevated helper.
    const mode = user.updateMode === 'idle' || user.updateMode === 'off' ? user.updateMode : 'ask';
    return { directory: String(user.directory || DEFAULT_DIRECTORY), key: String(user.key || DEFAULT_KEY), updateMode: mode, updateWindow: user.updateWindow ?? null };
}
function setupAutoUpdate(o) {
    let updater = null;
    // The handlers exist in every run so the window never errors; only the installed app actually checks for updates.
    electron_1.ipcMain.handle('updater-status', () => updater?.status() ?? { state: 'idle' });
    electron_1.ipcMain.handle('updater-install-now', () => { void updater?.installNow(); return true; });
    electron_1.ipcMain.handle('updater-check-now', () => { void updater?.checkNow(); return true; });
    if (!electron_1.app.isPackaged)
        return;
    updater = (0, updater_1.startUpdater)({
        app: o.app, version: electron_1.app.getVersion(), host: os.hostname(), dir: path.join(electron_1.app.getPath('userData'), 'updates'),
        config: readCfg,
        isLive: o.isLive,
        prepareToQuit: o.prepareToQuit,
        quit: () => electron_1.app.quit(),
        onStatus: s => o.send('updater-status', s),
        log: m => console.log(m),
    });
}
exports.setupAutoUpdate = setupAutoUpdate;
