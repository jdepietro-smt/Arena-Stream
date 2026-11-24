"use strict";
// A directory address can be a list, "http://main:8002,http://backup:8002". Reads and heartbeats go to the one that answered last,
// and fall over to the next if it does not. (The encoder and decoder programs do the same with the list themselves.)
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDirectories = exports.dirState = exports.splitDirs = void 0;
const splitDirs = (s) => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
exports.splitDirs = splitDirs;
// Which address answered last, shared by everything in the app so they all stay on the same one.
exports.dirState = { last: 0 };
// Tries the addresses in turn, starting at the last good one. `ok` decides whether an answer counts (for example HTTP 200);
// if no address gives an acceptable answer the last answer is returned, or the last error thrown if none answered at all.
async function withDirectories(list, fn, state = exports.dirState, ok = () => true) {
    const urls = (0, exports.splitDirs)(list);
    if (!urls.length)
        throw new Error('no directory address');
    let lastErr = null, lastResult, have = false;
    for (let k = 0; k < urls.length; k++) {
        const i = (state.last + k) % urls.length;
        try {
            const r = await fn(urls[i]);
            if (ok(r)) {
                state.last = i;
                return r;
            }
            lastResult = r;
            have = true;
        }
        catch (e) {
            lastErr = e;
        }
    }
    if (have)
        return lastResult;
    throw lastErr instanceof Error ? lastErr : new Error('the directory did not answer');
}
exports.withDirectories = withDirectories;
