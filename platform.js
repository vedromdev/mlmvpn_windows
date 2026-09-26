'use strict';

// --- platform: the one place this app knows which operating system it is on ---
//
// This application grew up on Windows and its OS knowledge was spread across a hundred files as
// `netsh`, `taskkill`, `schtasks`, `certutil`, `%ProgramData%` and a hard-coded `.exe` on every
// engine path. Porting it means every one of those has to become a choice, and a choice made in
// a hundred places is a choice nobody can review. So the choices live here.
//
// THE RULE: adding a platform must never change the Windows path. Every function below returns
// byte-for-byte what the code it replaces returned on win32. The macOS branch is additive. That
// is what lets the Windows build keep shipping from this same tree while the port is finished.
//
//   isWindows / isMac / isLinux   — ask the question, don't test `process.platform` by hand
//   exe(name)                     — 'xray' -> 'xray.exe' on Windows, 'xray' on macOS
//   supportDir()                  — %ProgramData%\MLM VPN  |  ~/Library/Application Support/MLM VPN
//   isElevated()                  — Administrator on Windows, uid 0 on macOS
//   kill(target)                  — taskkill        | pkill / kill
//   service.*                     — schtasks        | launchd LaunchAgent
//   dns.*                         — netsh/PowerShell| networksetup
//   proxy.*                       — WinINET registry| networksetup
//   cert.trust / cert.untrust     — certutil        | security (Keychain)
//   pingArgs()                    — -n/-w/-f/-l     | -c/-W/-D/-s
//   reveal(path)                  — explorer /select| open -R
//
// WHAT IS STILL WINDOWS-ONLY and is NOT hidden here, because hiding it would be a lie: the TUN
// driver (wintun -> the macOS utun handled by sing-box), the WFP/WinDivert kill switch and SNI
// engine (macOS uses pf), per-application routing tables, the game-shaping module and the
// Windows-only diagnostics. Those are listed in docs/MACOS-PORT.md; each needs its own design,
// not a rename.

const os = require('os');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const PLATFORM = process.platform;
const isWindows = PLATFORM === 'win32';
const isMac = PLATFORM === 'darwin';
const isLinux = PLATFORM === 'linux';

/** Human name for logs and UI copy. */
function name() {
    return isWindows ? 'Windows' : isMac ? 'macOS' : isLinux ? 'Linux' : PLATFORM;
}

// ============================================================
// Executables
// ============================================================

/**
 * An engine executable's file name for this platform.
 *
 * Accepts the name with or without `.exe` so callers migrating from the old literals can pass
 * either; on Windows it always ends `.exe`, on macOS it never does. `exe('xray.exe')` and
 * `exe('xray')` are the same call.
 */
function exe(engineName) {
    const base = String(engineName || '').replace(/\.exe$/i, '');
    return isWindows ? `${base}.exe` : base;
}

/** The reverse: a bare, lower-case process name with no extension, however the caller wrote it. */
function processName(engineName) {
    return String(engineName || '').replace(/\.exe$/i, '').toLowerCase();
}

// ============================================================
// Paths
// ============================================================

/**
 * The machine-wide directory shared by every user, where the store keeps verified core installs.
 *
 * Windows uses %ProgramData% (ACL-protected by store/cores.js). macOS has no %ProgramData%; the
 * nearest thing is /Library/Application Support, which is the documented location for
 * administrator-managed, machine-wide app data and is writable only by root/admin.
 */
function supportDir() {
    if (isWindows) {
        const programData = process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
        return path.join(programData, 'MLM VPN');
    }
    if (isMac) return '/Library/Application Support/MLM VPN';
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'MLM VPN');
}

/** The per-user data directory (~/.mlmvpn by convention throughout the app). */
function dataDir(home) {
    return path.join(home || process.env.MLMVPN_HOME || os.homedir(), '.mlmvpn');
}

// ============================================================
// Privileges
// ============================================================

let _elevated = null;

/**
 * Are we already running with the rights a network change needs?
 *
 * Windows wants Administrator (asked for in the manifest). macOS wants root: changing system DNS,
 * the system proxy, or installing a root certificate all refuse as an ordinary user. The packaged
 * Mac app is meant to be launched with a privileged helper (see docs/MACOS-PORT.md); until that
 * helper lands, a plain `sudo` launch is what makes these paths work, and `isElevated()` is how
 * callers find out which situation they are in — the same contract the Windows code already uses.
 */
