import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  Command,
  Domain,
  Redactor,
  wlstCommand,
  encodeProperties,
} from "./core";
export interface Server extends Domain {
  id: string;
  name: string;
  domainPath: string;
  oracleHome: string;
  username: string;
}
export function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
export function launch(c: Command): ChildProcess {
  return spawn(c.file, c.args, {
    cwd: c.cwd,
    env: c.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
export function pipeOutput(
  child: ChildProcess,
  secrets: string[],
  write: (s: string) => void,
): void {
  for (const source of [child.stdout, child.stderr]) {
    const redactor = new Redactor(secrets);
    const decoder = new StringDecoder("utf8");
    source?.on("data", (chunk: Buffer) =>
      write(redactor.push(decoder.write(chunk))),
    );
    source?.on("end", () =>
      write(redactor.push(decoder.end()) + redactor.flush()),
    );
  }
}
export function credentials(
  storage: string,
  id: string,
): {
  userConfig: string;
  userKey: string;
} {
  return {
    userConfig: path.join(storage, id, "user.config"),
    userKey: path.join(storage, id, "user.key"),
  };
}
export async function runWlst(
  resource: string,
  storage: string,
  server: Server,
  javaHome: string,
  data: Record<string, unknown>,
  secrets: string[],
  write: (s: string) => void,
): Promise<void> {
  const directory = path.join(storage, server.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temp = await fs.mkdtemp(path.join(directory, "operation-"));
  await fs.chmod(temp, 0o700);
  const input = path.join(temp, "input.properties");
  const script = path.join(temp, "operation.py");
  try {
    const files = credentials(storage, server.id);
    await fs.writeFile(input, encodeProperties({ ...data, ...files }), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.writeFile(
      script,
      `INPUT_FILE = ${JSON.stringify(input)}\n` +
        (await fs.readFile(resource, "utf8")),
      { mode: 0o600, flag: "wx" },
    );
    const child = launch(wlstCommand(server.oracleHome, javaHome, script));
    pipeOutput(child, secrets, write);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void terminate(child).finally(() => reject(Error("WLST timeout")));
      }, 180000);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Error(`WLST exit ${code}`));
      });
    });
    for (const file of Object.values(files)) {
      await fs.chmod(file, 0o600);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const kill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
      });
      kill.once("error", reject);
      kill.once("close", (code) =>
        code === 0 ? resolve() : reject(Error(`taskkill exit ${code}`)),
      );
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
}
