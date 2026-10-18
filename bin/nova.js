#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync, createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/* ------------------------------ config ------------------------------ */

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

// Optional developer overrides: load a .env that sits next to package.json (the package
// root, never the current directory, so a stray .env in some project can't redirect Nova).
// Real environment variables always win. The file is not published to npm.
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  }
} catch {

}

const env = (name, fallback) => (process.env[name] || "").trim() || fallback;

const UA = `@getnexus/nova/${VERSION}`;
const REPO = env("NOVA_RELEASES_REPO", "getnexusapp/releases");
const RELEASES = `https://github.com/${REPO}/releases`;
const LATEST_JSON = `${RELEASES}/latest/download/latest.json`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CLOUD = env("NEXUS_CLOUD_URL", "https://proxy.nexusworkspace.net").replace(/\/+$/, "");
const WEBSITE = env("NEXUS_WEBSITE_URL", "https://www.nexusworkspace.net");
const STATUS_PAGE = env("NEXUS_STATUS_URL", "https://status.nexusworkspace.net");
const APP_NAME = env("NEXUS_APP_NAME", "Nexus");
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const APP_EXE = env("NEXUS_APP_EXE", `${APP_NAME}.exe`);
// Linux: the executable name and the dpkg/rpm package name (Tauri lower-cases the product name).
const APP_BIN = env("NEXUS_APP_BIN", APP_NAME.toLowerCase());
const APP_PKG = env("NEXUS_APP_PKG", APP_NAME.toLowerCase());
const MIN_NODE = Number(env("NOVA_MIN_NODE", "20"));
const PLATFORM_KEY = env(
  "NOVA_PLATFORM_KEY",
  IS_LINUX ? `linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}` : "windows-x86_64"
);

// The session token is sent to CLOUD, so it must always be a secure https endpoint.
if (new URL(CLOUD).protocol !== "https:") {
  console.error("Error: NEXUS_CLOUD_URL must use https.");
  process.exit(1);
}

// Where the Nexus desktop app keeps its Nexus Cloud key (Rust `keyring` crate,
// service "com.nexus.desktop", user "nexus_cloud_key" -> Windows target "<user>.<service>").
const APP_KEYRING_SERVICE = "com.nexus.desktop";
const APP_KEYRING_USER = "nexus_cloud_key";
const APP_KEYRING_TARGET = `${APP_KEYRING_USER}.${APP_KEYRING_SERVICE}`;
// On Linux the same crate talks to the Secret Service (GNOME Keyring / KWallet) and finds the
// entry by these attributes, so Nova has to write them exactly the way the app does.
const APP_KEYRING_ATTRS = ["service", APP_KEYRING_SERVICE, "username", APP_KEYRING_USER, "target", "default", "application", "rust-keyring"];
const APP_KEYRING_LABEL = `keyring:${APP_KEYRING_USER}@${APP_KEYRING_SERVICE}`;

const program = new Command();

