import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeProperties } from "../src/core";

const wlst = fs.readFileSync(
  path.join(__dirname, "../resources/wlst.py"),
  "utf8",
);
const python = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
const skip = python ? false : "本机没有 python3";

/** 只解析不执行。校验的是 Python 3 文法；wlst.py 实际由 Jython 2 运行，其特有差异不在此保证。 */
const parses = (source: string) =>
  spawnSync(
    "python3",
    ["-I", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: source },
  ).status === 0;

test("wlst.py 语法可解析，检查本身对坏样本会失败", { skip }, () => {
  assert.ok(parses(wlst), "resources/wlst.py 应能解析");
  assert.ok(!parses("def broken(:\n    pass\n"), "坏样本应解析失败");
  assert.ok(
    !parses(wlst.replace("def property_value(value):", "def (value):")),
  );
});

/**
 * 按 java.util.Properties 读取一行 `k=<值>`：分隔符后的前导空白被忽略，
 * 值里 \uXXXX、\n \r \t \f 还原，其余 \X 取 X。
 */
function decode(line: string): string {
  assert.ok(line.startsWith("k="));
  return line
    .slice(2)
    .replace(/^[ \t\f]+/, "")
    .replace(
      /\\(?:u([0-9a-fA-F]{4})|(.))/gs,
      (_, hex: string | undefined, c: string) =>
        hex
          ? String.fromCharCode(parseInt(hex, 16))
          : (({ n: "\n", r: "\r", t: "\t", f: "\f" } as Record<string, string>)[
              c
            ] ?? c),
    );
}
const cases = [
  "plain",
  "",
  "a b",
  " leading and trailing ",
  "a=b:c#d!e",
  "back\\slash",
  "\\u0041 literal escape text",
  "line1\nline2\r\n",
  "tab\there\fform",
  "\u0001control\u007f",
  "中文口令",
  "emoji \u{1F600} pair",
];

test(
  "wlst.py 的 property_value 与 encodeProperties 经 Properties 解码后等价",
  { skip },
  () => {
    const match = /^( +)def property_value\(value\):\n((?:\1 .*\n|\n)+)/m.exec(
      wlst,
    );
    assert.ok(match, "应能从 wlst.py 取出 property_value");
    const indent = match[1].length;
    const body = match[0]
      .split("\n")
      .map((l) => l.slice(indent))
      .join("\n");
    const run = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `import json, sys\n${body}\nprint(json.dumps([property_value(v) for v in json.load(sys.stdin)]))`,
      ],
      { input: JSON.stringify(cases), encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const fromPython = JSON.parse(run.stdout) as string[];
    assert.equal(fromPython.length, cases.length);
    cases.forEach((value, i) => {
      assert.equal(
        decode(`k=${fromPython[i]}`),
        value,
        `wlst.py：${JSON.stringify(value)}`,
      );
      const line = encodeProperties({ k: value }).replace(/\n$/, "");
      assert.equal(
        decode(line),
        value,
        `encodeProperties：${JSON.stringify(value)}`,
      );
      // 写出的值只含可打印 ASCII，旧版 Properties 按 ISO-8859-1 读取也一致。
      assert.match(fromPython[i], /^[\x20-\x7e]*$/);
      assert.match(line, /^[\x20-\x7e]*$/);
    });
  },
);

test("解码器本身按 java.util.Properties 规则工作", () => {
  assert.equal(decode("k=a\\=b\\\\c\\n\\u4e2d"), "a=b\\c\n中");
  assert.equal(decode("k=  lead"), "lead", "分隔符后的前导空白被忽略");
  assert.equal(decode("k=\\ lead"), " lead");
});
