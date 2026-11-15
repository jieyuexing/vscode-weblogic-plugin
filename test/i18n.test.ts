import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { host, reset } from "./host";

const i18n = createRequire(__filename)(
  "../src/i18n",
) as typeof import("../src/i18n");
const source = (file: string) =>
  fs.readFileSync(path.join(__dirname, "../src", file), "utf8");

test("core 与运行时抛出的已知错误在简体中文下都有译文，英文保持原样", () => {
  reset();
  // 动态消息（带退出码）单独列出，其余从 core.ts 的 Error("…") 取出。
  const known = [
    ...[...source("core.ts").matchAll(/Error\(\s*"([^"]+)"/g)].map((m) => m[1]),
    "WLST timeout",
    "Shutdown timeout",
  ];
  assert.ok(known.length >= 8, `只取到 ${known.length} 条已知错误`);
  for (const message of known) {
    host.language = "en";
    assert.equal(i18n.describe(Error(message)), message);
    host.language = "zh-cn";
    assert.notEqual(i18n.describe(Error(message)), message, message);
  }
  host.language = "en";
  assert.equal(i18n.describe(Error("WLST exit 1")), "WLST exit 1");
  host.language = "zh-cn";
  assert.equal(i18n.describe(Error("WLST exit 1")), "WLST 退出码 1");
  assert.equal(
    i18n.describe(Error("taskkill exit 128")),
    "taskkill 退出码 128",
  );
  assert.equal(
    i18n.describe(Error("EACCES: permission denied")),
    "EACCES: permission denied",
  );
});

test("译文表里没有无处调用的条目", () => {
  const block = source("i18n.ts");
  const keys = [...block.matchAll(/^ {2}(?:"((?:[^"\\]|\\.)+)"|(\w+)):/gm)].map(
    (m) => m[1] ?? m[2],
  );
  assert.ok(keys.length > 30);
  const used = ["core.ts", "runtime.ts", "extension.ts"].map(source).join("\n");
  const dynamic = new Set(["WLST exit", "taskkill exit"]);
  for (const key of keys)
    assert.ok(
      dynamic.has(key) || used.includes(JSON.stringify(key)),
      `没有任何调用使用译文：${key}`,
    );
});
