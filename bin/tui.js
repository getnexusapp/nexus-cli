// Nova interactive shell: run `nova` with no arguments in a terminal.
// Zero dependencies. Commands are executed by re-spawning bin/nova.js, so every
// existing command works exactly as it does from the normal CLI.
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const NOVA_BIN = fileURLToPath(new URL("./nova.js", import.meta.url));

/* ------------------------------- branding ------------------------------ */
// Nova logo, pre-rendered from Nova.png with Unicode quadrant blocks (34 columns x 20 rows).
// BRAND is [r, g, b] and tints the logo, the prompt and the title.
const BRAND = [240, 240, 240];
const LOGO = [
  "              ▗▄██▄▖",
  "           ▗▄████████▄▄",
  "        ▄▟██████████████▙▄",
  "      █████████████████████▖",
  " ▄▄█▙▄▖ ▀▜████▛▀  ▀▜███████▌",
  "████████▄▖ ▀▘        ▝▀████▌   ▗▄█",
  "███████████▙▄           ▝▀▜▌▄▟████",
  " ▝▀███████████▙▄▄          ▐██████",
  "█▙▄ ▝▀▜█████████▌▐▄▖       ▐██████",
  "█████▄▖ ▀▜████▛▀  ▀▜█▙▄    ▐██████",
  "██████▌    ▀▀█▄▄  ▄▄████▙▄ ▝▀█████",
  "██████▌       ▝▀▌▐██████████▄▖ ▀▜█",
  "██████▌          ▝▀▜███████████▄▖",
  "████▛▀▐▙▄            ▀▜███████████",
  "█▀▘   ▐████▄▖        ▗▄ ▝▀████████",
  "      ▐███████▄▄  ▄▟████▙▄▖ ▀▜█▛▀",
  "      ▐█████████████████████",
  "       ▝▀▜██████████████▛▀",
  "           ▀▜████████▀▀",
  "              ▝▀██▀▘",
];

/* -------------------------------- styling ------------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const brand = sgr(`38;2;${BRAND.join(";")}`);
const brandBold = sgr(`1;38;2;${BRAND.join(";")}`);
const bold = sgr("1");
const dim = sgr("2");
const gray = sgr("90");

const out = (s) => process.stdout.write(s);
const cols = () => process.stdout.columns || 80;
const fit = (s, max) => (s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s);

/* ---------------------------------- UI ---------------------------------- */

