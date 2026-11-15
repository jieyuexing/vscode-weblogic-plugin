import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
  saved,
  sessionStarted,
  sessionEnded,
} from "./host";

test(
  "启动、调试启动、停止、重新启动与外部退出时服务器视图保持可见并即时显示状态",
  { skip: process.platform === "win32" },
  async () => {
    reset();
    const syn = await syntheticDomain(
      await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-view-")),
    );
    const { server, port, root } = syn;
    host.settings = { javaHome: root, debugPort: String(await freePort()) };
    const win = activate(makeContext(root, { servers: [server] }));
    await seedCredentials(path.join(root, "storage"), server.id);
    const label = (state: string) => `${state} · 127.0.0.1:${port}`;
    const step = async (command: string | undefined, state: string) => {
      if (command) await win.handlers.get(command)!(server);
      if (command && command !== "weblogic.stop")
        assert.equal(
          win.shown,
          label("Starting"),
          `${command} 后应立即显示正在启动`,
        );
      await until(
        () => win.shown === label(state),
        `${command} → ${state}，视图为「${win.shown}」`,
      );
      assert.equal(host.panel, "servers");
      assert.deepEqual(host.errors, []);
    };
    try {
      assert.equal(win.shown, label("Stopped"));
      await step("weblogic.start", "Started");
      await step("weblogic.stop", "Stopped");
      await step("weblogic.debug", "Started in debug mode");
      assert.equal(host.debugConfigs.length, 1);
      await step("weblogic.restart", "Started in debug mode");
      process.kill(await syn.pid(), "SIGTERM");
      await step(undefined, "Stopped");
    } finally {
      dispose(win);
      await syn.cleanup();
    }
  },
);

test(
  "SecretStorage 取到的口令不出现在启动输出通道",
  { skip: process.platform === "win32" },
  async () => {
    reset();
    const syn = await syntheticDomain(
      await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-redact-")),
      {
        startExtra:
          'echo "out-begin demo-pw-1 out-end"\necho "err-begin demo-pw-1 err-end" >&2\n',
      },
    );
    host.settings = { javaHome: syn.root };
    const win = activate(
      makeContext(syn.root, {
        servers: [syn.server],
        vault: new Map([["password.synthetic", "demo-pw-1"]]),
      }),
    );
    await seedCredentials(path.join(syn.root, "storage"), syn.server.id);
    try {
      await win.handlers.get("weblogic.start")!(syn.server);
      await until(
        () => win.shown.startsWith("Started"),
        `启动后的状态：${win.shown}`,
      );
      const output = host.outputs.find((o) => o.name === "WebLogic: demo")!;
      await until(
        () => output.text.includes("err-begin"),
        "stderr 的输出已写入通道",
      );
      // 脱敏器扣留流末尾的若干字符，两路输出又交错写入，只断言口令被替换的前半行。
      assert.ok(output.text.includes("out-begin [REDACTED]"));
      assert.ok(output.text.includes("err-begin [REDACTED]"));
      assert.ok(!output.text.includes("demo-pw-1"));
    } finally {
      dispose(win);
      await syn.cleanup();
    }
  },
);

test("Java 调试期间且自动构建关闭时，保存 .java 增量编译工作区", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-save-"));
  const win = activate(makeContext(root));
  // Java 扩展的语言客户端在本扩展之后订阅保存事件，经几个微任务才把 didSave 写入连接。
  const client = saved.event(async () => {
    await Promise.resolve();
    await Promise.resolve();
    host.executed.push(["didSave"]);
  });
  const save = async (doc: unknown) => {
    saved.fire(doc);
    await new Promise((r) => setTimeout(r));
  };
  const java = { uri: { fsPath: "/ws/A.java" }, languageId: "java" };
  const jsp = { uri: { fsPath: "/ws/a.jsp" }, languageId: "jsp" };
  const builds = () =>
    host.executed
      .filter((c) => c[0] === "java.workspace.compile")
      .map((c) => c.slice(1));
  try {
    host.settings = {};
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
    host.executed.length = 0;
    await save(java);
    assert.deepEqual(
      host.executed,
      [["didSave"], ["java.workspace.compile", false]],
      "只对 .java 增量编译，且在语言客户端发出 didSave 之后",
    );
    host.executed.length = 0;
    saved.fire(java);
    saved.fire(java);
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(
      host.executed.map((c) => c[0]),
      [
        "didSave",
        "didSave",
        "java.workspace.compile",
        "java.workspace.compile",
      ],
      "连续保存时每次编译都排在已发出的 didSave 之后",
    );
    host.executed.length = 0;
    host.settings = { enabled: true };
    await save(java);
    assert.deepEqual(builds(), [], "自动构建开启时由 JDT 自己构建");
    host.settings = {};
    sessionEnded.fire({ id: "debug" });
    await save(java);
    assert.deepEqual(builds(), [], "调试会话结束后不再编译");
  } finally {
    client.dispose();
    dispose(win);
    await fs.rm(root, { recursive: true, force: true });
  }
});
