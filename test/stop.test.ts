import { test } from "node:test";
import assert from "node:assert/strict";
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
  syntheticDomain,
  seedCredentials,
  Window,
  Synthetic,
} from "./host";

interface Prompt {
  message: string;
  items: string[];
  answer(choice: string | undefined): void;
}
// 合成 WLST 对 stop 动作退出非零，其余动作成功。
const failingStop = `grep -q '^action=stop' "$(dirname "$1")/input.properties" && exit 1\nexit 0\n`;

async function setup(): Promise<{
  syn: Synthetic;
  win: Window;
  prompts: Prompt[];
  close(): Promise<void>;
}> {
  reset();
  const syn = await syntheticDomain(
    await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-stop-")),
    { wlst: failingStop },
  );
  host.settings = { javaHome: syn.root };
  const prompts: Prompt[] = [];
  host.answerError = (message, items) =>
    new Promise((resolve) => prompts.push({ message, items, answer: resolve }));
  const win = activate(makeContext(syn.root, { servers: [syn.server] }));
  await seedCredentials(path.join(syn.root, "storage"), syn.server.id);
  return {
    syn,
    win,
    prompts,
    close: async () => {
      dispose(win);
      await syn.cleanup();
    },
  };
}
const started = (win: Window, syn: Synthetic) =>
  until(
    () => win.shown === `Started · 127.0.0.1:${syn.port}`,
    `启动完成：${win.shown}`,
  );

test(
  "停止失败只报一次错；提问期间不占着该服务器的锁；强制结束后不再重抛",
  { skip: process.platform === "win32" },
  async () => {
    const { syn, win, prompts, close } = await setup();
    try {
      await win.handlers.get("weblogic.start")!(syn.server);
      await started(win, syn);
      const stopping = win.handlers.get("weblogic.stop")!(syn.server);
      await until(() => prompts.length === 1, "出现强制结束的提问");
      assert.ok(prompts[0].message.startsWith("WLST failed."));
      assert.deepEqual(prompts[0].items, ["Force Terminate Process", "Cancel"]);
      // 提问尚未应答：同一服务器的其他命令不应得到“操作正在进行中”。
      await win.handlers.get("weblogic.console")!(syn.server);
      assert.equal(host.errors.length, 1, "只有停止失败的这一条提示");
      prompts[0].answer("Force Terminate Process");
      await stopping;
      await until(
        () => win.shown === `Stopped · 127.0.0.1:${syn.port}`,
        `强制结束后已停止：${win.shown}`,
      );
      assert.equal(host.errors.length, 1, "强制结束成功后不再重复报错");
    } finally {
      await close();
    }
  },
);

test(
  "停止失败后强制结束，重新启动继续；选择取消则不启动",
  { skip: process.platform === "win32" },
  async () => {
    const { syn, win, prompts, close } = await setup();
    try {
      await win.handlers.get("weblogic.start")!(syn.server);
      await started(win, syn);
      const before = await syn.pid();
      const restarting = win.handlers.get("weblogic.restart")!(syn.server);
      await until(() => prompts.length === 1, "出现强制结束的提问");
      prompts[0].answer("Cancel");
      await restarting;
      assert.equal(host.errors.length, 1);
      assert.equal(await syn.pid(), before, "取消后不重新启动");
      assert.equal(win.shown, `Started · 127.0.0.1:${syn.port}`);

      const again = win.handlers.get("weblogic.restart")!(syn.server);
      await until(() => prompts.length === 2, "再次出现提问");
      prompts[1].answer("Force Terminate Process");
      await again;
      await until(
        () => win.shown === `Started · 127.0.0.1:${syn.port}`,
        `重新启动后运行：${win.shown}`,
      );
      assert.notEqual(await syn.pid(), before, "强制结束后继续重新启动");
      assert.equal(host.errors.length, 2, "每次停止失败只报一次");
    } finally {
      await close();
    }
  },
);

test(
  "停止失败且没有本扩展拥有的进程时，只给一条说明，不提供强制结束",
  { skip: process.platform === "win32" },
  async () => {
    const { syn, win, prompts, close } = await setup();
    // 外部启动的服务器：端口在监听、日志显示已运行，但本窗口没有它的子进程。
    const listener = net.createServer().listen(syn.port, "127.0.0.1");
    await new Promise((r) => listener.once("listening", r));
    try {
      const logs = path.join(syn.domain, "servers/AdminServer/logs");
      await fs.mkdir(logs, { recursive: true });
      await fs.writeFile(path.join(logs, "AdminServer.log"), "<BEA-000360>\n");
      dispose(win);
      const restored = activate(
        makeContext(syn.root, { servers: [syn.server] }),
      );
      await until(
        () => restored.shown === `Started · 127.0.0.1:${syn.port}`,
        `按日志与端口恢复为运行中：${restored.shown}`,
      );
      await restored.handlers.get("weblogic.stop")!(syn.server);
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts[0].items, []);
      assert.ok(
        prompts[0].message.includes(
          "No process owned by this extension is available to terminate.",
        ),
      );
      prompts[0].answer(undefined);
      dispose(restored);
    } finally {
      listener.close();
      await close();
    }
  },
);
