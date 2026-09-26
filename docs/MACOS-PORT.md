# MLMVPN on macOS (Apple Silicon)

A native macOS arm64 port of MLMVPN for Windows. The user interface is unchanged — the desktop,
windows, dock, menu bar and every panel are the same code, and the macOS 26 (Tahoe) shell that was
already built for [MACOS26-UI-PLAN.md](MACOS26-UI-PLAN.md). What changed is the layer underneath it.

This document is honest about what is done and what is not. The port is a real, running start, not a
finished product.

---

## 1. What "porting" actually meant

The Windows-specific surface of this application is not packaging. It is a hundred small places
where the code talks to the operating system, and every one of them had to become a choice. They
were centralised in a new module, **`platform.js`**, so there is one place to review and one place
to fix:

| Concern | Windows (unchanged) | macOS (new) |
|---|---|---|
| Engine binary names | `xray.exe`, `sing-box.exe`, … | `xray`, `sing-box`, … |
| Machine-wide data | `%ProgramData%\MLM VPN` | `/Library/Application Support/MLM VPN` |
| "Am I privileged?" | PowerShell / Administrator | `uid === 0` |
| Stop a process | `taskkill /F /PID n /T` | `kill -9 n` / `pkill -9 -x <name>` |
| Run at login | `schtasks` logon task | `launchd` LaunchAgent |
| System DNS | `netsh` + PowerShell | `networksetup` + `dscacheutil` |
| System proxy | WinINET registry keys | `networksetup` HTTP/HTTPS/SOCKS |
| Trust the fronting CA | `certutil` → user Root store | `security` → System keychain |
| MTU probe | `ping -f -l` | `ping -D -s` |
| Reveal a file | `explorer /select,` | `open -R` |

**The rule the whole port follows: the Windows path must not change.** Every `platform.js` function
returns, on `win32`, exactly what the code it replaced returned. The macOS branch is additive, so
the Windows build keeps shipping from the same tree while the Mac port is finished.

Engine *paths* needed no per-manager edit: `core-paths.js` now translates a Windows-style name
(`xray.exe`) to the platform's real file name (`xray`) in one place, and every manager that already
funnels through `corePaths.file()` / `corePaths.dir()` — Xray, sing-box, Tor, warp/Aether, Geph,
GST, domain fronting — picked up macOS support for free.

---

## 2. Building and running on an Apple-Silicon Mac

```bash
# 1. Get the JavaScript
npm install

# 2. Get the arm64 engines into core/  (see §3)
node scripts/fetch-cores-mac.js

# 3. Run from source
npm run electron

# 4. Or package a .dmg / .zip
npm run build:mac        # electron-builder --mac, arm64 only
```

`build:mac` produces `dist/mlm-vpn-<version>-arm64.dmg` and a `.zip`. Both are unsigned: the first
run is `xattr -dr com.apple.quarantine` away from opening, and shipping properly needs a Developer
ID certificate and notarization (see §6). The `mac` target, the hardened-runtime entitlements
(`entitlements.mac.plist`) and the `build:mac` script are already in `package.json`.

---

## 3. The engines (`core/`)

`core/` is not in the repository — it is other people's compiled software (see
[BUILD.md](BUILD.md)). The Windows build's `core/` is all `.exe`; macOS needs arm64 builds with no
extension, in the same directories.

`scripts/fetch-cores-mac.js` does the mechanical part: it asks GitHub for each project's latest
release, picks the macOS/arm64 asset, extracts it and installs it under the name the app looks for.

```bash
node scripts/fetch-cores-mac.js            # everything it can find
node scripts/fetch-cores-mac.js --list     # what it would fetch
node scripts/fetch-cores-mac.js --only=xray,singbox
```

Engines it **cannot** fetch automatically, and says so rather than failing quietly:

