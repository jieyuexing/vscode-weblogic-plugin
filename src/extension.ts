import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import {
  parseDomain,
  parseHomes,
  startCommand,
  serverState,
  adminUrl,
  State,
} from "./core";
import {
  Server,
  probe,
  launch,
  pipeOutput,
  runWlst,
  terminate,
  credentials,
} from "./runtime";
import { t } from "./i18n";
interface Runtime {
  state: State;
  child?: ChildProcess;
  output: vscode.OutputChannel;
  running: boolean;
  debug: boolean;
  attached: boolean;
  generation: number;
  startedAt: number;
  busy: boolean;
  tail: string;
}
const labels: Record<State, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Started",
  debugging: "Started in debug mode",
  stopping: "Stopping",
};
class Servers implements vscode.TreeDataProvider<Server>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Server | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private servers: Server[];
  private readonly runtimes = new Map<string, Runtime>();
  private readonly timer: NodeJS.Timeout;
  private polling = false;
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.servers = context.globalState.get<Server[]>("servers", []);
    for (const s of this.servers) this.runtime(s);
    this.timer = setInterval(() => {
      void this.poll().catch(() => undefined);
    }, 1000);
    void this.restore();
  }
  getChildren(): Server[] {
    return this.servers;
  }
  getTreeItem(s: Server): vscode.TreeItem {
    const r = this.runtime(s);
    const item = new vscode.TreeItem(s.name);
    item.id = s.id;
    item.description = `${t(labels[r.state])} · ${s.host}:${s.port}`;
    item.tooltip = `${s.domainPath}\n${t(labels[r.state])}\n${adminUrl(s)}`;
    item.contextValue = `weblogic.${r.state}`;
    item.iconPath = new vscode.ThemeIcon(
      r.state === "stopped"
        ? "circle-outline"
        : r.state === "starting" || r.state === "stopping"
          ? "sync~spin"
          : "server-environment",
    );
    return item;
  }
  private runtime(s: Server): Runtime {
    let r = this.runtimes.get(s.id);
    if (!r) {
      r = {
        state: "stopped",
        output: vscode.window.createOutputChannel(`WebLogic: ${s.name}`),
        running: false,
        debug: false,
        attached: false,
        generation: 0,
        startedAt: 0,
        busy: false,
        tail: "",
      };
      this.runtimes.set(s.id, r);
    }
    return r;
  }
  private async restore(): Promise<void> {
    for (const s of this.servers) {
      try {
        const text = await fs.readFile(this.logPath(s), "utf8");
        const tail = text.slice(-32768);
        const up = tail.lastIndexOf("BEA-000360");
        const down = tail.lastIndexOf("SHUTDOWN");
        if (up > down && (await probe(s.host, s.port))) {
          this.runtime(s).state = "running";
          this.changed.fire(undefined);
        }
      } catch {
        /* 尚无日志的登记保持已停止。 */
      }
    }
  }
  private javaHome(): string {
    const value =
      vscode.workspace.getConfiguration("weblogic").get<string>("javaHome") ||
      process.env.JAVA_HOME;
    if (!value) throw Error(t("Set weblogic.javaHome or JAVA_HOME first."));
    return value;
  }
  private logPath(s: Server): string {
    return path.join(
      s.domainPath,
      "servers",
      s.adminName,
      "logs",
      `${s.adminName}.log`,
    );
  }
  private async save(): Promise<void> {
    await this.context.globalState.update("servers", this.servers);
    this.changed.fire(undefined);
  }
  async select(s?: Server): Promise<Server | undefined> {
    return (
      s ??
      (
        await vscode.window.showQuickPick(
          this.servers.map((server) => ({
            label: server.name,
            description: server.domainPath,
            server,
          })),
          { placeHolder: t("Select a server") },
        )
      )?.server
    );
  }
  private async input(
    prompt: string,
    value = "",
    password = false,
  ): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: t(prompt),
      value,
      password,
      ignoreFocusOut: true,
      validateInput: (s) => (s.trim() ? undefined : t("Required")),
    });
  }
  private async directory(title: string): Promise<string | undefined> {
    return (
      await vscode.window.showOpenDialog({
        title: t(title),
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      })
    )?.[0].fsPath;
  }
  private async oracleHome(initial = ""): Promise<string | undefined> {
    const home = await this.input("Oracle Home", initial);
    if (home) {
      await fs
        .access(
          path.join(home, "wlserver", "common", "templates", "wls", "wls.jar"),
        )
        .catch(() => {
          throw Error(
            t("The directory does not contain a WebLogic installation."),
          );
        });
    }
    return home;
  }
  private async domainInfo(domainPath: string): Promise<{
    config: ReturnType<typeof parseDomain>;
    home: string;
  }> {
    const config = parseDomain(
      await fs.readFile(path.join(domainPath, "config", "config.xml"), "utf8"),
    );
    let env = "";
    for (const suffix of process.platform === "win32"
      ? ["cmd", "sh"]
      : ["sh", "cmd"]) {
      try {
        env = await fs.readFile(
          path.join(domainPath, "bin", `setDomainEnv.${suffix}`),
          "utf8",
        );
        break;
      } catch {
        /* 尝试另一平台脚本。 */
      }
    }
    return { config, home: parseHomes(env).oracleHome };
  }
  async register(): Promise<void> {
    const domainPath = await this.directory("Select domain directory");
    if (!domainPath) return;
    const real = await fs.realpath(domainPath);
    for (const s of this.servers)
      if ((await fs.realpath(s.domainPath)) === real)
        throw Error(t("This domain is already registered."));
    const { config, home } = await this.domainInfo(domainPath);
    const oracleHome = await this.oracleHome(home);
    if (!oracleHome) return;
    const javaHome = this.javaHome();
    const username = await this.input("Administration username", "weblogic");
    if (!username) return;
    const password = await this.input("Administration password", "welcome1", true);
    if (password === undefined) return;
    const name = await this.input("Server name", path.basename(domainPath));
    if (!name) return;
    const s: Server = {
      id: randomUUID(),
      name,
      domainPath,
      oracleHome,
      username,
      ...config,
    };
    await this.credentialsFor(s, javaHome, password);
    this.servers.push(s);
    await this.save();
  }
  private async credentialsFor(
    s: Server,
    javaHome: string,
    password: string,
  ): Promise<void> {
    await this.context.secrets.store(`password.${s.id}`, password);
    try {
      await this.wlst(
        s,
        javaHome,
        { action: "credentials", username: s.username, password },
        [password],
      );
      this.runtime(s).output.appendLine(
        t(
          "Encrypted credentials were created offline; they will be refreshed with storeUserConfig after startup.",
        ),
      );
    } catch (err) {
      await this.context.secrets.delete(`password.${s.id}`);
      throw err;
    }
  }
  async create(): Promise<void> {
    const domainPath = await this.input("Domain directory");
    if (!domainPath) return;
    if (!path.isAbsolute(domainPath)) throw Error(t("Domain directory"));
    try {
      await fs.access(domainPath);
      throw Error(t("The domain directory must not exist."));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const oracleHome = await this.oracleHome();
    if (!oracleHome) return;
    const javaHome = this.javaHome();
    const username = await this.input("Administration username", "weblogic");
    if (!username) return;
    const password = await this.input("Administration password", "welcome1", true);
    if (password === undefined) return;
    const portString = await vscode.window.showInputBox({
      prompt: t("Administration port"),
      value: "7001",
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536
          ? undefined
          : t("Enter a port from 1 to 65535."),
    });
    if (portString === undefined) return;
    const s: Server = {
      id: randomUUID(),
      name: path.basename(domainPath),
      domainPath,
      oracleHome,
      username,
      adminName: "AdminServer",
      host: "localhost",
      port: Number(portString),
    };
    await this.context.secrets.store(`password.${s.id}`, password);
    try {
      await this.wlst(
        s,
        javaHome,
        {
          action: "create",
          domainPath,
          template: path.join(
            oracleHome,
            "wlserver",
            "common",
            "templates",
            "wls",
            "wls.jar",
          ),
          username,
          password,
          port: s.port,
        },
        [password],
      );
      Object.assign(s, (await this.domainInfo(domainPath)).config);
      this.servers.push(s);
      await this.save();
    } catch (err) {
      await this.context.secrets.delete(`password.${s.id}`);
      throw err;
    }
  }
  private async wlst(
    s: Server,
    javaHome: string,
    data: Record<string, unknown>,
    secrets: string[] = [],
  ): Promise<void> {
    await runWlst(
      this.context.asAbsolutePath("resources/wlst.py"),
      this.context.globalStorageUri.fsPath,
      s,
      javaHome,
      data,
      secrets,
      (chunk) => this.runtime(s).output.append(chunk),
    );
  }
  async start(s: Server, debug = false): Promise<void> {
    const r = this.runtime(s);
    if (r.state !== "stopped") throw Error(t("Operation already in progress."));
    if (await probe(s.host, s.port))
      throw Error(t("The server port is already in use."));
    const javaHome = this.javaHome();
    const password = await this.context.secrets.get(`password.${s.id}`);
    const port = String(
      vscode.workspace
        .getConfiguration("weblogic")
        .get<string | number>("debugPort", "8453"),
    );
    const command = startCommand(s.domainPath, javaHome, debug, port);
    r.state = "starting";
    r.running = false;
    r.debug = debug;
    r.attached = false;
    r.tail = "";
    r.startedAt = Date.now();
    const generation = ++r.generation;
    r.output.show(true);
    this.changed.fire(undefined);
    r.child = launch(command);
    const child = r.child;
    pipeOutput(child, password ? [password] : [], (chunk) => {
      r.output.append(chunk);
      r.tail = (r.tail + chunk).slice(-16384);
      if (r.tail.includes("BEA-000360")) r.running = true;
    });
    child.once("error", (err) => {
      if (r.generation !== generation) return;
      r.state = "stopped";
      r.output.appendLine(String(err));
      this.changed.fire(undefined);
    });
    child.once("close", () => {
      if (r.generation !== generation) return;
      const failed = r.state === "starting";
      r.state = "stopped";
      r.child = undefined;
      r.running = false;
      this.changed.fire(undefined);
      if (failed)
        void vscode.window.showErrorMessage(
          t(
            "The startup process exited before RUNNING. See the server output.",
          ),
        );
    });
  }
  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      for (const s of [...this.servers]) {
        const r = this.runtime(s);
        if (r.state === "stopped") continue;
        const previous = r.state;
        r.state = serverState(
          r.state,
          r.running,
          await probe(s.host, s.port),
          r.debug,
        );
        if (previous !== r.state) {
          r.output.appendLine("[WebLogic] " + t(labels[r.state]));
          this.changed.fire(undefined);
        }
        if (
          previous === "starting" &&
          (r.state === "running" || r.state === "debugging")
        ) {
          if (r.debug && !r.attached) {
            r.attached = true;
            void this.attach(s).catch((err) =>
              vscode.window.showErrorMessage(String(err)),
            );
          }
          void this.wlst(s, this.javaHome(), {
            action: "refresh",
            url: this.t3Url(s),
          }).catch(() => {
            r.output.appendLine(t("WLST failed. See the server output."));
          });
        }
        if (r.state === "starting" && Date.now() - r.startedAt > 300000) {
          r.startedAt = Date.now();
          void vscode.window.showWarningMessage(
            t(
              "The server did not reach RUNNING within five minutes. See the server output.",
            ),
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }
  private async attach(s: Server): Promise<void> {
    const value = String(
      vscode.workspace
        .getConfiguration("weblogic")
        .get<string | number>("debugPort", "8453"),
    );
    const port = Number(value.split(":").at(-1));
    const success = await vscode.debug.startDebugging(undefined, {
      type: "java",
      request: "attach",
      name: `WebLogic: ${s.name}`,
      hostName: s.host,
      port,
    });
    if (!success)
      void vscode.window.showWarningMessage(
        t(
          "A Java debugger could not attach. Install or enable a Java debugger and attach manually.",
        ),
      );
  }
  private t3Url(s: Server): string {
    return adminUrl(s)
      .replace(/^http:/, "t3:")
      .replace(/\/console$/, "");
  }
  async stop(s: Server): Promise<void> {
    const r = this.runtime(s);
    if (r.state === "stopped") return;
    const previous = r.state;
    r.state = "stopping";
    this.changed.fire(undefined);
    try {
      await this.wlst(s, this.javaHome(), {
        action: "stop",
        url: this.t3Url(s),
        adminName: s.adminName,
      });
      const until = Date.now() + 30000;
      while (await probe(s.host, s.port)) {
        if (Date.now() > until) throw Error("Shutdown timeout");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      r.state = "stopped";
      r.running = false;
      this.changed.fire(undefined);
    } catch (err) {
      r.state = previous;
      this.changed.fire(undefined);
      const choice = await vscode.window.showErrorMessage(
        `${t("WLST failed. See the server output.")} ${String(err)}`,
        t("Force Terminate Process"),
        t("Cancel"),
      );
      if (choice === t("Force Terminate Process")) {
        if (!r.child)
          throw Error(
            t("No process owned by this extension is available to terminate."),
          );
        await terminate(r.child);
      }
      throw err;
    }
  }
  async restart(s: Server): Promise<void> {
    const debug = this.runtime(s).debug;
    await this.stop(s);
    await this.start(s, debug);
  }
  async remove(s: Server): Promise<void> {
    if (this.runtime(s).state !== "stopped")
      throw Error(t("Stop the server before removing it."));
    if (
      (await vscode.window.showWarningMessage(
        t(
          "Remove the stopped server registration? The domain files will be kept.",
        ),
        { modal: true },
        t("Remove"),
      )) !== t("Remove")
    )
      return;
    await this.context.secrets.delete(`password.${s.id}`);
    await fs.rm(
      path.dirname(
        credentials(this.context.globalStorageUri.fsPath, s.id).userConfig,
      ),
      { recursive: true, force: true },
    );
    this.servers = this.servers.filter((x) => x.id !== s.id);
    this.runtime(s).output.dispose();
    this.runtimes.delete(s.id);
    await this.save();
  }
  async showLog(s: Server): Promise<void> {
    this.runtime(s).output.show();
    try {
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(this.logPath(s)),
        { preview: true },
      );
    } catch {
      void vscode.window.showInformationMessage(t("No log file exists yet."));
    }
  }
  async execute(name: string, s?: Server): Promise<void> {
    if (name === "register") {
      await this.register();
      return;
    }
    if (name === "create") {
      await this.create();
      return;
    }
    const server = await this.select(s);
    if (!server) return;
    const r = this.runtime(server);
    if (r.busy) throw Error(t("Operation already in progress."));
    r.busy = true;
    try {
      switch (name) {
        case "start":
          await this.start(server);
          break;
        case "debug":
          await this.start(server, true);
          break;
        case "stop":
          await this.stop(server);
          break;
        case "restart":
          await this.restart(server);
          break;
        case "console":
          await vscode.env.openExternal(vscode.Uri.parse(adminUrl(server)));
          break;
        case "log":
          await this.showLog(server);
          break;
        case "remove":
          await this.remove(server);
          break;
      }
    } finally {
      r.busy = false;
    }
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.changed.dispose();
    for (const r of this.runtimes.values()) {
      r.child?.unref();
      r.output.dispose();
    }
  }
}
export function activate(context: vscode.ExtensionContext): void {
  const servers = new Servers(context);
  context.subscriptions.push(
    servers,
    vscode.window.registerTreeDataProvider("weblogic.servers", servers),
  );
  for (const command of [
    "register",
    "create",
    "start",
    "debug",
    "stop",
    "restart",
    "console",
    "log",
    "remove",
  ])
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `weblogic.${command}`,
        (server?: Server) =>
          servers
            .execute(command, server)
            .catch((err) => vscode.window.showErrorMessage(String(err))),
      ),
    );
}