/* ------------------------------ helpers ----------------------------- */

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const cleanVersion = (v) => String(v ?? "").trim().replace(/^v/i, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.access(p).then(() => true, () => false);

/** Finds an executable on PATH (no shell involved). */
async function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      if ((await fs.stat(p)).isFile()) {
        await fs.access(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const xdgData = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;
const platformLabel = () => (IS_LINUX ? "Linux" : "Windows");

function compareVersions(a, b) {
  const parse = (v) => cleanVersion(v).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function netError(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new Error("The request timed out.");
  const code = err?.cause?.code || err?.code;
  if (code === "ENOTFOUND") return new Error("Could not resolve the server. Check your internet connection.");
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return new Error("The connection was refused or reset.");
  return new Error(err?.cause?.message || err?.message || "Network error.");
}

async function fetchJson(url, { method = "GET", headers = {}, body, timeout = 20_000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch { }
    return { ok: res.ok, status: res.status, data, text };
  } catch (err) {
    throw netError(err);
  }
}

function assertHttps(url, what = "URL") {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not valid.`);
  }
  if (u.protocol !== "https:") throw new Error(`${what} must use https.`);
  return u;
}

function assertTrustedDownload(url) {
  const u = assertHttps(url, "Download URL");
  const h = u.hostname.toLowerCase();
  const ok = h === "github.com" || h.endsWith(".github.com") || h.endsWith(".githubusercontent.com");
  if (!ok) throw new Error(`Refusing to download from untrusted host: ${h}`);
}

async function openUrl(url) {
  assertHttps(url);
  try {
    await open(url);
  } catch {
    console.log("Couldn't launch a browser. Open this link manually:");
  }
  console.log(url);
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
};

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/* --------------------------- platform support ----------------------- */

const OS_NAMES = { darwin: "macOS" };

/** Windows 10 reports build < 22000; Windows 11 reports 22000+. */
function windowsInfo() {
  const [major, , build] = os.release().split(".").map((n) => parseInt(n, 10) || 0);
  return { major, build, name: build >= 22000 ? "Windows 11" : "Windows 10" };
}

/** Distro name from /etc/os-release, and whether we're running inside WSL. */
function linuxInfo() {
  let name = "Linux";
  try {
    const m = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME=(.*)$/m);
    if (m) name = m[1].trim().replace(/^["']|["']$/g, "") || name;
  } catch {
    /* no os-release: keep the generic name */
  }
  return { name, wsl: /microsoft|wsl/i.test(os.release()) };
}

/** Nexus is available for Windows 10/11 and Linux (x64 or ARM64). Throws on anything else. */
function assertSupported() {
  if (!IS_WIN && !IS_LINUX) {
    const name = OS_NAMES[process.platform] || process.platform;
    throw new Error(`Nova currently supports Windows 10/11 and Linux only (this is ${name}). Nexus isn't available for other systems yet.`);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported CPU architecture: ${process.arch}. Nexus needs a 64-bit ${platformLabel()} system (x64 or ARM64).`);
  }
  if (IS_LINUX) {
    const l = linuxInfo();
    return { name: l.name, wsl: l.wsl, detail: `${l.name}, ${process.arch}${l.wsl ? " (WSL)" : ""}` };
  }
  const win = windowsInfo();
  if (win.major < 10) throw new Error("Nexus requires Windows 10 or Windows 11.");
  return {
    name: win.name,
    detail: `${win.name} (${os.release()}), ${process.arch}${process.arch === "arm64" ? ", runs the x64 build under emulation" : ""}`,
  };
}

/* ------------------------- release discovery ------------------------ */

const ghHeaders = () => ({
  Accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

function normalizeAssets(list) {
  return (list || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    sha256: typeof a.digest === "string" && a.digest.startsWith("sha256:") ? a.digest.slice(7) : null,
  }));
}

function githubError(r) {
  return new Error(
    r.status === 403 || r.status === 429
      ? "GitHub rate limit reached. Try again later, or set a GITHUB_TOKEN environment variable."
      : `Could not reach the release service (HTTP ${r.status}).`
  );
}

/** Returns { version, notes, publishedAt, platforms, assets? }. */
async function getLatestRelease() {
  // Primary: the same latest.json the app's updater reads (no API rate limits).
  try {
    const r = await fetchJson(LATEST_JSON);
    if (r.ok && r.data?.version) {
      return {
        version: cleanVersion(r.data.version),
        notes: r.data.notes || "",
        publishedAt: r.data.pub_date || null,
        platforms: r.data.platforms || {},
      };
    }
  } catch {
    /* fall through to the API */
  }

  const r = await fetchJson(RELEASE_API, { headers: ghHeaders() });
  if (!r.ok) throw githubError(r);
  return {
    version: cleanVersion(r.data.tag_name),
    notes: r.data.body || "",
    publishedAt: r.data.published_at || null,
    platforms: {},
    assets: normalizeAssets(r.data.assets),
  };
}

async function loadAssets(release) {
  if (release.assets) return release.assets;
  try {
    const r = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/v${release.version}`, { headers: ghHeaders() });
    if (r.ok) release.assets = normalizeAssets(r.data.assets);
  } catch {
    /* fall back to latest.json URLs */
  }
  return release.assets || [];
}

const SETUP_RE = /setup\.exe$/i;
const X64_RE = /(x64|x86[_-]64|amd64)/i;
const ARM_RE = /(aarch64|arm64)/i;

/** Picks the Windows installer (x64) from a release's assets. */
function pickInstaller(assets) {
  const candidates = assets
    .filter((a) => /^nexus/i.test(a.name) && SETUP_RE.test(a.name) && !ARM_RE.test(a.name))
    .map((a) => ({ a, score: X64_RE.test(a.name) ? 1 : 0 }))
    .sort((x, y) => y.score - x.score);
  return candidates.length ? candidates[0].a : null;
}

async function resolveInstaller(release) {
  const assets = await loadAssets(release);
  const picked = assets.length ? pickInstaller(assets) : null;
  if (picked) return picked;

  // Fallback: the platform URL from latest.json (updater artifact).
  const url = release.platforms?.[PLATFORM_KEY]?.url;
  if (url && SETUP_RE.test(new URL(url).pathname)) {
    return { name: path.basename(new URL(url).pathname), url, sha256: null };
  }

  throw new Error(`Nexus ${release.version} has no Windows installer yet. Check ${RELEASES} for available downloads.`);
}

const LINUX_FORMATS = { deb: /\.deb$/i, rpm: /\.rpm$/i, appimage: /\.appimage$/i };

/** Picks the first available Linux package, in the order of `formats`, built for this CPU. */
function pickLinuxPackage(assets, formats) {
  const arm = process.arch === "arm64";
  for (const format of formats) {
    const hit = assets.find((a) => {
      if (!/^nexus/i.test(a.name) || !LINUX_FORMATS[format].test(a.name)) return false;
      // No emulation on Linux, so the architecture has to match (an untagged asset is assumed x64).
      return arm ? ARM_RE.test(a.name) : !ARM_RE.test(a.name);
    });
    if (hit) return { ...hit, format };
  }
  return null;
}

async function resolveLinuxPackage(release, formats) {
  const assets = await loadAssets(release);
  const picked = assets.length ? pickLinuxPackage(assets, formats) : null;
  if (picked) return picked;

  // Fallback: the platform URLs from latest.json (Tauri may key them "linux-x86_64-appimage" etc).
  for (const key of [PLATFORM_KEY, `${PLATFORM_KEY}-appimage`, `${PLATFORM_KEY}-deb`, `${PLATFORM_KEY}-rpm`]) {
    const url = release.platforms?.[key]?.url;
    if (!url) continue;
    const name = path.basename(new URL(url).pathname);
    const format = formats.find((f) => LINUX_FORMATS[f].test(name));
    if (format) return { name, url, sha256: null, format };
  }

  throw new Error(`Nexus ${release.version} has no Linux package (${formats.join("/")}) for ${process.arch} yet. Check ${RELEASES} for available downloads.`);
}

/* ------------------------- installed-app detection ------------------ */

const UNINSTALL = "\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP_NAME;

/** Installed Nexus version from the Windows uninstall registry, or null. */
async function getWindowsInstalledVersion() {
  const keys = [`HKCU${UNINSTALL}`, `HKLM${UNINSTALL}`, `HKLM\\Software\\WOW6432Node${UNINSTALL.replace("\\Software", "")}`];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync("reg", ["query", key, "/v", "DisplayVersion"], { windowsHide: true });
      const m = stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/i);
      if (m) return cleanVersion(m[1]);
    } catch {
      /* try next */
    }
  }
  return null;
}

const appImageMetaPath = () => path.join(xdgData(), "nova", "appimage.json");

try {
  const { file: desktopFile, iconFound } = await writeDesktopEntry(target, dir);
  console.log(`Added a launcher entry: ${desktopFile}`);
  if (!iconFound) console.log("Couldn't extract an icon from the AppImage; set NEXUS_ICON_PATH to use your own.");
} catch (err) {
  console.log(`Note: couldn't create the launcher entry (${err.message}).`);
}

async function readAppImageMeta() {
  try {
    const m = JSON.parse(await fs.readFile(appImageMetaPath(), "utf8"));
    return typeof m?.version === "string" && typeof m?.path === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Strips the Debian epoch ("1:") and packaging revision ("-1", "-1ubuntu2"). */
const cleanDebVersion = (v) => cleanVersion(v).replace(/^\d+:/, "").replace(/-\d[\w.+~]*$/, "");

/** Linux: { version, source: "deb" | "rpm" | "appimage", exePath? } or null. */
async function getLinuxInstalled() {
  if (await which("dpkg-query")) {
    try {
      const { stdout } = await execFileAsync("dpkg-query", ["-W", "-f=${db:Status-Abbrev}\t${Version}", APP_PKG]);
      const [status, ver] = stdout.split("\t");
      if (status.trim().startsWith("ii") && ver?.trim()) return { version: cleanDebVersion(ver), source: "deb" };
    } catch {
      /* not installed as a deb */
    }
  }
  if (await which("rpm")) {
    try {
      const { stdout } = await execFileAsync("rpm", ["-q", "--qf", "%{VERSION}", APP_PKG]);
      if (stdout.trim()) return { version: cleanVersion(stdout), source: "rpm" };
    } catch {
      /* not installed as an rpm */
    }
  }
  const meta = await readAppImageMeta();
  if (meta && (await exists(meta.path))) return { version: cleanVersion(meta.version), source: "appimage", exePath: meta.path };
  return null;
}

/** { version, source } for the installed Nexus app on this OS, or null. `source` tells updates which format to keep using. */
async function getInstalledInfo() {
  if (IS_LINUX) return getLinuxInstalled();
  if (!IS_WIN) return null;
  const version = await getWindowsInstalledVersion();
  return version ? { version, source: "windows" } : null;
}

async function getInstalledVersion() {
  return (await getInstalledInfo())?.version ?? null;
}

/** Returns { version, exePath } if the Nexus desktop app is installed, else null. */
async function findInstalledApp() {
  if (IS_LINUX) {
    const info = await getLinuxInstalled();
    if (!info) return null;
    const exePath = info.exePath ?? (await which(APP_BIN)) ?? (await which(APP_NAME));
    return { version: info.version, exePath };
  }
  if (!IS_WIN) return null;
  const version = await getWindowsInstalledVersion();
  const roots = [process.env.LOCALAPPDATA, process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean);
  const candidates = roots.flatMap((r) => [path.join(r, APP_NAME, APP_EXE), path.join(r, "Programs", APP_NAME, APP_EXE)]);

  let exePath = null;
  for (const c of candidates) {
    if (await exists(c)) {
      exePath = c;
      break;
    }
  }
  return version || exePath ? { version, exePath } : null;
}

async function isAppRunning() {
  if (IS_LINUX) {
    try {
      await execFileAsync("pgrep", ["-x", "-i", APP_BIN]);
      return true; // pgrep exits 1 when nothing matches
    } catch {
      return false;
    }
  }
  if (!IS_WIN) return false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${APP_EXE}`, "/NH"], { windowsHide: true });
    return stdout.toLowerCase().includes(APP_EXE.toLowerCase());
  } catch {
    return false;
  }
}

/* ----------------------- Nexus app sign-in hand-off ----------------- */

const CRED_WRITE_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NovaCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL c, uint flags);
  public static void Write(string target, string user, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    IntPtr p = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, p, b.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)b.Length;
      c.CredentialBlob = p; c.Persist = 2; c.UserName = user;
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
[NovaCred]::Write($env:NOVA_TARGET, $env:NOVA_USER, $env:NOVA_SECRET)
`;

/** Linux: stores the key in the Secret Service keyring via libsecret's `secret-tool`. */
async function writeLinuxCredential(key) {
  const tool = await which("secret-tool");
  if (!tool) {
    throw new Error(
      "Couldn't write the sign-in to the Nexus app: `secret-tool` was not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/openSUSE/Arch) and make sure a keyring such as GNOME Keyring or KWallet is running."
    );
  }
  try {
    await new Promise((resolve, reject) => {
      // The secret goes through stdin, never the command line or the environment.
      const child = spawn(tool, ["store", `--label=${APP_KEYRING_LABEL}`, ...APP_KEYRING_ATTRS], {
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 60_000,
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.on("error", () => { });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim().split("\n")[0] || `secret-tool exited with code ${code}`))
      );
      child.stdin.end(key);
    });
  } catch (err) {
    throw new Error(`Couldn't write the sign-in to the Nexus app: ${err.message}`);
  }
}

/** Stores the key in Windows Credential Manager, where the Nexus app reads it on startup. */
async function writeAppCredential(key) {
  if (IS_LINUX) return writeLinuxCredential(key);
  const encoded = Buffer.from(CRED_WRITE_PS, "utf16le").toString("base64");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: 30_000,
      // The secret goes through the environment, never the command line.
      env: { ...process.env, NOVA_TARGET: APP_KEYRING_TARGET, NOVA_USER: APP_KEYRING_USER, NOVA_SECRET: key },
    });
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim().split("\n")[0];
    throw new Error(`Couldn't write the sign-in to the Nexus app: ${detail}`);
  }
}

async function deleteAppCredential() {
  if (IS_LINUX) {
    try {
      await execFileAsync("secret-tool", ["clear", "service", APP_KEYRING_SERVICE, "username", APP_KEYRING_USER], { timeout: 15_000 });
    } catch {
      /* nothing stored, or no secret-tool */
    }
    return;
  }
  try {
    await execFileAsync("cmdkey", [`/delete:${APP_KEYRING_TARGET}`], { windowsHide: true });
  } catch {
    /* nothing stored */
  }
}

/* ------------------------- download + install ----------------------- */

async function downloadFile(url, dest, expectedSha) {
  assertTrustedDownload(url);
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10 * 60_000) });
  } catch (err) {
    throw netError(err);
  }
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  assertTrustedDownload(res.url || url); // re-check after redirects

  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  let got = 0;
  let lastPct = -1;

  await pipeline(
    Readable.fromWeb(res.body),
    async function* (src) {
      for await (const chunk of src) {
        got += chunk.length;
        hash.update(chunk);
        if (total && process.stdout.isTTY) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\r  ${pct}%  (${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
          }
        }
        yield chunk;
      }
    },
    createWriteStream(dest)
  );
  if (process.stdout.isTTY && total) process.stdout.write("\n");

  if (total && got !== total) throw new Error("The download was incomplete. Please try again.");
  if (got === 0) throw new Error("The downloaded file was empty.");
  if (expectedSha) {
    if (hash.digest("hex") !== expectedSha.toLowerCase()) {
      throw new Error("Checksum mismatch: the installer does not match the published release.");
    }
    console.log("Checksum verified.");
  } else {
    console.log("Note: no checksum was published for this file, so it couldn't be verified.");
  }
}

