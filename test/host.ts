import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import Module, { createRequire } from "node:module";
import type { Server } from "../src/runtime";

export type { Server };

// 合成宿主：底部面板一次只显示一个视图；树视图被遮住时不重绘（与当前兼容宿主相同）。
export class EventEmitter<T> {
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

export interface Output {
  name: string;
  text: string;
  shown: number;
  disposed: boolean;
}
type Choice = (message: string, items: string[]) => Promise<string | undefined>;
type Handler = (arg?: unknown) => Promise<void>;
interface Provider {
  getChildren(): unknown[];
  getTreeItem(s: unknown): { description?: string };
  onDidChangeTreeData(listener: () => void): void;
}
export interface Window {
  handlers: Map<string, Handler>;
  provider?: Provider;
  shown: string;
  context: Context;
}

export const sessionStarted = new EventEmitter<unknown>();
export const sessionEnded = new EventEmitter<unknown>();
export const saved = new EventEmitter<unknown>();
export const host = {
  panel: "servers",
  language: "en",
  settings: {} as Record<string, unknown>,
  errors: [] as string[],
  warnings: [] as string[],
  debugConfigs: [] as Record<string, unknown>[],
  executed: [] as unknown[][],
  outputs: [] as Output[],
  inputs: [] as (string | undefined)[],
  dialogs: [] as string[][],
  answerError: (async () => undefined) as Choice,
  answerWarning: (async () => undefined) as Choice,
};
export function reset(): void {
  host.panel = "servers";
  host.language = "en";
  host.settings = {};
  host.errors = [];
  host.warnings = [];
  host.debugConfigs = [];
  host.executed = [];
  host.outputs = [];
  host.inputs = [];
  host.dialogs = [];
  host.answerError = async () => undefined;
  host.answerWarning = async () => undefined;
}
let current: Window | undefined;
function render(win: Window): void {
  const first = win.provider?.getChildren()[0];
  if (host.panel === "servers" && win.provider && first)
    win.shown = String(win.provider.getTreeItem(first).description);
}
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
  env: {
    get language() {
      return host.language;
    },
    openExternal: async () => true,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => host.settings[key] ?? fallback,
    }),
    onDidSaveTextDocument: saved.event,
    findFiles: async () => [],
    workspaceFolders: undefined,
  },
  window: {
    createOutputChannel: (name: string) => {
      const output: Output = { name, text: "", shown: 0, disposed: false };
      host.outputs.push(output);
      return {
        append: (s: string) => (output.text += s),
        appendLine: (s: string) => (output.text += s + "\n"),
        show() {
          output.shown++;
          host.panel = "output";
        },
        dispose() {
          output.disposed = true;
        },
      };
    },
    registerTreeDataProvider(_id: string, p: Provider) {
      const win = current!;
      win.provider = p;
      p.onDidChangeTreeData(() => render(win));
      return { dispose() {} };
    },
    showErrorMessage: async (message: string, ...items: string[]) => {
      host.errors.push(message);
      return host.answerError(message, items);
    },
    showWarningMessage: async (message: string, ...items: unknown[]) => {
      host.warnings.push(message);
      return host.answerWarning(
        message,
        items.filter((i): i is string => typeof i === "string"),
      );
    },
    showInformationMessage: async () => undefined,
    showInputBox: async () => host.inputs.shift(),
    showOpenDialog: async () => {
      const paths = host.dialogs.shift();
      return paths?.map((fsPath) => ({ fsPath }));
    },
    showQuickPick: async (items: unknown[]) => items[0],
  },
  debug: {
    startDebugging: async (_f: unknown, config: Record<string, unknown>) => {
      host.debugConfigs.push(config);
      if (config.internalConsoleOptions !== "neverOpen")
        host.panel = "debugConsole";
      return true;
    },
    onDidStartDebugSession: sessionStarted.event,
    onDidTerminateDebugSession: sessionEnded.event,
  },
  commands: {
    executeCommand: async (...args: unknown[]) => {
      host.executed.push(args);
      return 0;
    },
    registerCommand(id: string, h: Handler) {
      current!.handlers.set(id, h);
      return { dispose() {} };
    },
  },
};
const loader = Module as unknown as { _load: (...args: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

export interface Context {
  subscriptions: { dispose(): void }[];
  globalState: {
    get(key: string, fallback?: unknown): unknown;
    update(key: string, value: unknown): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  asAbsolutePath(p: string): string;
  globalStorageUri: { fsPath: string };
  /** 合成的 globalState 与 SecretStorage 内容，可在窗口间共用。 */
  state: { servers: unknown };
  vault: Map<string, string>;
}
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
/** 合成扩展上下文；globalState 与 SecretStorage 按值读写，传入同一份 state 即模拟同一用户的多个窗口。 */
export function makeContext(
  root: string,
  options: {
    servers?: Server[];
    state?: Context["state"];
    vault?: Map<string, string>;
    storage?: string;
  } = {},
): Context {
  const state = options.state ?? { servers: options.servers ?? [] };
  const vault = options.vault ?? new Map<string, string>();
  return {
    subscriptions: [],
    globalState: {
      get: (_key, fallback) => clone(state.servers) ?? fallback,
      update: async (_key, value) => {
        state.servers = clone(value);
      },
    },
    secrets: {
      get: async (key) => vault.get(key),
      store: async (key, value) => void vault.set(key, value),
      delete: async (key) => void vault.delete(key),
    },
    asAbsolutePath: (p) => path.join(root, p),
    globalStorageUri: { fsPath: options.storage ?? path.join(root, "storage") },
    state,
    vault,
  };
}
export function activate(context: Context): Window {
  const win: Window = { handlers: new Map(), shown: "", context };
  current = win;
  (
    createRequire(__filename)("../src/extension") as {
      activate(context: never): void;
    }
  ).activate(context as never);
  render(win);
  return win;
}
export function dispose(win: Window): void {
  for (const d of win.context.subscriptions) d.dispose();
}

export async function until(
  check: () => boolean,
  label: string,
  timeout = 15000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
export async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

export interface Synthetic {
  root: string;
  domain: string;
  oracle: string;
  pidFile: string;
  port: number;
  server: Server;
  pid(): Promise<number>;
  cleanup(): Promise<void>;
}
/**
 * 合成域：启动脚本监听管理端口并打印 RUNNING，合成 WLST 对 stop 结束该进程。
 * startExtra 追加在启动脚本开头，wlst 可替换默认的合成 WLST 脚本。
 */
export async function syntheticDomain(
  root: string,
  options: { startExtra?: string; wlst?: string } = {},
): Promise<Synthetic> {
  const port = await freePort();
  const domain = path.join(root, "domain");
  const oracle = path.join(root, "oracle");
  const pidFile = path.join(domain, "server.pid");
  await fs.mkdir(path.join(domain, "bin"), { recursive: true });
  await fs.mkdir(path.join(oracle, "oracle_common/common/bin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(domain, "bin/startWebLogic.sh"),
    `echo $$ > ${JSON.stringify(pidFile)}\n${options.startExtra ?? ""}exec node -e "require('net').createServer().listen(${port},'127.0.0.1',()=>console.log('<BEA-000360> RUNNING'))"\n`,
  );
  await fs.writeFile(
    path.join(oracle, "oracle_common/common/bin/wlst.sh"),
    options.wlst ??
      `grep -q '^action=stop' "$(dirname "$1")/input.properties" && kill $(cat ${JSON.stringify(pidFile)})\nexit 0\n`,
  );
  await fs.mkdir(path.join(root, "resources"), { recursive: true });
  await fs.writeFile(path.join(root, "resources/wlst.py"), "");
  const server: Server = {
    id: "synthetic",
    name: "demo",
    domainPath: domain,
    oracleHome: oracle,
    username: "weblogic",
    adminName: "AdminServer",
    host: "127.0.0.1",
    port,
  };
  const pid = async () => Number(await fs.readFile(pidFile, "utf8"));
  return {
    root,
    domain,
    oracle,
    pidFile,
    port,
    server,
    pid,
    cleanup: async () => {
      await pid()
        .then(
          (p) => process.kill(p, "SIGKILL"),
          () => undefined,
        )
        .catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
/** 合成 WLST 不生成加密凭据，预置空文件供成功后的权限收紧。 */
export async function seedCredentials(
  storage: string,
  id: string,
): Promise<void> {
  await fs.mkdir(path.join(storage, id), { recursive: true });
  for (const f of ["user.config", "user.key"])
    await fs.writeFile(path.join(storage, id, f), "");
}
