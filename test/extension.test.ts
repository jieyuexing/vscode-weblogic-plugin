import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import Module, { createRequire } from "node:module";

// 合成宿主：底部面板一次只显示一个视图；树视图被遮住时不重绘（与 Theia TreeWidget 相同）。
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
    return { dispose() {} };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}
let settings: Record<string, unknown> = {};
const vscode = {
  EventEmitter,
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
  },
  commands: {
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
