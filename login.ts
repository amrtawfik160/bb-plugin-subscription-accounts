// Drive a provider CLI's own sign-in from the page.
//
// Each CLI runs with HOME pointed at a fresh folder, so the machine's current
// login stays untouched, and under `script`, which gives it the terminal it
// needs before it prints a sign-in link. agy then reads a pasted code from that
// terminal; Cursor and Grok poll until the browser step is done.

import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LoginSpec } from "./providers.js";

export type LoginStatus = "starting" | "waiting" | "verifying" | "done" | "failed";

export interface LoginState {
  id: string;
  provider: string;
  targetAccount: string | null;
  status: LoginStatus;
  url: string | null;
  /** Device code to confirm in the browser (Grok, Codex). */
  userCode: string | null;
  needsCode: boolean;
  /** Epoch ms when the CLI stops waiting. */
  expiresAt: number | null;
  error: string | null;
  /** Saved account name once status is "done". */
  account: string | null;
}

const URL_TIMEOUT_MS = 30_000;
const TOKEN_WAIT_MS = 60_000;
const EXIT_WAIT_MS = 5_000;

export async function findBinary(name: string): Promise<string | null> {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[PX^_][^\x1b]*\x1b\\/g, "");
}

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export class LoginSession {
  readonly state: LoginState;
  private child: ChildProcess | null = null;
  private output = "";
  private finished = false;
  private watching = false;
  private exited: Promise<void> = Promise.resolve();
  /** Settles once the CLI has stopped and its folder is removed (or removal was given up). */
  closed: Promise<void> = Promise.resolve();

  constructor(
    provider: string,
    private readonly spec: LoginSpec,
    private readonly home: string,
    private readonly tokenPath: string,
    private readonly onChange: () => void,
    private readonly onToken: (tokenFile: string, home: string) => Promise<string>,
    targetAccount: string | null = null,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.state = {
      id: path.basename(home),
      provider,
      targetAccount,
      status: "starting",
      url: null,
      userCode: null,
      needsCode: spec.needsCode,
      expiresAt: null,
      error: null,
      account: null,
    };
  }

  async start(binaryPath: string): Promise<void> {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    const command = [binaryPath, ...this.spec.args].map(quote).join(" ");
    const child = spawn("script", ["-qfc", command, "/dev/null"], {
      cwd: this.home,
      env: {
        ...process.env,
        ...this.spec.env,
        HOME: this.home,
        XDG_CONFIG_HOME: path.join(this.home, ".config"),
        CLAUDE_CONFIG_DIR: path.join(this.home, ".claude"),
        CODEX_HOME: path.join(this.home, ".codex"),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const onData = (chunk: Buffer) => this.consume(chunk.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => this.fail(`Could not start ${this.spec.binary}: ${error.message}`));
    child.on("exit", () => {
      if (this.finished || this.state.status !== "waiting") return;
      // Cursor and Grok exit once the browser step is done; give the file a moment.
      if (!this.spec.needsCode) {
        setTimeout(() => {
          if (!this.finished && !this.watching) this.fail("Sign-in ended before a login was saved. Try again.");
        }, 5_000).unref();
        return;
      }
      this.fail("The sign-in link expired. Click Try again for a new one.");
    });
    setTimeout(() => {
      if (this.state.status === "starting") this.fail(`${this.spec.binary} did not print a sign-in link.`);
    }, URL_TIMEOUT_MS).unref();
  }

  submitCode(code: string): void {
    const trimmed = code.trim();
    if (!this.spec.needsCode) throw new Error("This sign-in does not take a code.");
    if (this.state.status !== "waiting") throw new Error("This sign-in is not waiting for a code. Start again.");
    if (!trimmed || /\s/.test(trimmed)) throw new Error("Paste the code exactly as it is shown.");
    this.child?.stdin?.write(`${trimmed}\r`);
    this.state.status = "verifying";
    this.onChange();
    this.watchForToken(TOKEN_WAIT_MS);
  }

  cancel(): void {
    this.fail("Cancelled.");
  }

  private _committed = false;

  markCommitted(): void {
    this._committed = true;
  }

  get committed(): boolean {
    return this._committed;
  }

  get active(): boolean {
    return !this.finished;
  }

  private consume(text: string): void {
    this.output = (this.output + stripAnsi(text)).slice(-8_000);
    if (this.state.status === "starting") {
      const url = this.spec.urlPattern.exec(this.output)?.[0];
      const code = this.spec.userCodePattern?.exec(this.output)?.[1];
      if (url && (!this.spec.userCodePattern || code)) {
        this.state.url = url;
        this.state.userCode = code ?? null;
        this.state.expiresAt = Date.now() + this.spec.windowMs;
        this.state.status = "waiting";
        this.onChange();
        // Polling CLIs write the file while still running; watch for it.
        if (!this.spec.needsCode) this.watchForToken(this.spec.windowMs);
      }
    }
    if (/authentication (?:failed|timed out)|invalid_grant|malformed auth code/i.test(this.output)) {
      // agy always ends with "authentication failed or timed out"; the line
      // before it says which one happened.
      const rejected = /invalid_grant|malformed auth code|token exchange failed/i.test(this.output);
      this.fail(
        rejected
          ? "That code wasn't accepted. Click Try again and paste the new code."
          : "The sign-in link expired. Click Try again for a new one.",
      );
    }
  }

  private watchForToken(timeoutMs: number): void {
    this.waitForToken(timeoutMs).catch((error: unknown) => {
      this.warn(`Sign-in watch failed: ${(error as Error).message}`);
      this.fail("Sign-in failed. Try again.");
    });
  }

  private async waitForToken(timeoutMs: number): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    const tokenFile = path.join(this.home, this.tokenPath);
    const deadline = Date.now() + timeoutMs;
    while (!this.finished && Date.now() < deadline) {
      try {
        const body = await fs.readFile(tokenFile, "utf8");
        if (/refresh_?token/i.test(body)) {
          // Let the CLI finish its write before reading it for real.
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (this.finished) return;
          this.state.status = "verifying";
          this.onChange();
          try {
            this.state.account = await this.onToken(tokenFile, this.home);
          } catch (error) {
            this.fail((error as Error).message);
            return;
          }
          this.state.status = "done";
          this.state.error = null;
          if (!this.finished) this.finish();
          else this.onChange();
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.fail((error as Error).message);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!this.finished) this.fail("Sign-in did not finish in time. Try again.");
  }

  private fail(message: string): void {
    if (this.finished) return;
    this.state.status = "failed";
    this.state.error = message;
    this.finish();
  }

  private finish(): void {
    this.finished = true;
    this.closed = this.cleanUp().catch((error: unknown) => {
      this.warn(`Could not remove sign-in folder ${this.home}: ${(error as Error).message}`);
    });
    this.onChange();
  }

  // The CLI can keep writing into its folder after SIGTERM, so wait for it to
  // stop (SIGKILL if it won't) before removing the folder.
  private async cleanUp(): Promise<void> {
    const pid = this.child?.pid;
    if (pid && this.child?.exitCode === null && this.child.signalCode === null) {
      signalGroup(pid, "SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.exited.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), EXIT_WAIT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        signalGroup(pid, "SIGKILL");
        await this.exited;
      }
    }
    // Children outside script's own lifetime may still be in the group.
    if (pid) signalGroup(pid, "SIGKILL");
    await fs.rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}
