import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { host, reset, makeContext, activate, dispose, Server } from "./host";

const REGISTERED = "11111111-1111-4111-8111-111111111111";
const ORPHAN = "22222222-2222-4222-8222-222222222222";
const BUSY = "33333333-3333-4333-8333-333333333333";
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

test("激活时清理没有登记的 UUID 目录、对应口令与遗留的临时目录", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-sweep-"));
  const storage = path.join(root, "storage");
  const server: Server = {
    id: REGISTERED,
    name: "demo",
    domainPath: path.join(root, "domain"),
    oracleHome: path.join(root, "oracle"),
    username: "weblogic",
    adminName: "AdminServer",
    host: "127.0.0.1",
    port: 7001,
  };
  const put = async (...parts: string[]) => {
    await fs.mkdir(path.dirname(path.join(storage, ...parts)), {
      recursive: true,
    });
    await fs.writeFile(path.join(storage, ...parts), "x");
  };
  await put(ORPHAN, "operation-aaaa", "input.properties");
  await put(ORPHAN, "user.config");
  await put(REGISTERED, "operation-bbbb", "input.properties");
  await put(REGISTERED, "user.config");
  await put(REGISTERED, "user.key");
  await put(REGISTERED, "operation-notes.txt");
  await put("notes", "operation-cccc", "keep.txt");
  await put("readme.txt");
  // 残留要放够久才清理：把上面这些的修改时间拨到一小时前。
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const age = async (target: string) => {
    for (const e of await fs.readdir(target, { withFileTypes: true }))
      if (e.isDirectory()) await age(path.join(target, e.name));
      else await fs.utimes(path.join(target, e.name), old, old);
    await fs.utimes(target, old, old);
  };
  await age(storage);
  // 另一个窗口正在登记或操作：刚创建的目录不能动。
  await put(BUSY, "operation-dddd", "input.properties");
  await put(REGISTERED, "operation-eeee", "input.properties");
  const untouched = await fs.stat(path.join(storage, REGISTERED));
  await fs.utimes(path.join(storage, REGISTERED), untouched.atime, old);
  const vault = new Map([
    [`password.${REGISTERED}`, "demo-pw-1"],
    [`password.${ORPHAN}`, "demo-pw-2"],
    [`password.${BUSY}`, "demo-pw-4"],
    ["password.not-a-server", "demo-pw-3"],
  ]);
  const win = activate(makeContext(root, { servers: [server], vault }));
  try {
    // 命令要等清理结束后才执行，清理不会碰到正在使用的临时目录。
    await win.handlers.get("weblogic.console")!(server);
    assert.ok(!(await exists(path.join(storage, ORPHAN))), "孤儿目录整个删除");
    assert.ok(!vault.has(`password.${ORPHAN}`), "孤儿口令删除");
    assert.ok(
      !(await exists(path.join(storage, REGISTERED, "operation-bbbb"))),
      "已登记目录下遗留的临时目录删除",
    );
    for (const kept of [
      path.join(storage, REGISTERED, "user.config"),
      path.join(storage, REGISTERED, "user.key"),
      path.join(storage, REGISTERED, "operation-notes.txt"),
      path.join(storage, "notes", "operation-cccc", "keep.txt"),
      path.join(storage, "readme.txt"),
    ])
      assert.ok(await exists(kept), `保留 ${path.relative(storage, kept)}`);
    assert.ok(
      await exists(path.join(storage, BUSY, "operation-dddd", "input.properties")),
      "另一个窗口正在登记的目录保留",
    );
    assert.equal(vault.get(`password.${BUSY}`), "demo-pw-4");
    assert.ok(
      await exists(path.join(storage, REGISTERED, "operation-eeee")),
      "另一个窗口正在用的临时目录保留",
    );
    assert.equal(vault.get(`password.${REGISTERED}`), "demo-pw-1");
    assert.equal(vault.get("password.not-a-server"), "demo-pw-3");
    assert.deepEqual(host.errors, []);
  } finally {
    dispose(win);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("存储目录不存在时激活照常完成", async () => {
  reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weblogic-sweep-"));
  const win = activate(makeContext(root));
  try {
    await win.handlers.get("weblogic.log")!();
    assert.deepEqual(host.errors, []);
  } finally {
    dispose(win);
    await fs.rm(root, { recursive: true, force: true });
  }
});
