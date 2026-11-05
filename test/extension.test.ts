import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import Module, { createRequire } from "node:module";

// 合成宿主：底部面板一次只显示一个视图；树视图被遮住时不重绘（与当前兼容宿主相同）。
let panel = "servers";
let shown = "";
let provider:
  | {
      getChildren(): unknown[];
      getTreeItem(s: unknown): { description?: string };
      onDidChangeTreeData(listener: () => void): void;
    }
  | undefined;
const handlers = new Map<string, (arg?: unknown) => Promise<void>>();
const debugConfigs: Record<string, unknown>[] = [];
const errors: string[] = [];
const render = () => {
  if (panel === "servers" && provider)
    shown = String(provider.getTreeItem(provider.getChildren()[0]).description);
};
class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}
let settings: Record<string, unknown> = {};
const executed: unknown[][] = [];
const sessionStarted = new EventEmitter<unknown>();
const sessionEnded = new EventEmitter<unknown>();
const saved = new EventEmitter<unknown>();
const vscode = {
  EventEmitter,
  Disposable: {
    from: (...items: { dispose(): void }[]) => ({
      dispose: () => items.forEach((d) => d.dispose()),
    }),
  },
  TreeItem: class {
    constructor(public label: string) {}
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ value }),
  },
  ProgressLocation: { Notification: 15 },
  env: { language: "en", openExternal: async () => true },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
    }),
    onDidSaveTextDocument: saved.event,
  },
  window: {
    createOutputChannel: () => ({
      append() {},
      appendLine() {},
      show() {
        panel = "output";
      },
      dispose() {},
    }),
    registerTreeDataProvider(_id: string, p: typeof provider) {
      provider = p;
      p!.onDidChangeTreeData(render);
      return { dispose() {} };
    },
    showErrorMessage: async (m: string) => {
      errors.push(m);
      return undefined;
    },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  debug: {
    startDebugging: async (_f: unknown, config: Record<string, unknown>) => {
      debugConfigs.push(config);
      if (config.internalConsoleOptions !== "neverOpen") panel = "debugConsole";
      return true;
    },
    onDidStartDebugSession: sessionStarted.event,
    onDidTerminateDebugSession: sessionEnded.event,
  },
  commands: {
    executeCommand: async (...args: unknown[]) => {
      executed.push(args);
      return 0;
    },
    registerCommand(id: string, h: (arg?: unknown) => Promise<void>) {
      handlers.set(id, h);
      return { dispose() {} };
    },
  },
};
const loader = Module as unknown as { _load: (...args: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > end) throw Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

test(
  "启动、调试启动、停止、重新启动与外部退出时服务器视图保持可见并即时显示状态",
  { skip: process.platform === "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-view-"));
    const port = await freePort();
    const domain = path.join(root, "domain");
    const oracle = path.join(root, "oracle");
    const pidFile = path.join(domain, "server.pid");
    await fs.mkdir(path.join(domain, "bin"), { recursive: true });
    await fs.mkdir(path.join(oracle, "oracle_common/common/bin"), {
      recursive: true,
    });
    // 合成域：打印 RUNNING 并监听管理端口；合成 WLST 的 stop 结束该进程。
    await fs.writeFile(
      path.join(domain, "bin/startWebLogic.sh"),
      `echo $$ > ${JSON.stringify(pidFile)}\nexec node -e "require('net').createServer().listen(${port},'127.0.0.1',()=>console.log('<BEA-000360> RUNNING'))"\n`,
    );
    await fs.writeFile(
      path.join(oracle, "oracle_common/common/bin/wlst.sh"),
      `grep -q '^action=stop' "$(dirname "$1")/input.properties" && kill $(cat ${JSON.stringify(pidFile)})\nexit 0\n`,
    );
    settings = { javaHome: root, debugPort: String(await freePort()) };
    const server = {
      id: "synthetic",
      name: "demo",
      domainPath: domain,
      oracleHome: oracle,
      username: "weblogic",
      adminName: "AdminServer",
      host: "127.0.0.1",
      port,
    };
    const context = {
      subscriptions: [] as { dispose(): void }[],
      globalState: {
        get: () => [server],
        update: async () => undefined,
      },
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
      },
      asAbsolutePath: (p: string) => path.join(root, p),
      globalStorageUri: { fsPath: path.join(root, "storage") },
    };
    await fs.mkdir(path.join(root, "resources"));
    await fs.writeFile(path.join(root, "resources/wlst.py"), "");
    // 合成 WLST 不生成加密凭据，预置空文件供成功后的权限收紧。
    await fs.mkdir(path.join(root, "storage/synthetic"), { recursive: true });
    for (const f of ["user.config", "user.key"])
      await fs.writeFile(path.join(root, "storage/synthetic", f), "");
    const extension = createRequire(__filename)(
      "../src/extension",
    ) as typeof import("../src/extension");
    extension.activate(context as never);
    const pid = async () => Number(await fs.readFile(pidFile, "utf8"));
    const label = (state: string) => `${state} · 127.0.0.1:${port}`;
    const step = async (command: string | undefined, state: string) => {
      if (command) await handlers.get(command)!(server);
      if (command && command !== "weblogic.stop")
        assert.equal(
          shown,
          label("Starting"),
          `${command} 后应立即显示正在启动`,
        );
      await until(
        () => shown === label(state),
        `${command} → ${state}，视图为「${shown}」`,
      );
      assert.equal(panel, "servers");
      assert.deepEqual(errors, []);
    };
    try {
      render();
      assert.equal(shown, label("Stopped"));
      await step("weblogic.start", "Started");
      await step("weblogic.stop", "Stopped");
      await step("weblogic.debug", "Started in debug mode");
      assert.equal(debugConfigs.length, 1);
      await step("weblogic.restart", "Started in debug mode");
      process.kill(await pid(), "SIGTERM");
      await step(undefined, "Stopped");
    } finally {
      for (const d of context.subscriptions) d.dispose();
      await pid()
        .then(
          (p) => process.kill(p, "SIGKILL"),
          () => undefined,
        )
        .catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("Java 调试期间且自动构建关闭时，保存 .java 增量编译工作区", async () => {
  const context = {
    subscriptions: [] as { dispose(): void }[],
    globalState: { get: () => [], update: async () => undefined },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    asAbsolutePath: (p: string) => p,
    globalStorageUri: { fsPath: os.tmpdir() },
  };
  const extension = createRequire(__filename)(
    "../src/extension",
  ) as typeof import("../src/extension");
  extension.activate(context as never);
  // Java 扩展的语言客户端在本扩展之后订阅保存事件，经几个微任务才把 didSave 写入连接。
  const client = saved.event(async () => {
    await Promise.resolve();
    await Promise.resolve();
    executed.push(["didSave"]);
  });
  const save = async (doc: unknown) => {
    saved.fire(doc);
    await new Promise((r) => setTimeout(r));
  };
  const java = { uri: { fsPath: "/ws/A.java" }, languageId: "java" };
  const jsp = { uri: { fsPath: "/ws/a.jsp" }, languageId: "jsp" };
  const builds = () =>
    executed
      .filter((c) => c[0] === "java.workspace.compile")
      .map((c) => c.slice(1));
  try {
    settings = {};
    await save(java);
    assert.deepEqual(builds(), [], "没有调试会话时不编译");
    sessionStarted.fire({
      id: "run",
      type: "java",
      configuration: { noDebug: true },
    });
    sessionStarted.fire({ id: "node", type: "node", configuration: {} });
    await save(java);
    assert.deepEqual(builds(), [], "运行模式与非 Java 会话不编译");
    sessionStarted.fire({ id: "debug", type: "java", configuration: {} });
    await save(jsp);
    executed.length = 0;
    await save(java);
    assert.deepEqual(
      executed,
      [["didSave"], ["java.workspace.compile", false]],
      "只对 .java 增量编译，且在语言客户端发出 didSave 之后",
    );
    executed.length = 0;
    saved.fire(java);
    saved.fire(java);
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(
      executed.map((c) => c[0]),
      [
        "didSave",
        "didSave",
        "java.workspace.compile",
        "java.workspace.compile",
      ],
      "连续保存时每次编译都排在已发出的 didSave 之后",
    );
    executed.length = 0;
    settings = { enabled: true };
    await save(java);
    assert.deepEqual(builds(), [], "自动构建开启时由 JDT 自己构建");
    settings = {};
    sessionEnded.fire({ id: "debug" });
    await save(java);
    assert.deepEqual(builds(), [], "调试会话结束后不再编译");
  } finally {
    client.dispose();
    for (const d of context.subscriptions) d.dispose();
  }
});
