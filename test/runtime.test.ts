import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runWlst, launch, terminate, Server } from "../src/runtime";

test(
  "WLST 私密输入权限、argv/env 与失败清理",
  { skip: process.platform === "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wlst-private-"));
    try {
      const oracle = path.join(root, "oracle");
      const bin = path.join(oracle, "oracle_common/common/bin");
      await fs.mkdir(bin, { recursive: true });
      const script = path.join(bin, "wlst.sh");
      // 合成解释器只读取文件路径，不把私密内容作为参数或环境输出。
      await fs.writeFile(
        script,
        `#!/bin/sh\nnode - "$1" <<'JS'\nconst fs=require('fs'),path=require('path'),assert=require('assert');\nconst script=process.argv[2],dir=path.dirname(script),input=path.join(dir,'input.properties');\nassert.equal(fs.statSync(input).mode&511,384);assert.equal(fs.statSync(script).mode&511,384);\nassert.ok(fs.readFileSync(input,'utf8').includes('synthetic-password'));\nassert.ok(!JSON.stringify(process.argv).includes('synthetic-password'));\nassert.ok(!JSON.stringify(process.env).includes('synthetic-password'));\nprocess.exit(9);\nJS\n`,
      );
      const resource = path.join(root, "resource.py");
      await fs.writeFile(resource, "exit()");
      const server: Server = {
        id: "synthetic",
        name: "demo",
        domainPath: root,
        oracleHome: oracle,
        username: "demo",
        adminName: "AdminServer",
        host: "localhost",
        port: 7101,
      };
      const storage = path.join(root, "storage");
      let output = "";
      await assert.rejects(
        runWlst(
          resource,
          storage,
          server,
          "/jdk",
          { action: "credentials", password: "synthetic-password" },
          ["synthetic-password"],
          (s) => (output += s),
        ),
        /WLST exit 9/,
      );
      assert.ok(!output.includes("synthetic-password"));
      assert.deepEqual(await fs.readdir(path.join(storage, server.id)), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

interface Fixture {
  root: string;
  storage: string;
  resource: string;
  server: Server;
}
/** 合成 WLST 解释器：body 是 sh 脚本正文，$1 为 operation.py 的路径。 */
async function fixture(body: string): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wlst-private-"));
  const oracle = path.join(root, "oracle");
  const bin = path.join(oracle, "oracle_common/common/bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "wlst.sh"), `#!/bin/sh\n${body}\n`);
  const resource = path.join(root, "resource.py");
  await fs.writeFile(resource, "exit()");
  return {
    root,
    storage: path.join(root, "storage"),
    resource,
    server: {
      id: "synthetic",
      name: "demo",
      domainPath: root,
      oracleHome: oracle,
      username: "demo",
      adminName: "AdminServer",
      host: "localhost",
      port: 7101,
    },
  };
}
const run = (f: Fixture, output: { text: string }) =>
  runWlst(
    f.resource,
    f.storage,
    f.server,
    "/jdk",
    { action: "credentials", password: "demo-pw-1" },
    ["demo-pw-1"],
    (s) => (output.text += s),
  );

test(
  "WLST 打到 stdout 与 stderr 的口令被替换",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture(
      `d="$(dirname "$1")/.."\n: > "$d/user.config"; : > "$d/user.key"\necho "out-begin demo-pw-1 out-end"\necho "err-begin demo-pw-1 err-end" >&2`,
    );
    try {
      const output = { text: "" };
      await run(f, output);
      // 两路输出各自扣留末尾后再合并，行内顺序不固定，只断言口令处被替换。
      assert.ok(output.text.includes("out-begin [REDACTED]"));
      assert.ok(output.text.includes("err-begin [REDACTED]"));
      assert.ok(
        output.text.includes("out-end") && output.text.includes("err-end"),
      );
      assert.ok(!output.text.includes("demo-pw-1"));
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "成功后收紧加密凭据文件为 0600、服务器目录为 0700",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture(
      `d="$(dirname "$1")/.."\n: > "$d/user.config"; : > "$d/user.key"\nchmod 644 "$d/user.config" "$d/user.key"`,
    );
    try {
      // 已存在且权限偏宽的目录也要收紧。
      await fs.mkdir(path.join(f.storage, f.server.id), { recursive: true });
      await fs.chmod(path.join(f.storage, f.server.id), 0o755);
      await run(f, { text: "" });
      const mode = async (...parts: string[]) =>
        (await fs.stat(path.join(f.storage, f.server.id, ...parts))).mode &
        0o777;
      assert.equal(await mode(), 0o700);
      assert.equal(await mode("user.config"), 0o600);
      assert.equal(await mode("user.key"), 0o600);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "terminate 结束整个进程组，包括子进程派生的进程",
  { skip: process.platform === "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wlst-terminate-"));
    const pidFile = path.join(root, "grandchild.pid");
    const child = launch({
      file: "/bin/sh",
      args: ["-c", `sleep 300 & echo $! > "${pidFile}"; wait`],
      cwd: root,
      env: process.env,
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let grandchild = 0;
    try {
      const end = Date.now() + 5000;
      while (!grandchild && Date.now() < end) {
        grandchild = Number(await fs.readFile(pidFile, "utf8").catch(() => 0));
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(grandchild && alive(grandchild), "孙进程应已启动");
      await terminate(child);
      const gone = Date.now() + 3000;
      while (alive(grandchild) && Date.now() < gone)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(!alive(grandchild), "孙进程应随进程组被结束");
    } finally {
      if (grandchild)
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* 已结束。 */
        }
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* 已结束。 */
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
