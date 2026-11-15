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
  Window,
} from "./host";

const names = (win: Window) =>
  (win.context.state.servers as Server[]).map((s) => s.name);

test("两个窗口各自登记与移除，保存时按 id 合并而不互相覆盖", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-windows-"));
  const oracle = await syntheticOracle(root);
  host.settings = { javaHome: root };
  host.answerWarning = async () => "Remove";
  const first = activate(makeContext(root));
  // 第二个窗口与第一个共用同一份 globalState、SecretStorage 与存储目录。
  const second = activate(
    makeContext(root, {
      state: first.context.state,
      vault: first.context.vault,
    }),
  );
  const register = async (win: Window, name: string, port: number) => {
    const domain = path.join(root, name);
    await syntheticExistingDomain(domain, oracle, port);
    host.dialogs.push([domain]);
    host.inputs.push(oracle, "weblogic", "demo-pw-1", name);
    await win.handlers.get("weblogic.register")!();
  };
  try {
    await register(first, "alpha", 7101);
    await register(second, "beta", 7102);
    assert.deepEqual(names(first).sort(), ["alpha", "beta"]);
    await register(first, "gamma", 7103);
    assert.deepEqual(names(first).sort(), ["alpha", "beta", "gamma"]);
    assert.equal(
      [...first.context.vault.keys()].filter((k) => k.startsWith("password."))
        .length,
      3,
    );
    // 第二个窗口移除 alpha 后，第一个窗口再登记也不会把 alpha 写回去。
    const alpha = (first.context.state.servers as Server[]).find(
      (s) => s.name === "alpha",
    )!;
    await second.handlers.get("weblogic.remove")!(alpha);
    await register(first, "delta", 7104);
    assert.deepEqual(names(first).sort(), ["beta", "delta", "gamma"]);
    assert.deepEqual(host.errors, []);
  } finally {
    dispose(first);
    dispose(second);
    await fs.rm(root, { recursive: true, force: true });
  }
});
