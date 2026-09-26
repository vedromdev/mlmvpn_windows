// platform.js — the one place the app asks which OS it is on.
//
// Every assertion here must hold on Windows, macOS and Linux alike, because the layer's whole
// promise is that the Windows path does not change: on win32 each function must return exactly what
// the code it replaced returned. So the expectations below are written in terms of platform.isX
// rather than in terms of this machine.
'use strict';

const assert = require('assert');
const path = require('path');

const platform = require('../../platform');
const corePaths = require('../../core-paths');

let checks = 0;
function ok(cond, msg) { checks++; assert.ok(cond, msg); }

// ── identity ─────────────────────────────────────────────────────────────────
ok([platform.isWindows, platform.isMac, platform.isLinux].filter(Boolean).length === 1,
    'exactly one of isWindows/isMac/isLinux is true');
ok(typeof platform.name() === 'string' && platform.name().length > 0, 'name() is a non-empty string');

// ── exe(): the extension exists only on Windows, and either spelling works ────
const ext = platform.isWindows ? '.exe' : '';
assert.strictEqual(platform.exe('xray'), 'xray' + ext, "exe('xray')");
assert.strictEqual(platform.exe('xray.exe'), 'xray' + ext, "exe('xray.exe') matches exe('xray')");
assert.strictEqual(platform.exe('sing-box'), 'sing-box' + ext, "exe('sing-box')");
assert.strictEqual(platform.exe(''), ext, 'exe of nothing is just the extension (or empty)');
checks += 4;

// ── processName(): always bare and lower-case ────────────────────────────────
assert.strictEqual(platform.processName('aether.exe'), 'aether');
assert.strictEqual(platform.processName('GST.EXE'), 'gst');
assert.strictEqual(platform.processName('lyrebird'), 'lyrebird');
checks += 3;

// ── pingArgs(): platform-correct flags, same shape ───────────────────────────
const ping = platform.pingArgs(1400, '1.1.1.1');
ok(ping[ping.length - 1] === '1.1.1.1', 'ping host is the last argument');
ok(ping.includes('1400'), 'ping carries the payload size');
ok(platform.isWindows ? ping.includes('-f') && ping.includes('-l') : ping.includes('-D') && ping.includes('-s'),
    'ping uses the platform-specific no-fragment flags');
ok(platform.pingCarried('64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=1 ms'), 'a reply with ttl counts as carried');
ok(!platform.pingCarried('Request timed out'), 'no reply does not');
checks += 5;

// ── supportDir(): absolute, and the documented location per platform ─────────
const support = platform.supportDir();
ok(path.isAbsolute(support), 'supportDir() is absolute');
if (platform.isWindows) ok(/MLM VPN$/.test(support), 'Windows support dir ends in MLM VPN');
if (platform.isMac) assert.strictEqual(support, '/Library/Application Support/MLM VPN');
checks += 2;

// ── core-paths translation: identity on Windows, `.exe`-stripping elsewhere ──
assert.strictEqual(corePaths.nativeRel('xray.exe'), platform.isWindows ? 'xray.exe' : 'xray', 'nativeRel');
assert.strictEqual(corePaths.nativeRel('geoip.dat'), 'geoip.dat', 'nativeRel leaves non-.exe names alone');
checks += 2;
if (platform.isWindows) {
    assert.strictEqual(corePaths.nativePath('C:/x/y/tor.exe'), 'C:/x/y/tor.exe', 'nativePath identity on Windows');
} else {
    // No such file exists, so the platform name wins: no `.exe`.
    assert.strictEqual(corePaths.nativePath('/x/y/tor.exe'), '/x/y/tor', 'nativePath strips .exe off Windows');
}
checks++;

// ── the shape of the OS broker ───────────────────────────────────────────────
for (const fn of ['kill', 'killSync', 'reveal']) ok(typeof platform[fn] === 'function', `platform.${fn} is a function`);
for (const fn of ['install', 'remove', 'exists']) ok(typeof platform.service[fn] === 'function', `platform.service.${fn} is a function`);
for (const fn of ['listServices', 'setStatic', 'setAutomatic', 'flush']) ok(typeof platform.dns[fn] === 'function', `platform.dns.${fn} is a function`);
for (const fn of ['set', 'clear']) ok(typeof platform.proxy[fn] === 'function', `platform.proxy.${fn} is a function`);
for (const fn of ['trust', 'untrust']) ok(typeof platform.cert[fn] === 'function', `platform.cert.${fn} is a function`);
checks += 16;

console.log(`platform: ${checks} checks passed on ${platform.name()}`);
