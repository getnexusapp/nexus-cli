# Nova by Nexus Workspace

Official command-line companion for the [Nexus](https://www.nexusworkspace.net/) desktop app.

Install Nexus, keep it up to date, sign in, check your Nexus Cloud AI usage, and see how the service is doing, all from your PowerShell or Terminal.

> **Platform support:** Nexus is currently available for **Windows 10 and Windows 11** and for **Linux** (x64 and ARM64). Nova runs on both. macOS builds don't exist yet; when they do, Nova will gain support for them too.

## Requirements

All platforms:

- [Node.js](https://nodejs.org/) 20 or newer
- An internet connection

**Windows**

- Windows 10 or Windows 11 (64-bit; x64 or ARM64)
- Windows on ARM PCs install the x64 build of Nexus, which Windows runs under emulation.

**Linux**

- A 64-bit distribution on x64 or ARM64. Unlike Windows, there is no emulation on Linux: the CPU architecture of the Nexus package must match your machine.
- One of: `apt-get` (for `.deb`), `dnf`, `zypper` or `yum` (for `.rpm`), or nothing at all (for the AppImage, which needs no root).
- `sudo` or `pkexec` to install `.deb` and `.rpm` packages (not needed when running as root, or for AppImages).
- `secret-tool` (package `libsecret-tools` on Debian/Ubuntu, `libsecret` on Fedora, openSUSE and Arch) and a running keyring such as GNOME Keyring or KWallet, so Nova can sign in the Nexus app.
- FUSE 2 (`libfuse2` or `libfuse2t64`) if you use the AppImage.
- A graphical session to actually run Nexus. Nova works in a headless shell, but the desktop app needs a display.

## Install

```sh
npm install -g @getnexus/nova
nova --help
```

The `-g` flag matters: it puts the `nova` command on your PATH. If you'd rather not install it, you can run it once with `npx @getnexus/nova install`.

On Linux, if `npm install -g` fails with a permissions error, configure npm to use a folder in your home directory instead of running it with `sudo`:

```sh
npm config set prefix "$HOME/.local"
```

Then make sure `~/.local/bin` is on your PATH.

## Quick start

```sh
nova install     # download and install the latest Nexus
nova login       # sign in (or sign up) with Google or GitHub
nova usage       # see your Nexus Cloud AI usage
```

Something not working? Run `nova doctor` first. It checks your Node.js version, operating system, internet access, the release feed, Nexus Cloud and your sign-in. On Linux it also lists the install formats available on your system and checks for `secret-tool` and a display.

## Commands

| Command | What it does |
| --- | --- |
| `nova install [--passive\|--silent] [--format deb\|rpm\|appimage]` | Download and install the latest Nexus |
| `nova update [--force] [--passive\|--silent] [--format deb\|rpm\|appimage]` | Install only if a newer release exists |
| `nova check` | Show installed vs. latest version |
| `nova login [-p google\|github] [--no-browser]` | Sign in or sign up from the terminal (requires Nexus installed); also signs in the Nexus app |
| `nova whoami` | Show the signed-in account |
| `nova usage` | Show Nexus Cloud AI token usage |
| `nova logout` | Sign out of Nova and the Nexus app, revoking the session |
| `nova status [--open]` | Check Nexus Cloud health (`--open` also opens the status page) |
| `nova website` | Open the Nexus website |
| `nova releases` | Open the releases page |
| `nova doctor` | Diagnose your setup |
| `nova version` | Print the CLI version (also `nova -v`) |

`--format` applies to Linux only. Run `nova <command> --help` for details on any command.

## Installing and updating Nexus

`nova install` downloads the latest Nexus installer for your system from the official release channel and installs it.

### Windows

Nova downloads the Windows installer (`setup.exe`) and launches it.

| Option | Effect |
| --- | --- |
| *(none)* | Opens the normal installer so you can follow the prompts. Windows may ask for permission (UAC). |
| `--passive` | Shows installer progress but needs no interaction. |
| `--silent` | Installs with no window at all. Nova waits for it to finish and reports success or failure. |

### Linux

Nova can install Nexus as a `.deb` package, an `.rpm` package or an AppImage. By default it picks the first format your system supports, in that order. Use `--format` to choose one yourself.

| Format | How it installs | Needs root |
| --- | --- | --- |
| `deb` | `apt-get install` on Debian, Ubuntu and derivatives | Yes (via `sudo` or `pkexec`) |
| `rpm` | `dnf`, `zypper` or `yum` on Fedora, openSUSE, RHEL and derivatives | Yes (via `sudo` or `pkexec`) |
| `appimage` | Copied to `~/.local/share/nexus/Nexus.AppImage` | No |

| Option | Effect |
| --- | --- |
| *(none)* | Runs your package manager with its normal prompts. |
| `--passive` | Answers the package manager's confirmation prompts automatically. |
| `--silent` | Same as `--passive`, with quieter output. |
| `--format <format>` | Forces `deb`, `rpm` or `appimage`. |

**AppImage installs.** Nova links the AppImage into `~/.local/bin` so you can start it with `nexus`, adds a launcher entry at `~/.local/share/applications/nexus.desktop` so Nexus appears in your application menu, and installs Nexus’s icon for that entry. Set `NEXUS_ICON_PATH` to use your own PNG instead. Nova never overwrites an existing `~/.local/bin/nexus` that isn't its own link; in that case run the AppImage directly. If `~/.local/bin` isn't on your PATH, Nova tells you.

**Updates stay in the same format.** `nova update` reinstalls using the format you already have, so you never end up with two copies of Nexus. Pass `--format` to override this.

### Updating

`nova update` does the same as `nova install`, but only when a newer version than the one installed is available. Add `--force` to reinstall the current version. Close Nexus before updating so the installer can replace its files; Nova will remind you if it's still running.

### Downloads are verified

Downloads are restricted to GitHub over HTTPS, checked for size, and verified against the published SHA-256 checksum whenever GitHub provides one. If no checksum is available, Nova tells you so.

## Signing in

`nova login` only works once the Nexus desktop app is installed (run `nova install` first). New accounts are created automatically on first sign-in, so the same command signs you up or in.

1. Nova shows a **confirmation code** and opens your browser (use `--no-browser` to print the link instead, which is handy over SSH or on a machine without a display).
2. Authorize with Google or GitHub (`-p github` to use GitHub; Google is the default).
3. The browser asks you to confirm. **Only continue if it shows the same code Nova printed.**
4. Nova finishes signing in and saves your session.

Your session is saved in two places.

| | Nova's own copy | The Nexus app's copy |
| --- | --- | --- |
| **Windows** | `%APPDATA%\nova\credentials.json` | Windows Credential Manager |
| **Linux** | `~/.config/nova/credentials.json` (or `$XDG_CONFIG_HOME/nova/credentials.json`), readable only by you | The Secret Service keyring (GNOME Keyring, KWallet), written with `secret-tool` |

If Nexus is already running, restart it to pick up the sign-in.

Nova and the app share one session, so `nova logout` signs you out of both and revokes the session on the server. Treat your session like a password and never share `credentials.json`.

## Exit codes

Nova exits with `0` on success and `1` on any error (including an unhealthy `nova status`), so it's safe to use in scripts.

PowerShell:

```powershell
nova update --silent
if ($LASTEXITCODE -ne 0) { Write-Error "Nexus update failed" }
```

Bash:

```sh
nova update --silent || echo "Nexus update failed" >&2
```

## Troubleshooting

| Problem | What to try |
| --- | --- |
| `nova` is not recognized / command not found | Install with `npm install -g @getnexus/nova`, then open a new terminal window. On Linux, check that npm's global `bin` folder is on your PATH. |
| "Nova currently supports Windows 10/11 and Linux only" | Nexus isn't available for macOS or other systems yet. |
| "GitHub rate limit reached" | Wait a while, or set the `GITHUB_TOKEN` environment variable. |
| Installer doesn't appear (Windows) | Check for a UAC prompt or a SmartScreen warning, or run `nova install --passive`. |
| "Checksum mismatch" | The download was corrupted or altered. Run the command again; if it persists, contact support. |
| "Nexus isn't installed" when signing in | Run `nova install` first. |
| "Your session is no longer valid" | Run `nova login` again. |
| Signed in to Nova but not the app | Restart Nexus. If it still asks you to sign in, sign in inside the app. |
| Sign-in times out | You have 10 minutes to complete it in the browser. Run `nova login` again. |
| "`secret-tool` was not found" (Linux) | Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora, openSUSE, Arch), and make sure GNOME Keyring or KWallet is running. Nova stays signed in; you'd otherwise sign in inside the app. |
| "neither sudo nor pkexec was found" (Linux) | Re-run Nova as root, or use `nova install --format appimage`, which needs no root. |
| "apt-get was not found" / no rpm package manager (Linux) | Use `--format appimage`, or install the downloaded package yourself. |
| The AppImage won't start (Linux) | Install FUSE 2 (`libfuse2` or `libfuse2t64`). |
| No Nexus entry in the app menu (Linux) | Log out and back in, or run `update-desktop-database ~/.local/share/applications`. AppImage installs only. |
| `nova login` can't open a browser (Linux) | Run `nova login --no-browser` and open the printed link yourself. |
| "no Linux package ... for arm64 yet" | The release has no build for your CPU architecture. Check the releases page. |

Still stuck? Run `nova doctor` and include its output when you contact support.

## Privacy and security

- Nova only talks to the Nexus Cloud service, GitHub (for releases and downloads) and the sign-in provider pages you open in your browser. It does not collect analytics.
- Secrets are never passed on the command line. On Windows, the Nexus Cloud key is handed to Windows Credential Manager through the environment of a short-lived process. On Linux, it is handed to `secret-tool` through standard input.
- On Linux, installing a `.deb` or `.rpm` runs your package manager with root privileges through `sudo` or `pkexec`. Nova only does this for packages it has just downloaded from the official release channel. AppImage installs stay entirely inside your home directory.
- Use of Nexus Cloud through Nova is covered by the Nexus Software License and Privacy Policy.

## Support

Questions or bug reports: [support@nexusworkspace.net](mailto:support@nexusworkspace.net)

## License

Nova is proprietary software, not open source. Use is governed by the [Nova CLI License](https://nexusworkspace.net/nova-license) and the [Nexus Software License](https://nexusworkspace.net/software-license).

Copyright © 2026 Nawrasse Andaloussi Dahman. All Rights Reserved.