| Engine | Why | What to do |
|---|---|---|
| **gst** (Google Script tunnel) | Ours; no release | `cd gst-src && cargo build --release && cp target/release/gst core/gst` |
| **Psiphon** | Upstream publishes no macOS ConsoleClient build | Build `ConsoleClient` for darwin/arm64 from `Psiphon-Labs/psiphon-tunnel-core` |
| **Aether** (ماسک / وایرگارد / وارپ) | Depends on the upstream's own macOS releases | Take the darwin/arm64 binary from its repository |
| **OpenVPN** | Distribution, not a release asset | `brew install openvpn`, copy the binary into `core/openvpn/` |
| **wintun.dll** | Windows-only driver | **Not needed** — macOS uses the kernel utun interface, driven by sing-box |

A manager with no binary simply reports "not installed" and its panel is inert, exactly as it does
on Windows when `core/` is empty. Nothing crashes.

---

## 4. What works on macOS today

- The whole UI, the desktop shell, the dock, the menu bar and the traffic lights.
- **Proxy-mode engines that terminate locally** — V2Ray (Xray), WARP family (Aether), GST, Psiphon,
  Tor, Geph, Lantern — through their loopback SOCKS/HTTP listeners, once the arm64 binary is in
  `core/`. These are port spawn + config work and needed no OS calls.
- **System proxy** on/off via `networksetup` (Network Settings › proxy mode `system`).
- **System DNS** via `networksetup`, including the "automatic" restore and the resolver-cache flush.
- **Run at login** (Settings › VPN همیشه روشن) as a user LaunchAgent.
- **Domain-fronting CA** trust/untrust through the System keychain.
- **Reconnect the last connection at login** — unchanged; it is our code, not the OS's.

---

## 5. What is still Windows-only (known gaps)

These are not rename-and-done; each needs a design for a different kernel. They are listed so nobody
expects them to work yet, and they fail closed (the feature reports unavailable rather than leaking).

| Feature | Windows mechanism | What macOS needs |
|---|---|---|
| **Full tunnel (TUN)** | sing-box + `wintun.dll`, routes via AutoRoute | sing-box over the kernel **utun**; already wired in `tun-manager.js` (no driver, but **root** required), still to be tested on hardware |
| **Kill switch / firewall** | `netsh advfirewall`, WFP filters | `pf` (pf.conf / anchors) — a new module |
| **SNI anti-filter engine** | WinDivert driver | No direct equivalent; needs a userspace approach (or is dropped) |
| **Per-application routing** | Windows executable paths + WinDivert | macOS sees apps differently; needs a redesign |
| **Game acceleration / shaping** | Windows registry + QoS + process tweaks | Different tunables; the whole `game/` module is Windows-specific |
| **Internet diagnostics (netdiag)** | `netstat`, `winhttp`, Winsock catalog | `scutil`, `netstat`, `dig` — a new collector set |
| **Cleanup of DHCP-handout DNS** | registry (`DhcpNameServer`) | `networksetup` covers it; the deep registry sweep is Windows-only |
| **Always elevated** | `requestedExecutionLevel: requireAdministrator` | A privileged helper (SMJobBless / `osascript`) — until then, launch with `sudo` for the features that need it |

The `platform.isElevated()` check is how callers already find out which situation they are in; the
TUN path, for example, refuses with a clear "needs root" message rather than a driver error.

---

## 6. Signing and notarization (later step)

`build:mac` produces an unsigned bundle. To distribute:

1. Join the Apple Developer Program and create a **Developer ID Application** certificate.
2. `CSC_LINK` / `CSC_KEY_PASSWORD` (or a keychain identity) so electron-builder signs the `.app`.
3. `notarytool submit … --wait` then `xcrun stapler staple` on the `.dmg`.

`hardenedRuntime`, `entitlements` and `entitlementsInherit` are already set, and
`entitlements.mac.plist` carries what that needs (`allow-jit`, `disable-library-validation` for the
third-party engines, network client/server).

---

## 7. Verifying a change

The Windows test suite must keep passing — the port is additive, so nothing in it should change a
Windows result:

```bash
npm test              # all suites
node scripts/check-syntax.js
```

The existing suites run on any platform; several reach the real network and can fail on a censored
line without anything being wrong with the build — read what failed before assuming you broke it.