function launchInstaller(file, args, wait) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: !wait, stdio: "ignore" });
    child.once("error", (err) => {
      // Installer wants elevation (UAC) - let the shell handle it.
      if (!wait && (err.code === "UNKNOWN" || err.code === "EACCES" || err.errno === 740)) {
        const c = spawn("cmd.exe", ["/c", "start", "", file], { detached: true, stdio: "ignore", windowsHide: true });
        c.once("error", reject);
        c.once("spawn", () => {
          c.unref();
          resolve(null);
        });
      } else {
        reject(err);
      }
    });
    if (wait) {
      child.once("exit", (code) => resolve(code));
    } else {
      child.once("spawn", () => {
        child.unref();
        resolve(null);
      });
    }
  });
}

/** Which Linux formats to consider, best first. */
async function linuxFormatOrder(requested, installedSource) {
  if (requested) {
    const f = String(requested).toLowerCase();
    if (!LINUX_FORMATS[f]) throw new Error("--format must be deb, rpm or appimage.");
    return [f];
  }
  // Updating an existing install must stay in its format, or you'd end up with two copies.
  if (installedSource && LINUX_FORMATS[installedSource]) return [installedSource];
  return linuxAvailableFormats();
}

async function linuxAvailableFormats() {
  const formats = [];
  if ((await which("dpkg")) && (await which("apt-get"))) formats.push("deb");
  if ((await which("rpm")) && ((await which("dnf")) || (await which("zypper")) || (await which("yum")))) formats.push("rpm");
  formats.push("appimage");
  return formats;
}

