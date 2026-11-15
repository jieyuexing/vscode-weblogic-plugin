import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDomain,
  parseHomes,
  startCommand,
  wlstCommand,
  serverState,
  adminUrl,
  applicationName,
  newestEarFolder,
  Redactor,
  encodeProperties,
  debugPort,
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
        SERVICE_API_KEY: "synthetic-key",
        DB_CREDENTIAL: "synthetic-credential",
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
    assert.deepEqual(
      Object.keys(c.env).filter((k) =>
        /pass|secret|token|api_key|credential/i.test(k),
      ),
      [],
    );
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
test("部署名取 EAR 文件名，拒绝非 EAR 与非法字符", () => {
  assert.equal(
    applicationName("/work/SimWebEAR/build/libs/SimWebEAR.ear"),
    "SimWebEAR",
  );
  assert.equal(applicationName("C:\\work\\demo-1.0.EAR"), "demo-1.0");
  assert.throws(() => applicationName("/work/demo.war"));
  assert.throws(() => applicationName("/work/demo app.ear"));
});
test("首次部署默认目录取最近修改的 EAR 所在目录，没有 EAR 时为空", () => {
  assert.equal(
    newestEarFolder([
      { path: "/ws/OldEAR/build/libs/Old.ear", mtime: 100 },
      { path: "/ws/SimWebEAR/build/libs/SimWebEAR.ear", mtime: 300 },
      { path: "/ws/Other/dist/Other.ear", mtime: 200 },
    ]),
    "/ws/SimWebEAR/build/libs",
  );
  assert.equal(newestEarFolder([]), undefined);
});
test("调试端口同时给出原样字符串与端口号，无效值没有端口号", () => {
  assert.deepEqual(debugPort("8453"), { value: "8453", port: 8453 });
  assert.deepEqual(debugPort(9000), { value: "9000", port: 9000 });
  assert.deepEqual(debugPort("127.0.0.1:8453"), {
    value: "127.0.0.1:8453",
    port: 8453,
  });
  assert.deepEqual(debugPort("[::1]:8454"), {
    value: "[::1]:8454",
    port: 8454,
  });
  for (const bad of ["", "abc", "0", "65536", "-1", "8453.5", "host:", ":"])
    assert.deepEqual(debugPort(bad), { value: bad, port: undefined }, bad);
});
test("Windows 命令经 cmd /d /s /c 执行，路径与参数各自加引号", () => {
  const start = startCommand(
    "C:\\work\\demo domain",
    "C:\\jdk",
    false,
    "8453",
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.equal(start.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(start.args, [
    "/d",
    "/s",
    "/c",
    '""C:\\work\\demo domain\\bin\\startWebLogic.cmd" "',
  ]);
  assert.equal(start.cwd, "C:\\work\\demo domain");
  const wlst = wlstCommand(
    "C:\\Oracle",
    "C:\\jdk",
    "C:\\private dir\\operation.py",
    "win32",
    {},
  );
  assert.equal(wlst.file, "cmd.exe");
  assert.deepEqual(wlst.args, [
    "/d",
    "/s",
    "/c",
    '""C:\\Oracle\\oracle_common\\common\\bin\\wlst.cmd" "C:\\private dir\\operation.py""',
  ]);
  assert.equal(wlst.env.JAVA_HOME, "C:\\jdk");
});
test("Windows 命令拒绝会被 cmd 解释的字符，POSIX 不受影响", () => {
  for (const c of ['"', "\r", "\n", "%", "&", "|", "<", ">", "^", "!"]) {
    assert.throws(
      () =>
        startCommand(
          `C:\\work\\bad${c}dir`,
          "C:\\jdk",
          false,
          "8453",
          "win32",
          {},
        ),
      /Unsafe command path/,
      JSON.stringify(c),
    );
    assert.throws(
      () => wlstCommand("C:\\Oracle", "C:\\jdk", `C:\\x${c}.py`, "win32", {}),
      /Unsafe command path/,
      JSON.stringify(c),
    );
  }
  assert.equal(
    startCommand("/work/a&b", "/jdk", false, "8453", "darwin", {}).file,
    "/bin/sh",
  );
});
