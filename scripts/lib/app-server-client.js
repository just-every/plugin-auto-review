"use strict";

const childProcess = require("node:child_process");
const readline = require("node:readline");

class AppServerJsonlClient {
  constructor({
    codexPath = process.env.CODEX_CLI_PATH || "codex",
    codexHome = process.env.CODEX_HOME,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 15000
  } = {}) {
    this.codexPath = codexPath;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = null;
    this.reader = null;
  }

  async start() {
    if (this.child) return;

    const childEnv = { ...this.env };
    if (this.codexHome) {
      childEnv.CODEX_HOME = this.codexHome;
    }

    this.child = childProcess.spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => {
      this.rejectPending(error);
    });
    this.child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const error = new Error(`codex app-server exited with ${reason}${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
      this.rejectPending(error);
    });

    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "auto-review-trust-hooks",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.child || this.child.killed) {
      throw new Error("codex app-server is not running");
    }

    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`timed out waiting for ${method}`));
      }, this.timeoutMs);

      this.pending.set(String(id), { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child || this.child.killed) {
      throw new Error("codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close() {
    if (!this.child || this.child.killed) return;

    if (this.reader) {
      this.reader.close();
    }
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 1000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      process.stderr.write(`Ignoring non-JSON app-server line: ${trimmed}\n`);
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = {
  AppServerJsonlClient
};