function isElevated() {
    if (_elevated !== null) return _elevated;
    if (isWindows) {
        try {
            const out = cp.execFileSync('powershell', [
                '-NoProfile', '-NonInteractive', '-Command',
                '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
                '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
            ], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
            _elevated = /true/i.test(String(out));
        } catch (e) {
            _elevated = false;
        }
        return _elevated;
    }
    try { _elevated = typeof process.getuid === 'function' && process.getuid() === 0; }
    catch (e) { _elevated = false; }
    return _elevated;
}

/** Only for tests. */
function _resetElevated() { _elevated = null; }

// ============================================================
// Processes
// ============================================================

function run(cmd, args, { timeout = 15000 } = {}) {
    return new Promise((resolve) => {
        cp.execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

/**
 * Stop a process, by pid when we hold one and by name otherwise.
 *
 * Windows: `taskkill /F /PID n /T` (tree) or `/F /IM name.exe /T`. macOS: `kill -9` on the pid, or
 * `pkill -x name` — `-x` on the bare name, deliberately, because a plain `pkill -f xray` also
 * matches this app's own command line. The tree-kill half has no macOS counterpart that matters:
 * the engines spawn no children except Tor's pluggable transport, which tor itself reaps.
 */
async function kill({ pid = 0, engine = '' } = {}) {
    const bare = processName(engine);
    if (isWindows) {
        const args = pid ? ['/F', '/PID', String(pid), '/T'] : ['/F', '/IM', `${bare}.exe`, '/T'];
        return run('taskkill', args, { timeout: 8000 });
    }
    if (pid) return run('kill', ['-9', String(pid)], { timeout: 8000 });
    if (bare) return run('pkill', ['-9', '-x', bare], { timeout: 8000 });
    return { ok: false, stdout: '', stderr: 'nothing to kill' };
}

/** The same, synchronously — for teardown paths that cannot await (stopXray, before-quit). */
function killSync({ pid = 0, engine = '' } = {}) {
    const bare = processName(engine);
    try {
        if (isWindows) {
            const args = pid ? ['/F', '/PID', String(pid), '/T'] : ['/F', '/IM', `${bare}.exe`, '/T'];
            cp.execFileSync('taskkill', args, { windowsHide: true, timeout: 8000, stdio: 'ignore' });
        } else if (pid) {
            cp.execFileSync('kill', ['-9', String(pid)], { timeout: 8000, stdio: 'ignore' });
        } else if (bare) {
            cp.execFileSync('pkill', ['-9', '-x', bare], { timeout: 8000, stdio: 'ignore' });
        }
    } catch (e) { /* nothing was running */ }
}

// ============================================================
// Always-on service  (Windows schtasks  |  macOS launchd)
// ============================================================

/**
 * The macOS LaunchAgent that runs the app at login — the counterpart of the Windows logon task.
 *
 * A per-user LaunchAgent in ~/Library/LaunchAgents, not a root LaunchDaemon: the app is a GUI
 * app, and a LaunchAgent starts it in the user's session exactly as the logon task does. The
 * Windows task runs "with highest privileges"; macOS has no equivalent flag, so the app is
 * responsible for asking for rights when it first touches the network (see docs/MACOS-PORT.md).
 */
const LAUNCH_AGENT_LABEL = 'com.mlmvpn.alwayson';

function launchAgentPlist(name_) {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `${name_}.plist`);
}

function plistEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const service = {
    /**
     * Create the run-at-login entry that starts `program`. Windows: the logon scheduled task.
     * Returns { ok, reason }.
     */
    async install(program) {
        if (isWindows) {
            const r = await run('schtasks.exe', ['/Create', '/TN', 'MLM VPN (Always-On)',
                '/TR', `"${program}"`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
            return { ok: r.ok, reason: r.stdout + r.stderr };
        }
        const file = launchAgentPlist(LAUNCH_AGENT_LABEL);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${plistEscape(program)}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, xml);
        } catch (e) {
            return { ok: false, reason: e.message };
        }
        // load -w makes it persistent; the modern `bootstrap` is only needed on newer macOS, and
        // `load` still works everywhere and does the same thing for a LaunchAgent.
        const r = await run('launchctl', ['load', '-w', file]);
        return { ok: r.ok, reason: r.stdout + r.stderr };
    },

    /** Remove the run-at-login entry. Missing is success. */
    async remove() {
        if (isWindows) {
            const r = await run('schtasks.exe', ['/Delete', '/TN', 'MLM VPN (Always-On)', '/F']);
            return { ok: r.ok, reason: r.stdout + r.stderr };
        }
        const file = launchAgentPlist(LAUNCH_AGENT_LABEL);
        const r = await run('launchctl', ['unload', '-w', file]);
        try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
        return { ok: r.ok || !fs.existsSync(file), reason: r.stdout + r.stderr };
    },

    /** Whether the run-at-login entry currently exists, asked of the OS rather than remembered. */
    async exists() {
        if (isWindows) return (await run('schtasks.exe', ['/Query', '/TN', 'MLM VPN (Always-On)'])).ok;
        if (fs.existsSync(launchAgentPlist(LAUNCH_AGENT_LABEL))) return true;
        return (await run('launchctl', ['list', LAUNCH_AGENT_LABEL])).ok;
    },

    label: LAUNCH_AGENT_LABEL,
    plistFor: launchAgentPlist,
};

// ============================================================
// DNS
// ============================================================

/**
 * The macOS network services ("Wi-Fi", "Ethernet") are the equivalent of Windows adapters, and
 * `networksetup` is what changes their resolvers. There is no single "the adapter" — the user can
 * be on Wi-Fi, Ethernet, or both — so every enabled service is changed, and the caller passes the
 * ones it wants from `list()`.
 */
const dns = {
    /** Enabled network services, Wi-Fi first when present. `*`-prefixed entries are disabled. */
    async listServices() {
        if (!isMac) return [];
        const r = await run('networksetup', ['-listallnetworkservices']);
        if (!r.ok) return [];
        return r.stdout.split('\n').slice(1)
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith('*'));
    },

    /** Pin a service to explicit resolvers. */
    async setStatic(service_, servers) {
        if (!isMac) return { ok: false };
        return run('networksetup', ['-setdnsservers', service_, ...servers]);
    },

    /** Hand a service back to DHCP-provided resolvers (`Empty` is networksetup's "automatic"). */
    async setAutomatic(service_) {
        if (!isMac) return { ok: false };
        return run('networksetup', ['-setdnsservers', service_, 'Empty']);
    },

    /** Make macOS forget its resolver cache, the way `ipconfig /flushdns` does on Windows. */
    async flush() {
        if (isWindows) return run('ipconfig', ['/flushdns']);
        if (isMac) {
            const a = await run('dscacheutil', ['-flushcache']);
            const b = await run('killall', ['-HUP', 'mDNSResponder']);
            return { ok: a.ok || b.ok, stdout: a.stdout + b.stdout, stderr: a.stderr + b.stderr };
        }
        return { ok: false };
    },
};

// ============================================================
// System proxy
// ============================================================

/**
 * macOS has no single system-proxy switch. `networksetup` sets HTTP, HTTPS and SOCKS proxies per
 * service, which is what the Windows code does through the WinINET registry keys — one call per
 * service instead of one registry write.
 */
const proxy = {
    async set({ host = '127.0.0.1', port, socksPort } = {}) {
        if (!isMac) return { ok: false };
        const services = await dns.listServices();
        const results = [];
        for (const s of services) {
            if (port) {
                results.push(await run('networksetup', ['-setwebproxy', s, host, String(port)]));
                results.push(await run('networksetup', ['-setsecurewebproxy', s, host, String(port)]));
                results.push(await run('networksetup', ['-setwebproxystate', s, 'on']));
                results.push(await run('networksetup', ['-setsecurewebproxystate', s, 'on']));
            }
            if (socksPort) {
                results.push(await run('networksetup', ['-setsocksfirewallproxy', s, host, String(socksPort)]));
                results.push(await run('networksetup', ['-setsocksfirewallproxystate', s, 'on']));
            }
        }
        return { ok: results.every((r) => r.ok), results };
    },

    async clear() {
        if (!isMac) return { ok: false };
        const services = await dns.listServices();
        const results = [];
        for (const s of services) {
            results.push(await run('networksetup', ['-setwebproxystate', s, 'off']));
            results.push(await run('networksetup', ['-setsecurewebproxystate', s, 'off']));
            results.push(await run('networksetup', ['-setsocksfirewallproxystate', s, 'off']));
        }
        return { ok: results.every((r) => r.ok), results };
    },
};

// ============================================================
// Certificates
// ============================================================

/**
 * Domain fronting makes Xray generate its own CA, and the machine has to trust it. Windows adds
 * it to the user's Root store with certutil; macOS uses `security` and, because a TLS-trusting
 * root has to be in the System keychain, needs root — the one place the Mac port genuinely
 * requires elevation for a feature Windows does not.
 */
const cert = {
    async trust(pemPath) {
        if (isWindows) return run('certutil.exe', ['-user', '-addstore', 'Root', pemPath], { timeout: 600000 });
        return run('security', ['add-trusted-cert', '-d', '-r', 'trustRoot',
            '-k', '/Library/Keychains/System.keychain', pemPath], { timeout: 600000 });
    },

    async untrust(pemPath) {
        if (isWindows) return run('certutil.exe', ['-user', '-delstore', 'Root', pemPath], { timeout: 600000 });
        return run('security', ['remove-trusted-cert', '-d', pemPath], { timeout: 600000 });
    },
};

// ============================================================
// Small shared helpers
// ============================================================

/**
 * `ping` arguments for a single "don't fragment" probe of `size` payload bytes.
 * Windows: -n 1 -w 1500 -f -l <size>.  macOS: -c 1 -W 1500 -D -s <size>.
 */
function pingArgs(size, host) {
    return isWindows
        ? ['-n', '1', '-w', '1500', '-f', '-l', String(size), host]
        : ['-c', '1', '-W', '1500', '-D', '-s', String(size), host];
}

/** Does a ping reply mean the packet carried? Both platforms say "ttl=" in the reply line. */
function pingCarried(output) {
    return /ttl=/i.test(String(output || ''));
}

/** Show a file to the user in the file manager (a log, a report). */
function reveal(target) {
    try {
        if (isWindows) cp.spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
        else if (isMac) cp.spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
        else cp.spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = {
    PLATFORM, isWindows, isMac, isLinux, name,
    exe, processName,
    supportDir, dataDir,
    isElevated, _resetElevated,
    kill, killSync,
    service,
    dns, proxy, cert,
    pingArgs, pingCarried, reveal,
    run,
};
