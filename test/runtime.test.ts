import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runWlst, Server } from "../src/runtime";

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
