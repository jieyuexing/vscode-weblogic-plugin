import * as vscode from "vscode";
const zh: Record<string, string> = {
  Stopped: "已停止",
  Starting: "正在启动",
  Started: "已启动",
  "Started in debug mode": "已以调试方式启动",
  Stopping: "正在停止",
  "Select EAR file": "选择 EAR 文件",
  Deploying: "正在部署",
  Deployed: "已部署",
  "EAR file not found:": "找不到 EAR 文件：",
  "Select an .ear file whose name uses letters, digits, '.', '_' or '-'.":
    "请选择 .ear 文件，文件名只能含字母、数字、“.”、“_”或“-”。",
  Remove: "移除",
  "Select domain directory": "选择域目录",
  "Oracle Home": "Oracle Home",
  "Administration username": "管理用户名",
  "Administration password": "管理口令",
  "Domain directory": "域目录",
  "Administration port": "管理端口",
  "Server name": "服务器名称",
  "Force Terminate Process": "强制结束进程",
  Cancel: "取消",
  "Select a server": "选择服务器",
  "Set weblogic.javaHome or JAVA_HOME first.":
    "请先设置 weblogic.javaHome 或 JAVA_HOME。",
  "Operation already in progress.": "操作正在进行中。",
  "This domain is already registered.": "该域已登记。",
  "The server port is already in use.": "服务器端口已被占用。",
  "The domain directory must not exist.": "域目录必须尚不存在。",
  "The domain directory must be an absolute path.": "域目录必须是绝对路径。",
  "See the output:": "请查看输出：",
  "Unsupported XML declaration": "不支持 DOCTYPE 或 ENTITY 声明。",
  "Invalid XML": "XML 格式无效。",
  "Invalid domain XML": "不是有效的域配置 config.xml。",
  "Administration server not found": "域配置里找不到管理服务器。",
  "Invalid listen port": "域配置里的监听端口无效。",
  "Unsafe command path": "路径含有命令行不允许的字符。",
  "WLST timeout": "WLST 执行超时。",
  "Shutdown timeout": "等待服务器关闭超时。",
  "WLST exit": "WLST 退出码",
  "taskkill exit": "taskkill 退出码",
  "A Java debugger could not attach. Install or enable a Java debugger and attach manually.":
    "Java 调试器未能附加，请安装或启用 Java 调试器后手动附加。",
  "The weblogic.debugPort setting has no valid port number, so the Java debugger was not attached.":
    "weblogic.debugPort 设置里没有有效的端口号，未附加 Java 调试器。",
  "The startup process exited before RUNNING. See the server output.":
    "启动进程在进入 RUNNING 前退出，请查看服务器输出。",
  "The server did not reach RUNNING within five minutes. See the server output.":
    "服务器在五分钟内未进入 RUNNING，请查看服务器输出。",
  "No process owned by this extension is available to terminate.":
    "没有可由本扩展强制结束的进程。",
  "WLST failed. See the server output.": "WLST 执行失败，请查看服务器输出。",
  "Remove the stopped server registration? The domain files will be kept.":
    "移除已停止服务器的登记？域文件将保留。",
  "Stop the server before removing it.": "请先停止服务器再移除。",
  Required: "必填",
  "Enter a port from 1 to 65535.": "请输入 1 到 65535 的端口。",
  "The directory does not contain a WebLogic installation.":
    "目录中没有 WebLogic 安装。",
  "Server is not running.": "服务器尚未启动。",
  "No log file exists yet.": "日志文件尚未生成。",
  "Encrypted credentials were created offline; they will be refreshed with storeUserConfig after startup.":
    "已离线生成加密凭据，启动后将用 storeUserConfig 更新。",
};
/** 把错误转成界面文字：core 与运行时抛出的已知英文错误在中文界面下翻译，其余原样。 */
export function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const exit = /^(WLST|taskkill) exit (.+)$/.exec(text);
  return exit ? `${t(`${exit[1]} exit`)} ${exit[2]}` : t(text);
}
export function t(message: string): string {
  return vscode.env.language.toLowerCase().startsWith("zh")
    ? (zh[message] ?? message)
    : message;
}
