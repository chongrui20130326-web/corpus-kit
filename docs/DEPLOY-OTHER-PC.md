# 在另一台电脑上安装 corpus-kit

面向「另一台 Windows 电脑」的完整步骤。全部命令在 **PowerShell** 里执行。

## 0. 前提

| 项 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | Windows 10/11 | — |
| Node.js | ≥ 20（推荐 22/24） | `node -v` |
| Git | 任意近版本（用 zip 方式可不装） | `git --version` |
| 本地模型网关 | LocalAI 或 Ollama，提供 OpenAI 兼容接口 | `curl http://127.0.0.1:8090/v1/models` |

> 本软件**没有任何 npm 依赖**，不需要 `npm install`。下载解压即可运行。

## 1. 获取代码（二选一）

### 方式 A：git clone（推荐，方便以后更新）

```powershell
cd C:\
mkdir 小说工具 -Force
cd 小说工具
git clone https://github.com/chongrui20130326-web/corpus-kit.git
cd corpus-kit
```

### 方式 B：下载 Release 压缩包（不装 Git 也能用）

```powershell
cd C:\
mkdir 小说工具 -Force
cd 小说工具
Invoke-WebRequest -Uri 'https://github.com/chongrui20130326-web/corpus-kit/releases/latest/download/corpus-kit-1.8.0.zip' -OutFile 'corpus-kit.zip'
Expand-Archive -Path 'corpus-kit.zip' -DestinationPath 'corpus-kit' -Force
cd corpus-kit
```

> 版本号以 Release 页最新为准；只要 `package.json` 与 `app.mjs` 在同一层即可。

## 2. 配置模型网关

复制示例配置，改成这台机器上实际的网关地址与模型名：

```powershell
Copy-Item config.example.json config.gateway.json
notepad config.gateway.json
```

一个连本机 LocalAI 的例子：

```json
{
  "baseUrl": "http://127.0.0.1:8090/v1",
  "apiKey": "local",
  "model": "qwen3.5:9b-uncensored-q8_0_64K",
  "concurrency": 2,
  "timeoutMs": 300000,
  "jsonMode": true
}
```

要点：

- `baseUrl` 写到 `/v1` 为止，不要带 `/chat/completions`。
- `model` 必须是网关 `/v1/models` 里真实存在的 id。
- 模型在别的机器上：把 `127.0.0.1` 换成那台机器的内网 IP，并确认网关监听 `0.0.0.0`。
- `jsonMode=false`：网关不支持 `response_format` 时用。

## 3. 启动

```powershell
node app.mjs --root work --port 4173 --no-open
```

看到 `http://127.0.0.1:4173` 即启动成功。浏览器打开该地址。

> 首次启动会自动创建 `work/` 目录，书库为空是正常的。

## 4. 验证清单

逐条执行，全部通过才算装好：

```powershell
# 4.1 版本
node -p "require('./package.json').version"          # 期望 1.8.0 或更高

# 4.2 网关可用
(Invoke-WebRequest 'http://127.0.0.1:8090/v1/models' -UseBasicParsing).StatusCode   # 期望 200

# 4.3 应用可用
(Invoke-WebRequest 'http://127.0.0.1:4173/api/books' -UseBasicParsing).StatusCode   # 期望 200

# 4.4 书库为空
(Invoke-WebRequest 'http://127.0.0.1:4173/api/library' -UseBasicParsing).Content    # 期望 []
```

## 5. 导入第一本书

### 界面导入

打开 `http://127.0.0.1:4173` → 顶部「书库」→ 导入 txt（章节标题形如「第1章」「第一章」都能识别）。

### 命令行导入

```powershell
node cli.mjs init --file C:\path\to\你的书.txt --work work\我的书 --force
```

导入后刷新页面，顶部书籍下拉会出现这本书。

## 6. 日常使用

```powershell
# 启动
node app.mjs --root work --port 4173

# 换端口
node app.mjs --root work --port 4180

# 停止：在运行窗口按 Ctrl+C
```

