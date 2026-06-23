# AI 自迭代平台生产化清单

当前版本已经能在本地跑通“接入客户网站 -> 收集信号 -> 生成任务 -> 生成补丁/PR -> 沙箱验证 -> 预览/发布/回滚 -> 输出 webhook”的闭环。真正上线前，还需要把下面 7 类外部能力填上真实配置。

## 1. 账号系统

已完成：
- `POST /api/auth/register`：创建组织、租户、用户、会话。
- `POST /api/auth/login`：邮箱密码登录。
- `GET /api/auth/me`：Bearer session 鉴权。
- `POST /api/auth/logout`：吊销会话。

生产建议：
- 把管理后台所有请求改成 Bearer session，不再依赖本地默认 `tenant-local` key。
- 后续补邮箱验证、找回密码、团队成员邀请、角色权限矩阵。

## 2. 数据库

已完成：
- `STORAGE_DRIVER=sqlite` 可启用 SQLite 持久化。
- `npm run db:migrate` 会创建 `data/itera.sqlite` 并从 `data/db.json` 迁移状态。
- smoke 已验证 SQLite 模式服务可启动，`/api/health` 会返回 `storage: "sqlite"`。

生产建议：
- 单机/早期试点可以先用 SQLite + 持久卷。
- 多租户 SaaS 扩大后，应迁移到 PostgreSQL，并把现在的 `app_state` 文档槽拆成真正的多表事务模型。

## 3. 公网部署

Docker 本地生产模拟：

```bash
copy .env.production.example .env.production
copy .env.local.example .env.local
npm run db:migrate
docker compose up --build
```

必须配置：
- `PUBLIC_BASE_URL=https://your-domain.com`
- 反向代理或容器平台必须启用 HTTPS。
- GitHub App callback URL：`https://your-domain.com/github/callback`
- GitHub webhook URL：`https://your-domain.com/api/github/webhook`
- Stripe webhook URL：`https://your-domain.com/api/billing/webhook`

当前项目是长驻 Node HTTP 服务，优先部署到支持 Docker/Node 常驻进程的平台。若使用 Vercel Serverless，需要改造成函数路由并接托管数据库。

本地/服务器启动时会自动读取 `.env`、`.env.local`、`.env.production`，并且不会覆盖系统环境变量或启动脚本里已经设置的变量。上线检查页会显示已加载的 env 文件名和关键配置项是否生效。

## 4. 第三方 AI API

已完成：
- 支持 OpenAI 兼容的 Chat Completions 接口。
- `GET /api/ai/status` 可查看当前模型配置状态。
- `POST /api/ai/validate` 会真实请求第三方模型，验证 API Key、Base URL 和模型名是否可用。
- 未配置模型时自动退回本地规则，不会假装已经具备复杂代码推理能力。

必须配置：
- `AI_PROVIDER=openai-compatible`
- `AI_API_BASE_URL=https://api.openai.com/v1`
- `AI_API_KEY`
- `AI_MODEL=gpt-4.1-mini`
- `AI_TEMPERATURE=0.2`

可替换为 DeepSeek、OpenRouter、通义千问兼容模式等第三方供应商，只要它提供 OpenAI 兼容的 `/v1/chat/completions` 接口即可。

## 5. GitHub App 授权

已完成：
- GitHub App JWT。
- installation token。
- `/github/install` 和 `/github/callback` 安装授权流程。
- `/api/github/webhook` 处理 installation / repository 授权变化。
- 有真实凭证时打开真实 PR；没有凭证时走 mock PR。

必须配置：
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY_BASE64` 或 `GITHUB_APP_PRIVATE_KEY_PATH`
- `GITHUB_WEBHOOK_SECRET`

GitHub App 权限：
- Contents: read/write
- Pull requests: read/write
- Metadata: read

## 6. 生产级隔离沙箱

已完成：
- 本地白名单命令沙箱。
- `ITERA_ALLOWED_REPO_ROOT` 路径限制。
- `SANDBOX_PROVIDER_URL` 外部沙箱 HTTP 适配器。
- `sandbox-provider.js` / `start-sandbox-provider.bat` 可启动独立沙箱 provider，本地默认监听 `127.0.0.1:8794`。

生产要求：
- 不要在主 Web 进程里执行客户代码。
- 接入隔离运行时：Firecracker microVM、Kubernetes Job、Vercel Sandbox、CI Runner 或自建容器池。
- 外部沙箱接口接收补丁、仓库信息和验证命令，返回 `status`、`commandResults`、`logs`。
- 主服务必须配置 `SANDBOX_PROVIDER_URL`，并配置 `SANDBOX_PROVIDER_TOKEN`；如果 provider 只在私网内访问，可显式设置 `SANDBOX_PROVIDER_PRIVATE_NETWORK=true`。

## 7. 计费系统

已完成：
- `GET /api/billing/plans`
- `GET /api/billing/current`
- `POST /api/billing/checkout`
- `POST /api/billing/portal`
- `POST /api/billing/webhook`
- Stripe webhook 可把组织套餐更新为 `pro/scale` 并写回数据库。

必须配置：
- `STRIPE_PAYMENT_LINK_PRO`
- `STRIPE_PAYMENT_LINK_SCALE`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CUSTOMER_PORTAL_URL`，或配置 `STRIPE_SECRET_KEY` 让后端创建 Customer Portal session。
- 如要由后端创建 Checkout Session，再补 `STRIPE_SECRET_KEY` 的 Checkout Session 调用。

## 一键健康检查

启动后访问：

```bash
curl http://127.0.0.1:8787/api/production/status
```

`production.readiness.blockers` 会列出当前仍缺的真实外部配置。没有 blocker 之前，系统只能算“本地闭环可运行”，不能算“生产完全就绪”。
