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
  applicationName,
  newestEarFolder,
  debugPort,
  State,
} from "./core";
import {
  Server,
  probe,
  launch,
  pipeOutput,
  runWlst,
  terminate,
  exited,
  credentials,
} from "./runtime";
import { t, describe } from "./i18n";
interface Runtime {
  state: State;
  child?: ChildProcess;
  output: vscode.OutputChannel;
  running: boolean;
  debug: boolean;
  attached: boolean;
  /** 启动时按设置解析出的调试器附加端口；设置无效时为 undefined。 */
  debugPort?: number;
  generation: number;
  startedAt: number;
  busy: boolean;
  tail: string;
}
/** 停止失败：保留当时本窗口拥有的进程，供用户选择强制结束。 */
class StopFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly child?: ChildProcess,
  ) {
    super(String(reason));
  }
}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** 残留多久才清理：WLST 最长跑 180 秒，留足余量，避免删掉另一个窗口正在用的目录。 */
const STALE_MS = 10 * 60 * 1000;
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
  /** 本窗口读到或保存过的服务器 id；已存列表里不在其中的项来自其他窗口。 */
  private readonly known: Set<string>;
  /** 本窗口新增或修改、尚未保存的服务器 id。 */
  private readonly touched = new Set<string>();
  private readonly runtimes = new Map<string, Runtime>();
  private failedOutput?: vscode.OutputChannel;
  private readonly timer: NodeJS.Timeout;
  private polling = false;
  private disposed = false;
  /** 激活时的存储清理；命令等它结束后才执行，清理不会碰到正在使用的临时目录。 */
  private readonly swept: Promise<void>;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.servers = context.globalState.get<Server[]>("servers", []);
    this.known = new Set(this.servers.map((s) => s.id));
    for (const s of this.servers) this.runtime(s);
    this.swept = this.sweep();
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
    item.tooltip = `${s.domainPath}\n${t(labels[r.state])}\n${adminUrl(s)}${s.application ? `\n${s.application}` : ""}`;
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
  /**
   * 登记或新建途中宿主被杀时，含口令的 WLST 输入文件会留在存储目录里：
   * 删除没有登记的 UUID 目录与对应口令，以及已登记目录下遗留的 operation-* 临时目录。
   * 只清理 STALE_MS 之内没有变动过的：另一个窗口可能正在登记或操作。
   */
  private async sweep(): Promise<void> {
    const storage = this.context.globalStorageUri.fsPath;
    const registered = new Set(this.servers.map((s) => s.id));
    const remove = (target: string) =>
      fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    const folders = async (directory: string) =>
      (await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    const stale = async (directory: string) => {
      const entries = await fs.readdir(directory).catch(() => []);
      const times = await Promise.all(
        [directory, ...entries.map((e) => path.join(directory, e))].map((p) =>
          fs.stat(p).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        ),
      );
      return Date.now() - Math.max(...times) > STALE_MS;
    };
    for (const name of await folders(storage)) {
      const directory = path.join(storage, name);
      if (registered.has(name)) {
        for (const sub of await folders(directory)) {
          const operation = path.join(directory, sub);
          if (sub.startsWith("operation-") && (await stale(operation)))
            await remove(operation);
        }
      } else if (UUID.test(name) && (await stale(directory))) {
        await remove(directory);
        await Promise.resolve(
          this.context.secrets.delete(`password.${name}`),
        ).catch(() => undefined);
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
  /**
   * 保存前重读已存的列表，按 id 合并：本窗口新增、修改、删除的项以本窗口为准，
   * 其他窗口新增的项保留，别的窗口已移除而本窗口没动过的项不写回。
   */
  private async save(changed?: Server): Promise<void> {
    if (changed) this.touched.add(changed.id);
    const stored = this.context.globalState.get<Server[]>("servers", []);
    const mine = new Map(this.servers.map((s) => [s.id, s]));
    const storedIds = new Set(stored.map((s) => s.id));
    const merged = stored
      .filter((s) => mine.has(s.id) || !this.known.has(s.id))
      .map((s) => mine.get(s.id) ?? s);
    for (const s of this.servers)
      if (!storedIds.has(s.id) && this.touched.has(s.id)) merged.push(s);
    await this.context.globalState.update("servers", merged);
    this.servers = merged;
    for (const s of merged) this.known.add(s.id);
    this.touched.clear();
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
    this.releaseFailedOutput();
    const domainPath = await this.directory("Select domain directory");
    if (!domainPath) return;
    const real = await fs.realpath(domainPath);
    for (const s of this.servers)
      // 已登记的目录被移走时无法解析，回退到登记的原路径比较，不中断登记。
      if (
        (await fs.realpath(s.domainPath).catch(() => s.domainPath)) === real
      )
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
    try {
      await this.credentialsFor(s, javaHome, password);
    } catch (err) {
      throw this.failed(s, err);
    }
    this.servers.push(s);
    await this.save(s);
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
    this.releaseFailedOutput();
    const domainPath = await this.input("Domain directory");
    if (!domainPath) return;
    if (!path.isAbsolute(domainPath))
      throw Error(t("The domain directory must be an absolute path."));
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
      await this.save(s);
    } catch (err) {
      await this.context.secrets.delete(`password.${s.id}`);
      throw this.failed(s, err);
    }
  }
  /**
   * 登记或新建失败：打开该服务器的输出供查看，并在报错里写明去哪看。
   * 尚未登记的服务器不再保留运行时；它的输出通道留到下一次登记或新建开始时释放，用户看完前不消失。
   */
  private failed(s: Server, err: unknown): Error {
    const output = this.runtime(s).output;
    this.runtimes.delete(s.id);
    this.failedOutput = output;
    output.show(true);
    return Error(`${describe(err)} ${t("See the output:")} WebLogic: ${s.name}`);
  }
  private releaseFailedOutput(): void {
    this.failedOutput?.dispose();
    this.failedOutput = undefined;
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
    const port = debugPort(
      vscode.workspace
        .getConfiguration("weblogic")
        .get<string | number>("debugPort", "8453"),
    );
    const command = startCommand(s.domainPath, javaHome, debug, port.value);
    r.state = "starting";
    r.running = false;
    r.debug = debug;
    r.debugPort = port.port;
    r.attached = false;
    r.tail = "";
    r.startedAt = Date.now();
    const generation = ++r.generation;
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
      if (failed) {
        r.output.show(true);
        void vscode.window.showErrorMessage(
          t(
            "The startup process exited before RUNNING. See the server output.",
          ),
        );
      }
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
              vscode.window.showErrorMessage(describe(err)),
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
    const port = this.runtime(s).debugPort;
    if (port === undefined) {
      void vscode.window.showWarningMessage(
        t(
          "The weblogic.debugPort setting has no valid port number, so the Java debugger was not attached.",
        ),
      );
      return;
    }
    const success = await vscode.debug.startDebugging(undefined, {
      type: "java",
      request: "attach",
      name: `WebLogic: ${s.name}`,
      hostName: s.host,
      port,
      // 不切到调试控制台，底部服务器视图保持可见。
      internalConsoleOptions: "neverOpen",
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
  /** 等端口不再监听；超时抛错。 */
  private async awaitDown(s: Server): Promise<void> {
    const until = Date.now() + 30000;
    while (await probe(s.host, s.port)) {
      if (Date.now() > until) throw Error("Shutdown timeout");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  /** 经 WLST 停止；失败时恢复原状态并抛 StopFailure，是否强制结束由调用方在锁外询问。 */
  private async stop(s: Server): Promise<void> {
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
      await this.awaitDown(s);
      r.state = "stopped";
      r.running = false;
      this.changed.fire(undefined);
    } catch (err) {
      r.state = previous;
      this.changed.fire(undefined);
      throw new StopFailure(err, r.child);
    }
  }
  /** 结束本扩展拥有的启动进程树，等进程退出且端口释放。 */
  private async forceStop(s: Server, child: ChildProcess): Promise<void> {
    const r = this.runtime(s);
    // 询问期间用户可能已另行停止并重新启动，此时不再动手。
    if (r.child !== child) return;
    const previous = r.state;
    r.state = "stopping";
    this.changed.fire(undefined);
    try {
      await terminate(child);
      await exited(child, 30000);
      await this.awaitDown(s);
      r.state = "stopped";
      r.running = false;
    } catch (err) {
      r.state = previous;
      throw err;
    } finally {
      this.changed.fire(undefined);
    }
  }
  /**
   * 停止或重新启动。停止失败时先在锁内收尾，再在锁外只提示一次并询问是否强制结束，
   * 这样等待用户应答期间不占着该服务器的锁；强制结束成功后重新启动照常继续。
   */
  private async stopOrRestart(s: Server, restart: boolean): Promise<void> {
    const r = this.runtime(s);
    const debug = r.debug;
    const failure = await this.locked(r, async () => {
      try {
        await this.stop(s);
      } catch (err) {
        if (err instanceof StopFailure) return err;
        throw err;
      }
      if (restart) await this.start(s, debug);
    });
    if (!failure) return;
    const detail = `${t("WLST failed. See the server output.")} ${describe(failure.reason)}`;
    if (!failure.child) {
      void vscode.window.showErrorMessage(
        `${detail} ${t("No process owned by this extension is available to terminate.")}`,
      );
      return;
    }
    const choice = await vscode.window.showErrorMessage(
      detail,
      t("Force Terminate Process"),
      t("Cancel"),
    );
    if (choice !== t("Force Terminate Process")) return;
    const child = failure.child;
    await this.locked(r, async () => {
      await this.forceStop(s, child);
      if (restart) await this.start(s, debug);
    });
  }
  async deploy(s: Server, choose: boolean): Promise<void> {
    const r = this.runtime(s);
    if (r.state !== "running" && r.state !== "debugging")
      throw Error(t("Server is not running."));
    let file = s.application;
    if (choose || !file) {
      const defaultUri = file ? vscode.Uri.file(file) : await this.earFolder();
      file = (
        await vscode.window.showOpenDialog({
          title: t("Select EAR file"),
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { EAR: ["ear"] },
          defaultUri,
        })
      )?.[0].fsPath;
      if (!file) return;
    }
    const name = applicationName(file);
    await fs.access(file).catch(() => {
      throw Error(`${t("EAR file not found:")} ${file}`);
    });
    r.output.appendLine(`[WebLogic] ${t("Deploying")} ${name} ← ${file}`);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${t("Deploying")} ${name}`,
      },
      () =>
        this.wlst(s, this.javaHome(), {
          action: "deploy",
          url: this.t3Url(s),
          adminName: s.adminName,
          appName: name,
          appPath: file,
        }).catch((err) => {
          r.output.show(true);
          throw err;
        }),
    );
    r.output.appendLine(`[WebLogic] ${t("Deployed")} ${name}`);
    if (s.application !== file) {
      s.application = file;
      await this.save(s);
    }
    void vscode.window.showInformationMessage(`${t("Deployed")} ${name}`);
  }
  /** 首次部署定位到工作区内最近修改的 EAR 所在目录，没有 EAR 时用第一个工作区目录。 */
  private async earFolder(): Promise<vscode.Uri | undefined> {
    const files = await vscode.workspace.findFiles(
      "**/*.ear",
      "**/node_modules/**",
      200,
    );
    const folder = newestEarFolder(
      await Promise.all(
        files.map(async (uri) => ({
          path: uri.fsPath,
          mtime: await fs.stat(uri.fsPath).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        })),
      ),
    );
    return folder
      ? vscode.Uri.file(folder)
      : vscode.workspace.workspaceFolders?.[0]?.uri;
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
  private async locked<T>(r: Runtime, work: () => Promise<T>): Promise<T> {
    if (r.busy) throw Error(t("Operation already in progress."));
    r.busy = true;
    try {
      return await work();
    } finally {
      r.busy = false;
    }
  }
  async execute(name: string, s?: Server): Promise<void> {
    await this.swept;
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
    if (name === "stop" || name === "restart") {
      await this.stopOrRestart(server, name === "restart");
      return;
    }
    await this.locked(this.runtime(server), async () => {
      switch (name) {
        case "start":
          await this.start(server);
          break;
        case "debug":
          await this.start(server, true);
          break;
        case "deploy":
          await this.deploy(server, true);
          break;
        case "redeploy":
          await this.deploy(server, false);
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
    });
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.changed.dispose();
    this.releaseFailedOutput();
    for (const r of this.runtimes.values()) {
      r.child?.unref();
      r.output.dispose();
    }
  }
}
/**
 * 自动构建关闭时 JDT 不会因保存产生新 class，Java Debugger 也就无从热替换：
 * Java 调试期间保存 .java 后增量编译工作区，热替换仍由 Java Debugger 按它自己的设置完成。
 * 不用按工程编译：它不先编译依赖工程，依赖工程从未编译时只产出带编译错误的 class。
 * 编译请求推迟到下一个宏任务：Java 扩展的语言客户端在同一保存事件里隔几个微任务才发出 didSave，
 * 编译请求抢先到达时，JDT LS 的异步构建可能赶在它刷新该文件之前，本次改动就编不进去；
 * didSave 先到则 JDT LS 处理完它（同步刷新文件）才分派随后的构建请求。
 */
function buildOnSave(): vscode.Disposable {
  const sessions = new Set<string>();
  return vscode.Disposable.from(
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === "java" && !s.configuration.noDebug) sessions.add(s.id);
    }),
    vscode.debug.onDidTerminateDebugSession((s) => sessions.delete(s.id)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (
        sessions.size &&
        doc.languageId === "java" &&
        !vscode.workspace.getConfiguration("java.autobuild").get("enabled")
      )
        // 编译错误由 Java 扩展的问题列表呈现，这里不另行提示。
        setTimeout(
          () =>
            void vscode.commands
              .executeCommand("java.workspace.compile", false)
              .then(undefined, () => undefined),
        );
    }),
  );
}
export function activate(context: vscode.ExtensionContext): void {
  const servers = new Servers(context);
  context.subscriptions.push(
    servers,
    vscode.window.registerTreeDataProvider("weblogic.servers", servers),
    buildOnSave(),
  );
  for (const command of [
    "register",
    "create",
    "start",
    "debug",
    "stop",
    "restart",
    "deploy",
    "redeploy",
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
            .catch((err) => vscode.window.showErrorMessage(describe(err))),
      ),
    );
}
