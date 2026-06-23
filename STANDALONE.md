# Itera AI 独立运行说明

这个目录里的平台可以脱离 Codex 独立运行。Codex 只是开发和调试时帮你改代码的工具，不是平台运行所必需的依赖。

## 最简单启动

1. 安装 Node.js 18 LTS 或更新版本。
2. 打开这个文件夹：
   `outputs/ai-self-iteration-platform`
3. 双击：
   `start-standalone.bat`
4. 浏览器访问：
   `http://127.0.0.1:8787/`

这个启动方式会自动使用 SQLite 数据库：

```text
outputs/ai-self-iteration-platform/data/itera.sqlite
```

只要这个 `data` 文件夹还在，项目、反馈、任务、运行记录都会保留。

## 同时启动测试商城

如果你想完整测试“客户网站提交反馈 -> 平台生成任务 -> 批准后进化 -> 测试商城页面变化”，双击：

```text
outputs/start-itera-demo-standalone.bat
```

它会打开两个窗口：

- 平台：`http://127.0.0.1:8787/`
- 测试商城：`http://127.0.0.1:8795/`

两个窗口都要保持打开。关闭窗口后，对应服务就停止。

## 命令行启动

也可以不用 bat，直接在平台目录运行：

```powershell
npm.cmd run standalone:check
npm.cmd start
```

如果要指定端口：

```powershell
$env:PORT="8788"
npm.cmd start
```

## 接入第三方 AI API

平台不依赖 Codex 运行，但要让它真正具备“AI 思考和拆解问题”的能力，需要接入一个第三方大模型 API。当前后端支持 OpenAI 兼容的 Chat Completions 接口。

1. 在 `outputs/ai-self-iteration-platform` 目录里复制 `.env.local.example`，改名为 `.env.local`。
2. 用记事本打开 `.env.local`。
3. 填入你的第三方 API 配置：

```env
AI_PROVIDER=openai-compatible
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=你的 API Key
AI_MODEL=gpt-4.1-mini
AI_TEMPERATURE=0.2
```

如果你用 DeepSeek，可以这样填：

```env
AI_PROVIDER=deepseek
AI_API_BASE_URL=https://api.deepseek.com
AI_API_KEY=你的 DeepSeek API Key
AI_MODEL=deepseek-v4-flash
AI_TEMPERATURE=0.2
```

如果你用 OpenRouter，可以这样填：

```env
AI_PROVIDER=openrouter
AI_API_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=你的 OpenRouter API Key
AI_MODEL=openai/gpt-4.1-mini
AI_TEMPERATURE=0.2
```

保存后重新启动 `start-standalone.bat`。打开平台的“生产检查”页面，点击“AI 大模型 API”里的“验证 API”。验证通过后，反馈归类、任务拆解和低风险静态站补丁生成会优先调用第三方模型；如果没有配置 API Key，平台会退回本地规则，只能做简单归类和少量固定模板修复。

## 迁移到另一台电脑

把整个 `ai-self-iteration-platform` 文件夹复制过去即可。至少要保留：

- `server.js`
- `app.js`
- `styles.css`
- `index.html`
- `docs.html`
- `sdk/`
- `scripts/`
- `package.json`
- `data/`，如果你要保留已有数据

到新电脑后安装 Node.js，然后双击 `start-standalone.bat`。

## 本地独立模式能做什么

本地独立模式已经可以：

- 创建客户项目和 API Key
- 生成一行嵌入代码
- 接收客户网站反馈
- 接入第三方 AI API 后，把反馈自动归类成迭代任务
- 批准后生成代码计划、补丁、QA、沙箱记录
- 对本地测试站真实写入 HTML/CSS/校验脚本
- 明确显示“本地测试站已更新，生产站待接入”

## 生产上线还需要什么

如果你希望它不只是改本地测试站，而是真正改客户线上网站，还需要配置：

- 真实 GitHub App 或 `GITHUB_TOKEN`
- 客户授权的 GitHub 仓库
- 真实 CI/checks
- Vercel、Netlify 或自定义部署 Hook
- 公网 HTTPS 地址，也就是 `PUBLIC_BASE_URL`

这些配置可以放在 `.env.local`。本地独立启动不强制要求它们，但没有这些配置时，平台会明确显示“生产上线缺口”，不会假装已经上线。

## 停止服务

在启动窗口里按：

```text
Ctrl + C
```

然后输入 `Y` 确认即可。

## 常见问题

如果打开网页失败，先确认启动窗口没有关闭，并检查端口是否被占用。

如果提示找不到 Node.js，需要先安装 Node.js 18 LTS。

如果要让其他电脑访问，不要只用 `127.0.0.1`，需要把 `HOST` 改成 `0.0.0.0`，并处理防火墙和公网 HTTPS。
