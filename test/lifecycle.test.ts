import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import {
  host,
  reset,
  makeContext,
  activate,
  dispose,
  until,
  freePort,
  syntheticDomain,
  seedCredentials,
  Server,
} from "./host";

const posix = { skip: process.platform === "win32" };
const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

test("激活时只有日志显示已运行且端口在监听才恢复为运行中", posix, async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-restore-"));
  const port = await freePort();
  const domain = path.join(root, "domain");
  const server: Server = {
    id: "synthetic",
    name: "demo",
    domainPath: domain,
    oracleHome: path.join(root, "oracle"),
    username: "weblogic",
    adminName: "AdminServer",
    host: "127.0.0.1",
    port,
  };
  const logs = path.join(domain, "servers/AdminServer/logs");
  await fs.mkdir(logs, { recursive: true });
  const log = (text?: string) =>
    text === undefined
      ? fs.rm(path.join(logs, "AdminServer.log"), { force: true })
      : fs.writeFile(path.join(logs, "AdminServer.log"), text);
  const listener = net.createServer();
  const shownAfterRestore = async () => {
    const win = activate(makeContext(root, { servers: [server] }));
    await sleep(400);
    dispose(win);
    return win.shown;
  };
  const running = `Started · 127.0.0.1:${port}`;
  const stopped = `Stopped · 127.0.0.1:${port}`;
  try {
    await log("<BEA-000360> RUNNING\n");
    assert.equal(
      await shownAfterRestore(),
      stopped,
      "日志已运行但端口没有监听",
    );
    await new Promise((r) => listener.listen(port, "127.0.0.1", () => r(0)));
    assert.equal(await shownAfterRestore(), running);
    await log("<BEA-000360> RUNNING\n... SHUTDOWN\n");
    assert.equal(await shownAfterRestore(), stopped, "日志里已关闭");
    await log("nothing yet\n");
    assert.equal(await shownAfterRestore(), stopped, "日志里没有运行记录");
    await log(undefined);
    assert.equal(await shownAfterRestore(), stopped, "没有日志文件");
  } finally {
    listener.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "移除只在确认后删除登记、口令、加密凭据与输出，运行中的服务器不能移除",
  posix,
  async () => {
    reset();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-remove-"));
    const syn = await syntheticDomain(root);
    host.settings = { javaHome: root };
    const vault = new Map([["password.synthetic", "demo-pw-1"]]);
    const win = activate(makeContext(root, { servers: [syn.server], vault }));
    const storage = path.join(root, "storage", "synthetic");
    await seedCredentials(path.join(root, "storage"), "synthetic");
    const remove = () => win.handlers.get("weblogic.remove")!(syn.server);
    const stored = () => win.context.state.servers as Server[];
    try {
      host.answerWarning = async () => "Cancel";
      await remove();
      assert.equal(stored().length, 1, "取消后保留登记");
      assert.ok(vault.has("password.synthetic"));
      assert.ok(await exists(storage));

      await win.handlers.get("weblogic.start")!(syn.server);
      await until(() => win.shown.startsWith("Started"), `启动：${win.shown}`);
      host.answerWarning = async () => "Remove";
      await remove();
      assert.deepEqual(host.errors, ["Stop the server before removing it."]);
      assert.equal(stored().length, 1, "运行中不能移除");

      await win.handlers.get("weblogic.stop")!(syn.server);
      await until(() => win.shown.startsWith("Stopped"), `停止：${win.shown}`);
      await remove();
      assert.deepEqual(stored(), []);
      assert.ok(!vault.has("password.synthetic"), "口令已删除");
      assert.ok(!(await exists(storage)), "加密凭据目录已删除");
      assert.ok(await exists(syn.domain), "域目录保留");
      assert.ok(
        host.outputs.find((o) => o.name === "WebLogic: demo")!.disposed,
      );
    } finally {
      dispose(win);
      await syn.cleanup();
    }
  },
);

test(
  "启动完成后用 refresh 更新加密凭据；调试端口取冒号之后的端口号",
  posix,
  async () => {
    reset();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-refresh-"));
    const actions = path.join(root, "actions.log");
    const syn = await syntheticDomain(root, {
      wlst: `grep '^action=' "$(dirname "$1")/input.properties" >> ${JSON.stringify(actions)}\nexit 0\n`,
    });
    const debug = await freePort();
    host.settings = { javaHome: root, debugPort: `127.0.0.1:${debug}` };
    const win = activate(makeContext(root, { servers: [syn.server] }));
    await seedCredentials(path.join(root, "storage"), "synthetic");
    try {
      await win.handlers.get("weblogic.debug")!(syn.server);
      await until(
        () => win.shown.startsWith("Started in debug mode"),
        `调试启动：${win.shown}`,
      );
      await until(() => host.debugConfigs.length === 1, "调试器附加");
      assert.equal(host.debugConfigs[0].port, debug);
      await until(
        () => /action=refresh/.test(read(actions)),
        "启动后执行 refresh",
      );
      assert.deepEqual(host.errors, []);
    } finally {
      dispose(win);
      await syn.cleanup();
    }
  },
);
