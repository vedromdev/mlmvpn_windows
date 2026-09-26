#!/usr/bin/env node
'use strict';

/*
 * Fetch the Apple-Silicon engine binaries into core/.
 *
 *   node scripts/fetch-cores-mac.js            # everything it can
 *   node scripts/fetch-cores-mac.js --only=xray,singbox
 *   node scripts/fetch-cores-mac.js --list     # show what it would fetch, download nothing
 *
 * WHY THIS EXISTS
 *
 * None of the engines are in this repository (they are 450 MB of other people's compiled
 * software — see docs/BUILD.md) and the Windows build's core/ is full of .exe files. A macOS
 * port needs the arm64 counterparts, and chasing eleven upstream release pages by hand is how a
 * port stalls. This does the mechanical part: it asks GitHub for each project's latest release,
 * picks the macOS/arm64 asset, extracts it and installs it under the name the app looks for.
 *
 * WHAT IT CANNOT DO, and says so per engine instead of failing quietly:
 *   - Psiphon, Lantern, Aether and Geph only publish macOS builds for some versions; when the
 *     asset is missing it prints the repository to build from.
 *   - gst (the Google Script tunnel client) is ours and has no release — build it from gst-src
 *     with cargo, per docs/BUILD.md.
 *   - The TUN adapter driver (wintun.dll on Windows) has no macOS counterpart: macOS uses the
 *     kernel's utun interface and sing-box drives it directly.
 *
 * Run it from the repository root on an Apple-Silicon Mac.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'core');
const platform = require(path.join(ROOT, 'platform'));

const args = process.argv.slice(2);
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
const LIST = args.includes('--list');

/**
 * One entry per engine the app runs. `asset` matches the release asset file name; `bin` is the
 * file name the app resolves inside core/; `aliases` are extra files to install from the same
 * archive (a project that ships two binaries in one tarball).
 */
const MANIFEST = [
    { id: 'xray', repo: 'XTLS/Xray-core', asset: /Xray-macos-arm64-v8a\.zip$/i, bin: 'xray',
      why: 'V2Ray/VLESS/VMess/Trojan/Shadowsocks core' },
    { id: 'singbox', repo: 'SagerNet/sing-box', asset: /sing-box-.*darwin-arm64\.tar\.gz$/i, bin: 'sing-box',
      why: 'the TUN / full-tunnel engine (utun on macOS)' },
    { id: 'tailscale', repo: 'tailscale/tailscale', asset: /tailscale_.*_arm64\.tgz$/i, bin: 'tailscaled',
      aliases: ['tailscale'], why: 'the GitHub tunnel' },
    { id: 'geph', repo: 'geph-official/geph5', asset: /(macos|darwin).*(arm64|aarch64)|(arm64|aarch64).*(macos|darwin)/i, bin: 'geph5-client',
      why: 'the Geph fronted broker' },
    { id: 'lantern', repo: 'getlantern/lantern', asset: /(darwin|macos).*(arm64|aarch64)|(arm64|aarch64).*(darwin|macos)/i, bin: 'lantern',
      why: 'the domain-fronted proxy' },
    { id: 'tor', repo: 'torproject/tor', asset: /tor-expert-bundle-macos.*\.tar\.gz$|tor-expert-bundle.*macos.*\.tar\.gz$/i, bin: 'tor',
      aliases: ['lyrebird', 'conjure-client'], subdir: 'tor', why: 'Tor with its pluggable transports' },

    // Not on GitHub, and not published as a release asset at all.
    { id: 'geodata', direct: [
        ['https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat', 'geoip.dat'],
        ['https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat', 'geosite.dat'],
      ], why: 'routing databases Xray and sing-box both read' },
    { id: 'gst', manual: 'build it from gst-src with cargo: `cd gst-src && cargo build --release && cp target/release/gst core/gst`',
      why: 'the Google Script tunnel client (ours)' },
    { id: 'psiphon', manual: 'build psiphon-tunnel-core\'s ConsoleClient for darwin/arm64 from github.com/Psiphon-Labs/psiphon-tunnel-core',
      why: 'the Psiphon engine' },
    { id: 'aether', manual: 'get the upstream Aether 2.0.0 darwin/arm64 binary from its own repository',
      why: 'MASQUE / WireGuard / WARP-in-WARP' },
    { id: 'openvpn', manual: 'install OpenVPN 2.6 (e.g. `brew install openvpn`) and copy the binary into core/openvpn/',
      why: 'the OpenVPN gateway' },
];