建议把启动命令存成 `start.ps1`：

```powershell
# start.ps1
Set-Location $PSScriptRoot
node app.mjs --root work --port 4173
```

## 7. 更新到新版本

```powershell
cd C:\小说工具\corpus-kit
git pull
# 或用 Release 方式：重新下载 zip 覆盖，注意保留 work 目录
```

`work/` 里是书稿数据，更新代码时**不要删**。

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 端口被占用 `EADDRINUSE` | 4173 已在用 | 换 `--port 4180`，或结束旧进程 |
| 页面能开，生成时全失败 | 网关 503 / 模型不在 | 先 `Invoke-WebRequest http://127.0.0.1:8090/v1/models`，503 说明网关停在手动模式，切到服务器模式 |
| 模型返回 404 | `model` 名字不对 | 用 `/v1/models` 返回的 id 原样填 |
| 中文乱码 | 终端编码 | `chcp 65001` 后再执行 |
| `node` 不是内部命令 | 没装 Node 或没进 PATH | 装 Node LTS，重开终端 |
| 上传 GitHub 按钮报错 | 没登录 gh | `gh auth login`，或改用 git clone 方式管理 |

## 9. 给「另一台电脑上的 AI」的完整指令

把下面整段复制给它，它就能自己完成下载与部署：

```text
你在一台 Windows 电脑上。请安装并部署 corpus-kit（Node.js 写的小说语料工具，无 npm 依赖）。

目标目录：C:\小说工具\corpus-kit
仓库地址：https://github.com/chongrui20130326-web/corpus-kit.git
Release 附件：https://github.com/chongrui20130326-web/corpus-kit/releases/latest/download/corpus-kit-1.8.0.zip

按顺序执行，每步把命令和输出都贴出来：

1) 检查环境：node -v（必须 ≥20）、git --version。缺 Node 就装 LTS，然后重开终端。
2) 下载代码（二选一，Git 可用优先 A）：
   A. cd C:\ && mkdir 小说工具 -Force && cd 小说工具 && git clone https://github.com/chongrui20130326-web/corpus-kit.git
   B. 若没有 Git：cd C:\小说工具 && Invoke-WebRequest '<zip 地址>' -OutFile corpus-kit.zip && Expand-Archive corpus-kit.zip -DestinationPath corpus-kit -Force
3) 进入目录：cd C:\小说工具\corpus-kit，确认能看到 package.json 与 app.mjs。
4) 配置网关：Copy-Item config.example.json config.gateway.json，然后读取本机网关：
   (Invoke-WebRequest 'http://127.0.0.1:8090/v1/models' -UseBasicParsing).Content
   把返回里的某个模型 id 填入 config.gateway.json 的 model 字段，baseUrl 填 http://127.0.0.1:8090/v1，concurrency 填 2，timeoutMs 填 300000，jsonMode 保持 true。
   如果 8090 不通，问我把网关地址改成什么，不要自己猜。
5) 启动：node app.mjs --root work --port 4173 --no-open（后台运行也可以，但必须保持进程活着）。
6) 验证（四项全部通过才算完成）：
   - node -p "require('./package.json').version"
   - (Invoke-WebRequest 'http://127.0.0.1:8090/v1/models' -UseBasicParsing).StatusCode = 200
   - (Invoke-WebRequest 'http://127.0.0.1:4173/api/books' -UseBasicParsing).StatusCode = 200
   - (Invoke-WebRequest 'http://127.0.0.1:4173/api/library' -UseBasicParsing).Content = []
7) 汇报：安装路径、版本号、Node 版本、网关地址与所用模型名、验证四项结果、浏览器访问地址。

约束：
- 不要修改仓库里的代码与配置示例，只创建 config.gateway.json 与 work/。
- 不要执行 npm install（本项目无依赖）。
- 出错时先贴完整报错，再给修复方案；不要静默重试超过 2 次。
```
