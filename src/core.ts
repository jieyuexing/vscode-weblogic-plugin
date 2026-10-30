import * as path from "node:path";
export type State =
  | "stopped"
  | "starting"
  | "running"
  | "debugging"
  | "stopping";
export interface Domain {
  adminName: string;
  host: string;
  port: number;
}
interface Xml {
  name: string;
  text: string;
  children: Xml[];
}
function decode(s: string): string {
  return s.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, k: string) =>
      k[0] === "#"
        ? String.fromCodePoint(
            k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1)),
          )
        : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k] ?? ""),
  );
}
export function parseDomain(source: string): Domain {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw Error("Unsupported XML declaration");
  const root: Xml = { name: "root", text: "", children: [] };
  const stack = [root];
  for (const t of source
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<[^>]*>|[^<]+/g) ?? []) {
    if (t.startsWith("<?")) continue;
    if (t.startsWith("</")) {
      const name = t.slice(2, -1).trim().split(":").pop();
      if (stack.length < 2 || stack.pop()!.name !== name)
        throw Error("Invalid XML");
    } else if (t.startsWith("<")) {
      const match = /^<([\w:.-]+)(?:\s[^<>]*)?\s*\/?>$/.exec(t);
      if (!match) throw Error("Invalid XML");
      const el: Xml = {
        name: match[1].split(":").pop()!,
        text: "",
        children: [],
      };
      stack.at(-1)!.children.push(el);
      if (!t.endsWith("/>")) stack.push(el);
    } else stack.at(-1)!.text += decode(t.trim());
  }
  if (
    stack.length !== 1 ||
    root.children.length !== 1 ||
    root.children[0].name !== "domain"
  )
    throw Error("Invalid domain XML");
  const domain = root.children[0];
  const value = (el: Xml, n: string) =>
    el.children.find((c) => c.name === n)?.text;
  const adminName = value(domain, "admin-server-name") || "AdminServer";
  const server = domain.children.find(
    (c) => c.name === "server" && value(c, "name") === adminName,
  );
  if (!server) throw Error("Administration server not found");
  const port = Number(value(server, "listen-port") || 7001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid listen port");
  const host = value(server, "listen-address") || "localhost";
  return {
    adminName,
    host: host === "0.0.0.0" || host === "::" ? "localhost" : host,
    port,
  };
}
export function parseHomes(text: string): {
  wlHome: string;
  oracleHome: string;
} {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m =
      /^\s*(?:set\s+"?|export\s+)?(WL_HOME|ORACLE_HOME)\s*=\s*(.*?)\s*$/i.exec(
        line,
      );
    if (m) values[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, "");
  }
  const expand = (s: string) =>
    s.replace(/%ORACLE_HOME%|\$\{?ORACLE_HOME\}?/gi, values.ORACLE_HOME ?? "");
  const wlHome = expand(values.WL_HOME || "");
  const api = wlHome.includes("\\") ? path.win32 : path.posix;
  const oracleHome = values.ORACLE_HOME || (wlHome ? api.dirname(wlHome) : "");
  return {
    wlHome: wlHome || (oracleHome ? api.join(oracleHome, "wlserver") : ""),
    oracleHome,
  };
}
export interface Command {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
function environment(
  javaHome: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    JAVA_HOME: javaHome,
    USER_MEM_ARGS: base.USER_MEM_ARGS || "-Xms256m -Xmx1024m",
  };
  for (const k of Object.keys(env))
    if (/pass(word|wd)?|secret|token|api_key|credential/i.test(k))
      delete env[k];
  return env;
}
function scriptCommand(
  script: string,
  cwd: string,
  javaHome: string,
  platform: string,
  base: NodeJS.ProcessEnv,
  args: string[] = [],
): Command {
  if (platform === "win32") {
    if (/["\r\n%&|<>^!]/.test(script + args.join("")))
      throw Error("Unsafe command path");
    return {
      file: base.ComSpec || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""${script}" ${args.map((a) => `"${a}"`).join(" ")}"`,
      ],
      cwd,
      env: environment(javaHome, base),
    };
  }
  return {
    file: "/bin/sh",
    args: [script, ...args],
    cwd,
    env: environment(javaHome, base),
  };
}
export function startCommand(
  domain: string,
  javaHome: string,
  debug: boolean,
  port: string,
  platform = process.platform,
  base = process.env,
): Command {
  const api = platform === "win32" ? path.win32 : path.posix;
  const c = scriptCommand(
    api.join(
      domain,
      "bin",
      `startWebLogic.${platform === "win32" ? "cmd" : "sh"}`,
    ),
    domain,
    javaHome,
    platform,
    base,
  );
  c.env.debugFlag = debug ? "true" : "false";
  if (debug) c.env.DEBUG_PORT = port;
  else delete c.env.DEBUG_PORT;
  return c;
}
export function wlstCommand(
  oracleHome: string,
  javaHome: string,
  script: string,
  platform = process.platform,
  base = process.env,
): Command {
  const api = platform === "win32" ? path.win32 : path.posix;
  return scriptCommand(
    api.join(
      oracleHome,
      "oracle_common",
      "common",
      "bin",
      `wlst.${platform === "win32" ? "cmd" : "sh"}`,
    ),
    oracleHome,
    javaHome,
    platform,
    base,
    [script],
  );
}
export function serverState(
  current: State,
  seenRunning: boolean,
  listening: boolean,
  debug: boolean,
): State {
  if (current === "stopping") return listening ? "stopping" : "stopped";
  if (current === "starting")
    return seenRunning && listening
      ? debug
        ? "debugging"
        : "running"
      : "starting";
  return listening ? current : "stopped";
}
export function adminUrl(d: Pick<Domain, "host" | "port">): string {
  return `http://${d.host.includes(":") ? `[${d.host}]` : d.host}:${d.port}/console`;
}
export class Redactor {
  private pending = "";
  constructor(private readonly secrets: string[]) {}
  push(chunk: string): string {
    this.pending += chunk;
    const hold = Math.max(0, ...this.secrets.map((s) => s.length - 1));
    let cut = Math.max(0, this.pending.length - hold);
    for (const s of this.secrets.filter(Boolean)) {
      let at = this.pending.indexOf(s);
      while (at >= 0) {
        if (at < cut && at + s.length > cut) cut = at;
        at = this.pending.indexOf(s, at + 1);
      }
    }
    const out = this.clean(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    return out;
  }
  flush(): string {
    const out = this.clean(this.pending);
    this.pending = "";
    return out;
  }
  private clean(s: string): string {
    for (const secret of this.secrets.filter(Boolean))
      s = s.split(secret).join("[REDACTED]");
    return s;
  }
}
export function encodeProperties(data: Record<string, unknown>): string {
  const escape = (value: string) =>
    value
      .split("")
      .map((c) =>
        c === "\\"
          ? "\\\\"
          : c === "\n"
            ? "\\n"
            : c === "\r"
              ? "\\r"
              : c === "\t"
                ? "\\t"
                : /[ =:#!]/.test(c)
                  ? "\\" + c
                  : c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126
                    ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
                    : c,
      )
      .join("");
  return (
    Object.entries(data)
      .map(([key, value]) => `${escape(key)}=${escape(String(value))}`)
      .join("\n") + "\n"
  );
}