export async function startTui({ version, commands }) {
  const builtins = [
    ["help", "Show every command"],
    ["clear", "Clear the screen"],
    ["exit", "Leave Nova"],
  ];
  const all = [...commands.filter(([n]) => n !== "help"), ...builtins].sort((a, b) => a[0].localeCompare(b[0]));
  const names = all.map(([n]) => n);
  const MAX_ROWS = 10;
  const PROMPT = "> ";

  let buffer = "";
  let cursor = 0;
  let history = [];
  let histIdx = -1;
  let draft = "";
  let drawn = false;
  let busy = false;

  process.on("SIGINT", () => { }); // Ctrl+C is handled as a key; this also shields Nova while a command runs

  function header() {
    out("\n");
    LOGO.forEach((row, i) => {
      const last = i === LOGO.length - 1;
      out("  " + brand(last ? row.padEnd(34) : row) + (last ? "  " + brandBold("Nova") + gray(" by Nexus Workspace") : "") + "\n");
    });
    out("\n");
    out("  " + bold(`Nova CLI ${version}`) + "\n");
    out("  " + gray("Tab to autocomplete, ↑/↓ for history, Ctrl+C to quit") + "\n\n");
  }

  function suggestions() {
    const word = buffer.trimStart();
    if (word.includes(" ")) {
      const hit = all.find(([n]) => n === word.split(/\s+/)[0]);
      return { rows: hit ? [hit] : [], more: 0 };
    }
    const matches = all.filter(([n]) => n.startsWith(word));
    return { rows: matches.slice(0, MAX_ROWS), more: Math.max(0, matches.length - MAX_ROWS) };
  }

  function clearLive() {
    if (!drawn) return;
    out("\x1b[1A\r\x1b[J"); // from the prompt line, up to the divider, wipe everything below
    drawn = false;
  }

  function render() {
    const width = cols() - 1;
    clearLive();
    const { rows, more } = suggestions();
    const nameW = Math.max(14, ...rows.map(([n]) => n.length + 2));
    const lines = [gray("─".repeat(Math.min(width, 60))), brand(PROMPT.trimEnd()) + " " + fit(buffer, width - PROMPT.length)];
    for (const [n, d] of rows) {
      lines.push("    " + dim(n.padEnd(nameW)) + gray(fit(d, Math.max(0, width - 4 - nameW))));
    }
    if (more) lines.push("    " + gray(`${more} more`));
    out(lines.join("\n"));
    const up = lines.length - 2;
    if (up > 0) out(`\x1b[${up}A`);
    out("\r");
    const col = PROMPT.length + Math.min(cursor, width - PROMPT.length);
    if (col > 0) out(`\x1b[${col}C`);
    drawn = true;
  }

  function printAll() {
    const w = Math.max(...names.map((n) => n.length)) + 3;
    for (const [n, d] of all) out("  " + n.padEnd(w) + gray(d) + "\n");
    out("\n");
  }

  const splitArgs = (line) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

  function execute(line) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [NOVA_BIN, ...splitArgs(line)], { stdio: "inherit" });
      child.on("error", (err) => {
        out(`Error: ${err.message}\n`);
        resolve();
      });
      child.on("close", resolve);
    });
  }

  function quit() {
    clearLive();
    out(gray("Bye.") + "\n");
    process.stdin.setRawMode(false);
    process.exit(0);
  }

  async function submit() {
    const line = buffer.trim();
    clearLive();
    out(brand(">") + " " + buffer + "\n");
    buffer = "";
    cursor = 0;
    histIdx = -1;
    if (!line) return render();

    if (history[history.length - 1] !== line) history.push(line);
    const cmd = line.split(/\s+/)[0];

    if (cmd === "exit" || cmd === "quit") return quit();
    if (cmd === "clear") {
      out("\x1b[2J\x1b[3J\x1b[H");
      header();
    } else if (cmd === "help" && !line.includes(" ")) {
      printAll();
    } else {
      busy = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out("\n");
      await execute(line);
      out("\n");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      busy = false;
    }
    render();
  }

  function complete() {
    const word = buffer.trimStart();
    if (word.includes(" ")) return;
    const matches = names.filter((n) => n.startsWith(word));
    if (!matches.length) return;
    if (matches.length === 1) {
      buffer = matches[0] + " ";
    } else {
      let prefix = matches[0];
      for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length > word.length) buffer = prefix;
    }
    cursor = buffer.length;
  }

  function setBuffer(text) {
    buffer = text;
    cursor = text.length;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", (str, key = {}) => {
    if (busy) return;
    if (key.ctrl && key.name === "c") return quit();
    if (key.ctrl && key.name === "d" && !buffer) return quit();

    switch (key.name) {
      case "return":
      case "enter":
        submit();
        return;
      case "tab":
        complete();
        break;
      case "backspace":
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
        }
        break;
      case "delete":
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        break;
      case "left":
        cursor = Math.max(0, cursor - 1);
        break;
      case "right":
        cursor = Math.min(buffer.length, cursor + 1);
        break;
      case "home":
        cursor = 0;
        break;
      case "end":
        cursor = buffer.length;
        break;
      case "up":
        if (!history.length) break;
        if (histIdx === -1) {
          draft = buffer;
          histIdx = history.length - 1;
        } else if (histIdx > 0) histIdx--;
        setBuffer(history[histIdx]);
        break;
      case "down":
        if (histIdx === -1) break;
        if (histIdx < history.length - 1) setBuffer(history[++histIdx]);
        else {
          histIdx = -1;
          setBuffer(draft);
        }
        break;
      default:
        if (key.ctrl && key.name === "a") cursor = 0;
        else if (key.ctrl && key.name === "e") cursor = buffer.length;
        else if (key.ctrl && key.name === "u") {
          buffer = buffer.slice(cursor);
          cursor = 0;
        } else if (key.ctrl && key.name === "w") {
          const left = buffer.slice(0, cursor).replace(/\S+\s*$/, "");
          buffer = left + buffer.slice(cursor);
          cursor = left.length;
        } else if (str && !key.ctrl && !key.meta && str >= " ") {
          buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
          cursor += str.length;
        } else return;
    }
    render();
  });

  process.stdout.on("resize", () => !busy && render());

  out("\x1b[2J\x1b[3J\x1b[H");
  header();
  render();
}