function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const go = (u, redirects) => {
            https.get(u, { headers: { 'User-Agent': 'mlmvpn-mac-fetch' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (redirects > 5) return reject(new Error('too many redirects'));
                    res.resume();
                    return go(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                const out = fs.createWriteStream(dest);
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve(dest)));
                out.on('error', reject);
            }).on('error', reject);
        };
        go(url, 0);
    });
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'mlmvpn-mac-fetch', Accept: 'application/vnd.github+json' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function extract(archive, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const name = archive.toLowerCase();
    if (name.endsWith('.zip')) cp.execFileSync('unzip', ['-oq', archive, '-d', dir], { stdio: 'inherit' });
    else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) cp.execFileSync('tar', ['xzf', archive, '-C', dir], { stdio: 'inherit' });
    else if (name.endsWith('.tar')) cp.execFileSync('tar', ['xf', archive, '-C', dir], { stdio: 'inherit' });
    else throw new Error(`unknown archive type: ${path.basename(archive)}`);
}

/** Find a file named like `bin` anywhere under `dir`. */
function findBinary(dir, bin) {
    const want = bin.replace(/\.exe$/i, '');
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) { stack.push(p); continue; }
            if (entry.name.replace(/\.exe$/i, '') === want) return p;
        }
    }
    return null;
}

function installBinary(from, toName, subdir) {
    const destDir = subdir ? path.join(CORE, subdir) : CORE;
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, platform.exe(toName));
    fs.copyFileSync(from, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
}

async function fetchFromGitHub(entry) {
    const rel = await getJson(`https://api.github.com/repos/${entry.repo}/releases/latest`);
    const asset = (rel.assets || []).find((a) => entry.asset.test(a.name));
    if (!asset) throw new Error(`no macOS/arm64 asset in ${entry.repo}'s latest release (${(rel.assets || []).map((a) => a.name).join(', ') || 'no assets'})`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mlm-${entry.id}-`));
    const archive = path.join(tmp, asset.name);
    log(`  ↓ ${asset.name}`);
    await download(asset.browser_download_url, archive);
    extract(archive, tmp);
    const found = findBinary(tmp, entry.bin);
    if (!found) throw new Error(`${entry.bin} not found inside ${asset.name}`);
    const dest = installBinary(found, entry.bin, entry.subdir);
    for (const alias of entry.aliases || []) {
        const af = findBinary(tmp, alias);
        if (af) installBinary(af, alias, entry.subdir);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return dest;
}

async function fetchDirect(entry) {
    for (const [url, name] of entry.direct) {
        log(`  ↓ ${name}`);
        await download(url, path.join(CORE, name));
    }
    return CORE;
}

async function main() {
    if (!platform.isMac) {
        warn(`This fetches macOS binaries. This machine is ${platform.name()}; building the Mac`);
        warn('port means running it on an Apple-Silicon Mac (or downloading the archives yourself).');
    }
    fs.mkdirSync(CORE, { recursive: true });

    const wanted = ONLY.length ? MANIFEST.filter((m) => ONLY.includes(m.id)) : MANIFEST;
    const ok = [], manual = [], failed = [];

    for (const entry of wanted) {
        if (LIST) { log(`${entry.id.padEnd(10)} ${entry.repo || entry.manual ? '—' : ''} ${entry.why}`); continue; }
        if (entry.manual) { manual.push(entry); continue; }
        if (!entry.repo && !entry.direct) { manual.push(entry); continue; }
        log(`\n${entry.id} — ${entry.why}`);
        try {
            if (entry.direct) await fetchDirect(entry);
            else await fetchFromGitHub(entry);
            ok.push(entry.id);
        } catch (e) {
            failed.push({ id: entry.id, reason: e.message, repo: entry.repo });
        }
    }

    if (LIST) return;

    log('\n──────────────────────────────────────────────');
    log(`fetched: ${ok.join(', ') || 'nothing'}`);
    if (failed.length) {
        log('\ncould not fetch automatically (install by hand):');
        for (const f of failed) log(`  • ${f.id}: ${f.reason}\n    from https://github.com/${f.repo}/releases`);
    }
    if (manual.length) {
        log('\nno packaged macOS build — build or install these yourself:');
        for (const m of manual) log(`  • ${m.id} (${m.why})\n    ${m.manual}`);
    }
    log('\nThen run:  npm run electron   (or `npm run build:mac` to package)');
}

main().catch((e) => { console.error(e); process.exit(1); });