function runInherit(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** Runs a command as root: directly if we are root, otherwise through sudo (TTY) or pkexec (no TTY). */
async function runPrivileged(cmd, args, envPairs = []) {
  const inner = envPairs.length ? ["env", ...envPairs, cmd, ...args] : [cmd, ...args];
  if (isRoot()) return runInherit(inner[0], inner.slice(1));
  let tool = null;
  for (const t of process.stdin.isTTY ? ["sudo", "pkexec"] : ["pkexec", "sudo"]) {
    if (await which(t)) {
      tool = t;
      break;
    }
  }
  if (!tool) throw new Error("Installing needs root and neither sudo nor pkexec was found. Re-run Nova as root, or use `--format appimage` (no root needed).");
  return runInherit(tool, inner);
}

async function installSystemPackage(format, file, opts) {
  const auto = Boolean(opts.silent || opts.passive);
  if (format === "deb") {
    if (!(await which("apt-get"))) throw new Error("apt-get was not found. Use `--format appimage`, or install the .deb yourself.");
    const args = ["install", ...(auto ? ["-y"] : []), ...(opts.silent ? ["-qq"] : []), ...(opts.force ? ["--reinstall"] : []), file];
    return runPrivileged("apt-get", args, auto ? ["DEBIAN_FRONTEND=noninteractive"] : []);
  }
  const mgr = (await which("dnf")) ? "dnf" : (await which("zypper")) ? "zypper" : (await which("yum")) ? "yum" : null;
  if (!mgr) throw new Error("No rpm package manager (dnf, zypper or yum) was found. Use `--format appimage`, or install the .rpm yourself.");
  const args =
    mgr === "zypper"
      ? [...(auto ? ["--non-interactive"] : []), "install", "--allow-unsigned-rpm", ...(opts.force ? ["--force"] : []), file]
      : [opts.force ? "reinstall" : "install", ...(auto ? ["-y"] : []), file];
  return runPrivileged(mgr, args);
}

const desktopEntryPath = () => path.join(xdgData(), "applications", `${APP_BIN}.desktop`);

/** Escapes a value for a quoted Exec= argument in a .desktop file. */
const desktopQuote = (s) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

const BUNDLED_ICON = fileURLToPath(new URL("./nexus.png", import.meta.url));

/** Copies the icon that ships with Nova next to the AppImage. Returns its path, or null. */
async function installIcon(destDir) {
  const override = env("NEXUS_ICON_PATH", "");
  const src = override && (await exists(override)) ? override : BUNDLED_ICON;
  if (!(await exists(src))) return null;
  const dest = path.join(destDir, `${APP_BIN}${path.extname(src) || ".png"}`);
  try {
    await fs.copyFile(src, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Writes ~/.local/share/applications/<bin>.desktop so Nexus shows up in app menus. */
async function writeDesktopEntry(appImage, dataDir) {
  const icon = (await installIcon(dataDir)) ?? APP_BIN; // theme-name fallback
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    `Comment=${APP_NAME} workspace`,
    `Exec=${desktopQuote(appImage)} %U`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Office;Utility;",
    "",
  ].join("\n");

  const file = desktopEntryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entry, { mode: 0o644 });

  const udd = await which("update-desktop-database");
  if (udd) await execFileAsync(udd, [path.dirname(file)]).catch(() => { });
  return { file, iconFound: icon !== APP_BIN };
}

/** AppImages need no root: keep one copy under ~/.local/share/<app> and link it into ~/.local/bin. */
async function installAppImage(file, release) {
  const dir = path.join(xdgData(), APP_BIN);
  const target = path.join(dir, `${APP_NAME}.AppImage`);
  const binDir = path.join(os.homedir(), ".local", "bin");
  const link = path.join(binDir, APP_BIN);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  // Stage then rename, so an update works even while the old AppImage is running.
  const staged = `${target}.new`;
  try {
    await fs.copyFile(file, staged);
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, target);
  } catch (err) {
    await fs.rm(staged, { force: true }).catch(() => { }); // don't leave a half-copied file behind
    throw err;
  }

  // Only create the link if it's absent or already ours; never clobber someone else's file.
  const st = await fs.lstat(link).catch(() => null);
  let ours = false;
  if (st?.isSymbolicLink()) {
    const current = await fs.readlink(link).catch(() => null);
    ours = current !== null && path.resolve(binDir, current) === target; // handles relative links
  }
  const linked = !st || ours;
  if (!st) await fs.symlink(target, link); // an existing link of ours already points at the right file

  await fs.mkdir(path.dirname(appImageMetaPath()), { recursive: true });
  await fs.writeFile(appImageMetaPath(), JSON.stringify({ version: release.version, path: target, installedAt: new Date().toISOString() }, null, 2));

  try {
    const { file: desktopFile, iconFound } = await writeDesktopEntry(target, dir);
    console.log(`Added a launcher entry: ${desktopFile}`);
    if (!iconFound) console.log("Couldn't find an icon to install; the launcher will use a generic one.");
  } catch (err) {
    console.log(`Note: couldn't create the launcher entry (${err.message}).`);
  }

  console.log(`Nexus ${release.version} installed to ${target}.`);
  if (linked) {
    console.log(`Start it with \`${APP_BIN}\`.`);
    if (!(process.env.PATH || "").split(path.delimiter).includes(binDir)) console.log(`Note: ${binDir} is not on your PATH yet.`);
  } else {
    console.log(`${link} already exists and isn't Nova's link, so it was left alone. Run ${target} directly.`);
  }
  console.log("If it won't start, install FUSE 2 (libfuse2 / libfuse2t64), which AppImages need.");
}

async function installLinux(release, opts) {
  const formats = await linuxFormatOrder(opts.format, opts.installedSource);
  const pkg = await resolveLinuxPackage(release, formats);
  console.log(`Downloading Nexus ${release.version} for Linux (${pkg.name})...`);

  if (await isAppRunning()) console.log("Note: Nexus is running. Close it so the update can take effect.");

  // The package manager runs as root (and apt as the _apt user), so the file must be readable
  // by others; the directory stays writable only by us.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-"));
  await fs.chmod(dir, 0o755);
  const dest = path.join(dir, path.basename(pkg.name));
  try {
    await downloadFile(pkg.url, dest, pkg.sha256);
    if (pkg.format === "appimage") {
      await installAppImage(dest, release);
    } else {
      console.log(`Installing the ${pkg.format} package (this needs root)...`);
      const code = await installSystemPackage(pkg.format, dest, opts);
      if (code !== 0) throw new Error(`The package manager exited with code ${code}.`);
      console.log(`Nexus ${release.version} installed.`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

async function installRelease(release, opts = {}) {
  assertSupported();
  if (IS_LINUX) return installLinux(release, opts);
  const pkg = await resolveInstaller(release);
  console.log(`Downloading Nexus ${release.version} for Windows (${pkg.name})...`);

  if (await isAppRunning()) {
    console.log("Note: Nexus is running. Close it so the installer can replace its files.");
  }

  const dest = path.join(os.tmpdir(), `nexus-${release.version}-${Date.now()}-${path.basename(pkg.name)}`);
  let removeTemp = true;
  try {
    await downloadFile(pkg.url, dest, pkg.sha256);

    const args = opts.silent ? ["/S"] : opts.passive ? ["/P"] : [];
    const wait = Boolean(opts.silent || opts.passive);
    console.log(wait ? "Running the installer..." : "Launching the installer...");
    const code = await launchInstaller(dest, args, wait);
    if (wait) {
      if (code !== 0) throw new Error(`The installer exited with code ${code}.`);
      console.log(`Nexus ${release.version} installed.`);
    } else {
      removeTemp = false; // the installer is still using the file
      console.log("Installer launched. Follow the Windows prompts to finish.");
    }
  } finally {
    if (removeTemp) await fs.rm(dest, { force: true }).catch(() => { });
  }
}

/* ----------------------------- credentials -------------------------- */

function credentialsPath() {
  const base = IS_WIN ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : xdgConfig();
  return path.join(base, "nova", "credentials.json");
}

async function loadCredentials() {
  try {
    const c = JSON.parse(await fs.readFile(credentialsPath(), "utf8"));
    return typeof c?.key === "string" && c.key ? c : null;
  } catch {
    return null;
  }
}

async function saveCredentials(creds) {
  const file = credentialsPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // It holds a bearer token: owner-only on Linux (mode only applies when the file is created, so chmod too).
  await fs.writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => { });
}

async function clearCredentials() {
  await fs.rm(credentialsPath(), { force: true }).catch(() => { });
}

async function requireLogin() {
  const creds = await loadCredentials();
  if (!creds) throw new Error("You're not signed in. Run `nova login` first.");
  return creds;
}

const authHeader = (creds) => ({ Authorization: `Bearer ${creds.key}` });

function apiError(r, fallback) {
  if (r.status === 401) return new Error("Your session is no longer valid. Run `nova login` again.");
  return new Error(r.data?.error || `${fallback} (HTTP ${r.status})`);
}

/* ------------------------------- login ------------------------------ */

// Matches the code the Nexus server shows on its confirmation page.
const confirmCode = (state) => {
  const hex = sha256(state).slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
};

async function doLogin(provider, { browser }) {
  if (!["google", "github"].includes(provider)) throw new Error("Provider must be 'google' or 'github'.");
  assertSupported();

  // Sign-in is only offered once the Nexus desktop app is on this computer.
  const app = await findInstalledApp();
  if (!app) {
    throw new Error("Nexus isn't installed on this computer. Run `nova install` first, then `nova login`.");
  }
  console.log(`Found Nexus${app.version ? ` ${app.version}` : ""}.`);

  const verifier = randomBytes(32).toString("hex");
  const start = await fetchJson(`${CLOUD}/auth/oauth/start`, {
    method: "POST",
    body: { provider, challenge: sha256(verifier) },
  });
  if (!start.ok) throw new Error(start.data?.error || `Couldn't start sign-in (HTTP ${start.status}).`);

  const { state, url } = start.data || {};
  if (!state || !url) throw new Error("The server didn't return a sign-in session.");
  assertHttps(url, "Sign-in URL");

  console.log(`Signing in with ${provider === "google" ? "Google" : "GitHub"}.`);
  console.log(`\n  Confirmation code:  ${confirmCode(state)}\n`);
  console.log("After you authorize, the browser asks you to confirm. Only continue if it shows this same code.");
  if (browser) {
    if (IS_LINUX && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.log("No display detected; trying to open a browser anyway. If nothing opens, use the link below.");
    }
    await openUrl(url); // launches the browser if it can, and always prints the link too
  } else {
    console.log(`Open this link:\n${url}`);
  }
  console.log("\nWaiting for sign-in (Ctrl+C to cancel)...");

  const deadline = Date.now() + 10 * 60_000;
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    let r;
    try {
      r = await fetchJson(`${CLOUD}/auth/oauth/poll`, { method: "POST", body: { state, verifier } });
      failures = 0;
    } catch (err) {
      if (++failures >= 5) throw err;
      continue;
    }
    if (r.status === 429) continue;
    if (!r.ok) throw new Error(r.data?.error || `Sign-in failed (HTTP ${r.status}).`);
    if (r.data?.key) {
      const creds = { key: r.data.key, savedAt: new Date().toISOString() };
      const me = await fetchJson(`${CLOUD}/auth/me`, { headers: authHeader(creds) }).catch(() => null);
      if (me?.ok && me.data?.email) creds.email = me.data.email;
      await saveCredentials(creds);
      console.log(`Signed in${creds.email ? ` as ${creds.email}` : ""}.`);

      // Hand the same session to the Nexus app so it's signed in too.
      try {
        await writeAppCredential(creds.key);
        creds.sharedWithApp = true;
        await saveCredentials(creds);
        console.log("The Nexus app is signed in too.");
        if (await isAppRunning()) console.log("Nexus is currently running. Restart it to pick up the new sign-in.");
      } catch (err) {
        console.error(`Warning: ${err.message}`);
        console.error("Nova is signed in, but you'll need to sign in inside the Nexus app yourself.");
        process.exitCode = 1;
      }
      return;
    }
  }
  throw new Error("Sign-in timed out. Please try again.");
}

/* ------------------------------ commands ---------------------------- */

program.name("nova").description("Official CLI companion for Nexus App").version(VERSION, "-v, --version", "Show CLI version");

program.addHelpText(
  "after",
  `
Examples:
  nova install            Install the latest Nexus for your system
  nova update             Install the latest release only if it's newer
  nova check              Show installed vs. latest version
  nova login              Sign in or sign up (Google/GitHub); requires Nexus installed
  nova whoami             Show the signed-in account
  nova usage              Show your Nexus Cloud AI usage
  nova logout             Sign out of Nova and the Nexus app
  nova status             Check Nexus Cloud health
  nova website            Open the Nexus website
  nova releases           Open the Nexus releases page
  nova doctor             Diagnose your setup
  nova version            Show CLI version

Nexus is available for Windows 10/11 and Linux (x64 and ARM64).
On Linux, Nova installs the .deb or .rpm with your package manager (needs root),
or an AppImage under ~/.local (no root). Use --format to choose.
`
);

program
  .command("install")
  .description("Download and install the latest Nexus for your system")
  .option("--passive", "show installer progress but require no interaction")
  .option("--silent", "install with no UI at all")
  .option("--format <format>", "Linux only: deb, rpm or appimage (default: auto-detect)")
  .action(
    run(async (opts) => {
      assertSupported();
      console.log("Checking the latest Nexus release...");
      const [release, info] = await Promise.all([getLatestRelease(), getInstalledInfo()]);
      await installRelease(release, { ...opts, installedSource: info?.source });
    })
  );

program
  .command("update")
  .description("Update Nexus if a newer release is available")
  .option("-f, --force", "reinstall even if already up to date")
  .option("--passive", "show installer progress but require no interaction")
  .option("--silent", "install with no UI at all")
  .option("--format <format>", "Linux only: deb, rpm or appimage (default: the format already installed)")
  .action(
    run(async (opts) => {
      assertSupported();
      console.log("Checking the latest Nexus release...");
      const [release, info] = await Promise.all([getLatestRelease(), getInstalledInfo()]);
      const installed = info?.version ?? null;
      if (installed && compareVersions(installed, release.version) >= 0 && !opts.force) {
        console.log(`Nexus is up to date (${installed}).`);
        return;
      }
      console.log(
        installed ? `Update available: ${installed} -> ${release.version}` : `Installing Nexus ${release.version} (installed version unknown).`
      );
      await installRelease(release, { ...opts, installedSource: info?.source });
    })
  );

program
  .command("check")
  .description("Show installed and latest Nexus versions")
  .action(
    run(async () => {
      const [release, installed] = await Promise.all([getLatestRelease(), getInstalledVersion()]);
      console.log(`Latest release:    ${release.version}`);
      if (release.publishedAt) console.log(`Published:         ${new Date(release.publishedAt).toLocaleString()}`);
      console.log(`Installed version: ${installed ?? "not detected"}`);
      if (installed) {
        console.log(compareVersions(installed, release.version) < 0 ? "An update is available. Run `nova update`." : "You're up to date.");
      } else if (IS_WIN || IS_LINUX) {
        console.log("Nexus doesn't appear to be installed. Run `nova install`.");
      }
      console.log(RELEASES);
    })
  );

program
  .command("login")
  .description("Sign in (or sign up) from the terminal; also signs in the installed Nexus app")
  .option("-p, --provider <provider>", "google or github", "google")
  .option("--no-browser", "print the sign-in link instead of opening a browser")
  .action(run((opts) => doLogin(opts.provider.toLowerCase(), opts)));

program
  .command("logout")
  .description("Sign out and revoke this CLI's session")
  .action(
    run(async () => {
      const creds = await loadCredentials();
      if (!creds) {
        console.log("You're already signed out.");
        return;
      }
      await fetchJson(`${CLOUD}/auth/logout`, { method: "POST", headers: authHeader(creds) }).catch(() => { });
      await clearCredentials();
      // The app shares this session, which is now revoked, so remove its copy too.
      if (creds.sharedWithApp) await deleteAppCredential();
      console.log(creds.sharedWithApp ? "Signed out of Nova and the Nexus app." : "Signed out.");
    })
  );

program
  .command("whoami")
  .description("Show the signed-in Nexus account")
  .action(
    run(async () => {
      const creds = await requireLogin();
      const r = await fetchJson(`${CLOUD}/auth/me`, { headers: authHeader(creds) });
      if (!r.ok) {
        if (r.status === 401) await clearCredentials();
        throw apiError(r, "Couldn't fetch account info");
      }
      console.log(r.data.email);
      if (r.data.createdAt) console.log(`Member since ${new Date(r.data.createdAt).toLocaleDateString()}`);
    })
  );

program
  .command("usage")
  .description("Show your Nexus Cloud AI usage")
  .action(
    run(async () => {
      const creds = await requireLogin();
      const r = await fetchJson(`${CLOUD}/api/usage`, { headers: authHeader(creds) });
      if (!r.ok) {
        if (r.status === 401) await clearCredentials();
        throw apiError(r, "Couldn't fetch usage");
      }
      const d = r.data;
      const n = (x) => Number(x ?? 0).toLocaleString();
      console.log(`5-hour window: ${n(d.usedInWindow)} / ${n(d.windowLimit)} tokens`);
      if (d.resetAt) console.log(`  resets in ${fmtDuration(new Date(d.resetAt).getTime() - Date.now())}`);
      console.log(`Today:         ${n(d.usedToday)} / ${n(d.dailyLimit)} tokens`);
      if (d.mode && d.mode !== "normal") console.log(`Service mode:  ${d.mode} (limits are reduced)`);
    })
  );

program
  .command("website")
  .alias("web")
  .description("Open the Nexus website")
  .action(run(() => openUrl(WEBSITE)));

program
  .command("status")
  .description("Check Nexus Cloud health")
  .option("-o, --open", "also open the status page in your browser")
  .action(
    run(async (opts) => {
      const t0 = Date.now();
      let healthy = false;
      try {
        const r = await fetchJson(`${CLOUD}/health`, { timeout: 10_000 });
        healthy = r.ok && r.data?.ok === true;
        console.log(healthy ? `Nexus Cloud: operational (${Date.now() - t0} ms)` : `Nexus Cloud: degraded (HTTP ${r.status})`);
      } catch (err) {
        console.log(`Nexus Cloud: unreachable (${err.message})`);
      }
      if (opts.open) await openUrl(STATUS_PAGE);
      if (!healthy) process.exitCode = 1;
    })
  );

program
  .command("releases")
  .description("Open Nexus downloads and release notes")
  .action(run(() => openUrl(RELEASES)));

program
  .command("version")
  .description("Show CLI version")
  .action(() => console.log(VERSION));

program
  .command("doctor")
  .description("Check whether your setup is ready")
  .action(
    run(async () => {
      let bad = 0;
      const line = (ok, label, detail = "") => {
        if (!ok) bad++;
        console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
      };

      const major = parseInt(process.versions.node.split(".")[0], 10);
      line(major >= MIN_NODE, "Node.js", `${process.version} (need >= ${MIN_NODE})`);

      try {
        line(true, "Platform", assertSupported().detail);
      } catch (err) {
        line(false, "Platform", err.message);
      }

      if (IS_LINUX) {
        line(true, "Install formats", (await linuxAvailableFormats()).join(", "));
        const st = await which("secret-tool");
        console.log(`${st ? "✓" : "–"} Keyring tool: ${st ? "secret-tool" : "secret-tool not found (needed to sign in the Nexus app; install libsecret-tools)"}`);
        const display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
        console.log(`${display ? "✓" : "–"} Display: ${display ? "found" : "none detected (nova login will still try to open a browser; use --no-browser to just print the link)"}`);
      }

      try {
        const r = await getLatestRelease();
        line(true, "Release feed", `latest is ${r.version}`);
      } catch (err) {
        line(false, "Release feed", err.message);
      }

      try {
        const t0 = Date.now();
        const r = await fetchJson(`${CLOUD}/health`, { timeout: 10_000 });
        line(r.ok && r.data?.ok === true, "Nexus Cloud", r.ok ? `${Date.now() - t0} ms` : `HTTP ${r.status}`);
      } catch (err) {
        line(false, "Nexus Cloud", err.message);
      }

      const app = await findInstalledApp().catch(() => null);
      line(Boolean(app), "Nexus installed", app ? app.version ?? app.exePath : "not detected (run `nova install`)");

      const creds = await loadCredentials();
      console.log(`${creds ? "✓" : "–"} Signed in: ${creds ? creds.email || "yes" : "no (optional, run `nova login`)"}`);
      if (creds) console.log(`${creds.sharedWithApp ? "✓" : "–"} Shared with Nexus app: ${creds.sharedWithApp ? "yes" : "no (sign in inside the app)"}`);

      if (bad) process.exitCode = 1;
    })
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
