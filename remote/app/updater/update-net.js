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
exports.cleanOld = exports.downloadRelease = exports.sha256File = exports.checkOffer = void 0;
// Software updates, the network part: ask the Link directory what to install, and download it safely (resumable, checked
// against the published size and SHA-256 before it is ever run). No Electron here, so it can be tested with plain node.
const http = __importStar(require("node:http"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const update_core_1 = require("./update-core");
function base(directory) { return new URL(directory.includes('://') ? directory : `http://${directory}`); }
function request(directory, key, urlPath, headers = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const u = base(directory);
        const req = http.request({ method: 'GET', host: u.hostname, port: Number(u.port) || 80, path: urlPath, agent: false, timeout: timeoutMs, headers: { 'X-Arena-Key': key, ...headers } }, resolve);
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}
async function checkOffer(o) {
    const res = await request(o.directory, o.key, `/v1/update/${encodeURIComponent(o.app)}/latest?host=${encodeURIComponent(o.host)}&version=${encodeURIComponent(o.version)}`);
    let data = '';
    res.setEncoding('utf8');
    for await (const c of res)
        data += c;
    if (res.statusCode !== 200)
        throw new Error(`directory answered ${res.statusCode}`);
    return JSON.parse(data);
}
exports.checkOffer = checkOffer;
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}
exports.sha256File = sha256File;
// Downloads the offered installer into `dir` and returns its path. Resumes a partial download, refuses a file whose size or
// hash differs from what was published, and never leaves a half-written file under the final name.
async function downloadRelease(o) {
    if (!o.offer.update || !(0, update_core_1.safeFileName)(o.offer.file) || !/^[0-9a-f]{64}$/i.test(String(o.offer.sha256 || '')) || !(Number(o.offer.size) > 0))
        throw new Error('the offer is not usable');
    const offer = o.offer;
    fs.mkdirSync(o.dir, { recursive: true });
    const final = path.join(o.dir, offer.file), part = final + '.part';
    // Already downloaded and intact (for example after a restart): nothing to do.
    if (fs.existsSync(final) && fs.statSync(final).size === offer.size && (await sha256File(final)) === offer.sha256.toLowerCase()) {
        o.onProgress?.(100);
        return final;
    }
    try {
        fs.rmSync(final, { force: true });
    }
    catch { /* in use: the rename below will say */ }
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > offer.size) {
        fs.rmSync(part, { force: true });
        have = 0;
    }
    while (have < offer.size) {
        const res = await request(o.directory, o.key, `/v1/update/${encodeURIComponent(o.app)}/file/${encodeURIComponent(offer.file)}`, have ? { Range: `bytes=${have}-` } : {}, 15000);
        if (res.statusCode === 416) {
            fs.rmSync(part, { force: true });
            have = 0;
            continue;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            throw new Error(`download refused (${res.statusCode})`);
        }
        if (res.statusCode === 200 && have) {
            fs.rmSync(part, { force: true });
            have = 0;
        } // the server ignored the range: start over
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        let got = have;
        try {
            for await (const chunk of res) {
                if (!out.write(chunk))
                    await new Promise(r => out.once('drain', () => r()));
                got += chunk.length;
                o.onProgress?.(Math.min(99, Math.floor(got / offer.size * 100)));
                if (got > offer.size)
                    throw new Error('the download is larger than published');
            }
        }
        finally {
            await new Promise(r => out.end(r));
        }
        have = fs.statSync(part).size;
        if (have < offer.size && res.complete)
            throw new Error('the download ended early');
    }
    if (have !== offer.size) {
        fs.rmSync(part, { force: true });
        throw new Error('size does not match what was published');
    }
    if ((await sha256File(part)) !== offer.sha256.toLowerCase()) {
        fs.rmSync(part, { force: true });
        throw new Error('the download failed its integrity check');
    }
    fs.renameSync(part, final);
    o.onProgress?.(100);
    return final;
}
exports.downloadRelease = downloadRelease;
// Removes installers (and half downloads) other than the one in use.
function cleanOld(dir, keepFile) {
    try {
        for (const f of fs.readdirSync(dir))
            if (f !== keepFile && f !== keepFile + '.part')
                fs.rmSync(path.join(dir, f), { force: true });
    }
    catch { /* nothing there */ }
}
exports.cleanOld = cleanOld;
