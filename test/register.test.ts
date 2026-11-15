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
  syntheticOracle,
  syntheticExistingDomain,
  Server,
} from "./host";

const stored = (win: { context: { state: { servers: unknown } } }) =>
  win.context.state.servers as Server[];

test("已登记域的目录已被移走时，登记其他域仍能完成；真正重复的域照常被拒绝", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-register-"));
  const oracle = await syntheticOracle(root);
  const gone: Server = {
    id: "gone",
    name: "gone",
    domainPath: path.join(root, "moved-away"),
    oracleHome: oracle,
    username: "weblogic",
    adminName: "AdminServer",
    host: "127.0.0.1",
    port: 7001,
  };
  const domain = path.join(root, "demo_domain");
  await syntheticExistingDomain(domain, oracle, 7101);
  host.settings = { javaHome: root };
  const win = activate(makeContext(root, { servers: [gone] }));
  try {
    host.dialogs.push([domain]);
    host.inputs.push(oracle, "weblogic", "demo-pw-1", "demo");
    await win.handlers.get("weblogic.register")!();
    assert.deepEqual(host.errors, []);
    const servers = stored(win);
    assert.deepEqual(
      servers.map((s) => [s.name, s.domainPath, s.port]),
      [
        ["gone", gone.domainPath, 7001],
        ["demo", domain, 7101],
      ],
    );
    assert.equal(
      win.context.vault.get(`password.${servers[1].id}`),
      "demo-pw-1",
    );
    host.dialogs.push([domain]);
    await win.handlers.get("weblogic.register")!();
    assert.deepEqual(host.errors, ["This domain is already registered."]);
    assert.equal(stored(win).length, 2);
  } finally {
    dispose(win);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("登记失败时打开输出并在提示里写明去哪看，下一次登记开始时释放该输出；新建遇到非绝对路径给出完整说明", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-register-"));
  // 合成 WLST 打印一行后失败退出。
  const oracle = await syntheticOracle(root, `echo "wlst-detail"\nexit 3\n`);
  const domain = path.join(root, "demo_domain");
  await syntheticExistingDomain(domain, oracle, 7101);
  host.settings = { javaHome: root };
  const win = activate(makeContext(root));
  try {
    host.dialogs.push([domain]);
    host.inputs.push(oracle, "weblogic", "demo-pw-1", "demo");
    await win.handlers.get("weblogic.register")!();
    assert.deepEqual(host.errors, [
      "WLST exit 3 See the output: WebLogic: demo",
    ]);
    const output = host.outputs.find((o) => o.name === "WebLogic: demo")!;
    assert.equal(output.shown, 1, "失败后打开输出");
    assert.ok(output.text.includes("wlst-detail"));
    assert.ok(!output.disposed, "用户看完前输出不被释放");
    assert.equal(win.context.vault.size, 0, "失败后清掉口令");
    assert.deepEqual(win.context.state.servers, []);

    host.inputs.push(undefined);
    host.dialogs.push([domain]);
    await win.handlers.get("weblogic.register")!();
    assert.ok(output.disposed, "下一次登记开始时释放");

    host.errors.length = 0;
    host.inputs.push("~/domains/demo");
    await win.handlers.get("weblogic.create")!();
    assert.deepEqual(host.errors, [
      "The domain directory must be an absolute path.",
    ]);
  } finally {
    dispose(win);
    await fs.rm(root, { recursive: true, force: true });
  }
});
