# WebLogic Server

本地 WebLogic 开发域的服务器视图，支持登记已有域、新建域、启动、以调试方式启动、停止、重新启动、打开管理控制台与日志。扩展 ID：`jieyuexing.weblogic`。界面支持英语与简体中文，服务器视图位于底部面板。

需要 VS Code 1.85 或兼容扩展 API 的编辑器、WebLogic 安装及其支持的 JDK。调试需要已安装且可工作的 Java 调试扩展。新建域使用安装自带的 `wlserver/common/templates/wls/wls.jar`。

1. 在设置中填写 `weblogic.javaHome`；留空时使用启动编辑器的 `JAVA_HOME`。
2. 在底部「服务器」视图选择「登记已有域」，选择例如 `/opt/domains/demo_domain`，确认 Oracle Home，并输入管理用户名和口令。
3. 选择服务器后使用工具栏或右键菜单启动、停止或以调试方式启动。`BEA-000360` 与监听端口共同确认启动完成，之后自动请求 Java 调试器 attach。
4. 「新建域」需要尚不存在的绝对目录、Oracle Home、用户名、口令和管理端口，完成后自动登记。该域采用开发模式。

监听地址采用域现有配置；新域保持 WebLogic 的默认地址。未指定监听地址时连接 `localhost`。`weblogic.debugPort` 默认 `8453`，也可传入 WebLogic 接受的地址表达式，扩展不强制改绑地址。请按本机网络环境设置域和调试监听范围。

## 凭据与生命周期

服务器路径、管理地址与用户名保存在扩展 globalState，不写用户 settings.json。口令保存在 SecretStorage；新域保留模板生成的加密 `boot.properties`；模板未生成时以 0600 写入，供 WebLogic 首次启动后加密。已有域应已具备免交互启动的 `boot.properties`。

登记时通过 WLST 内的官方 `UserConfigFileManager` API 离线生成加密 user.config/user.key，避免为了登记而启动服务器；进入 RUNNING 后再用在线 `storeUserConfig` 更新。停止使用这对文件连接明确的管理地址并执行 `shutdown`。登记阶段不能验证离线输入的口令是否正确，启动后的在线更新会核实。

加密凭据位于扩展 globalStorageUri 的服务器 UUID 子目录，目录权限 0700、文件权限 0600。WLST 操作通过临时 0600 文件输入，操作结束或失败会删除。stdout/stderr 按已知口令脱敏。Windows 的 chmod 不等价于 POSIX 权限，应在实机核对当前用户目录 ACL；Windows 启停分支需另行实机验收。

WLST 失败时可明确选择「强制结束进程」，只处理本扩展当前拥有的启动进程树。扩展退出时不调用停止操作。当前兼容宿主在重载窗口时会清理扩展宿主的子进程，实测可触发服务器的 JVM shutdown hook；因此尚不能保证该宿主重载或退出后服务器持续运行。重开后根据域日志与端口恢复普通运行状态，调试会话需重新附加。每个服务器一个输出通道，「显示日志」还会打开域内的管理服务器日志文件。移除仅删除登记与扩展凭据，不删除域。

## 开发

使用 packageManager 声明的 pnpm 10，开发依赖仅在本仓安装，运行时无第三方依赖。

```sh
corepack pnpm install
corepack pnpm run check-types
corepack pnpm run lint
corepack pnpm test
corepack pnpm run build
corepack pnpm run vsce:package
```

产物为 `weblogic-0.1.0.vsix`。单元测试覆盖合成域解析、平台命令、环境变量、日志脱敏与启动状态。构建、fixture 和打包不替代真实编辑器加载、WebLogic 启停及 Java 断点验证。

v0.1 不含部署、重新部署、热部署、数据源、WLST 编辑器或远程域管理。

## 当前兼容宿主的布局限制

在当前兼容宿主中，恢复上次已打开的服务器面板可能暂时空白。关闭该面板，再执行「查看：切换服务器」可显示已登记服务器和当前状态；登记仍持久保存。首次登记、面板重新打开后的启动、停止与调试状态已实测。视图可见性事件刷新未消除此问题，未加入延迟轮询或自动改写宿主布局。
