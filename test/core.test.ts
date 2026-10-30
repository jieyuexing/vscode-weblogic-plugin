import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDomain,
  parseHomes,
  startCommand,
  wlstCommand,
  serverState,
  adminUrl,
  Redactor,
  encodeProperties,
} from "../src/core";
const xml = `<domain xmlns="http://xmlns.oracle.com/weblogic/domain"><name>demo_domain</name><admin-server-name>Console</admin-server-name><server><name>Worker</name><listen-port>8001</listen-port></server><server><name>Console</name><listen-address></listen-address><listen-port>7101</listen-port></server></domain>`;
test("管理服务器选择与默认值，不误取受管服务器", () => {
  assert.deepEqual(parseDomain(xml), {
    adminName: "Console",
    host: "localhost",
    port: 7101,
  });
  assert.deepEqual(
    parseDomain("<domain><server><name>AdminServer</name></server></domain>"),
    { adminName: "AdminServer", host: "localhost", port: 7001 },
  );
  assert.equal(
    parseDomain(
      xml.replace(
        "<listen-address></listen-address>",
        "<listen-address>host&amp;demo</listen-address>",
      ),
    ).host,
    "host&demo",
  );
});
test("拒绝不完整、非法端口与外部实体配置", () => {
  for (const bad of [
    "<domain>",
    xml.replace("7101", "0"),
    '<!DOCTYPE domain SYSTEM "file:///private"><domain/>',
  ])
    assert.throws(() => parseDomain(bad));
});
test("Unix 与 Windows 环境提取保留原路径", () => {
  assert.deepEqual(parseHomes('WL_HOME="/opt/demo/wlserver"'), {
    wlHome: "/opt/demo/wlserver",
    oracleHome: "/opt/demo",
  });
  assert.deepEqual(
    parseHomes(
      'set "ORACLE_HOME=C:\\Oracle"\r\nset WL_HOME=%ORACLE_HOME%\\wlserver',
    ),
    { wlHome: "C:\\Oracle\\wlserver", oracleHome: "C:\\Oracle" },
  );
});
test("命令不含口令；debug 端口原样传递，普通启动禁用 debug", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const c = startCommand(
      "/opt/demo domain",
      "/jdk",
      true,
      "127.0.0.1:8453",
      platform,
      {
        PATH: "/bin",
        debugFlag: "true",
        WLS_PASSWORD: "synthetic-password",
        ACCESS_TOKEN: "synthetic-token",
      },
    );
    assert.equal(c.env.DEBUG_PORT, "127.0.0.1:8453");
    assert.equal(c.env.debugFlag, "true");
    assert.equal(
      startCommand("/demo", "/jdk", false, "8453", platform, {}).env.debugFlag,
      "false",
    );
    const w = wlstCommand(
      "/oracle",
      "/jdk",
      "/private/script.py",
      platform,
      {},
    );
    assert.ok(!JSON.stringify([c, w]).includes("synthetic-password"));
    assert.ok(!Object.keys(c.env).some((k) => /pass|secret/i.test(k)));
    assert.equal(c.cwd, "/opt/demo domain");
  }
});
test("启动状态必须同时有本轮 RUNNING 日志和监听证据", () => {
  assert.equal(serverState("starting", true, false, true), "starting");
  assert.equal(serverState("starting", false, true, true), "starting");
  assert.equal(serverState("starting", true, true, true), "debugging");
  assert.equal(serverState("stopping", true, false, false), "stopped");
  assert.equal(serverState("running", true, false, false), "stopped");
  assert.equal(
    adminUrl({ host: "::1", port: 7001 }),
    "http://[::1]:7001/console",
  );
});
test("日志脱敏覆盖跨块口令", () => {
  const r = new Redactor(["synthetic-password"]);
  const out =
    r.push("before synthetic-") + r.push("password after") + r.flush();
  assert.equal(out, "before [REDACTED] after");
});
test("私密 Properties 数据转义兼容旧版 WLST 和 Unicode", () => {
  assert.equal(
    encodeProperties({ password: "a=b\\c\n中文" }),
    "password=a\\=b\\\\c\\n\\u4e2d\\u6587\n",
  );
});
