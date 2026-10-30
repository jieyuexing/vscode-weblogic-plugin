# WebLogic Server 扩展

## 方向与边界

独立 VS Code 扩展 `jieyuexing.weblogic`，参照 Eclipse 服务器交互。v0.1 管理本机开发域：登记、新建域、启动、以调试方式启动、停止、重新启动、管理控制台与日志。部署、热部署、请求追踪、数据源、远程域管理不在 v0.1。

用户已决定：监听地址沿用 WebLogic 默认；调试端口默认 8453，设置值原样交给 DEBUG_PORT。示例只用合成域，仓库未来可公开。服务器登记进 globalState，口令只进 SecretStorage 和必要的域 boot.properties；短时 WLST 输入文件 0600、用后删除，不进 argv、env 或日志。扩展退出时不调用停止；当前兼容宿主的布局恢复与进程树清理限制见 README，不能据静态实现宣称退出后持久运行已验收。

## 工程与路由

| 触发条件 | 命令 | 合同文档 |
| --- | --- | --- |
| 类型、风格、单元回归 | `corepack pnpm run check-types`、`corepack pnpm run lint`、`corepack pnpm test` | `README.md`、`test/core.test.ts` |
| 构建与 VSIX | `corepack pnpm run build`、`corepack pnpm run vsce:package` | `README.md` |
| WLST 凭据、建域、停止 | 扩展服务器视图的对应命令 | `README.md`「凭据与生命周期」；`resources/wlst.py` |

TypeScript + esbuild，pnpm 10，运行时无第三方依赖。清单使用 package.nls.json / package.nls.zh-cn.json，扩展显示边界由 src/i18n.ts 翻译。纯逻辑 src/core.ts 不导入 vscode，进程与私密文件在 src/runtime.ts。Windows 命令分支只有静态/单元证据时明确说明未实机。

执行者不推送；不安装到日常配置，不发布。测试临时文件使用任务指定隔离目录。提交说明简体中文，conventional commit，并带执行者 Co-Authored-By。
