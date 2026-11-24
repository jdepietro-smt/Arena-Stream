"use strict";
// Software updates, the parts with no side effects (so they can be tested on their own).
//
// A PC is offered a release by the Link directory (see link/directory/directory.py). It downloads the installer in the
// background, checks it, and then waits for a good moment to install: never while something is live unless a maintenance
// window says it may.
Object.defineProperty(exports, "__esModule", { value: true });
exports.installDecision = exports.IDLE_BEFORE_INSTALL_MS = exports.inWindow = exports.validWindow = exports.worthTaking = exports.safeFileName = exports.cmpVersion = exports.parseVersion = void 0;
// 1.10.0 is newer than 1.9.0; anything unreadable counts as 0.
function parseVersion(v) {
    const out = String(v ?? '').split('.').slice(0, 4).map(p => { const m = /^\d+/.exec(p); return m ? parseInt(m[0], 10) : 0; });
    while (out.length < 4)
        out.push(0);
    return out;
}
exports.parseVersion = parseVersion;
function cmpVersion(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    for (let i = 0; i < 4; i++)
        if (x[i] !== y[i])
            return x[i] - y[i];
    return 0;
}
exports.cmpVersion = cmpVersion;
// Only a plain file name from the directory is ever used on disk: no folders, no ".." tricks.
const safeFileName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(n);
exports.safeFileName = safeFileName;
// Should this offer be taken at all? The directory already filters, but the app does not trust that blindly.
function worthTaking(offer, current) {
    if (!offer || !offer.update || !offer.version || !(0, exports.safeFileName)(offer.file) || !/^[0-9a-f]{64}$/i.test(String(offer.sha256 || '')))
        return false;
    if (!(Number(offer.size) > 1024 * 1024))
        return false;
    return cmpVersion(offer.version, current) > 0 || (!!offer.exact && cmpVersion(offer.version, current) !== 0);
}
exports.worthTaking = worthTaking;
const mins = (hhmm) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; };
function validWindow(w) {
    return !!w && mins(w.from) !== null && mins(w.to) !== null && w.from !== w.to;
}
exports.validWindow = validWindow;
function inWindow(now, w) {
    if (!validWindow(w))
        return false;
    const t = now.getHours() * 60 + now.getMinutes(), a = mins(w.from), b = mins(w.to);
    return a < b ? t >= a && t < b : t >= a || t < b;
}
exports.inWindow = inWindow;
exports.IDLE_BEFORE_INSTALL_MS = 2 * 60 * 1000;
// Whether to install now, and if not, what it is waiting for (shown in the app and in the portal).
function installDecision(c) {
    if (c.manual)
        return { install: true, waiting: '' };
    if (c.mode === 'off')
        return { install: false, waiting: 'updates are turned off' };
    if (c.mode === 'ask')
        return { install: false, waiting: 'your go-ahead' };
    if (inWindow(c.now, c.window))
        return { install: true, waiting: '' };
    if (c.live)
        return { install: false, waiting: c.window && validWindow(c.window) ? `the maintenance window (${c.window.from}-${c.window.to}) or the stream to stop` : 'the stream to stop' };
    if (c.idleMs < exports.IDLE_BEFORE_INSTALL_MS)
        return { install: false, waiting: 'a quiet moment' };
    return { install: true, waiting: '' };
}
exports.installDecision = installDecision;
