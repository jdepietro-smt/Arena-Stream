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
exports.installerPath = exports.startUpdater = void 0;
// Software updates inside the app: every ten minutes ask the directory whether a newer version is offered to this PC, download it
// in the background, and install it at a safe moment (see installDecision). The installer is the same NSIS installer people use
// by hand, run silently; it replaces the app and starts it again.
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const update_core_1 = require("./update-core");
const update_net_1 = require("./update-net");
const dirs_1 = require("./dirs");
const CHECK_EVERY_MS = 10 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
function startUpdater(env) {
    let status = { state: 'idle' };
    let offer = null;
    let file = null; // downloaded and checked
    let busy = false, manual = false, idleSince = Date.now(), failures = 0;
    const set = (s) => { status = s; env.onStatus(s); };
    const mode = () => env.config().updateMode ?? 'idle';
    async function check() {
        if (busy || status.state === 'installing')
            return;
        const c = env.config();
        if (mode() === 'off') {
            set({ state: 'off', checkedAt: Date.now() });
            return;
        }
        if (!c.directory || !c.key)
            return;
        busy = true;
        try {
            set({ ...status, state: file ? 'ready' : 'checking' });
            const o = await (0, dirs_1.withDirectories)(c.directory, u => (0, update_net_1.checkOffer)({ directory: u, key: c.key, app: env.app, host: env.host, version: env.version }), dirs_1.dirState);
            if (!(0, update_core_1.worthTaking)(o, env.version)) {
                // "nothing to install" from the backup directory is not proof: it may simply not hold the release files. Only the main
                // directory (first address) can withdraw an update that is already downloaded.
                if (dirs_1.dirState.last !== 0 && file && offer) {
                    set({ state: 'ready', pending: offer.version, checkedAt: Date.now(), waiting: (0, update_core_1.installDecision)(ctx()).waiting });
                    return;
                }
                offer = null;
                file = null;
                (0, update_net_1.cleanOld)(env.dir, null);
                set({ state: 'idle', checkedAt: Date.now() });
                failures = 0;
                return;
            }
            if (!file || !offer || offer.version !== o.version || offer.sha256 !== o.sha256) {
                offer = o;
                file = null;
                set({ state: 'downloading', pending: o.version, pct: 0, checkedAt: Date.now() });
                env.log(`[update] ${o.version} is offered, downloading`);
                let last = 0;
                file = await (0, dirs_1.withDirectories)(c.directory, u => (0, update_net_1.downloadRelease)({ directory: u, key: c.key, app: env.app, offer: o, dir: env.dir, onProgress: pct => { if (pct !== last && pct % 5 === 0) {
                        last = pct;
                        set({ state: 'downloading', pending: o.version, pct, checkedAt: Date.now() });
                    } } }), dirs_1.dirState);
                (0, update_net_1.cleanOld)(env.dir, o.file);
                env.log(`[update] ${o.version} downloaded and checked`);
            }
            failures = 0;
            set({ state: 'ready', pending: offer.version, checkedAt: Date.now(), waiting: (0, update_core_1.installDecision)(ctx()).waiting });
        }
        catch (e) {
            failures++;
            const msg = e.message;
            env.log(`[update] ${msg}`);
            set({ state: 'error', pending: offer?.version, error: msg, checkedAt: Date.now() });
        }
        finally {
            busy = false;
        }
    }
    const ctx = () => ({ mode: mode(), live: env.isLive(), idleMs: Date.now() - idleSince, now: new Date(), window: env.config().updateWindow, manual });
    async function tick() {
        if (env.isLive())
            idleSince = Date.now();
        if (status.state !== 'ready' || !file || !offer)
            return;
        const d = (0, update_core_1.installDecision)(ctx());
        if (d.waiting !== status.waiting)
            set({ ...status, waiting: d.waiting });
        if (d.install)
            await install();
    }
    async function install() {
        if (!file || status.state === 'installing')
            return;
        const target = file, version = offer?.version;
        set({ state: 'installing', pending: version });
        env.log(`[update] installing ${version}: stopping everything first`);
        try {
            await env.prepareToQuit();
            // The same silent switches electron-updater uses: no screens, and the installer starts the new app afterwards.
            const args = ['/S', '--updated', '--force-run'];
            if (env.run)
                env.run(target, args);
            else
                (0, node_child_process_1.spawn)(target, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
        catch (e) {
            set({ state: 'error', pending: version, error: `could not start the installer: ${e.message}` });
            manual = false;
            return;
        }
        setTimeout(env.quit, 1500);
    }
    setTimeout(() => { void check(); }, FIRST_CHECK_MS).unref?.();
    setInterval(() => { void check(); }, CHECK_EVERY_MS).unref?.();
    setInterval(() => { void tick(); }, 15000).unref?.();
    return {
        status: () => status,
        // "Install now" and "Check now" from the window.
        installNow: async () => { manual = true; if (status.state !== 'ready')
            await check(); if (status.state === 'ready')
            await install();
        else
            manual = false; },
        checkNow: () => check(),
        failures: () => failures,
    };
}
exports.startUpdater = startUpdater;
const installerPath = (dir, f) => path.join(dir, f);
exports.installerPath = installerPath;
