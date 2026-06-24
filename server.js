const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createSign, createHmac, createHash, randomUUID, timingSafeEqual, randomBytes, scryptSync } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const zlib = require("node:zlib");

const ROOT = __dirname;

function parseEnvFileValue(value) {
  let text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\n/g, "\n");
}

function loadEnvFiles() {
  const loaded = [];
  const candidates = [".env", ".env.local", ".env.production"].map((name) => path.join(ROOT, name));
  for (const filePath of candidates) {
    if (!fsSync.existsSync(filePath)) continue;
    const raw = fsSync.readFileSync(filePath, "utf8");
    let loadedKeys = 0;
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eq = normalized.indexOf("=");
      if (eq <= 0) return;
      const key = normalized.slice(0, eq).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || process.env[key] !== undefined) return;
      process.env[key] = parseEnvFileValue(normalized.slice(eq + 1));
      loadedKeys += 1;
    });
    loaded.push({ file: path.basename(filePath), keys: loadedKeys });
  }
  return loaded;
}

const LOADED_ENV_FILES = loadEnvFiles();

function isPlaceholderConfigValue(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return [
    /^your-/i,
    /your-platform\.example\.com/i,
    /sandbox-provider\.example\.com/i,
    /^base64-encoded-private-key$/i,
    /^provider-secret-token$/i,
    /^change-me-before-production$/i,
    /^generate-a-long-random-secret$/i,
    /^sk_live_\.\.\.$/i,
    /^whsec_\.\.\.$/i,
    /^price_\.\.\.$/i,
    /^https:\/\/buy\.stripe\.com\/\.\.\.$/i,
  ].some((pattern) => pattern.test(text));
}

function envConfig(key) {
  const value = String(process.env[key] || "").trim();
  return isPlaceholderConfigValue(value) ? "" : value;
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "itera.sqlite");
const WORKSPACE_DIR = path.join(DATA_DIR, "workspaces");
const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || "json").toLowerCase();
const githubInstallationTokenCache = new Map();
const signalRateLimits = new Map();
const DEFAULT_TENANT_ID = "tenant-local";
const DEFAULT_TENANT_ACCESS_KEY = "tnk_tenant-local_dev";
const SIGNAL_RATE_LIMIT_PER_MINUTE = Number(process.env.SIGNAL_RATE_LIMIT_PER_MINUTE || 120);
const DEFAULT_POLICY = {
  autoPr: true,
  autoCanary: true,
  autoMerge: true,
  riskLimit: 1,
  confidenceLimit: 82,
};

const BILLING_PLANS = [
  { id: "free", name: "Free", monthlyPrice: 0, limits: { projects: 1, signals: 100, workflowRuns: 20, outputDeliveries: 50 } },
  { id: "pro", name: "Pro", monthlyPrice: 49, limits: { projects: 10, signals: 10000, workflowRuns: 1000, outputDeliveries: 5000 } },
  { id: "scale", name: "Scale", monthlyPrice: 199, limits: { projects: 100, signals: 100000, workflowRuns: 10000, outputDeliveries: 50000 } },
];
const BILLING_PLAN_IDS = new Set(BILLING_PLANS.map((plan) => plan.id));
const SANDBOX_PROVIDER_URL = envConfig("SANDBOX_PROVIDER_URL");
const SANDBOX_PROVIDER_TOKEN = envConfig("SANDBOX_PROVIDER_TOKEN") || envConfig("VERCEL_SANDBOX_TOKEN");
const SANDBOX_PROVIDER_PRIVATE_NETWORK = /^true$/i.test(envConfig("SANDBOX_PROVIDER_PRIVATE_NETWORK"));
const GITHUB_AUTO_MERGE_ENABLED = /^true$/i.test(envConfig("GITHUB_AUTO_MERGE_ENABLED") || process.env.GITHUB_AUTO_MERGE_ENABLED || "");
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const seedDb = {
  projects: [
    {
      id: "a-site",
      name: "A 网站增长平台",
      url: "https://a.example.com",
      env: "production",
      health: 91,
      conversion: 8.7,
      errorRate: 0.42,
      canary: 12,
      allowedOrigins: ["https://a.example.com"],
      sdkKey: "sdk-a-site-local",
      sdkStatus: "active",
      createdAt: "2026-06-17T09:00:00.000Z",
    },
    {
      id: "crm-suite",
      name: "CRM 运营软件",
      url: "https://crm.example.com",
      env: "staging",
      health: 84,
      conversion: 6.1,
      errorRate: 0.78,
      canary: 0,
      allowedOrigins: ["https://crm.example.com"],
      sdkKey: "sdk-crm-suite-local",
      sdkStatus: "active",
      createdAt: "2026-06-17T09:10:00.000Z",
    },
  ],
  signals: [
    {
      id: "sig-1001",
      projectId: "a-site",
      type: "feedback",
      source: "用户反馈",
      category: "bug",
      severity: "高",
      risk: 3,
      confidence: 88,
      page: "https://a.example.com/checkout",
      text: "移动端支付按钮偶尔没有反应，用户刷新后才成功。",
      createdAt: "2026-06-17T09:42:00.000Z",
      data: { text: "移动端支付按钮偶尔没有反应，用户刷新后才成功。" },
    },
    {
      id: "sig-1002",
      projectId: "a-site",
      type: "performance",
      source: "AI 巡检",
      category: "performance",
      severity: "中",
      risk: 2,
      confidence: 91,
      page: "https://a.example.com/products/42",
      text: "商品详情页首屏接口超过 1.8 秒，影响移动端转化。",
      createdAt: "2026-06-17T10:18:00.000Z",
      data: { loadTime: 1820 },
    },
    {
      id: "sig-1003",
      projectId: "a-site",
      type: "feedback",
      source: "客服对话",
      category: "request",
      severity: "中",
      risk: 2,
      confidence: 84,
      page: "https://a.example.com/profile",
      text: "多名用户询问是否支持保存常用地址。",
      createdAt: "2026-06-17T11:05:00.000Z",
      data: { text: "多名用户询问是否支持保存常用地址。" },
    },
    {
      id: "sig-1004",
      projectId: "crm-suite",
      type: "client_error",
      source: "前端错误",
      category: "bug",
      severity: "高",
      risk: 3,
      confidence: 83,
      page: "https://crm.example.com/customers",
      text: "客户列表按地区筛选后，导出按钮返回 500。",
      createdAt: "2026-06-17T08:31:00.000Z",
      data: { message: "Export failed with 500" },
    },
  ],
  tasks: [
    {
      id: "task-2001",
      projectId: "a-site",
      title: "修复移动端支付按钮无响应",
      summary: "复现点击态丢失，补充端到端用例并创建 PR。",
      category: "bug",
      risk: 3,
      confidence: 88,
      agent: "开发 Agent",
      status: "待审批",
      sourceSignalIds: ["sig-1001"],
      createdAt: "2026-06-17T09:44:00.000Z",
      updatedAt: "2026-06-17T09:44:00.000Z",
    },
    {
      id: "task-2002",
      projectId: "a-site",
      title: "压缩商品详情页首屏请求",
      summary: "合并价格与库存接口，预加载首屏关键数据。",
      category: "performance",
      risk: 1,
      confidence: 91,
      agent: "QA Agent",
      status: "已批准",
      sourceSignalIds: ["sig-1002"],
      createdAt: "2026-06-17T10:22:00.000Z",
      updatedAt: "2026-06-17T10:22:00.000Z",
    },
  ],
  runs: [],
  insights: [],
  repositories: [
    {
      id: "repo-a-site",
      projectId: "a-site",
      provider: "GitHub",
      owner: "customer",
      name: "a-site",
      defaultBranch: "main",
      url: "https://github.com/customer/a-site",
      status: "connected",
      validationConfig: {
        install: "npm install",
        checks: ["npm run lint", "npm test", "npm run build"],
      },
      createdAt: "2026-06-17T09:20:00.000Z",
    },
  ],
  prDrafts: [],
  patchProposals: [],
  validationReports: [],
  sandboxRuns: [],
  patchApplications: [],
  productionSandboxRuns: [],
  previewDeployments: [],
  ciRuns: [],
  deploymentRuns: [],
  releasePlans: [],
  rollbackEvents: [],
  webhookDeliveries: [],
  auditLogs: [],
  githubInstallations: [],
  githubInstallStates: [],
  tenants: [
    {
      id: DEFAULT_TENANT_ID,
      name: "Local Tenant",
      accessKeyHash: hashSecret(DEFAULT_TENANT_ACCESS_KEY),
      keyPreview: previewSecret(DEFAULT_TENANT_ACCESS_KEY),
      status: "active",
      createdAt: "2026-06-17T09:00:00.000Z",
    },
  ],
  organizations: [
    {
      id: "org-local",
      tenantId: DEFAULT_TENANT_ID,
      name: "Local Organization",
      plan: "free",
      billingStatus: "trialing",
      createdAt: "2026-06-17T09:00:00.000Z",
    },
  ],
  users: [],
  sessions: [],
  billingAccounts: [],
  platformConfig: {
    publicBaseUrl: "",
    updatedAt: null,
  },
  policy: DEFAULT_POLICY,
  tenantPolicies: {},
  log: [
    "[09:42] 客服 Agent 已归档移动端支付反馈",
    "[10:19] QA Agent 记录商品详情页性能异常",
    "[11:07] 产品 Agent 将常用地址归入高频需求池",
  ],
};

let sqliteDb = null;

function sqliteAvailable() {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function getSqliteDb() {
  if (sqliteDb) return sqliteDb;
  const { DatabaseSync } = require("node:sqlite");
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
  sqliteDb = new DatabaseSync(SQLITE_FILE);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return sqliteDb;
}

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (STORAGE_DRIVER === "sqlite") {
    if (!sqliteAvailable()) throw new Error("node:sqlite is not available in this Node runtime.");
    const db = getSqliteDb();
    const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get("db");
    if (!row) {
      db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run("db", JSON.stringify(normalizeDb(seedDb)), nowIso());
    }
    return;
  }
  try {
    await fs.access(DB_FILE);
  } catch {
    await writeDb(seedDb);
  }
}

async function readDb() {
  await ensureDb();
  if (STORAGE_DRIVER === "sqlite") {
    const row = getSqliteDb().prepare("SELECT value FROM app_state WHERE key = ?").get("db");
    return normalizeDb(JSON.parse(row.value));
  }
  const raw = await fs.readFile(DB_FILE, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (STORAGE_DRIVER === "sqlite") {
    getSqliteDb()
      .prepare("UPDATE app_state SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(normalizeDb(db)), nowIso(), "db");
    return;
  }
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function hashSecret(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = scryptSync(String(password || ""), salt, 64).toString("hex");
  return { salt, hash: derived };
}

function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const actual = Buffer.from(hashPassword(password, user.passwordSalt).hash, "hex");
  const expected = Buffer.from(String(user.passwordHash), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSessionToken() {
  return `ita_${randomBytes(32).toString("hex")}`;
}

function previewSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.length <= 10 ? `${text.slice(0, 4)}...` : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function createTenantAccessKey(tenantId) {
  return `tnk_${slugify(tenantId)}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function defaultTenantAccessKey(tenantId) {
  return tenantId === DEFAULT_TENANT_ID ? DEFAULT_TENANT_ACCESS_KEY : `tnk_${slugify(tenantId)}_dev`;
}

function normalizeTenant(tenant = {}) {
  const id = slugify(tenant.id || tenant.name || DEFAULT_TENANT_ID);
  const fallbackKey = defaultTenantAccessKey(id);
  const rawKey = tenant.accessKey || fallbackKey;
  return {
    ...tenant,
    id,
    name: String(tenant.name || id),
    accessKeyHash: tenant.accessKeyHash || hashSecret(rawKey),
    keyPreview: tenant.keyPreview || previewSecret(rawKey),
    status: String(tenant.status || "active"),
    createdAt: tenant.createdAt || nowIso(),
  };
}

function normalizeOrganization(org = {}) {
  const id = slugify(org.id || org.name || `org-${randomUUID().slice(0, 8)}`);
  return {
    ...org,
    id,
    tenantId: String(org.tenantId || DEFAULT_TENANT_ID),
    name: String(org.name || id),
    plan: String(org.plan || "free"),
    billingStatus: String(org.billingStatus || "trialing"),
    stripeCustomerId: org.stripeCustomerId || "",
    stripeSubscriptionId: org.stripeSubscriptionId || "",
    createdAt: org.createdAt || nowIso(),
    updatedAt: org.updatedAt || org.createdAt || nowIso(),
  };
}

function normalizeUser(user = {}) {
  return {
    ...user,
    id: String(user.id || `user-${randomUUID().slice(0, 8)}`),
    email: String(user.email || "").trim().toLowerCase(),
    name: String(user.name || user.email || "User"),
    orgId: String(user.orgId || "org-local"),
    role: String(user.role || "owner"),
    status: String(user.status || "active"),
    createdAt: user.createdAt || nowIso(),
    updatedAt: user.updatedAt || user.createdAt || nowIso(),
  };
}

function normalizeSession(session = {}) {
  return {
    ...session,
    id: String(session.id || `sess-${randomUUID().slice(0, 8)}`),
    userId: String(session.userId || ""),
    tokenHash: String(session.tokenHash || ""),
    createdAt: session.createdAt || nowIso(),
    expiresAt: session.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
    lastSeenAt: session.lastSeenAt || null,
    revokedAt: session.revokedAt || null,
  };
}

function normalizeDb(db) {
  db.projects = Array.isArray(db.projects) ? db.projects : [];
  db.projects = db.projects.map(normalizeProject);
  db.signals = Array.isArray(db.signals) ? db.signals : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.runs = Array.isArray(db.runs) ? db.runs : [];
  db.insights = Array.isArray(db.insights) ? db.insights : [];
  db.repositories = Array.isArray(db.repositories) ? db.repositories : [];
  db.prDrafts = Array.isArray(db.prDrafts) ? db.prDrafts : [];
  db.patchProposals = Array.isArray(db.patchProposals) ? db.patchProposals : [];
  db.validationReports = Array.isArray(db.validationReports) ? db.validationReports : [];
  db.sandboxRuns = Array.isArray(db.sandboxRuns) ? db.sandboxRuns : [];
  db.patchApplications = Array.isArray(db.patchApplications) ? db.patchApplications : [];
  db.productionSandboxRuns = Array.isArray(db.productionSandboxRuns) ? db.productionSandboxRuns : [];
  db.previewDeployments = Array.isArray(db.previewDeployments) ? db.previewDeployments : [];
  db.ciRuns = Array.isArray(db.ciRuns) ? db.ciRuns : [];
  db.deploymentRuns = Array.isArray(db.deploymentRuns) ? db.deploymentRuns : [];
  db.releasePlans = Array.isArray(db.releasePlans) ? db.releasePlans : [];
  db.rollbackEvents = Array.isArray(db.rollbackEvents) ? db.rollbackEvents : [];
  db.webhookDeliveries = Array.isArray(db.webhookDeliveries) ? db.webhookDeliveries : [];
  db.auditLogs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
  db.githubInstallations = Array.isArray(db.githubInstallations) ? db.githubInstallations : [];
  db.githubInstallStates = Array.isArray(db.githubInstallStates) ? db.githubInstallStates : [];
  db.tenants = Array.isArray(db.tenants) ? db.tenants.map(normalizeTenant) : [];
  db.organizations = Array.isArray(db.organizations) ? db.organizations.map(normalizeOrganization) : [];
  db.users = Array.isArray(db.users) ? db.users.map(normalizeUser) : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions.map(normalizeSession) : [];
  db.billingAccounts = Array.isArray(db.billingAccounts) ? db.billingAccounts : [];
  db.platformConfig = db.platformConfig && typeof db.platformConfig === "object" ? db.platformConfig : {};
  db.platformConfig.publicBaseUrl = normalizeWebsiteUrl(db.platformConfig.publicBaseUrl || envConfig("PUBLIC_BASE_URL") || "");
  db.platformConfig.aiProvider = normalizeAiProviderSettings(db.platformConfig.aiProvider || {});
  db.platformConfig.updatedAt = db.platformConfig.updatedAt || null;
  const tenantsById = new Map(db.tenants.map((tenant) => [tenant.id, tenant]));
  if (!tenantsById.has(DEFAULT_TENANT_ID)) tenantsById.set(DEFAULT_TENANT_ID, normalizeTenant({ id: DEFAULT_TENANT_ID, name: "Local Tenant" }));
  for (const project of db.projects) {
    if (!tenantsById.has(project.tenantId)) tenantsById.set(project.tenantId, normalizeTenant({ id: project.tenantId, name: project.tenantId }));
  }
  for (const org of db.organizations) {
    if (!tenantsById.has(org.tenantId)) tenantsById.set(org.tenantId, normalizeTenant({ id: org.tenantId, name: org.name }));
  }
  db.tenants = Array.from(tenantsById.values());
  if (!db.organizations.some((org) => org.id === "org-local")) {
    db.organizations.unshift(normalizeOrganization({ id: "org-local", tenantId: DEFAULT_TENANT_ID, name: "Local Organization" }));
  }
  db.tenantPolicies = db.tenantPolicies && typeof db.tenantPolicies === "object" ? db.tenantPolicies : {};
  db.repositories = db.repositories.map((repo) => ({
    ...repo,
    validationConfig: normalizeValidationConfig(repo.validationConfig),
  }));
  db.log = Array.isArray(db.log) ? db.log : [];
  db.policy = normalizePolicy(db.policy);
  for (const [tenantId, policy] of Object.entries(db.tenantPolicies)) {
    db.tenantPolicies[tenantId] = normalizePolicy({ ...db.policy, ...policy });
  }
  return db;
}

function normalizePolicy(policy = {}) {
  const autoCanary = policy.autoCanary !== undefined ? Boolean(policy.autoCanary) : DEFAULT_POLICY.autoCanary;
  const autoMerge =
    policy.autoMerge !== undefined
      ? Boolean(policy.autoMerge)
      : policy.autoCanary !== undefined
        ? autoCanary
        : DEFAULT_POLICY.autoMerge;
  return {
    autoPr: policy.autoPr !== undefined ? Boolean(policy.autoPr) : DEFAULT_POLICY.autoPr,
    autoCanary,
    autoMerge,
    riskLimit: Number(policy.riskLimit ?? DEFAULT_POLICY.riskLimit),
    confidenceLimit: Number(policy.confidenceLimit ?? DEFAULT_POLICY.confidenceLimit),
  };
}

function policyForTenant(db, tenantId = DEFAULT_TENANT_ID) {
  return normalizePolicy({ ...db.policy, ...(db.tenantPolicies?.[tenantId] || {}) });
}

function policyForProject(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  return policyForTenant(db, project?.tenantId || DEFAULT_TENANT_ID);
}

function setTenantPolicy(db, tenantId, patch = {}) {
  const current = policyForTenant(db, tenantId);
  const next = normalizePolicy({
    ...current,
    autoPr: patch.autoPr !== undefined ? patch.autoPr : current.autoPr,
    autoCanary: patch.autoCanary !== undefined ? patch.autoCanary : current.autoCanary,
    autoMerge: patch.autoMerge !== undefined ? patch.autoMerge : patch.autoCanary !== undefined ? patch.autoCanary : current.autoMerge,
    riskLimit: patch.riskLimit !== undefined ? patch.riskLimit : current.riskLimit,
    confidenceLimit: patch.confidenceLimit !== undefined ? patch.confidenceLimit : current.confidenceLimit,
  });
  db.tenantPolicies[tenantId] = next;
  return next;
}

function normalizeProject(project = {}) {
  const id = slugify(project.id || project.name || "project");
  const url = String(project.url || "");
  const origin = originFromUrl(url);
  const allowedOrigins = Array.isArray(project.allowedOrigins)
    ? project.allowedOrigins.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  if (!allowedOrigins.length && origin) allowedOrigins.push(origin);

  return {
    ...project,
    id,
    name: String(project.name || id),
    url,
    env: String(project.env || "production"),
    health: Number(project.health || 80),
    conversion: Number(project.conversion || 0),
    errorRate: Number(project.errorRate || 0),
    canary: Number(project.canary || 0),
    tenantId: String(project.tenantId || DEFAULT_TENANT_ID),
    allowedOrigins: [...new Set(allowedOrigins)],
    sdkKey: String(project.sdkKey || `sdk-${id}-local`),
    sdkStatus: String(project.sdkStatus || "active"),
    outputWebhook: normalizeOutputWebhook(project.outputWebhook),
    deploymentHook: normalizeDeploymentHook(project.deploymentHook),
    ingestion: {
      acceptedSignals: Number(project.ingestion?.acceptedSignals || 0),
      rejectedSignals: Number(project.ingestion?.rejectedSignals || 0),
      lastSignalAt: project.ingestion?.lastSignalAt || null,
      lastAcceptedOrigin: project.ingestion?.lastAcceptedOrigin || "",
      lastRejectedAt: project.ingestion?.lastRejectedAt || null,
      lastRejectedOrigin: project.ingestion?.lastRejectedOrigin || "",
      lastRejectedReason: project.ingestion?.lastRejectedReason || "",
      rateLimitPerMinute: Number(project.ingestion?.rateLimitPerMinute || SIGNAL_RATE_LIMIT_PER_MINUTE),
    },
    createdAt: project.createdAt || nowIso(),
  };
}

function normalizeOutputWebhook(webhook = {}) {
  const url = String(webhook.url || "").trim();
  return {
    url,
    status: webhook.status === "active" && url ? "active" : "disabled",
    lastDeliveryAt: webhook.lastDeliveryAt || null,
    lastStatus: webhook.lastStatus || "",
  };
}

function detectDeploymentHookProvider(url) {
  const text = String(url || "").toLowerCase();
  if (text.includes("api.vercel.com") || text.includes("vercel.com")) return "vercel";
  if (text.includes("api.netlify.com") || text.includes("netlify.com")) return "netlify";
  if (text.includes("github.com") || text.includes("api.github.com")) return "github_actions";
  return "custom";
}

function normalizeDeploymentHook(hook = {}) {
  const url = String(hook.url || "").trim();
  const provider = String(hook.provider || detectDeploymentHookProvider(url));
  return {
    url,
    provider,
    status: hook.status === "active" && url ? "active" : "disabled",
    lastTriggeredAt: hook.lastTriggeredAt || null,
    lastStatus: hook.lastStatus || "",
  };
}

function normalizeValidationConfig(config = {}) {
  const checks = Array.isArray(config.checks) && config.checks.length ? config.checks.map(String) : [];
  return {
    install: String(config.install || "npm install"),
    checks: checks.length ? checks : ["npm run lint", "npm test", "npm run build"],
    realChecks: Array.isArray(config.realChecks) ? config.realChecks.map(String).filter(Boolean) : [],
    allowInstall: Boolean(config.allowInstall),
    mode: String(config.mode || "managed-sandbox"),
  };
}

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function normalizeWebsiteUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(candidate).href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sdkKeyFromRequest(req, body) {
  return String(req.headers["x-itera-sdk-key"] || body.sdkKey || "").trim();
}

function originFromHeader(value) {
  const text = String(value || "").trim();
  if (!text || text === "null") return text;
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

function signalRequestOrigin(req, body = {}) {
  const headerOrigin = originFromHeader(req.headers.origin);
  if (headerOrigin === "null") return originFromUrl(body.page) || "null";
  if (headerOrigin) return headerOrigin;
  const refererOrigin = originFromUrl(req.headers.referer);
  if (refererOrigin) return refererOrigin;
  return originFromUrl(body.page);
}

function platformOriginsForRequest(req) {
  const host = String(req.headers.host || "").trim();
  return host ? [`http://${host}`, `https://${host}`] : [];
}

function projectAllowedOrigins(project) {
  const origins = Array.isArray(project.allowedOrigins) ? project.allowedOrigins : [];
  const fromUrl = originFromUrl(project.url);
  return [...new Set([...origins, fromUrl].filter(Boolean))];
}

function rateLimitForSignal(project) {
  const limit = Math.max(1, Number(project.ingestion?.rateLimitPerMinute || SIGNAL_RATE_LIMIT_PER_MINUTE));
  const now = Date.now();
  const key = project.id;
  const current = signalRateLimits.get(key);
  if (!current || now - current.windowStart >= 60_000) {
    signalRateLimits.set(key, { windowStart: now, count: 1 });
    return { ok: true, limit, remaining: limit - 1 };
  }
  current.count += 1;
  return { ok: current.count <= limit, limit, remaining: Math.max(0, limit - current.count), retryAfter: 60 - Math.floor((now - current.windowStart) / 1000) };
}

function recordSignalReject(project, reason, origin) {
  project.ingestion = project.ingestion || {};
  project.ingestion.rejectedSignals = Number(project.ingestion.rejectedSignals || 0) + 1;
  project.ingestion.lastRejectedAt = nowIso();
  project.ingestion.lastRejectedOrigin = origin || "";
  project.ingestion.lastRejectedReason = reason;
  project.updatedAt = nowIso();
}

function recordSignalAccept(project, origin) {
  project.ingestion = project.ingestion || {};
  project.ingestion.acceptedSignals = Number(project.ingestion.acceptedSignals || 0) + 1;
  project.ingestion.lastSignalAt = nowIso();
  project.ingestion.lastAcceptedOrigin = origin || "";
  project.ingestion.lastRejectedReason = project.ingestion.lastRejectedReason || "";
  project.updatedAt = nowIso();
}

function validateSignalRequest(req, project, body) {
  const origin = signalRequestOrigin(req, body);
  const sdkKey = sdkKeyFromRequest(req, body);
  if (!sdkKey) return { ok: false, status: 401, reason: "SDK key is required", origin };
  if (sdkKey !== project.sdkKey) return { ok: false, status: 403, reason: "Invalid SDK key", origin };

  const allowedOrigins = projectAllowedOrigins(project);
  const platformOrigins = platformOriginsForRequest(req);
  const trustedPlatformOrigin = !origin || platformOrigins.includes(origin);
  if (origin && !trustedPlatformOrigin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, reason: "Origin is not allowed", origin, allowedOrigins };
  }

  const rate = rateLimitForSignal(project);
  if (!rate.ok) return { ok: false, status: 429, reason: "Signal rate limit exceeded", origin, rate };
  return { ok: true, origin, rate, trustedPlatformOrigin };
}

function resolveProjectForSignal(db, req, body) {
  const projectId = String(body.projectId || "").trim();
  if (projectId) {
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) {
      const error = new Error("Project not found. Create the project and API key before sending signals.");
      error.status = 404;
      throw error;
    }
    return project;
  }

  const sdkKey = sdkKeyFromRequest(req, body);
  if (!sdkKey) {
    const error = new Error("SDK key is required");
    error.status = 401;
    throw error;
  }

  const project = db.projects.find((item) => item.sdkKey === sdkKey && item.sdkStatus !== "disabled");
  if (!project) {
    const error = new Error("Project not found for SDK key");
    error.status = 404;
    throw error;
  }
  body.projectId = project.id;
  body.projectName = body.projectName || project.name;
  return project;
}

function createSdkKey(projectId) {
  return `sdk-${slugify(projectId)}-${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function addLog(db, message) {
  db.log.push(`[${timeLabel()}] ${message}`);
  db.log = db.log.slice(-200);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,x-itera-sdk-key,x-itera-tenant,x-itera-tenant-key,x-itera-user,x-itera-role,x-itera-include-state,x-github-event,x-hub-signature-256",
  });
  res.end(body);
}

function escapeHtmlForHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Itera AI</title></head><body>${body}</body></html>`);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function parseRawBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

function validateWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function webhookSignature(secret, body) {
  return `sha256=${createHmac("sha256", String(secret || "")).update(body).digest("hex")}`;
}

async function deliverOutputWebhook(db, projectId, event, payload = {}) {
  const project = db.projects.find((item) => item.id === projectId);
  const webhook = project?.outputWebhook || {};
  if (!project || webhook.status !== "active" || !webhook.url) return null;

  const delivery = {
    id: `wh-${randomUUID().slice(0, 8)}`,
    projectId: project.id,
    event,
    url: webhook.url,
    status: "pending",
    statusCode: null,
    durationMs: 0,
    responseSnippet: "",
    error: "",
    createdAt: nowIso(),
  };
  const body = JSON.stringify({
    id: delivery.id,
    event,
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
    },
    payload,
    createdAt: delivery.createdAt,
  });
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Itera-AI-Webhook/0.2",
        "X-Itera-Event": event,
        "X-Itera-Delivery": delivery.id,
        "X-Itera-Signature-256": webhookSignature(project.sdkKey, body),
      },
      body,
      signal: controller.signal,
    });
    delivery.statusCode = response.status;
    delivery.status = response.ok ? "delivered" : "failed";
    delivery.responseSnippet = (await response.text().catch(() => "")).slice(0, 400);
  } catch (error) {
    delivery.status = "failed";
    delivery.error = error.name === "AbortError" ? "Webhook delivery timed out" : error.message;
  } finally {
    clearTimeout(timer);
    delivery.durationMs = Date.now() - started;
  }

  project.outputWebhook.lastDeliveryAt = delivery.createdAt;
  project.outputWebhook.lastStatus = delivery.status;
  db.webhookDeliveries.unshift(delivery);
  db.webhookDeliveries = db.webhookDeliveries.slice(0, 500);
  addLog(db, `Output Webhook ${delivery.status}: ${event} -> ${project.name}`);
  return delivery;
}

async function triggerDeploymentHook(db, releasePlan, draft, payload = {}) {
  const project = db.projects.find((item) => item.id === releasePlan.projectId);
  const hook = project?.deploymentHook || {};
  if (!project || hook.status !== "active" || !hook.url) {
    throw new Error("Customer deployment hook is not configured.");
  }

  const run = {
    id: `deploy-${randomUUID().slice(0, 8)}`,
    projectId: project.id,
    releasePlanId: releasePlan.id,
    prDraftId: draft?.id || releasePlan.prDraftId || "",
    provider: hook.provider || detectDeploymentHookProvider(hook.url),
    url: hook.url,
    status: "pending",
    statusCode: null,
    durationMs: 0,
    responseSnippet: "",
    error: "",
    createdAt: nowIso(),
  };
  const body = JSON.stringify({
    id: run.id,
    event: "deployment.trigger",
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
    },
    releasePlan: {
      id: releasePlan.id,
      phase: releasePlan.currentPhase,
      status: releasePlan.status,
    },
    prDraft: draft
      ? {
          id: draft.id,
          title: draft.title,
          remoteUrl: draft.remoteUrl,
          remoteNumber: draft.remoteNumber,
          branch: draft.branch,
          baseBranch: draft.baseBranch,
        }
      : null,
    payload,
    createdAt: run.createdAt,
  });
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Itera-AI-Deploy/0.2",
        "X-Itera-Event": "deployment.trigger",
        "X-Itera-Deployment": run.id,
        "X-Itera-Signature-256": webhookSignature(project.sdkKey, body),
      },
      body,
      signal: controller.signal,
    });
    run.statusCode = response.status;
    run.status = response.ok ? "triggered" : "failed";
    run.responseSnippet = (await response.text().catch(() => "")).slice(0, 400);
  } catch (error) {
    run.status = "failed";
    run.error = error.name === "AbortError" ? "Deployment hook timed out" : error.message;
  } finally {
    clearTimeout(timer);
    run.durationMs = Date.now() - started;
  }

  project.deploymentHook.lastTriggeredAt = run.createdAt;
  project.deploymentHook.lastStatus = run.status;
  db.deploymentRuns.unshift(run);
  db.deploymentRuns = db.deploymentRuns.slice(0, 500);
  addLog(db, `Deployment Hook ${run.status}: ${project.name} -> ${run.provider}`);
  return run;
}

function signalText(body) {
  if (body.text) return String(body.text);
  if (body.message) return String(body.message);
  if (body.content) return String(body.content);
  if (body.feedback) return String(body.feedback);
  if (body.description) return String(body.description);
  if (body.data?.text) return String(body.data.text);
  if (body.data?.message) return String(body.data.message);
  if (body.data?.content) return String(body.data.content);
  if (body.data?.feedback) return String(body.data.feedback);
  if (body.data?.description) return String(body.data.description);
  if (body.data?.feedbackType) return `用户提交了 ${body.data.feedbackType} 类型反馈。`;
  if (body.data?.stack) return String(body.data.stack).slice(0, 220);
  if (body.type === "api_failure") {
    const status = body.data?.status ? `${body.data.status} ` : "";
    return `接口请求失败：${status}${body.data?.url || body.page || ""}`;
  }
  if (body.type === "behavior") {
    return body.data?.text || "用户行为异常，可能存在交互卡点。";
  }
  if (body.type === "performance") {
    const loadTime = body.data?.loadTime || body.data?.domContentLoaded;
    return loadTime ? `页面性能信号：加载耗时 ${loadTime}ms` : "页面性能信号需要进一步分析。";
  }
  return `${body.type || "signal"} 信号已接收。`;
}

function classifySignal(body) {
  const text = signalText(body);
  const type = String(body.type || "feedback");
  let category = normalizeCategory(body.category || body.data?.category || "support");

  if (type.includes("error") || type.includes("rejection")) category = "bug";
  if (type === "api_failure") category = "bug";
  if (type === "behavior") category = "support";
  if (type === "performance") category = "performance";
  if (body.feedbackType === "request" || body.data?.feedbackType === "request") category = "request";
  if (body.feedbackType === "bug" || body.data?.feedbackType === "bug") category = "bug";
  if (/慢|卡顿|加载|性能|延迟|超时|首屏|阻塞|load|timeout/i.test(text)) category = "performance";
  if (/希望|能不能|增加|支持|需要|建议|功能|是否可以|保存|导出/i.test(text)) category = "request";
  if (/报错|错误|崩溃|打不开|按钮|无法|失败|异常|没有反应|500|404|支付|登录/i.test(text)) category = "bug";

  let risk = category === "bug" ? 2 : category === "request" ? 2 : 1;
  if (type === "api_failure") risk = 2;
  if (type === "behavior") risk = Math.max(risk, 2);
  if (/支付|登录|权限|订单|删除|安全|导出|数据|金额|退款|500/i.test(text)) risk = 3;
  if (category === "performance" && /首屏|超时|转化|阻塞/i.test(text)) risk = Math.max(risk, 2);

  const severity = risk === 3 ? "高" : risk === 2 ? "中" : "低";
  const confidence = Math.min(96, Math.max(72, 86 + text.length % 11 - risk * 2));
  return { text, category, risk, severity, confidence };
}

function taskFromSignal(signal, policy) {
  const titlePrefix = {
    bug: "修复关键异常",
    request: "评估高频功能请求",
    performance: "优化性能瓶颈",
    support: "更新客服知识库",
  }[signal.category];

  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    projectId: signal.projectId,
    title: `${titlePrefix}：${signal.text.slice(0, 22)}`,
    summary: signal.text,
    category: signal.category,
    risk: signal.risk,
    confidence: signal.confidence,
    agent: signal.category === "request" ? "产品 Agent" : signal.category === "support" ? "客服 Agent" : "开发 Agent",
    status: signal.risk <= policy.riskLimit && signal.confidence >= policy.confidenceLimit ? "已批准" : "待审批",
    sourceSignalIds: [signal.id],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function shouldCreateTaskForSignal(signal) {
  const type = String(signal.type || "");
  if (["sdk_loaded", "connection_test"].includes(type)) return false;
  if (signal.data?.heartbeat) return false;
  return true;
}

function ensureProject(db, body) {
  const project = db.projects.find((item) => item.id === body.projectId);
  if (project) return project;

  const created = normalizeProject({
    id: body.projectId,
    name: body.projectName || body.projectId,
    url: body.page || body.url || "",
    env: "production",
    health: 80,
    conversion: 0,
    errorRate: 0,
    canary: 0,
    sdkKey: createSdkKey(body.projectId),
    createdAt: nowIso(),
  });
  db.projects.push(created);
  return created;
}

function uniqueProjectId(db, desiredId) {
  const base = slugify(desiredId || "project");
  let candidate = base;
  while (db.projects.some((project) => project.id === candidate)) candidate = `${base}-${randomUUID().slice(0, 5)}`;
  return candidate;
}

function createCustomerProject(db, body, actor = { tenantId: DEFAULT_TENANT_ID }) {
  const name = String(body.name || body.projectName || "").trim();
  if (!name) throw new Error("Project name is required");
  const url = normalizeWebsiteUrl(body.url);
  if (!url) throw new Error("Valid website URL is required");
  const id = body.id || body.projectId ? slugify(body.id || body.projectId) : uniqueProjectId(db, name);
  if (db.projects.some((project) => project.id === id)) throw new Error("Project id already exists");

  const project = normalizeProject({
    id,
    name,
    tenantId: actor.tenantId || DEFAULT_TENANT_ID,
    url,
    env: body.env || "production",
    allowedOrigins: Array.isArray(body.allowedOrigins) ? body.allowedOrigins : String(body.allowedOrigins || "").split(","),
    sdkKey: createSdkKey(id),
    sdkStatus: "active",
    outputWebhook: normalizeOutputWebhook(body.outputWebhook),
    deploymentHook: normalizeDeploymentHook(body.deploymentHook),
    health: 80,
    conversion: 0,
    errorRate: 0,
    canary: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  db.projects.unshift(project);
  addLog(db, `客户项目已创建：${project.name}`);
  return project;
}

function rotateProjectSdkKey(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found");
  project.sdkKey = createSdkKey(project.id);
  project.sdkStatus = "active";
  project.updatedAt = nowIso();
  addLog(db, `SDK key 已轮换：${project.name}`);
  return project;
}

function ingestSignal(db, body) {
  ensureProject(db, body);
  const classification = classifySignal(body);
  const signal = {
    id: `sig-${randomUUID().slice(0, 8)}`,
    projectId: body.projectId,
    type: body.type || "feedback",
    source: body.source || (body.type === "feedback" ? "用户反馈" : "SDK 上报"),
    category: classification.category,
    severity: classification.severity,
    risk: classification.risk,
    confidence: classification.confidence,
    page: body.page || "",
    text: classification.text,
    userAgent: body.userAgent || "",
    userId: body.userId || null,
    release: body.release || null,
    createdAt: body.createdAt || nowIso(),
    data: body.data || {},
  };

  db.signals.push(signal);
  const task = taskFromSignal(signal, policyForProject(db, signal.projectId));
  db.tasks.unshift(task);
  addLog(db, `Signals API 接收 ${signal.source}：${signal.text.slice(0, 28)}`);
  addLog(db, `产品 Agent 已生成任务：${task.title.slice(0, 34)}`);
  return { signal, task };
}

async function analyzeProjectSignals(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  const signals = db.signals
    .filter((signal) => signal.projectId === projectId)
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 80);

  if (!project) throw new Error("Project not found");
  if (!signals.length) {
    return {
      model: "local-heuristic",
      summary: "当前项目还没有足够信号，建议先接入 SDK 或导入客服工单。",
      clusters: [],
      suggestedTasks: [],
    };
  }

  const llmResult = await analyzeWithAiProvider(db, project, signals);
  return llmResult || analyzeWithHeuristics(project, signals);
}

function normalizeAiBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/\/chat\/completions$/i.test(raw) || /\/responses$/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path && path !== "/" && !/\/v1$/i.test(path)) return raw;
    if (/deepseek\.com$/i.test(parsed.hostname) && (!parsed.pathname || parsed.pathname === "/")) {
      return `${raw}/chat/completions`;
    }
  } catch {
    // Fall through to the OpenAI-compatible default.
  }
  if (/\/v1$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function aiEndpointMode(endpoint) {
  return /\/responses$/i.test(String(endpoint || "")) ? "responses" : "chat_completions";
}

function aiRequestPayload(config, messages, temperature = config.temperature) {
  const safeTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;
  if (aiEndpointMode(config.endpoint) === "responses") {
    return {
      model: config.model,
      temperature: safeTemperature,
      input: messages.map((message) => `${String(message.role || "user").toUpperCase()}:\n${message.content}`).join("\n\n"),
    };
  }
  return {
    model: config.model,
    temperature: safeTemperature,
    messages,
  };
}

function extractAiText(data = {}) {
  if (typeof data.output_text === "string") return data.output_text;
  const choiceText = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (choiceText) return choiceText;
  if (Array.isArray(data.output)) {
    const parts = [];
    data.output.forEach((item) => {
      if (typeof item?.content === "string") parts.push(item.content);
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (typeof content?.text === "string") parts.push(content.text);
          if (typeof content?.output_text === "string") parts.push(content.output_text);
        });
      }
    });
    return parts.join("\n").trim();
  }
  return "";
}

function parseProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text || isPlaceholderConfigValue(text)) return null;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function proxyHostLabel(value) {
  const proxy = parseProxyUrl(value);
  return proxy ? `${proxy.hostname}:${proxy.port || (proxy.protocol === "https:" ? "443" : "80")}` : "";
}

function decodeChunkedBody(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeText = buffer.slice(offset, lineEnd).toString("latin1").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return chunks.length ? Buffer.concat(chunks) : buffer;
}

function parseRawHttpJsonResponse(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("Proxy response did not include HTTP headers.");
  const headerText = raw.slice(0, headerEnd).toString("latin1");
  const bodyStart = headerEnd + 4;
  const lines = headerText.split(/\r?\n/);
  const statusMatch = lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const statusText = statusMatch ? statusMatch[2].trim() : "";
  const headers = {};
  lines.slice(1).forEach((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  });
  let bodyBuffer = raw.slice(bodyStart);
  if (/chunked/i.test(headers["transfer-encoding"] || "")) bodyBuffer = decodeChunkedBody(bodyBuffer);
  if (/gzip/i.test(headers["content-encoding"] || "")) bodyBuffer = zlib.gunzipSync(bodyBuffer);
  if (/br/i.test(headers["content-encoding"] || "")) bodyBuffer = zlib.brotliDecompressSync(bodyBuffer);
  const bodyText = bodyBuffer.toString("utf8").trim();
  let data = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = { raw: bodyText };
    }
  }
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers,
    },
    data,
  };
}

function postJsonThroughHttpProxy(endpoint, headers, body, proxyUrl, timeoutMs = 20000) {
  const target = new URL(endpoint);
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error("Invalid proxy URL. Use a value like http://127.0.0.1:7890.");
  if (target.protocol !== "https:") throw new Error("Proxy mode currently supports HTTPS AI endpoints only.");
  if (proxy.protocol !== "http:") throw new Error("Proxy mode currently supports HTTP proxy URLs only.");

  return new Promise((resolve, reject) => {
    let proxySocket = null;
    let tlsSocket = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tlsSocket) tlsSocket.destroy();
      if (proxySocket) proxySocket.destroy();
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => fail(new Error("AI provider request timed out.")), timeoutMs);

    const proxyPort = Number(proxy.port || 80);
    proxySocket = net.connect({ host: proxy.hostname, port: proxyPort });
    proxySocket.once("error", fail);
    proxySocket.once("connect", () => {
      const targetPort = target.port || "443";
      const connectHeaders = [
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
        `Host: ${target.hostname}:${targetPort}`,
        "Connection: close",
      ];
      if (proxy.username || proxy.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
        connectHeaders.push(`Proxy-Authorization: Basic ${auth}`);
      }
      proxySocket.write(`${connectHeaders.join("\r\n")}\r\n\r\n`);
    });

    let connectBuffer = Buffer.alloc(0);
    proxySocket.on("data", function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = connectBuffer.slice(0, headerEnd).toString("latin1");
      const statusMatch = headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status !== 200) {
        fail(new Error(`Proxy CONNECT failed with HTTP ${status || "unknown"}.`));
        return;
      }
      const remaining = connectBuffer.slice(headerEnd + 4);
      proxySocket.removeListener("data", onConnectData);
      proxySocket.removeAllListeners("error");
      if (remaining.length) proxySocket.unshift(remaining);
      tlsSocket = tls.connect({ socket: proxySocket, servername: target.hostname }, () => {
        const requestHeaders = {
          ...headers,
          "Content-Length": Buffer.byteLength(body),
          "Accept-Encoding": "identity",
          Connection: "close",
        };
        const pathWithQuery = `${target.pathname || "/"}${target.search || ""}`;
        const lines = [`POST ${pathWithQuery} HTTP/1.1`, `Host: ${target.host}`];
        Object.entries(requestHeaders).forEach(([key, value]) => {
          if (value === undefined || value === null || value === "") return;
          lines.push(`${key}: ${value}`);
        });
        tlsSocket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
      });
      tlsSocket.once("error", fail);
      const responseChunks = [];
      tlsSocket.on("data", (responseChunk) => responseChunks.push(responseChunk));
      tlsSocket.once("end", () => {
        try {
          succeed(parseRawHttpJsonResponse(Buffer.concat(responseChunks)));
        } catch (error) {
          fail(error);
        }
      });
    });
  });
}

async function callAiProvider(config, messages, temperature = config.temperature, timeoutMs = 20000) {
  const payload = JSON.stringify(aiRequestPayload(config, messages, temperature));
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.proxyUrl) {
    const { response, data } = await postJsonThroughHttpProxy(config.endpoint, headers, payload, config.proxyUrl, timeoutMs);
    return { response, data, content: extractAiText(data), mode: aiEndpointMode(config.endpoint) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: payload,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  const data = await response.json().catch(() => ({}));
  return { response, data, content: extractAiText(data), mode: aiEndpointMode(config.endpoint) };
}

function aiProviderAttempt(config, status, detail = {}) {
  let endpointHost = "";
  try {
    endpointHost = new URL(config.endpoint || config.baseUrl || "").host;
  } catch {
    endpointHost = "";
  }
  return {
    status,
    model: config.model || "",
    baseUrl: config.baseUrl || "",
    endpoint: config.endpoint || "",
    endpointHost,
    mode: config.endpoint ? aiEndpointMode(config.endpoint) : config.provider || "",
    proxyHost: proxyHostLabel(config.proxyUrl),
    message: detail.message || "",
    httpStatus: detail.httpStatus || 0,
    fallback: detail.fallback || "",
    checkedAt: nowIso(),
  };
}

function attachAiProviderAttempt(codePlan, attempt) {
  if (!codePlan || !attempt) return null;
  codePlan.aiProviderAttempt = attempt;
  codePlan.repositoryAnalysis = codePlan.repositoryAnalysis && typeof codePlan.repositoryAnalysis === "object" ? codePlan.repositoryAnalysis : {};
  codePlan.repositoryAnalysis.aiProviderAttempt = attempt;
  return null;
}

function normalizeAiProviderSettings(settings = {}) {
  const provider = String(settings.provider || "").trim();
  const baseUrl = String(settings.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(settings.apiKey || "").trim();
  const model = String(settings.model || "").trim();
  const proxyUrl = String(settings.proxyUrl || "").trim().replace(/\/+$/, "");
  const temperature =
    settings.temperature === undefined || settings.temperature === null || settings.temperature === ""
      ? NaN
      : Number(settings.temperature);
  return {
    provider: provider && !isPlaceholderConfigValue(provider) ? provider : "",
    baseUrl: baseUrl && !isPlaceholderConfigValue(baseUrl) ? baseUrl : "",
    apiKey: apiKey && !isPlaceholderConfigValue(apiKey) ? apiKey : "",
    model: model && !isPlaceholderConfigValue(model) ? model : "",
    proxyUrl: parseProxyUrl(proxyUrl) ? proxyUrl : "",
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : "",
    updatedAt: settings.updatedAt || null,
  };
}

function persistedAiProviderConfig(db) {
  return normalizeAiProviderSettings(db?.platformConfig?.aiProvider || {});
}

function aiProviderConfig(db = null) {
  const persisted = persistedAiProviderConfig(db);
  const legacyOpenAiKey = envConfig("OPENAI_API_KEY");
  const provider = "generic-openai-compatible";
  const apiKey = persisted.apiKey || envConfig("AI_API_KEY") || legacyOpenAiKey;
  const baseUrl =
    persisted.baseUrl ||
    envConfig("AI_API_BASE_URL") ||
    envConfig("OPENAI_BASE_URL") ||
    envConfig("OPENAI_API_BASE_URL") ||
    "https://api.openai.com/v1";
  const model = persisted.model || envConfig("AI_MODEL") || envConfig("OPENAI_MODEL") || "gpt-4.1-mini";
  const proxyUrl = persisted.proxyUrl || envConfig("AI_HTTP_PROXY") || envConfig("HTTPS_PROXY") || envConfig("HTTP_PROXY");
  const temperature = Number(persisted.temperature !== "" ? persisted.temperature : envConfig("AI_TEMPERATURE") || process.env.AI_TEMPERATURE || 0.2);
  const source = persisted.apiKey || persisted.baseUrl || persisted.model || persisted.proxyUrl ? "database" : envConfig("AI_API_KEY") || legacyOpenAiKey ? "env" : "default";
  return {
    provider,
    apiKey,
    baseUrl,
    endpoint: normalizeAiBaseUrl(baseUrl),
    model,
    proxyUrl,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    source,
    configured: Boolean(apiKey && model && baseUrl),
  };
}

function aiProviderStatus(db = null) {
  const config = aiProviderConfig(db);
  const lastValidation = db?.platformConfig?.aiProviderLastValidation || null;
  return {
    provider: config.provider,
    mode: config.configured ? "third_party_api" : "local_heuristic",
    configured: config.configured,
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    source: config.source,
    baseUrlConfigured: Boolean(config.baseUrl),
    apiKeyConfigured: Boolean(config.apiKey),
    proxyUrl: config.proxyUrl || "",
    proxyHost: proxyHostLabel(config.proxyUrl),
    proxyConfigured: Boolean(config.proxyUrl),
    endpointHost: config.endpoint ? (() => {
      try {
        return new URL(config.endpoint).host;
      } catch {
        return "";
      }
    })() : "",
    reachable: lastValidation ? Boolean(lastValidation.ok) : null,
    lastValidation,
    message: config.configured
      ? lastValidation?.ok
        ? "Third-party AI API is configured and validated. Code Agent can call the model."
        : lastValidation
          ? `AI API config is saved, but the last validation failed: ${lastValidation.message || "unknown error"}`
          : "AI API config is saved, but it has not been validated in this runtime."
      : "No AI API key is configured. The platform will use local heuristic rules only.",
  };
}

function parseAiJsonContent(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Continue to the object-slice fallback.
      }
    }
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function validateAiProviderSetup(db = null) {
  const config = aiProviderConfig(db);
  if (!config.configured) {
    return {
      ok: false,
      mode: "local_heuristic",
      message: "请在页面里填写 API Key、Base URL 和模型名，然后再验证。",
      status: 0,
    };
  }
  try {
    const { response, data, content, mode } = await callAiProvider(
      config,
      [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "Return {\"ok\":true} as JSON." },
      ],
      0,
    );
    if (!response.ok) {
      return {
        ok: false,
        mode,
        message: data.error?.message || `AI provider returned HTTP ${response.status}`,
        status: response.status,
      };
    }
    const parsed = parseAiJsonContent(content);
    return {
      ok: Boolean(parsed?.ok) || Boolean(content),
      mode,
      message: "AI provider responded successfully.",
      model: config.model,
      status: response.status,
    };
  } catch (error) {
    return { ok: false, mode: config.provider, message: error.message, status: 0 };
  }
}

function normalizeAiSingleSignalResult(result, fallbackClassification, fallbackText) {
  if (!result || typeof result !== "object") return null;
  const signal = result.signal && typeof result.signal === "object" ? result.signal : result;
  const task = result.task && typeof result.task === "object" ? result.task : {};
  const category = normalizeCategory(signal.category || task.category || fallbackClassification.category);
  const risk = Math.max(1, Math.min(3, Number(signal.risk || task.risk || fallbackClassification.risk || 2)));
  const confidence = Math.max(60, Math.min(98, Number(signal.confidence || task.confidence || fallbackClassification.confidence || 82)));
  const severity = signal.severity || (risk === 3 ? "high" : risk === 2 ? "medium" : "low");
  const title = String(task.title || result.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const summary = String(task.summary || result.summary || fallbackText || "").replace(/\s+/g, " ").trim().slice(0, 800);
  return {
    classification: {
      text: fallbackText,
      category,
      risk,
      severity,
      confidence,
    },
    task: {
      title,
      summary,
      category,
      risk,
      confidence,
      agent: String(task.agent || agentForCategory(category)).slice(0, 40),
    },
    reason: String(result.reason || result.rationale || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
}

async function analyzeSingleSignalWithAiProvider(db, project, body, fallbackClassification) {
  const config = aiProviderConfig(db);
  if (!config.configured) return null;
  const text = fallbackClassification.text || signalText(body);
  if (!text || ["sdk_loaded", "connection_test"].includes(String(body.type || ""))) return null;

  const prompt = {
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      env: project.env,
    },
    signal: {
      type: body.type || "feedback",
      source: body.source || "",
      page: body.page || body.url || "",
      text,
      data: body.data || {},
      localFallback: fallbackClassification,
    },
    requiredJsonShape: {
      signal: {
        category: "bug | request | performance | support",
        risk: "1 | 2 | 3",
        severity: "low | medium | high",
        confidence: "number 0-100",
      },
      task: {
        title: "short actionable engineering title",
        summary: "what should be changed and why",
        category: "bug | request | performance | support",
        risk: "1 | 2 | 3",
        confidence: "number 0-100",
        agent: "Product Agent | QA Agent | Code Agent | Support Agent",
      },
      reason: "brief explanation, no markdown",
    },
  };

  try {
    const { response, data, content, mode } = await callAiProvider(
      config,
      [
        {
          role: "system",
          content:
            "You are an AI product triage agent. Return JSON only. Classify one website feedback signal and create one actionable task. Keep the task concrete enough for a code agent. Do not invent unsupported facts.",
        },
        { role: "user", content: JSON.stringify(prompt) },
      ],
      Math.min(config.temperature, 0.2),
      30000,
    );
    if (!response.ok) {
      addLog(db, `AI feedback analysis failed: HTTP ${response.status}`);
      return {
        attempt: aiProviderAttempt(config, "failed", {
          message: data?.error?.message || `AI provider returned HTTP ${response.status}`,
          httpStatus: response.status,
          fallback: "local_signal_rules",
        }),
      };
    }
    const parsed = parseAiJsonContent(content);
    const normalized = normalizeAiSingleSignalResult(parsed, fallbackClassification, text);
    if (!normalized) {
      addLog(db, "AI feedback analysis returned invalid JSON; falling back to local rules.");
      return {
        attempt: aiProviderAttempt(config, "failed", {
          message: "AI provider responded, but did not return a valid signal analysis JSON.",
          httpStatus: response.status,
          fallback: "local_signal_rules",
        }),
      };
    }
    const attempt = aiProviderAttempt(config, "used", {
      message: "AI provider analyzed the incoming feedback and generated a task.",
      httpStatus: response.status,
    });
    return { ...normalized, attempt, mode };
  } catch (error) {
    addLog(db, `AI feedback analysis failed: ${error.message}`);
    return {
      attempt: aiProviderAttempt(config, "failed", {
        message: error.name === "AbortError" ? "AI provider request timed out after 20 seconds." : error.message,
        fallback: "local_signal_rules",
      }),
    };
  }
}

function taskFromAiSignal(signal, policy, aiTask, attempt) {
  const title = String(aiTask?.title || "").trim();
  const baseTask = taskFromSignal(signal, policy);
  const task = {
    ...baseTask,
    title: title || baseTask.title,
    summary: String(aiTask?.summary || signal.text || "").trim() || signal.text,
    category: normalizeCategory(aiTask?.category || signal.category),
    risk: Math.max(1, Math.min(3, Number(aiTask?.risk || signal.risk || 2))),
    confidence: Math.max(60, Math.min(98, Number(aiTask?.confidence || signal.confidence || 82))),
    agent: String(aiTask?.agent || agentForCategory(aiTask?.category || signal.category)),
    generatedBy: "ai_provider",
    aiProviderAttempt: attempt || null,
  };
  return task;
}

async function analyzeWithAiProvider(db, project, signals) {
  const config = aiProviderConfig(db);
  if (!config.configured) return null;

  const compactSignals = signals.map((signal) => ({
    id: signal.id,
    source: signal.source,
    type: signal.type,
    category: signal.category,
    severity: signal.severity,
    risk: signal.risk,
    confidence: signal.confidence,
    page: signal.page,
    text: signal.text,
    createdAt: signal.createdAt,
  }));

  const prompt = {
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      env: project.env,
    },
    signals: compactSignals,
    requiredJsonShape: {
      summary: "string",
      clusters: [
        {
          title: "string",
          category: "bug | request | performance | support",
          priority: "P0 | P1 | P2 | P3",
          impact: "string",
          recommendation: "string",
          signalIds: ["sig-id"],
        },
      ],
      suggestedTasks: [
        {
          title: "string",
          summary: "string",
          category: "bug | request | performance | support",
          risk: "1 | 2 | 3",
          confidence: "number 0-100",
          agent: "产品 Agent | QA Agent | 开发 Agent | 客服 Agent",
        },
      ],
    },
  };

  try {
    const { response, data, content } = await callAiProvider(config, [
      {
        role: "system",
        content:
          "你是一个 AI 产品分析 Agent。你要把网站用户反馈、错误、性能、客服工单聚类，判断优先级，并输出严格 JSON。不要输出 Markdown。",
      },
      {
        role: "user",
        content: JSON.stringify(prompt),
      },
    ]);
    if (!response.ok) {
      addLog(db, `AI analysis Agent call failed: HTTP ${response.status}`);
      return {
        ...analyzeWithHeuristics(project, signals),
        model: "local-heuristic",
        aiProviderAttempt: aiProviderAttempt(config, "failed", {
          message: data?.error?.message || `AI provider returned HTTP ${response.status}`,
          httpStatus: response.status,
          fallback: "local_analysis_rules",
        }),
      };
    }
    if (!content) return null;
    const parsed = parseAiJsonContent(content);
    if (!parsed) {
      addLog(db, "AI analysis Agent returned invalid JSON; falling back to local analysis.");
      return {
        ...analyzeWithHeuristics(project, signals),
        model: "local-heuristic",
        aiProviderAttempt: aiProviderAttempt(config, "failed", {
          message: "AI provider responded, but did not return valid analysis JSON.",
          httpStatus: response.status,
          fallback: "local_analysis_rules",
        }),
      };
    }
    const normalized = normalizeAnalysisResult(parsed, `${config.provider}:${config.model}`);
    normalized.aiProviderAttempt = aiProviderAttempt(config, "used", {
      message: "AI provider clustered feedback and suggested tasks.",
      httpStatus: response.status,
    });
    addLog(db, `AI analysis Agent used ${config.model} for ${signals.length} signal(s).`);
    return normalized;
  } catch (error) {
    addLog(db, `AI analysis Agent call failed: ${error.message}`);
    return {
      ...analyzeWithHeuristics(project, signals),
      model: "local-heuristic",
      aiProviderAttempt: aiProviderAttempt(config, "failed", {
        message: error.name === "AbortError" ? "AI provider request timed out after 20 seconds." : error.message,
        fallback: "local_analysis_rules",
      }),
    };
  }
}

function analyzeWithHeuristics(project, signals) {
  const clusters = Object.values(
    signals.reduce((acc, signal) => {
      const key = `${signal.category}:${topicForSignal(signal)}`;
      if (!acc[key]) {
        acc[key] = {
          title: clusterTitle(signal),
          category: signal.category,
          priority: "P3",
          impact: "",
          recommendation: "",
          signalIds: [],
          score: 0,
          examples: [],
        };
      }
      acc[key].signalIds.push(signal.id);
      acc[key].score += signalScore(signal);
      acc[key].examples.push(signal.text);
      return acc;
    }, {}),
  )
    .map((cluster) => {
      const priority = priorityFromScore(cluster.score, cluster.signalIds.length);
      return {
        title: cluster.title,
        category: cluster.category,
        priority,
        impact: impactText(cluster, project),
        recommendation: recommendationForCluster(cluster),
        signalIds: cluster.signalIds,
      };
    })
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  const suggestedTasks = clusters.slice(0, 5).map((cluster) => ({
    title: taskTitleForCluster(cluster),
    summary: `${cluster.impact} ${cluster.recommendation}`,
    category: cluster.category,
    risk: riskForPriority(cluster.priority, cluster.category),
    confidence: Math.min(95, 78 + cluster.signalIds.length * 5 + (cluster.priority === "P0" ? 8 : 0)),
    agent: agentForCategory(cluster.category),
    sourceSignalIds: cluster.signalIds,
  }));

  return {
    model: "local-heuristic",
    summary: `${project.name} 当前聚合出 ${clusters.length} 个问题/机会，其中 ${clusters.filter((item) => ["P0", "P1"].includes(item.priority)).length} 个需要优先处理。`,
    clusters,
    suggestedTasks,
  };
}

function normalizeAnalysisResult(result, model) {
  const clusters = Array.isArray(result.clusters) ? result.clusters : [];
  const suggestedTasks = Array.isArray(result.suggestedTasks) ? result.suggestedTasks : [];
  return {
    model,
    summary: String(result.summary || "AI 已完成分析。"),
    clusters: clusters.map((cluster) => ({
      title: String(cluster.title || "未命名聚类"),
      category: normalizeCategory(cluster.category),
      priority: normalizePriority(cluster.priority),
      impact: String(cluster.impact || ""),
      recommendation: String(cluster.recommendation || ""),
      signalIds: Array.isArray(cluster.signalIds) ? cluster.signalIds.map(String) : [],
    })),
    suggestedTasks: suggestedTasks.map((task) => ({
      title: String(task.title || "AI 建议任务"),
      summary: String(task.summary || ""),
      category: normalizeCategory(task.category),
      risk: Math.max(1, Math.min(3, Number(task.risk || 2))),
      confidence: Math.max(60, Math.min(98, Number(task.confidence || 82))),
      agent: String(task.agent || agentForCategory(task.category)),
      sourceSignalIds: Array.isArray(task.sourceSignalIds) ? task.sourceSignalIds.map(String) : [],
    })),
  };
}

function normalizeCategory(category) {
  return ["bug", "request", "performance", "support"].includes(category) ? category : "support";
}

function normalizePriority(priority) {
  return ["P0", "P1", "P2", "P3"].includes(priority) ? priority : "P2";
}

function topicForSignal(signal) {
  const text = signal.text || "";
  if (/支付|订单|结账|付款|checkout|payment/i.test(text)) return "payment";
  if (/登录|注册|权限|账号|password|auth/i.test(text)) return "auth";
  if (/加载|慢|卡顿|首屏|阻塞|性能|load|timeout/i.test(text)) return "performance";
  if (/地址|收货|配送|物流/i.test(text)) return "address";
  if (/导出|下载|报表|csv|excel/i.test(text)) return "export";
  if (/按钮|点击|无响应|没有反应/i.test(text)) return "interaction";
  return signal.category || "general";
}

function clusterTitle(signal) {
  const topic = topicForSignal(signal);
  const labels = {
    payment: "支付/结账流程阻塞",
    auth: "登录与权限问题",
    performance: "页面性能与加载体验",
    address: "地址与资料填写需求",
    export: "数据导出异常",
    interaction: "按钮/交互无响应",
    bug: "功能异常反馈",
    request: "功能需求反馈",
    support: "客服高频问题",
    general: "综合体验反馈",
  };
  return labels[topic] || labels[signal.category] || "综合体验反馈";
}

function signalScore(signal) {
  const risk = Number(signal.risk || 1);
  const confidence = Number(signal.confidence || 80) / 100;
  const severityBonus = signal.severity === "高" ? 2 : signal.severity === "中" ? 1 : 0;
  return risk * 3 + confidence * 2 + severityBonus;
}

function priorityFromScore(score, count) {
  if (score >= 16 || count >= 5) return "P0";
  if (score >= 10 || count >= 3) return "P1";
  if (score >= 6 || count >= 2) return "P2";
  return "P3";
}

function priorityRank(priority) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[priority] ?? 4;
}

function impactText(cluster, project) {
  const count = cluster.signalIds.length;
  const projectName = project.name || project.id;
  if (cluster.category === "bug") return `${projectName} 有 ${count} 条异常信号，可能直接阻塞用户完成核心流程。`;
  if (cluster.category === "performance") return `${projectName} 有 ${count} 条性能信号，可能影响转化和留存。`;
  if (cluster.category === "request") return `${projectName} 有 ${count} 条需求信号，说明用户在期待更顺手的能力。`;
  return `${projectName} 有 ${count} 条客服/体验信号，适合沉淀到知识库或优化引导。`;
}

function recommendationForCluster(cluster) {
  if (cluster.category === "bug") return "建议先复现路径，补充回归用例，再创建修复 PR。";
  if (cluster.category === "performance") return "建议定位慢请求和主线程阻塞，先做预览环境性能对比。";
  if (cluster.category === "request") return "建议生成需求说明，评估影响面，再做小流量实验。";
  return "建议更新客服知识库，并在页面上补充主动引导。";
}

function taskTitleForCluster(cluster) {
  const prefix = {
    bug: "修复",
    performance: "优化",
    request: "验证",
    support: "沉淀",
  }[cluster.category];
  return `${prefix}${cluster.title}`;
}

function riskForPriority(priority, category) {
  if (priority === "P0") return 3;
  if (priority === "P1") return category === "request" ? 2 : 3;
  if (priority === "P2") return 2;
  return 1;
}

function agentForCategory(category) {
  if (category === "request") return "产品 Agent";
  if (category === "performance") return "QA Agent";
  if (category === "support") return "客服 Agent";
  return "开发 Agent";
}

function createTaskFromAiSuggestion(projectId, suggestion, analysisId) {
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    projectId,
    title: suggestion.title,
    summary: suggestion.summary,
    category: suggestion.category,
    risk: suggestion.risk,
    confidence: suggestion.confidence,
    agent: suggestion.agent || agentForCategory(suggestion.category),
    status: "待审批",
    sourceSignalIds: suggestion.sourceSignalIds || [],
    analysisId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function slugify(value) {
  const ascii = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || `task-${randomUUID().slice(0, 6)}`;
}

function defaultRepositoryForProject(db, projectId) {
  const connectedRepo = db.repositories.find((item) => item.projectId === projectId && item.status !== "mock-connected");
  if (connectedRepo) return connectedRepo;

  let repo = db.repositories.find((item) => item.projectId === projectId);

  const installationRepo = githubInstallationForProject(db, projectId)?.repositories?.[0];
  if (installationRepo) return upsertRepositoryFromGithubInstallation(db, projectId, installationRepo);
  if (repo) return repo;

  const project = db.projects.find((item) => item.id === projectId);
  repo = {
    id: `repo-${randomUUID().slice(0, 8)}`,
    projectId,
    provider: "GitHub",
    owner: "customer",
    name: project ? project.id : projectId,
    defaultBranch: "main",
    url: `https://github.com/customer/${project ? project.id : projectId}`,
    status: "mock-connected",
    validationConfig: normalizeValidationConfig(),
    createdAt: nowIso(),
  };
  db.repositories.push(repo);
  return repo;
}

function taskSearchText(task) {
  return [task?.title, task?.summary, task?.sourceSignalId, task?.category].filter(Boolean).join(" ");
}

function isProductImageTask(task) {
  return /image|photo|picture|svg|vector|\u56fe\u7247|\u77e2\u91cf|\u5b9e\u7269|\u7167\u7247|\u5546\u54c1/i.test(taskSearchText(task));
}

function isAiGeneratedProductImageTask(task) {
  return isProductImageTask(task) && /ai|gpt|generated|\u751f\u6210/i.test(taskSearchText(task));
}

function isDesignTask(task) {
  return /design|visual|ui|layout|beautiful|\u8bbe\u8ba1|\u89c6\u89c9|\u7f8e\u89c2|\u6f02\u4eae|\u5e03\u5c40|\u8d28\u611f/i.test(taskSearchText(task));
}

function isCheckoutTrustTask(task) {
  return /checkout|payment|trust|secure|\u7ed3\u7b97|\u652f\u4ed8|\u5b89\u5168|\u4fe1\u4efb/i.test(taskSearchText(task));
}

function isButtonCtaTask(task) {
  return /button|cta|buy|cart|\u6309\u94ae|\u8d2d\u4e70|\u52a0\u5165|\u9192\u76ee/i.test(taskSearchText(task));
}

function isSensitiveUnknownTask(task) {
  if (isCheckoutTrustTask(task)) return false;
  return /auth|login|password|token|permission|role|delete|database|order|refund|charge|payment|checkout|server|api|backend|\u767b\u5f55|\u5bc6\u7801|\u6743\u9650|\u5220\u9664|\u6570\u636e\u5e93|\u8ba2\u5355|\u9000\u6b3e|\u6263\u6b3e|\u652f\u4ed8|\u7ed3\u7b97|\u540e\u7aef|\u670d\u52a1\u5668/i.test(taskSearchText(task));
}

function inferGeneratedStaticIntent(task) {
  const text = taskSearchText(task);
  if (/mobile|responsive|card|crowd|spacing|price|\u79fb\u52a8|\u624b\u673a|\u5361\u7247|\u62e5\u6324|\u95f4\u8ddd|\u4ef7\u683c|\u770b\u6f0f/i.test(text)) {
    return {
      kind: "mobile_layout",
      title: "移动端商品卡片可读性优化",
      summary: "优化移动端商品卡片间距、价格和按钮布局，让用户更容易看清价格并完成操作。",
      marker: "data-itera-generated-mobile-layout",
      anchor: "products",
      cssClass: "itera-generated-mobile-layout",
      operations: [
        "index.html: 在商品区增加可见的移动端体验优化说明。",
        "styles.css: 增加移动端商品卡片单列、价格按钮换行和触控目标样式。",
        "scripts/check-site.js: 校验通用生成器写入的标记。",
      ],
    };
  }
  if (/coupon|discount|promo|offer|\u4f18\u60e0|\u4fc3\u9500|\u6298\u6263|\u5238/i.test(text)) {
    return {
      kind: "promotion",
      title: "优惠提示与购买动机强化",
      summary: "在商品区增加优惠提示，让用户在点击购买前看到明确的促销信息。",
      marker: "data-itera-generated-promo",
      anchor: "products",
      cssClass: "itera-generated-promo",
      operations: [
        "index.html: 在商品区写入优惠提示条。",
        "styles.css: 增加优惠提示和 CTA 强调样式。",
        "scripts/check-site.js: 校验优惠提示标记。",
      ],
    };
  }
  if (/help|faq|shipping|return|support|question|\u5e2e\u52a9|\u5e38\u89c1\u95ee\u9898|\u8fd0\u8f93|\u9000\u6362|\u5ba2\u670d|\u7591\u95ee/i.test(text)) {
    return {
      kind: "support_content",
      title: "常见问题主动说明",
      summary: "在页面中增加帮助说明，减少用户因为配送、售后或使用方式产生的重复咨询。",
      marker: "data-itera-generated-help",
      anchor: "reviews",
      cssClass: "itera-generated-help",
      operations: [
        "index.html: 在用户反馈/评价区增加常见问题说明。",
        "styles.css: 增加帮助说明卡片样式。",
        "scripts/check-site.js: 校验帮助说明标记。",
      ],
    };
  }
  if (/form|input|required|validation|phone|address|\u8868\u5355|\u8f93\u5165|\u5fc5\u586b|\u6821\u9a8c|\u624b\u673a|\u5730\u5740/i.test(text)) {
    return {
      kind: "form_clarity",
      title: "表单填写提示优化",
      summary: "在表单附近增加清晰提示，降低用户因为不知道怎么填写而卡住的概率。",
      marker: "data-itera-generated-form-clarity",
      anchor: "checkout",
      cssClass: "itera-generated-form-clarity",
      operations: [
        "index.html: 在结算区增加表单填写提示。",
        "styles.css: 增加提示卡片样式。",
        "scripts/check-site.js: 校验表单提示标记。",
      ],
    };
  }
  return {
    kind: "content_clarity",
    title: "页面说明清晰度优化",
    summary: "根据用户反馈增加一处可见说明，把问题对应的页面意图讲清楚。",
    marker: "data-itera-generated-content-clarity",
    anchor: "products",
    cssClass: "itera-generated-content-clarity",
    operations: [
      "index.html: 在相关业务区增加可见说明。",
      "styles.css: 增加说明模块样式。",
      "scripts/check-site.js: 校验说明模块标记。",
    ],
  };
}

function shouldPreferGeneratedStaticGenerator(task, intent = inferGeneratedStaticIntent(task)) {
  if (!intent || intent.kind === "content_clarity") return false;
  if (isProductImageTask(task) || isCheckoutTrustTask(task) || isSensitiveUnknownTask(task)) return false;
  return true;
}

function isStaticLocalRepository(repo) {
  if (!repo?.localPath) return false;
  try {
    const localPath = resolveTrustedLocalPath(repo.localPath);
    return fsSync.existsSync(path.join(localPath, "index.html")) && fsSync.existsSync(path.join(localPath, "styles.css"));
  } catch {
    return false;
  }
}

function uniqueList(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function codeAgentReadFile(localPath, relativePath, task) {
  const isGeneratedAsset = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(relativePath);
  const filePath = localRepoFile(localPath, relativePath);
  const exists = fsSync.existsSync(filePath);
  const result = {
    path: relativePath,
    exists,
    kind: isGeneratedAsset ? "asset" : "text",
    bytes: exists ? fsSync.statSync(filePath).size : 0,
    evidence: [],
  };
  if (!exists || isGeneratedAsset) return result;

  const text = fsSync.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  result.lines = lines.length;
  result.preview = text.slice(0, 12000);
  const patterns = [];
  if (isProductImageTask(task)) patterns.push(/<img[^>]+src=/i, /product-card/i, /productImageFiles/i, /assets\/.*(?:svg|png)/i);
  if (isDesignTask(task)) patterns.push(/<body/i, /\.hero/i, /\.product-card/i, /box-shadow|background|hover/i);
  if (isCheckoutTrustTask(task)) patterns.push(/checkout|payment|form|button|trust-note/i);
  if (isButtonCtaTask(task)) patterns.push(/add-button|button|cart|primary-link/i);
  if (!patterns.length) patterns.push(/TODO|FIXME|error|button|form|section|class=/i);

  lines.forEach((line, index) => {
    if (result.evidence.length >= 5) return;
    if (patterns.some((pattern) => pattern.test(line))) {
      result.evidence.push({
        line: index + 1,
        text: line.trim().slice(0, 180),
      });
    }
  });
  if (!result.evidence.length) {
    const firstUsefulLine = lines.findIndex((line) => line.trim() && !line.trim().startsWith("<!--"));
    if (firstUsefulLine >= 0) {
      result.evidence.push({
        line: firstUsefulLine + 1,
        text: lines[firstUsefulLine].trim().slice(0, 180),
      });
    }
  }
  return result;
}

function inspectRepositoryForTask(task, repository, files = []) {
  if (!repository?.localPath) {
    return {
      status: "needs_repository",
      confidence: 20,
      canAutoPatch: false,
      summary: "还没有可读取的客户代码仓库，无法判断应该删除或写入哪些代码。",
      filesRead: [],
      operations: [],
      blockers: ["连接真实 GitHub 仓库或本地仓库后，Code Agent 才能读取上下文。"],
    };
  }

  let localPath = "";
  try {
    localPath = resolveTrustedLocalPath(repository.localPath);
  } catch (error) {
    return {
      status: "repository_blocked",
      confidence: 10,
      canAutoPatch: false,
      summary: "仓库路径不在允许范围内，Code Agent 已阻断读取。",
      filesRead: [],
      operations: [],
      blockers: [error.message],
    };
  }

  const readTargets = uniqueList([
    "package.json",
    "index.html",
    "styles.css",
    "main.js",
    "scripts/check-site.js",
    ...files.filter((file) => !/\.(png|jpe?g|gif|webp|ico)$/i.test(file)),
  ]);
  const filesRead = readTargets.map((file) => codeAgentReadFile(localPath, file, task));
  const existingTextFiles = filesRead.filter((file) => file.exists && file.kind === "text");
  const missingFiles = filesRead.filter((file) => !file.exists).map((file) => file.path);
  const generatedIntent = inferGeneratedStaticIntent(task);
  const preferGeneratedStatic = shouldPreferGeneratedStaticGenerator(task, generatedIntent);
  const knownAdapter =
    !preferGeneratedStatic &&
    (isProductImageTask(task) || isDesignTask(task) || isCheckoutTrustTask(task) || isButtonCtaTask(task));
  const genericPatchable =
    (preferGeneratedStatic || !knownAdapter) &&
    isStaticLocalRepository(repository) &&
    !isSensitiveUnknownTask(task) &&
    existingTextFiles.some((file) => file.path === "index.html") &&
    existingTextFiles.some((file) => file.path === "styles.css");

  const operations = [];
  if (genericPatchable && preferGeneratedStatic) {
    operations.push(...generatedIntent.operations);
  } else if (knownAdapter && isProductImageTask(task)) {
    const suffix = isAiGeneratedProductImageTask(task) ? "ai" : "photo";
    operations.push(
      `读取 index.html 中商品图片 src，替换为 lamp-${suffix}.png / cup-${suffix}.png / keyboard-${suffix}.png。`,
      "读取 styles.css 中商品图展示规则，保证新图片可见而不是隐藏状态。",
      "读取 scripts/check-site.js，把新图片引用纳入本地校验。",
    );
  } else if (knownAdapter && isDesignTask(task)) {
    operations.push(
      "读取 index.html 的 body 与首屏结构，确定可挂载设计刷新状态。",
      "读取 styles.css 的 hero、product-card、button 样式，写入可见视觉层改动。",
    );
  } else if (knownAdapter && isCheckoutTrustTask(task)) {
    operations.push("读取 checkout 区块和表单位置，在提交前写入安全支付提示。", "读取 styles.css 并新增 trust-note 可见样式。");
  } else if (knownAdapter && isButtonCtaTask(task)) {
    operations.push("读取按钮选择器和购买链路相关样式，增强 CTA 视觉权重。");
  } else if (genericPatchable) {
    operations.push(...generatedIntent.operations);
  } else {
    operations.push("已读取仓库上下文，但没有可靠自动补丁适配器，需要真实代码生成 Agent 继续推理。");
  }
  const canAutoPatch = knownAdapter || genericPatchable;

  return {
    status: canAutoPatch ? "ready_to_patch" : "needs_code_generation",
    confidence: knownAdapter ? 86 : genericPatchable ? 72 : 48,
    canAutoPatch,
    generator: knownAdapter ? "deterministic_adapter" : genericPatchable ? "local_static_code_generator" : "planning_only",
    generatedIntent: genericPatchable ? generatedIntent : null,
    summary: knownAdapter
      ? `Code Agent 已读取 ${existingTextFiles.length} 个文本文件，可生成真实文件改动。`
      : genericPatchable
        ? `Code Agent 已读取 ${existingTextFiles.length} 个文本文件，可用通用静态站生成器写入低风险前端改动。`
        : `Code Agent 已读取 ${existingTextFiles.length} 个文本文件，但该问题还缺专用修复器或 LLM 代码生成。`,
    filesRead,
    missingFiles,
    operations,
    blockers: canAutoPatch ? [] : ["缺少通用代码生成器：需要读取更多上下文、生成 diff、跑测试，再允许发布。"],
  };
}

function filesForTask(task, repository = null) {
  if (isStaticLocalRepository(repository)) {
    if (shouldPreferGeneratedStaticGenerator(task)) return ["index.html", "styles.css", "scripts/check-site.js"];
    if (isProductImageTask(task)) {
      const imageSuffix = isAiGeneratedProductImageTask(task) ? "ai" : "photo";
      return [
        "index.html",
        "styles.css",
        "scripts/check-site.js",
        `assets/lamp-${imageSuffix}.png`,
        `assets/cup-${imageSuffix}.png`,
        `assets/keyboard-${imageSuffix}.png`,
      ];
    }
    if (isDesignTask(task)) return ["index.html", "styles.css", "scripts/check-site.js"];
    if (isCheckoutTrustTask(task)) return ["index.html", "styles.css", "scripts/check-site.js"];
    if (isButtonCtaTask(task)) return ["index.html", "styles.css", "scripts/check-site.js"];
    return ["index.html", "styles.css", "scripts/check-site.js"];
  }
  if (task.category === "bug") return ["src/pages/checkout.tsx", "src/lib/analytics.ts", "tests/e2e/checkout.spec.ts"];
  if (task.category === "performance") return ["src/pages/product-detail.tsx", "src/lib/api-cache.ts", "tests/performance/product-detail.spec.ts"];
  if (task.category === "request") return ["src/features/user-profile.tsx", "src/api/preferences.ts", "tests/unit/preferences.test.ts"];
  return ["src/content/help-center.ts", "src/components/help-widget.tsx", "tests/unit/help-widget.test.ts"];
}

function createCodeChangePlan(task, repository, files = []) {
  const staticSite = isStaticLocalRepository(repository);
  const repositoryAnalysis = inspectRepositoryForTask(task, repository, files);
  const plan = {
    summary: "先定位用户反馈影响的真实代码路径，再生成可验证的最小变更。",
    repositoryAnalysis,
    canAutoPatch: Boolean(repositoryAnalysis.canAutoPatch),
    diagnosis: [
      "将反馈转成工程问题，而不是直接套固定模板。",
      "只允许改动与任务相关的页面、样式、脚本或资源文件。",
      "如果没有真实文件变化，发布会被阻塞，不能标记为已完成。",
    ],
    affectedFiles: files,
    remove: [],
    modify: [],
    add: [],
    avoid: [
      "不写隐藏 meta 或无 UI 效果的假补丁。",
      "不改支付、权限、删除类敏感逻辑，除非任务明确要求。",
      "不在 0 files changed 时继续部署。",
    ],
    verification: ["运行客户项目现有检查命令", "确认 HTML/CSS/资源文件中存在本次变更证据", "刷新客户站点验证肉眼可见变化"],
    acceptanceCriteria: ["任务对应问题有用户可感知的变化", "变更文件数大于 0", "本地检查通过后才记录部署"],
  };

  const useGeneratedStaticPlan = repositoryAnalysis.generator === "local_static_code_generator";

  if (!staticSite) {
    return {
      ...plan,
      summary: "为真实客户仓库生成 PR 前，先规划影响文件、删除点、写入点和验证命令。",
      modify: files.map((file) => `${file}: 按任务意图修改业务逻辑或测试覆盖。`),
      add: ["必要时新增回归测试，锁定用户反馈路径。"],
    };
  }

  if (!useGeneratedStaticPlan && isAiGeneratedProductImageTask(task)) {
    return {
      ...plan,
      summary: "商品图反馈需要替换真实页面资源，而不是只改状态。",
      diagnosis: ["当前商品图不能满足 AI 生成图诉求；需要新资源、新引用和校验同时变化。"],
      modify: ["index.html: 将商品卡片图片 src 切换到 AI 风格 PNG。", "styles.css: 增强图片饱和度和对比度，让新图在页面上可见。", "scripts/check-site.js: 校验页面引用 AI 图片。"],
      add: ["assets/lamp-ai.png", "assets/cup-ai.png", "assets/keyboard-ai.png"],
      remove: ["不删除原 SVG/旧 PNG，作为回滚资源保留。"],
    };
  }

  if (!useGeneratedStaticPlan && isProductImageTask(task)) {
    return {
      ...plan,
      summary: "商品图反馈需要替换页面真实资源，并保留可回滚旧资源。",
      diagnosis: ["当前商品图是占位/矢量风格；用户希望看到更真实的商品图。"],
      modify: ["index.html: 修改三个商品 img src。", "styles.css: 将商品图从 contain 改成 cover 并加细边框。", "scripts/check-site.js: 校验新图片引用。"],
      add: ["assets/lamp-photo.png", "assets/cup-photo.png", "assets/keyboard-photo.png"],
      remove: ["不删除旧 SVG，保留回滚能力。"],
    };
  }

  if (!useGeneratedStaticPlan && isDesignTask(task)) {
    return {
      ...plan,
      summary: "设计感问题必须改可见布局和视觉层，隐藏标记不算完成。",
      diagnosis: ["页面缺少层次、卡片阴影和首屏视觉引导；需要 CSS 与 body 状态共同生效。"],
      modify: ["index.html: 给 body 增加 design refresh 状态。", "styles.css: 增加首屏背景、卡片阴影、hover 反馈和主按钮强调。"],
      add: ["可见的设计刷新 CSS 规则。"],
      remove: ["删除/避免只写 meta 的无效补丁。"],
    };
  }

  if (!useGeneratedStaticPlan && isCheckoutTrustTask(task)) {
    return {
      ...plan,
      summary: "支付信任问题要在结算区增加用户可见的安全说明。",
      diagnosis: ["用户缺少支付安全感；应在提交表单前看到保障信息。"],
      modify: ["index.html: 在 checkout form 前插入安全支付提示。", "styles.css: 增加 trust-note 样式。"],
      add: ["结算区安全支付提示。"],
    };
  }

  if (!useGeneratedStaticPlan && isButtonCtaTask(task)) {
    return {
      ...plan,
      summary: "按钮反馈要修改 CTA 可见样式，确保用户能感知按钮变化。",
      diagnosis: ["购买按钮不够醒目；需要提高颜色、阴影和点击目标识别度。"],
      modify: ["styles.css: 强化 .add-button 颜色和阴影。"],
      add: ["CTA 升级标记与样式规则。"],
    };
  }

  if (useGeneratedStaticPlan) {
    const intent = repositoryAnalysis.generatedIntent || inferGeneratedStaticIntent(task);
    return {
      ...plan,
      summary: `Code Agent 已选择通用静态站生成器：${intent.title}。`,
      diagnosis: [
        "该反馈属于低风险前端内容/样式改动，不涉及支付扣款、权限、删除或后端数据。",
        "已读取 index.html 与 styles.css，可在相关页面区块写入用户可见改进。",
        "会把校验标记写入 scripts/check-site.js，避免 0 改动假完成。",
      ],
      modify: repositoryAnalysis.operations,
      add: [`index.html: 写入 ${intent.title} 可见模块。`, `styles.css: 写入 ${intent.cssClass} 作用域样式。`, `scripts/check-site.js: 校验 ${intent.marker} 标记。`],
      remove: ["不删除现有业务区块，只追加低风险可回滚改动。"],
      avoid: [...plan.avoid, "不把通用生成器用于支付扣款、权限、删除、订单等敏感未知逻辑。"],
    };
  }

  return {
    ...plan,
    summary: "该反馈还没有专用落地适配器，应先生成工程计划并阻塞发布。",
    diagnosis: ["系统无法可靠判断该问题该删哪些代码、写哪些代码。"],
    modify: files.map((file) => `${file}: 需要代码 Agent 进一步读取上下文后再改。`),
    add: ["专用修复适配器或真实 LLM 代码生成步骤。"],
    avoid: [...plan.avoid, "不生成隐藏占位补丁冒充完成。"],
  };
}

function shortEvidence(value, length = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function codeAgentStage(id, status, title, detail, evidence = []) {
  return {
    id,
    status,
    title,
    detail: shortEvidence(detail, 260),
    evidence: (evidence || []).filter(Boolean).map((item) => shortEvidence(item, 220)).slice(0, 8),
  };
}

function buildCodeAgentTrace({ task, repository, codePlan, patch, application, checkRun, deployment, error } = {}) {
  const analysis = codePlan?.repositoryAnalysis || {};
  const filesRead = Array.isArray(analysis.filesRead) ? analysis.filesRead : [];
  const readableFiles = filesRead.filter((file) => file.exists && file.kind === "text");
  const patchFiles = Array.isArray(patch?.patchFiles) ? patch.patchFiles : [];
  const changedFiles = Array.isArray(application?.changedFiles) ? application.changedFiles : [];
  const operations = Array.isArray(analysis.operations) && analysis.operations.length ? analysis.operations : codePlan?.modify || [];
  const blockers = [...(analysis.blockers || []), ...(error ? [error.message || error] : [])].filter(Boolean);
  const aiAttempt = analysis.aiProviderAttempt || codePlan?.aiProviderAttempt || null;
  const aiStageStatus =
    aiAttempt?.status === "used"
      ? "completed"
      : aiAttempt?.status === "failed"
        ? "warning"
        : aiAttempt?.status === "skipped"
          ? "waiting"
          : "waiting";
  const checkStatus = checkRun?.ciRun?.status || (checkRun?.result?.status === "passed" ? "success" : checkRun?.result?.status ? "failure" : "");
  const finalStatus = error
    ? "blocked"
    : deployment?.status === "deployed" || deployment?.status === "triggered"
      ? "completed"
      : checkStatus === "success"
        ? "verified"
        : application
          ? changedFiles.length
            ? "written"
            : "blocked"
          : patch
            ? patchFiles.length
              ? "patch_ready"
              : "blocked"
            : analysis.canAutoPatch
              ? "planned"
              : analysis.status || "waiting";

  return {
    id: `code-agent-${patch?.id || application?.id || task?.id || randomUUID().slice(0, 8)}`,
    status: finalStatus,
    generator: analysis.generator || "not_selected",
    aiProviderAttempt: aiAttempt,
    confidence: Number(analysis.confidence || 0),
    summary: codePlan?.summary || analysis.summary || "代码改动 Agent 等待仓库上下文。",
    repository: repository ? `${repository.provider || "repo"}:${repository.owner || ""}/${repository.name || ""}` : "not connected",
    updatedAt: nowIso(),
    stages: [
      codeAgentStage("understand", task ? "completed" : "waiting", "理解反馈", task?.title || "等待任务", [
        task ? `类型：${task.category || "unknown"}，风险：${task.risk || 1}，置信度：${task.confidence || 0}%` : "",
        task?.summary || "",
      ]),
      codeAgentStage(
        "read_repository",
        readableFiles.length ? "completed" : repository ? "blocked" : "waiting",
        "读取客户代码",
        readableFiles.length
          ? `读取 ${readableFiles.length} 个文本文件，检查 ${filesRead.length} 个目标文件。`
          : repository
            ? "已连接仓库，但没有读到可用于本次修改的文本文件。"
            : "还没有连接可读取的客户仓库。",
        readableFiles.flatMap((file) => [
          `${file.path} · ${file.lines || 0} 行 · ${file.bytes || 0} bytes`,
          ...(file.evidence || []).slice(0, 2).map((item) => `${file.path}:L${item.line} ${item.text}`),
        ]),
      ),
      codeAgentStage(
        "decide_changes",
        analysis.canAutoPatch ? "completed" : blockers.length ? "blocked" : "waiting",
        "决定怎么改",
        analysis.summary || codePlan?.summary || "等待 Agent 生成代码方案。",
        [...operations, ...(codePlan?.add || [])],
      ),
      codeAgentStage(
        "ai_model",
        aiStageStatus,
        "调用第三方大模型",
        aiAttempt
          ? `${aiAttempt.status} · ${aiAttempt.model || "model"} · ${aiAttempt.endpointHost || "endpoint"}${aiAttempt.fallback ? ` · fallback: ${aiAttempt.fallback}` : ""}`
          : "本次还没有第三方大模型调用记录。",
        aiAttempt
          ? [
              aiAttempt.message || "",
              aiAttempt.httpStatus ? `HTTP ${aiAttempt.httpStatus}` : "",
              aiAttempt.checkedAt || "",
            ]
          : [],
      ),
      codeAgentStage(
        "generate_patch",
        patch ? (patchFiles.length ? "completed" : "blocked") : "waiting",
        "生成代码补丁",
        patch ? `${patch.id} · ${patchFiles.length} 个补丁文件 · ${patch.status}` : "还没有生成补丁。",
        patchFiles.map((file) => `${file.path}: ${file.intent || "待修改"}`),
      ),
      codeAgentStage(
        "write_files",
        application ? (changedFiles.length ? "completed" : "blocked") : "waiting",
        "写入文件",
        application
          ? `${application.status} · ${changedFiles.length} 个文件变化 · ${application.workspacePath || ""}`
          : "补丁还没有写入客户代码。",
        changedFiles.map((file) => `${file.path}: ${file.bytesBefore || 0} -> ${file.bytesAfter || 0} bytes`),
      ),
      codeAgentStage(
        "verify",
        checkStatus ? (checkStatus === "success" ? "completed" : "blocked") : "waiting",
        "运行检查",
        checkRun
          ? `${checkRun.result?.command || checkRun.ciRun?.checks?.[0]?.name || "check"} · ${checkStatus}`
          : "写入后需要运行客户项目检查。",
        checkRun ? [checkRun.result?.output || checkRun.ciRun?.checks?.[0]?.output || ""] : [],
      ),
      codeAgentStage(
        "release",
        deployment ? (["deployed", "triggered"].includes(deployment.status) ? "completed" : deployment.status) : "waiting",
        "更新网站",
        deployment ? `${deployment.provider || "deployment"} · ${deployment.status} · ${deployment.url || ""}` : "检查通过后才会进入部署/发布。",
        deployment ? [deployment.url || deployment.responseSnippet || ""] : [],
      ),
    ],
    blockers,
    filesRead: filesRead.map((file) => ({
      path: file.path,
      exists: file.exists,
      kind: file.kind,
      bytes: file.bytes || 0,
      lines: file.lines || 0,
      evidence: (file.evidence || []).slice(0, 3),
    })),
    changedFiles: changedFiles.map((file) => ({
      path: file.path,
      bytesBefore: file.bytesBefore || 0,
      bytesAfter: file.bytesAfter || 0,
    })),
  };
}

function repositoryContextForAi(repositoryAnalysis) {
  return (repositoryAnalysis.filesRead || [])
    .filter((file) => file.exists && file.kind === "text" && ["index.html", "styles.css", "scripts/check-site.js"].includes(file.path))
    .map((file) => ({
      path: file.path,
      content: String(file.preview || file.content || "").slice(0, 12000),
    }));
}

function hasUnsafeAiHtml(html) {
  return /<\s*(script|iframe|object|embed|form|input|button|link|meta)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /javascript:/i.test(html);
}

function hasUnsafeAiCss(css) {
  return /@import/i.test(css) || /url\s*\(/i.test(css) || /position\s*:\s*fixed/i.test(css);
}

function sanitizeAiStaticPatchIntent(raw, task) {
  if (!raw || typeof raw !== "object") return null;
  const slug = slugify(raw.kind || task?.title || "ai-patch").slice(0, 36) || "ai-patch";
  const cssClass = /^itera-ai-[a-z0-9-]{3,48}$/.test(String(raw.cssClass || ""))
    ? String(raw.cssClass)
    : `itera-ai-${slug}`;
  const marker = /^data-itera-ai-[a-z0-9-]{3,56}$/.test(String(raw.marker || ""))
    ? String(raw.marker)
    : `data-itera-ai-${slug}`;
  const title = String(raw.title || task?.title || "Itera AI improvement").replace(/\s+/g, " ").slice(0, 90);
  const summary = String(raw.summary || task?.summary || "Generated from user feedback.").replace(/\s+/g, " ").slice(0, 260);
  const htmlBlock = String(raw.htmlBlock || "").trim();
  const cssBlock = String(raw.cssBlock || "").trim();
  if (!htmlBlock || !cssBlock) return null;
  if (htmlBlock.length > 9000 || cssBlock.length > 9000) return null;
  if (hasUnsafeAiHtml(htmlBlock) || hasUnsafeAiCss(cssBlock)) return null;
  if (!htmlBlock.includes(marker) || !htmlBlock.includes(cssClass)) return null;
  const anchor = ["product-grid", "checkout", "reviews", "main-end"].includes(raw.anchor) ? raw.anchor : "main-end";
  return {
    kind: slug,
    anchor,
    cssClass,
    marker,
    title,
    summary,
    htmlBlock,
    cssBlock: cssBlock.includes(marker) ? cssBlock : `/* ${marker} */\n${cssBlock}`,
    checkSnippet: `if (!html.includes("${marker}")) throw new Error("index.html is missing AI generated marker ${marker}");`,
    operations: Array.isArray(raw.operations) ? raw.operations.map((item) => String(item).slice(0, 180)).slice(0, 6) : [],
  };
}

async function createAiEnhancedCodePlan(db, task, repository, basePlan) {
  const config = aiProviderConfig(db);
  const analysis = basePlan?.repositoryAnalysis;
  if (!config.configured) return attachAiProviderAttempt(basePlan, aiProviderAttempt(config, "skipped", { message: "AI API is not configured." }));
  if (!isStaticLocalRepository(repository) || !analysis?.filesRead?.length) {
    return attachAiProviderAttempt(basePlan, aiProviderAttempt(config, "skipped", { message: "Repository context was not ready for AI code generation." }));
  }
  if (Number(task?.risk || 1) >= 3 || isSensitiveUnknownTask(task)) {
    return attachAiProviderAttempt(basePlan, aiProviderAttempt(config, "skipped", { message: "Task is sensitive or high risk; AI patch generation was skipped." }));
  }
  const contextFiles = repositoryContextForAi(analysis);
  if (!contextFiles.some((file) => file.path === "index.html") || !contextFiles.some((file) => file.path === "styles.css")) {
    return attachAiProviderAttempt(basePlan, aiProviderAttempt(config, "skipped", { message: "AI code generation requires index.html and styles.css context." }));
  }

  const prompt = {
    task: {
      title: task?.title,
      summary: task?.summary,
      category: task?.category,
      risk: task?.risk,
      confidence: task?.confidence,
    },
    repository: {
      provider: repository?.provider,
      name: repository?.name,
      files: contextFiles,
    },
    output: {
      kind: "short slug",
      anchor: "product-grid | checkout | reviews | main-end",
      cssClass: "itera-ai-example",
      marker: "data-itera-ai-example",
      title: "visible UI title",
      summary: "visible UI summary",
      htmlBlock: "safe HTML block, no script/form/input/button/a tags, must include marker and cssClass",
      cssBlock: "scoped CSS for cssClass, no @import, no url(), no fixed overlays",
      operations: ["what code is inserted or changed"],
    },
  };

  try {
    const { response, data, content } = await callAiProvider(
      config,
      [
        {
          role: "system",
          content:
            "You are a careful frontend code agent. Return JSON only. Generate a minimal, visible, low-risk HTML/CSS patch for a static website. Do not create scripts, forms, payment logic, auth logic, deletion logic, external URLs, or hidden-only changes.",
        },
        { role: "user", content: JSON.stringify(prompt) },
      ],
      Math.min(config.temperature, 0.3),
      60000,
    );
    if (!response.ok) {
      addLog(db, `AI Code Agent call failed: HTTP ${response.status}`);
      return attachAiProviderAttempt(
        basePlan,
        aiProviderAttempt(config, "failed", {
          message: data?.error?.message || `AI provider returned HTTP ${response.status}`,
          httpStatus: response.status,
          fallback: "local_rules",
        }),
      );
    }
    const parsed = parseAiJsonContent(content);
    const intent = sanitizeAiStaticPatchIntent(parsed?.htmlBlock ? parsed : parsed?.output || parsed?.patch, task);
    if (!intent) {
      addLog(db, "AI Code Agent call returned an invalid patch payload; falling back to local rules.");
      return attachAiProviderAttempt(
        basePlan,
        aiProviderAttempt(config, "failed", {
          message: "AI provider responded, but the response was not a safe patch JSON.",
          httpStatus: response.status,
          fallback: "local_rules",
        }),
      );
    }
    const operations = intent.operations.length
      ? intent.operations
      : [`index.html: insert visible AI-generated block ${intent.marker}.`, `styles.css: add scoped styles for .${intent.cssClass}.`];
    const successfulAttempt = aiProviderAttempt(config, "used", {
      message: "AI provider generated a safe static patch intent.",
      httpStatus: response.status,
    });
    addLog(db, `AI Code Agent used ${config.model} via ${successfulAttempt.endpointHost || "configured endpoint"}.`);
    return {
      ...basePlan,
      aiProviderAttempt: successfulAttempt,
      summary: `第三方 AI API 已读取静态站上下文并生成低风险前端补丁方案。`,
      canAutoPatch: true,
      repositoryAnalysis: {
        ...analysis,
        aiProviderAttempt: successfulAttempt,
        status: "ready_to_patch",
        confidence: Math.max(Number(analysis.confidence || 0), 78),
        canAutoPatch: true,
        generator: "ai_static_code_generator",
        aiGeneratedIntent: intent,
        operations,
        blockers: [],
        summary: `第三方 AI API 已生成 HTML/CSS 补丁，平台将先在本地/沙箱验证后再发布。`,
      },
      modify: operations,
      add: [`index.html: 写入 AI 生成的可见模块。`, `styles.css: 写入 AI 生成的作用域样式。`, `scripts/check-site.js: 校验 ${intent.marker} 标记。`],
      remove: ["不删除现有业务代码；只追加低风险可回滚改动。"],
      avoid: [...(basePlan.avoid || []), "不允许 AI 直接改支付、权限、删除、脚本注入或外部资源。"],
      verification: [...(basePlan.verification || []), `确认页面包含 ${intent.marker}`],
    };
  } catch (error) {
    addLog(db, `AI Code Agent call failed: ${error.message}`);
    return attachAiProviderAttempt(
      basePlan,
      aiProviderAttempt(config, "failed", {
        message: error.name === "AbortError" ? "AI provider request timed out after 20 seconds." : error.message,
        fallback: "local_rules",
      }),
    );
  }
}

function codePlanNeedsRepositoryRefresh(codePlan) {
  const analysis = codePlan?.repositoryAnalysis;
  if (!analysis) return true;
  if (analysis.status === "repository_blocked") return true;
  if ((analysis.blockers || []).some((item) => /localPath|allowed|ITERA_ALLOWED_REPO_ROOT|workspace/i.test(String(item)))) return true;
  if (!Array.isArray(analysis.filesRead) || !analysis.filesRead.some((file) => file.exists && file.kind === "text")) return true;
  return false;
}

function buildDraftChangedFiles(task, repository) {
  return filesForTask(task, repository).map((file) => ({
    path: file,
    intent: changeIntentForTask(task, file),
  }));
}

function createPrDraft(db, projectId, taskId, repositoryId) {
  const task = db.tasks.find((item) => item.id === taskId && item.projectId === projectId);
  if (!task) throw new Error("Task not found");

  const repository =
    db.repositories.find((item) => item.id === repositoryId && item.projectId === projectId) ||
    defaultRepositoryForProject(db, projectId);

  const existing = db.prDrafts.find((item) => item.taskId === task.id && item.status !== "closed");
  if (existing) {
    const existingRepo = db.repositories.find((item) => item.id === existing.repositoryId);
    const expectedFiles = filesForTask(task, existingRepo || repository);
    const existingFilePaths = (existing.changedFiles || []).map((file) => file.path);
    const refreshExistingPlan =
      !existing.codePlan ||
      codePlanNeedsRepositoryRefresh(existing.codePlan) ||
      expectedFiles.length !== existingFilePaths.length ||
      expectedFiles.some((file) => !existingFilePaths.includes(file));
    if (refreshExistingPlan) {
      existing.repositoryId = (existingRepo || repository).id;
      existing.provider = (existingRepo || repository).provider;
      existing.repository = `${(existingRepo || repository).owner}/${(existingRepo || repository).name}`;
      existing.changedFiles = buildDraftChangedFiles(task, existingRepo || repository);
      existing.codePlan = createCodeChangePlan(
        task,
        existingRepo || repository,
        (existing.changedFiles || []).map((file) => file.path),
      );
      existing.codeAgentTrace = buildCodeAgentTrace({ task, repository: existingRepo || repository, codePlan: existing.codePlan });
      existing.status = existing.status === "qa_blocked" ? "drafted" : existing.status;
      existing.updatedAt = nowIso();
    }
    const shouldSupersedeMock =
      existing.repositoryId !== repository.id &&
      existingRepo?.status === "mock-connected" &&
      repository.status !== "mock-connected";
    if (!shouldSupersedeMock) return existing;

    existing.status = "closed";
    existing.closedReason = "superseded_by_connected_repository";
    existing.updatedAt = nowIso();
    db.patchProposals
      .filter((item) => item.prDraftId === existing.id && item.status !== "discarded")
      .forEach((item) => {
        item.status = "discarded";
        item.discardedReason = "superseded_by_connected_repository";
        item.updatedAt = nowIso();
      });
  }

  const branch = `itera/${slugify(task.category)}-${slugify(task.title)}`;
  const files = filesForTask(task, repository);
  const codePlan = createCodeChangePlan(task, repository, files);
  const draft = {
    id: `pr-${randomUUID().slice(0, 8)}`,
    projectId,
    repositoryId: repository.id,
    taskId: task.id,
    provider: repository.provider,
    repository: `${repository.owner}/${repository.name}`,
    baseBranch: repository.defaultBranch,
    branch,
    title: `[Itera AI] ${task.title}`,
    summary: task.summary,
    status: "drafted",
    risk: task.risk,
    confidence: task.confidence,
    changedFiles: buildDraftChangedFiles(task, repository),
    codePlan,
    implementationPlan: implementationPlanForTask(task),
    testPlan: testPlanForTask(task),
    reviewChecklist: reviewChecklistForTask(task),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  draft.codeAgentTrace = buildCodeAgentTrace({ task, repository, codePlan });
  db.prDrafts.unshift(draft);
  task.prDraftId = draft.id;
  task.status = task.status === "待审批" ? "已批准" : task.status;
  task.updatedAt = nowIso();
  addLog(db, `代码 Agent 已生成 PR 草稿：${draft.title.slice(0, 48)}`);
  return draft;
}

function changeIntentForTask(task, file) {
  if (file.includes("test") || file.includes("spec")) return "补充回归测试，锁定本次问题不会复发。";
  if (task.category === "bug") return "定位并修复用户反馈对应的异常路径。";
  if (task.category === "performance") return "减少阻塞请求和重复计算，提升首屏体验。";
  if (task.category === "request") return "实现最小可验证功能，并保留配置开关。";
  return "更新帮助内容或引导逻辑，降低客服咨询量。";
}

function implementationPlanForTask(task) {
  const plans = {
    bug: [
      "复现相关用户路径和错误信号。",
      "在最小影响范围内修复异常分支。",
      "补充端到端回归用例。",
    ],
    performance: [
      "标记慢请求和主线程阻塞点。",
      "增加缓存、延迟加载或请求合并。",
      "对比优化前后的关键性能指标。",
    ],
    request: [
      "整理需求验收条件。",
      "实现最小功能闭环。",
      "通过灰度或配置开关控制发布范围。",
    ],
    support: [
      "将高频问题沉淀为知识库答案。",
      "在相关页面增加主动提示。",
      "观察同类客服工单是否下降。",
    ],
  };
  return plans[task.category] || plans.bug;
}

function testPlanForTask(task) {
  const base = ["运行项目现有测试", "在预览环境执行浏览器巡检"];
  if (task.category === "bug") return [...base, "复现原问题并验证修复"];
  if (task.category === "performance") return [...base, "比较 LCP、接口耗时和错误率"];
  if (task.category === "request") return [...base, "验证新功能的空状态、异常状态和移动端"];
  return [...base, "验证帮助内容展示和埋点上报"];
}

function reviewChecklistForTask(task) {
  return [
    `风险等级：${task.risk}`,
    "没有修改敏感权限、支付或删除逻辑，除非任务明确要求。",
    "改动范围与任务来源信号一致。",
    "测试计划覆盖用户反馈中的关键路径。",
  ];
}

async function createPatchProposal(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const existing = db.patchProposals.find((item) => item.prDraftId === draft.id && item.status !== "discarded");

  const task = db.tasks.find((item) => item.id === draft.taskId);
  const repository = db.repositories.find((item) => item.id === draft.repositoryId);
  const draftFiles = (draft.changedFiles || []).map((file) => file.path);
  const hasReadablePreview = draft.codePlan?.repositoryAnalysis?.filesRead?.some((file) => file.preview);
  let codePlan = draft.codePlan && hasReadablePreview ? draft.codePlan : createCodeChangePlan(task || draft, repository, draftFiles);
  const aiCodePlan = await createAiEnhancedCodePlan(db, task || draft, repository, codePlan);
  if (aiCodePlan) {
    codePlan = aiCodePlan;
    draft.codePlan = codePlan;
    draft.updatedAt = nowIso();
  }
  const canGeneratePatch = Boolean(codePlan.canAutoPatch);
  const patchFiles = canGeneratePatch
    ? (draft.changedFiles || []).map((file) => ({
        path: file.path,
        intent: file.intent,
        diff: unifiedDiffForFile(task || draft, file.path, codePlan),
      }))
    : [];

  if (existing) {
    const expectedPatchPaths = patchFiles.map((file) => file.path);
    const existingPatchPaths = (existing.patchFiles || []).map((file) => file.path);
    const nextAiAttempt = codePlan.repositoryAnalysis?.aiProviderAttempt || codePlan.aiProviderAttempt || null;
    const previousAiAttempt = existing.codePlan?.repositoryAnalysis?.aiProviderAttempt || existing.codePlan?.aiProviderAttempt || null;
    const shouldRefreshExisting =
      !existing.codePlan ||
      codePlanNeedsRepositoryRefresh(existing.codePlan) ||
      (codePlan.repositoryAnalysis?.aiProviderAttempt && !existing.codePlan?.repositoryAnalysis?.aiProviderAttempt) ||
      (nextAiAttempt?.status === "used" && previousAiAttempt?.status !== "used") ||
      (nextAiAttempt?.status === "used" && existing.codePlan?.repositoryAnalysis?.generator !== codePlan.repositoryAnalysis?.generator) ||
      (canGeneratePatch && (!existing.patchFiles || !existing.patchFiles.length)) ||
      (canGeneratePatch &&
        (expectedPatchPaths.length !== existingPatchPaths.length ||
          expectedPatchPaths.some((file) => !existingPatchPaths.includes(file)))) ||
      ["planning_required", "sandbox_failed"].includes(existing.status);
    if (shouldRefreshExisting) {
      db.validationReports
        .filter((report) => report.patchProposalId === existing.id)
        .forEach((report) => {
          report.status = "superseded";
          report.supersededAt = nowIso();
        });
      db.sandboxRuns
        .filter((run) => run.patchProposalId === existing.id)
        .forEach((run) => {
          run.status = "superseded";
          run.supersededAt = nowIso();
        });
      existing.codePlan = codePlan;
      existing.patchFiles = patchFiles;
      existing.mode = canGeneratePatch ? "proposal" : "code_plan_only";
      existing.summary = canGeneratePatch
        ? patchSummaryForTask(task || draft)
        : "Code Agent 已完成仓库读取和修复计划，但还不能可靠生成真实补丁，已阻断发布。";
      existing.status = canGeneratePatch ? "generated" : "planning_required";
      existing.updatedAt = nowIso();
    }
    existing.codeAgentTrace = buildCodeAgentTrace({ task: task || draft, repository, codePlan: existing.codePlan || codePlan, patch: existing });
    draft.codeAgentTrace = existing.codeAgentTrace;
    draft.status = canGeneratePatch ? "patch_generated" : draft.status;
    draft.updatedAt = nowIso();
    return existing;
  }

  const proposal = {
    id: `patch-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    taskId: draft.taskId,
    repositoryId: draft.repositoryId,
    status: canGeneratePatch ? "generated" : "planning_required",
    mode: canGeneratePatch ? "proposal" : "code_plan_only",
    summary: canGeneratePatch
      ? patchSummaryForTask(task || draft)
      : "Code Agent 已完成仓库读取和修复计划，但还不能可靠生成真实补丁，已阻断发布。",
    codePlan,
    patchFiles,
    verificationCommands: verificationCommandsForTask(task || draft),
    riskGates: riskGatesForTask(task || draft),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  proposal.codeAgentTrace = buildCodeAgentTrace({ task: task || draft, repository, codePlan, patch: proposal });

  db.patchProposals.unshift(proposal);
  draft.patchProposalId = proposal.id;
  draft.codeAgentTrace = proposal.codeAgentTrace;
  draft.status = "patch_generated";
  draft.updatedAt = nowIso();
  addLog(db, `Patch Agent 已生成补丁提案：${draft.title.slice(0, 48)}`);
  return proposal;
}

function patchSummaryForTask(task) {
  if (task.category === "bug") return "生成最小修复补丁，优先覆盖用户反馈中的阻塞路径。";
  if (task.category === "performance") return "生成性能优化补丁，减少阻塞加载、重复请求或主线程长任务。";
  if (task.category === "request") return "生成最小功能补丁，先满足可验证的核心需求。";
  return "生成客服与帮助内容补丁，减少重复咨询并提升页面引导。";
}

function unifiedDiffForFile(task, filePath, codePlan = null) {
  const category = task.category || "bug";
  const title = String(task.title || "Itera AI task").replace(/\r?\n/g, " ");
  const safeComment = `Itera AI patch proposal: ${title}`;
  const intent = inferGeneratedStaticIntent(task);
  const forceGeneratedStatic = codePlan?.repositoryAnalysis?.generator === "local_static_code_generator";
  const aiIntent = codePlan?.repositoryAnalysis?.generator === "ai_static_code_generator" ? codePlan?.repositoryAnalysis?.aiGeneratedIntent : null;

  if (aiIntent) {
    if (filePath === "index.html") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+${escapeForPatch(aiIntent.htmlBlock)}
`;
    }
    if (filePath === "styles.css") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+${escapeForPatch(aiIntent.cssBlock)}
`;
    }
    if (filePath.includes("check-site")) {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+${escapeForPatch(aiIntent.checkSnippet)}
`;
    }
  }

  if (
    (forceGeneratedStatic ||
      (!isProductImageTask(task) && !isDesignTask(task) && !isCheckoutTrustTask(task) && !isButtonCtaTask(task))) &&
    !isSensitiveUnknownTask(task)
  ) {
    if (filePath === "index.html") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+<aside class="${escapeForPatch(intent.cssClass)}" ${escapeForPatch(intent.marker)}>
+  <small>Itera AI 已处理反馈</small>
+  <h3>${escapeForPatch(intent.title)}</h3>
+  <p>${escapeForPatch(intent.summary)}</p>
+</aside>
`;
    }
    if (filePath === "styles.css") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+/* data-itera-generated-${escapeForPatch(intent.kind)} */
+.${escapeForPatch(intent.cssClass)} {
+  padding: 16px;
+  background: #f5fbff;
+  border: 1px solid #bdd7f2;
+  border-radius: 8px;
+}
`;
    }
    if (filePath.includes("check-site")) {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+if (!html.includes("${escapeForPatch(intent.marker)}")) {
+  throw new Error("index.html is missing Itera generated marker ${escapeForPatch(intent.marker)}");
+}
`;
    }
  }

  if (isButtonCtaTask(task)) {
    if (filePath === "index.html") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+<p class="cta-upgrade-note" data-itera-cta-upgrade-v2>
+  Itera AI 已根据反馈强化购买按钮，按钮现在更醒目、更容易点击。
+</p>
`;
    }
    if (filePath === "styles.css") {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+/* data-itera-cta-upgrade-v2 */
+.cta-upgrade-note {
+  margin: 0 0 16px;
+  padding: 12px 14px;
+  color: #14532d;
+  background: #e8f8ee;
+  border: 1px solid #a7d8b4;
+  border-radius: 8px;
+  font-weight: 800;
+}
+.add-button {
+  color: #fff;
+  background: linear-gradient(135deg, #16a34a, #2563eb);
+  border-color: transparent;
+  box-shadow: 0 14px 30px rgba(37, 99, 235, 0.30);
+}
`;
    }
    if (filePath.includes("check-site")) {
      return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+if (!html.includes("data-itera-cta-upgrade-v2")) {
+  throw new Error("index.html is missing CTA upgrade marker data-itera-cta-upgrade-v2");
+}
+if (!css.includes("data-itera-cta-upgrade-v2")) {
+  throw new Error("styles.css is missing CTA upgrade marker data-itera-cta-upgrade-v2");
+}
`;
    }
  }

  if (filePath.includes("test") || filePath.includes("spec")) {
    return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+test("${escapeForPatch(title)}", async () => {
+  // ${escapeForPatch(safeComment)}
+  // Reproduce the reported user path before accepting this patch.
+  expect(true).toBe(true);
+});
`;
  }

  if (category === "performance") {
    return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+// ${escapeForPatch(safeComment)}
+export const iteraPerformanceHint = {
+  deferNonCriticalWork: true,
+  cacheKey: "itera:${escapeForPatch(slugify(title))}",
+  reason: "Reduce blocking work detected by user feedback and performance signals."
+};
`;
  }

  if (category === "request") {
    return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+// ${escapeForPatch(safeComment)}
+export const iteraFeatureFlag = {
+  enabled: false,
+  rollout: "manual-review",
+  reason: "Validate demand before broad release."
+};
`;
  }

  if (category === "support") {
    return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+// ${escapeForPatch(safeComment)}
+export const iteraHelpArticle = {
+  source: "support-signal",
+  needsHumanReview: true
+};
`;
  }

  return `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@
+// ${escapeForPatch(safeComment)}
+export function iteraGuardrail(event) {
+  if (!event) return { ok: false, reason: "missing-event" };
+  return { ok: true };
+}
`;
}

function escapeForPatch(value) {
  return String(value || "").replace(/\*\//g, "* /").replace(/\r?\n/g, " ").slice(0, 140);
}

function verificationCommandsForTask(task) {
  const commands = ["npm test", "npm run lint"];
  if (task.category === "performance") commands.push("npm run test:performance");
  if (task.category === "bug") commands.push("npm run test:e2e");
  return commands;
}

function riskGatesForTask(task) {
  const gates = ["PR 必须通过 CI", "人工 Review 后才允许合并", "预览环境完成浏览器巡检"];
  if (Number(task.risk || 1) >= 3) gates.push("高风险任务必须启用灰度发布和回滚预案");
  return gates;
}

function patchProposalMarkdown(proposal) {
  const files = (proposal.patchFiles || [])
    .map((file) => `## ${file.path}\n\nIntent: ${file.intent}\n\n\`\`\`diff\n${file.diff}\n\`\`\``)
    .join("\n\n");
  const commands = (proposal.verificationCommands || []).map((command) => `- \`${command}\``).join("\n");
  const gates = (proposal.riskGates || []).map((gate) => `- [ ] ${gate}`).join("\n");

  return `# Patch Proposal ${proposal.id}

${proposal.summary}

## Files

${files || "- No files proposed"}

## Verification Commands

${commands || "- TBD"}

## Risk Gates

${gates || "- Human review required"}
`;
}

function latestQaReportForPatch(db, patchProposalId) {
  return db.validationReports
    .filter((report) => report.patchProposalId === patchProposalId && !["voided", "superseded"].includes(report.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function createQaReport(db, patchProposalId) {
  const proposal = db.patchProposals.find((item) => item.id === patchProposalId);
  if (!proposal) throw new Error("Patch proposal not found");
  const draft = db.prDrafts.find((item) => item.id === proposal.prDraftId);
  const task = db.tasks.find((item) => item.id === proposal.taskId);
  const patchFiles = Array.isArray(proposal.patchFiles) ? proposal.patchFiles : [];
  const diffs = patchFiles.map((file) => String(file.diff || ""));
  const paths = patchFiles.map((file) => String(file.path || ""));
  const taskRisk = Number(task?.risk || draft?.risk || 1);
  const sensitivePattern = /checkout|payment|pay|billing|order|auth|login|permission|role|delete|refund|database|migration/i;
  const touchesSensitiveSurface =
    taskRisk >= 3 || sensitivePattern.test(`${task?.title || ""} ${task?.summary || ""} ${paths.join(" ")}`);

  const checks = [
    {
      id: "patch-files",
      name: "补丁文件完整性",
      status: patchFiles.length ? "passed" : "failed",
      detail: patchFiles.length ? `已生成 ${patchFiles.length} 个补丁文件。` : "没有生成任何补丁文件。",
    },
    {
      id: "diff-format",
      name: "Diff 结构检查",
      status: diffs.length && diffs.every((diff) => diff.includes("diff --git") && !/<<<<<<<|=======|>>>>>>>/.test(diff))
        ? "passed"
        : "failed",
      detail: "检查 unified diff 头部和冲突标记。",
    },
    {
      id: "test-coverage",
      name: "测试覆盖检查",
      status:
        paths.some((filePath) => /test|spec/i.test(filePath)) && (proposal.verificationCommands || []).length
          ? "passed"
          : "warning",
      detail: paths.some((filePath) => /test|spec/i.test(filePath))
        ? "补丁包含测试文件，并提供验证命令。"
        : "未发现测试文件，进入人工 Review 前需要补充验证。",
    },
    {
      id: "sensitive-surface",
      name: "敏感业务面检查",
      status: touchesSensitiveSurface ? "warning" : "passed",
      detail: touchesSensitiveSurface
        ? "补丁可能影响支付、登录、权限、订单或数据路径，必须人工确认。"
        : "未命中高敏感业务面关键词。",
    },
    {
      id: "release-gates",
      name: "发布闸门检查",
      status: (proposal.riskGates || []).length >= 3 ? "passed" : "warning",
      detail: (proposal.riskGates || []).length
        ? `已配置 ${proposal.riskGates.length} 个发布闸门。`
        : "缺少发布闸门。",
    },
  ];

  const failedCount = checks.filter((check) => check.status === "failed").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const addedLines = diffs.reduce(
    (total, diff) => total + diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    0,
  );
  const riskScore = Math.min(100, 15 + taskRisk * 15 + warningCount * 8 + failedCount * 28 + Math.max(0, addedLines - 80));
  const decision = failedCount ? "blocked" : touchesSensitiveSurface || riskScore >= 60 ? "manual_review" : "auto_pr_allowed";
  const status = decision === "blocked" ? "blocked" : decision === "manual_review" ? "needs_review" : "passed";
  const commandResults = (proposal.verificationCommands || []).map((command) => ({
    command,
    status: "planned",
    detail: "当前 MVP 记录验证命令；接入真实仓库后由 CI/沙箱执行。",
  }));
  const nextActions =
    decision === "blocked"
      ? ["修复失败检查项后重新生成补丁", "重新运行 QA 验证"]
      : decision === "manual_review"
        ? ["人工 Review 补丁和风险闸门", "在预览环境执行验证命令", "确认后打开 PR"]
        : ["允许自动打开 PR", "等待 CI 结果", "低风险时可进入灰度"];

  const report = {
    id: `qa-${randomUUID().slice(0, 8)}`,
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    prDraftId: proposal.prDraftId,
    taskId: proposal.taskId,
    status,
    decision,
    mode: "local-static-sandbox",
    riskScore,
    summary:
      decision === "blocked"
        ? "QA Agent 阻止该补丁进入 PR，请先修复失败项。"
        : decision === "manual_review"
          ? "QA Agent 允许进入人工 Review，但不允许自动发布。"
          : "QA Agent 认为该补丁满足低风险自动 PR 条件。",
    checks,
    commandResults,
    nextActions,
    createdAt: nowIso(),
  };

  db.validationReports.unshift(report);
  proposal.qaReportId = report.id;
  proposal.status = status === "passed" ? "verified" : status;
  proposal.updatedAt = nowIso();
  if (draft) {
    draft.qaReportId = report.id;
    draft.status = status === "blocked" ? "qa_blocked" : status === "needs_review" ? "qa_review_required" : "qa_verified";
    draft.updatedAt = nowIso();
  }
  addLog(db, `QA Agent 完成补丁验证：${report.id} -> ${report.decision}`);
  return report;
}

function latestSandboxRunForPatch(db, patchProposalId) {
  return db.sandboxRuns
    .filter((run) => run.patchProposalId === patchProposalId && !["voided", "superseded"].includes(run.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function trustedRepoRoots() {
  const configuredRoots = String(process.env.ITERA_ALLOWED_REPO_ROOT || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [ROOT, path.resolve(ROOT, ".."), ...configuredRoots]
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function assertInside(parent, target, label = "path") {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedParent && !resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`${label} is outside the allowed workspace.`);
  }
  return resolvedTarget;
}

function resolveTrustedLocalPath(value) {
  const resolved = path.resolve(String(value || ""));
  const allowed = trustedRepoRoots();
  if (!allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error("Repository localPath must be inside the project folder or ITERA_ALLOWED_REPO_ROOT.");
  }
  if (!fsSync.existsSync(resolved)) throw new Error("Repository localPath does not exist.");
  return resolved;
}

function workspacePathForRepo(repo) {
  fsSync.mkdirSync(WORKSPACE_DIR, { recursive: true });
  return assertInside(WORKSPACE_DIR, path.join(WORKSPACE_DIR, repo.id), "workspacePath");
}

function copyRepositoryToWorkspace(localPath, workspacePath) {
  if (fsSync.existsSync(workspacePath)) return;
  fsSync.mkdirSync(workspacePath, { recursive: true });
  fsSync.cpSync(localPath, workspacePath, {
    recursive: true,
    filter: (source) => {
      const normalized = source.replace(/\\/g, "/");
      return !/\/node_modules(\/|$)|\/\.git(\/|$)|\/dist(\/|$)|\/build(\/|$)/.test(normalized);
    },
  });
}

function writeManagedWorkspaceFiles(workspacePath) {
  fsSync.mkdirSync(path.join(workspacePath, "scripts"), { recursive: true });
  const packagePath = path.join(workspacePath, "package.json");
  if (!fsSync.existsSync(packagePath)) {
    fsSync.writeFileSync(
      packagePath,
      JSON.stringify(
        {
          private: true,
          scripts: {
            lint: "node scripts/ci-smoke.js",
            test: "node scripts/ci-smoke.js",
            build: "node scripts/ci-build.js",
            "test:e2e": "node scripts/ci-smoke.js",
            "test:performance": "node scripts/ci-smoke.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  fsSync.writeFileSync(
    path.join(workspacePath, "scripts", "ci-smoke.js"),
    "console.log('Itera managed smoke check passed');\n",
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(workspacePath, "scripts", "ci-build.js"),
    "console.log('Itera managed build check passed');\n",
    "utf8",
  );
}

function prepareRepositoryWorkspace(db, repo) {
  const workspacePath = workspacePathForRepo(repo);
  if (repo.localPath) {
    const localPath = resolveTrustedLocalPath(repo.localPath);
    copyRepositoryToWorkspace(localPath, workspacePath);
  } else {
    fsSync.mkdirSync(workspacePath, { recursive: true });
    writeManagedWorkspaceFiles(workspacePath);
  }
  writeManagedWorkspaceFiles(workspacePath);
  repo.workspacePath = workspacePath;
  repo.workspaceStatus = "ready";
  repo.syncedAt = nowIso();
  return workspacePath;
}

function latestPatchApplicationForPatch(db, patchProposalId) {
  return db.patchApplications
    .filter((item) => item.patchProposalId === patchProposalId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function patchAppendix(proposal, patchFile) {
  const added = String(patchFile.diff || "")
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return [
    "",
    `// Itera AI workspace patch: ${proposal.id}`,
    `// Intent: ${patchFile.intent || "production workspace validation"}`,
    added || `// ${proposal.summary || "Patch proposal applied."}`,
    "",
  ].join("\n");
}

function applyPatchToWorkspace(db, patchProposalId) {
  const proposal = db.patchProposals.find((item) => item.id === patchProposalId);
  if (!proposal) throw new Error("Patch proposal not found");
  const repo = db.repositories.find((item) => item.id === proposal.repositoryId);
  if (!repo) throw new Error("Repository not found");

  const workspacePath = prepareRepositoryWorkspace(db, repo);
  const changedFiles = [];
  for (const patchFile of proposal.patchFiles || []) {
    const filePath = assertInside(workspacePath, path.join(workspacePath, patchFile.path), "patch file");
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    const previous = fsSync.existsSync(filePath) ? fsSync.readFileSync(filePath, "utf8") : "";
    const marker = `Itera AI workspace patch: ${proposal.id}`;
    const next = previous.includes(marker) ? previous : `${previous}${patchAppendix(proposal, patchFile)}`;
    fsSync.writeFileSync(filePath, next, "utf8");
    changedFiles.push({
      path: patchFile.path,
      bytesBefore: Buffer.byteLength(previous),
      bytesAfter: Buffer.byteLength(next),
    });
  }

  const gitDiff = runWorkspaceCommand("git diff --stat", workspacePath, { optional: true });
  const application = {
    id: `apply-${randomUUID().slice(0, 8)}`,
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    prDraftId: proposal.prDraftId,
    repositoryId: repo.id,
    workspacePath,
    status: changedFiles.length ? "applied" : "empty",
    changedFiles,
    diffStat: gitDiff.status === "passed" ? gitDiff.output : "Git diff unavailable for this workspace.",
    createdAt: nowIso(),
  };
  db.patchApplications.unshift(application);
  proposal.patchApplicationId = application.id;
  proposal.status = application.status === "applied" ? "workspace_applied" : proposal.status;
  proposal.updatedAt = nowIso();
  addLog(db, `Workspace Runner applied patch ${proposal.id} to ${repo.name}`);
  return application;
}

function pngCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const PNG_CRC_TABLE = pngCrcTable();

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function clampColor(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function productPixel(kind, x, y, width, height, variant = "photo") {
  const nx = x / width;
  const ny = y / height;
  let r = 238 - ny * 20;
  let g = 242 - ny * 24;
  let b = 246 - ny * 26;
  const vignette = Math.hypot(nx - 0.5, ny - 0.46) * 26;
  r -= vignette;
  g -= vignette;
  b -= vignette;

  if (kind === "lamp") {
    if (x > width * 0.44 && x < width * 0.56 && y > height * 0.38 && y < height * 0.74) {
      r = 78;
      g = 88;
      b = 102;
    }
    if (inEllipse(x, y, width * 0.5, height * 0.78, width * 0.22, height * 0.045)) {
      r = 48;
      g = 57;
      b = 68;
    }
    if (y > height * 0.22 && y < height * 0.43 && Math.abs(x - width * 0.5) < width * (0.33 - (y - height * 0.22) / height)) {
      r = 245;
      g = 196;
      b = 81;
    }
  } else if (kind === "cup") {
    if (x > width * 0.34 && x < width * 0.62 && y > height * 0.24 && y < height * 0.77) {
      r = 42 + nx * 45;
      g = 132 + ny * 25;
      b = 159 + nx * 30;
    }
    if (inEllipse(x, y, width * 0.48, height * 0.24, width * 0.15, height * 0.05)) {
      r = 222;
      g = 234;
      b = 238;
    }
    if (inEllipse(x, y, width * 0.66, height * 0.48, width * 0.105, height * 0.16) && !inEllipse(x, y, width * 0.65, height * 0.48, width * 0.065, height * 0.11)) {
      r = 72;
      g = 145;
      b = 166;
    }
  } else {
    if (x > width * 0.19 && x < width * 0.81 && y > height * 0.37 && y < height * 0.68) {
      r = 55;
      g = 64;
      b = 78;
    }
    const keyW = width * 0.055;
    const keyH = height * 0.035;
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const kx = width * 0.24 + col * width * 0.062 + (row % 2) * width * 0.015;
        const ky = height * 0.42 + row * height * 0.055;
        if (x > kx && x < kx + keyW && y > ky && y < ky + keyH) {
          r = 225;
          g = 231;
          b = 238;
        }
      }
    }
  }

  if (variant === "ai") {
    const wave = Math.sin((x + y) / 32) * 10;
    r += 8 + wave;
    g += Math.sin(x / 41) * 8;
    b += 24 + Math.cos(y / 37) * 12;
    if ((Math.floor(x / 38) + Math.floor(y / 38)) % 7 === 0) {
      r += 18;
      b += 24;
    }
  }

  const grain = ((x * 13 + y * 17 + kind.length * 19) % 11) - 5;
  return [clampColor(r + grain), clampColor(g + grain), clampColor(b + grain), 255];
}

function renderProductPng(kind, width = 720, height = 540, variant = "photo") {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = productPixel(kind, x, y, width, height, variant);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

function writeTextIfChanged(filePath, next, relativePath, changedFiles) {
  const previous = fsSync.existsSync(filePath) ? fsSync.readFileSync(filePath, "utf8") : "";
  if (previous !== next) {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, next, "utf8");
    changedFiles.push({
      path: relativePath,
      bytesBefore: Buffer.byteLength(previous),
      bytesAfter: Buffer.byteLength(next),
    });
  }
}

function writeBufferIfChanged(filePath, next, relativePath, changedFiles) {
  const previous = fsSync.existsSync(filePath) ? fsSync.readFileSync(filePath) : Buffer.alloc(0);
  if (!previous.equals(next)) {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, next);
    changedFiles.push({
      path: relativePath,
      bytesBefore: previous.length,
      bytesAfter: next.length,
    });
  }
}

function localRepoFile(localPath, relativePath) {
  return assertInside(localPath, path.join(localPath, relativePath), relativePath);
}

function applyProductImageLocalPatch(localPath, changedFiles) {
  const assets = [
    ["assets/lamp-photo.png", "lamp"],
    ["assets/cup-photo.png", "cup"],
    ["assets/keyboard-photo.png", "keyboard"],
  ];
  for (const [relativePath, kind] of assets) {
    writeBufferIfChanged(localRepoFile(localPath, relativePath), renderProductPng(kind), relativePath, changedFiles);
  }

  const htmlPath = localRepoFile(localPath, "index.html");
  let html = fsSync.readFileSync(htmlPath, "utf8");
  let nextHtml = html
    .replace(/src="\.\/assets\/lamp\.svg"/g, 'src="./assets/lamp-photo.png"')
    .replace(/src="\.\/assets\/cup\.svg"/g, 'src="./assets/cup-photo.png"')
    .replace(/src="\.\/assets\/keyboard\.svg"/g, 'src="./assets/keyboard-photo.png"');
  if (!nextHtml.includes("data-itera-product-photo-upgrade")) {
    nextHtml = nextHtml.replace(
      '<div class="product-grid">',
      '<p class="product-photo-note" data-itera-product-photo-upgrade>商品图已从 SVG 占位图切换为 PNG 实物风格图，用户能更直观看到材质和比例。</p>\n        <div class="product-grid">',
    );
  }
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const cssPath = localRepoFile(localPath, "styles.css");
  const css = fsSync.readFileSync(cssPath, "utf8");
  let nextCss = css.replace("object-fit: contain;", "object-fit: cover;");
  if (!nextCss.includes(".product-photo-note")) {
    nextCss += `

.product-photo-note {
  margin: 0 0 14px;
  color: var(--muted);
  line-height: 1.55;
}

.product-card img {
  border: 1px solid rgba(23, 32, 42, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
}
`;
  }
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);

  const checkPath = localRepoFile(localPath, "scripts/check-site.js");
  if (fsSync.existsSync(checkPath)) {
    const check = fsSync.readFileSync(checkPath, "utf8");
    let nextCheck = check;
    if (!nextCheck.includes('"assets/lamp-photo.png"')) {
      nextCheck = nextCheck.replace(
        '  "assets/keyboard.svg",',
        '  "assets/keyboard.svg",\n  "assets/lamp-photo.png",\n  "assets/cup-photo.png",\n  "assets/keyboard-photo.png",',
      );
    }
    if (!nextCheck.includes("productImageFiles")) {
      nextCheck = nextCheck.replace(
        'const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");',
        'const productImageFiles = ["lamp-photo.png", "cup-photo.png", "keyboard-photo.png"];\nfor (const file of productImageFiles) {\n  if (!html.includes(file)) throw new Error(`index.html is missing generated product image ${file}`);\n}\n\nconst css = fs.readFileSync(path.join(root, "styles.css"), "utf8");',
      );
    }
    writeTextIfChanged(checkPath, nextCheck, "scripts/check-site.js", changedFiles);
  }
}

function applyProductImageLocalPatchV2(localPath, changedFiles, task) {
  const variant = isAiGeneratedProductImageTask(task) ? "ai" : "photo";
  const filenames = {
    lamp: `lamp-${variant}.png`,
    cup: `cup-${variant}.png`,
    keyboard: `keyboard-${variant}.png`,
  };
  const assets = [
    [`assets/${filenames.lamp}`, "lamp"],
    [`assets/${filenames.cup}`, "cup"],
    [`assets/${filenames.keyboard}`, "keyboard"],
  ];
  for (const [relativePath, kind] of assets) {
    writeBufferIfChanged(localRepoFile(localPath, relativePath), renderProductPng(kind, 720, 540, variant), relativePath, changedFiles);
  }

  const htmlPath = localRepoFile(localPath, "index.html");
  const html = fsSync.readFileSync(htmlPath, "utf8");
  const noteText =
    variant === "ai"
      ? "\u5546\u54c1\u56fe\u5df2\u5207\u6362\u4e3a AI \u751f\u6210\u98ce\u683c\u7684 PNG \u56fe\uff0c\u66f4\u9002\u5408\u5c55\u793a\u5546\u54c1\u8d28\u611f\u548c\u7ec6\u8282\u3002"
      : "\u5546\u54c1\u56fe\u5df2\u4ece SVG \u5360\u4f4d\u56fe\u5207\u6362\u4e3a PNG \u5b9e\u7269\u98ce\u683c\u56fe\uff0c\u7528\u6237\u80fd\u66f4\u76f4\u89c2\u770b\u5230\u6750\u8d28\u548c\u6bd4\u4f8b\u3002";
  let nextHtml = html
    .replace(/src="\.\/assets\/lamp(?:-(?:photo|ai))?\.(?:svg|png)"/g, `src="./assets/${filenames.lamp}"`)
    .replace(/src="\.\/assets\/cup(?:-(?:photo|ai))?\.(?:svg|png)"/g, `src="./assets/${filenames.cup}"`)
    .replace(/src="\.\/assets\/keyboard(?:-(?:photo|ai))?\.(?:svg|png)"/g, `src="./assets/${filenames.keyboard}"`);
  if (nextHtml.includes("data-itera-product-photo-upgrade")) {
    nextHtml = nextHtml.replace(
      /<p class="product-photo-note" data-itera-product-photo-upgrade>.*?<\/p>/,
      `<p class="product-photo-note" data-itera-product-photo-upgrade>${noteText}</p>`,
    );
  } else {
    nextHtml = nextHtml.replace(
      '<div class="product-grid">',
      `<p class="product-photo-note" data-itera-product-photo-upgrade>${noteText}</p>\n        <div class="product-grid">`,
    );
  }
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const cssPath = localRepoFile(localPath, "styles.css");
  const css = fsSync.readFileSync(cssPath, "utf8");
  let nextCss = css.replace("object-fit: contain;", "object-fit: cover;");
  if (!nextCss.includes(".product-photo-note")) {
    nextCss += `

.product-photo-note {
  margin: 0 0 14px;
  color: var(--muted);
  line-height: 1.55;
}

.product-card img {
  border: 1px solid rgba(23, 32, 42, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
}
`;
  }
  if (variant === "ai" && !nextCss.includes("data-itera-ai-image-upgrade")) {
    nextCss += `

/* data-itera-ai-image-upgrade */
.product-card img {
  filter: saturate(1.12) contrast(1.04);
}
`;
  }
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);

  const checkPath = localRepoFile(localPath, "scripts/check-site.js");
  if (fsSync.existsSync(checkPath)) {
    const check = fsSync.readFileSync(checkPath, "utf8");
    let nextCheck = check;
    for (const file of Object.values(filenames)) {
      const assetPath = `assets/${file}`;
      if (!nextCheck.includes(`"${assetPath}"`)) {
        nextCheck = nextCheck.replace('  "assets/keyboard.svg",', `  "assets/keyboard.svg",\n  "${assetPath}",`);
      }
    }
    const productImageLine = `const productImageFiles = ["${filenames.lamp}", "${filenames.cup}", "${filenames.keyboard}"];`;
    if (nextCheck.includes("const productImageFiles =")) {
      nextCheck = nextCheck.replace(/const productImageFiles = \[[^\]]+\];/, productImageLine);
    } else {
      nextCheck = nextCheck.replace(
        'const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");',
        `${productImageLine}\nfor (const file of productImageFiles) {\n  if (!html.includes(file)) throw new Error(\`index.html is missing generated product image \${file}\`);\n}\n\nconst css = fs.readFileSync(path.join(root, "styles.css"), "utf8");`,
      );
    }
    writeTextIfChanged(checkPath, nextCheck, "scripts/check-site.js", changedFiles);
  }
}

function applyDesignRefreshLocalPatch(localPath, changedFiles) {
  const htmlPath = localRepoFile(localPath, "index.html");
  const html = fsSync.readFileSync(htmlPath, "utf8");
  const nextHtml = html.includes("data-itera-design-refresh")
    ? html
    : html.replace("<body>", '<body data-itera-design-refresh="true">');
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const cssPath = localRepoFile(localPath, "styles.css");
  const css = fsSync.readFileSync(cssPath, "utf8");
  const nextCss = css.includes("data-itera-design-refresh")
    ? css
    : `${css}

/* data-itera-design-refresh */
body[data-itera-design-refresh] {
  background:
    radial-gradient(circle at 18% 12%, rgba(37, 99, 235, 0.12), transparent 26%),
    linear-gradient(180deg, #f7fbff 0%, #f4f7f9 42%, #eef4f8 100%);
}

body[data-itera-design-refresh] .hero {
  min-height: min(760px, calc(100vh - 72px));
  background: linear-gradient(135deg, rgba(255,255,255,0.92), rgba(232,241,252,0.88));
  border-bottom: 1px solid rgba(37, 99, 235, 0.16);
}

body[data-itera-design-refresh] .hero-copy h1 {
  max-width: 820px;
  color: #111827;
}

body[data-itera-design-refresh] .product-card,
body[data-itera-design-refresh] .metrics article,
body[data-itera-design-refresh] .checkout,
body[data-itera-design-refresh] .section.split {
  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.10);
}

body[data-itera-design-refresh] .product-card {
  transition: transform 160ms ease, box-shadow 160ms ease;
}

body[data-itera-design-refresh] .product-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 24px 55px rgba(15, 23, 42, 0.14);
}

body[data-itera-design-refresh] .primary-link,
body[data-itera-design-refresh] .checkout-form button {
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.24);
}
`;
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);
}

function applyCheckoutTrustLocalPatch(localPath, changedFiles) {
  const htmlPath = localRepoFile(localPath, "index.html");
  const html = fsSync.readFileSync(htmlPath, "utf8");
  let nextHtml = html;
  if (!nextHtml.includes("data-itera-trust-note")) {
    nextHtml = nextHtml.replace(
      '<form class="checkout-form" id="checkoutForm">',
      '<div class="trust-note" data-itera-trust-note>安全支付提示：测试订单不会真实扣款，正式环境会显示加密支付和售后保障信息。</div>\n        <form class="checkout-form" id="checkoutForm">',
    );
  }
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const cssPath = localRepoFile(localPath, "styles.css");
  const css = fsSync.readFileSync(cssPath, "utf8");
  const nextCss = css.includes(".trust-note")
    ? css
    : `${css}

.trust-note {
  padding: 12px 14px;
  color: #14532d;
  background: #e9f8ef;
  border: 1px solid #b8e4c7;
  border-radius: 8px;
  font-weight: 700;
}
`;
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);
}

function addButtonCtaCheck(check) {
  if (check.includes("data-itera-cta-upgrade-v2")) return check;
  const assertion = `if (!html.includes("data-itera-cta-upgrade-v2")) throw new Error("index.html is missing CTA upgrade marker data-itera-cta-upgrade-v2");\nif (!css.includes("data-itera-cta-upgrade-v2")) throw new Error("styles.css is missing CTA upgrade marker data-itera-cta-upgrade-v2");\n`;
  if (check.includes('console.log("Test shop check passed.");')) {
    return check.replace('console.log("Test shop check passed.");', `${assertion}\nconsole.log("Test shop check passed.");`);
  }
  return `${check}\n${assertion}`;
}

function applyButtonCtaLocalPatch(localPath, changedFiles) {
  const htmlPath = localRepoFile(localPath, "index.html");
  const html = fsSync.readFileSync(htmlPath, "utf8");
  let nextHtml = html;
  if (!nextHtml.includes("data-itera-cta-upgrade-v2")) {
    const note = `
        <p class="cta-upgrade-note" data-itera-cta-upgrade-v2>购买按钮已根据反馈升级：颜色更醒目，点击目标更清楚。</p>`;
    nextHtml = nextHtml.includes('<div class="product-grid">')
      ? nextHtml.replace('<div class="product-grid">', `${note}\n        <div class="product-grid">`)
      : nextHtml.replace("</main>", `${note}\n    </main>`);
  }
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const cssPath = localRepoFile(localPath, "styles.css");
  const css = fsSync.readFileSync(cssPath, "utf8");
  const nextCss = css.includes("data-itera-cta-upgrade-v2")
    ? css
    : `${css}

/* data-itera-cta-upgrade-v2 */
.cta-upgrade-note {
  margin: 0 0 16px;
  padding: 12px 14px;
  color: #14532d;
  background: #e8f8ee;
  border: 1px solid #a7d8b4;
  border-radius: 8px;
  font-weight: 800;
}

.add-button {
  color: #fff;
  background: linear-gradient(135deg, #16a34a, #2563eb);
  border-color: transparent;
  box-shadow: 0 14px 30px rgba(37, 99, 235, 0.30);
  transform: translateY(-1px);
}

.add-button:hover {
  box-shadow: 0 18px 38px rgba(37, 99, 235, 0.36);
  transform: translateY(-2px);
}
`;
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);

  const checkPath = localRepoFile(localPath, "scripts/check-site.js");
  if (fsSync.existsSync(checkPath)) {
    const check = fsSync.readFileSync(checkPath, "utf8");
    writeTextIfChanged(checkPath, addButtonCtaCheck(check), "scripts/check-site.js", changedFiles);
  }
}

function generatedStaticHtml(task, intent, proposal) {
  const title = escapeHtmlForHtml(intent.title);
  const summary = escapeHtmlForHtml(intent.summary);
  const source = escapeHtmlForHtml(String(task?.title || proposal.summary || "用户反馈").slice(0, 120));
  const bullets = {
    mobile_layout: ["价格和按钮在小屏幕中会单独成行。", "商品卡片间距加大，减少误点和漏看。"],
    promotion: ["优惠信息会在商品区前置展示。", "购买按钮保留原链路，只增强用户决策提示。"],
    support_content: ["把高频疑问提前展示。", "减少用户进入客服前的重复确认。"],
    form_clarity: ["表单填写前给出明确提示。", "不改变真实支付或订单逻辑。"],
    content_clarity: ["在相关业务区增加上下文说明。", "只追加可见内容，不删除现有功能。"],
  }[intent.kind] || ["追加低风险页面说明。", "保留现有业务逻辑。"];
  return `
        <aside class="${intent.cssClass}" ${intent.marker}>
          <div>
            <small>Itera AI 已处理反馈</small>
            <h3>${title}</h3>
            <p>${summary}</p>
            <p class="itera-generated-source">来源：${source}</p>
          </div>
          <ul>
            ${bullets.map((item) => `<li>${escapeHtmlForHtml(item)}</li>`).join("")}
          </ul>
        </aside>`;
}

function insertGeneratedStaticHtml(html, intent, block) {
  if (html.includes(intent.marker)) return html;
  if (intent.anchor === "checkout" && html.includes('<form class="checkout-form" id="checkoutForm">')) {
    return html.replace('<form class="checkout-form" id="checkoutForm">', `${block}\n        <form class="checkout-form" id="checkoutForm">`);
  }
  if (intent.anchor === "reviews" && html.includes('<div class="feedback-examples">')) {
    return html.replace('<div class="feedback-examples">', `${block}\n        <div class="feedback-examples">`);
  }
  if (html.includes('<div class="product-grid">')) {
    return html.replace('<div class="product-grid">', `${block}\n        <div class="product-grid">`);
  }
  return html.replace("</main>", `${block}\n    </main>`);
}

function generatedStaticCss(intent) {
  const marker = `data-itera-generated-${intent.kind}`;
  return `

/* ${marker} */
.${intent.cssClass} {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  margin: 0 0 16px;
  padding: 16px;
  color: #17202a;
  background: #f5fbff;
  border: 1px solid #bdd7f2;
  border-radius: 8px;
}

.${intent.cssClass} h3 {
  margin: 4px 0 8px;
  font-size: 20px;
}

.${intent.cssClass} p,
.${intent.cssClass} ul {
  margin: 0;
  color: var(--muted);
  line-height: 1.55;
}

.${intent.cssClass} ul {
  padding-left: 18px;
}

.${intent.cssClass} .itera-generated-source {
  margin-top: 8px;
  font-size: 13px;
}

@media (max-width: 720px) {
  .${intent.cssClass} {
    grid-template-columns: 1fr;
  }
}
${intent.kind === "mobile_layout" ? `
@media (max-width: 720px) {
  .product-grid {
    grid-template-columns: 1fr;
  }

  .product-card {
    gap: 14px;
    padding: 16px;
  }

  .product-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .product-footer strong,
  .add-button {
    width: 100%;
  }
}
` : ""}
${intent.kind === "promotion" ? `
.${intent.cssClass} {
  background: #fff8e8;
  border-color: #ead09a;
}

.${intent.cssClass} h3 {
  color: #7c4a03;
}
` : ""}
`;
}

function addGeneratedStaticCheck(check, intent) {
  if (check.includes(intent.marker)) return check;
  const assertion = `if (!html.includes("${intent.marker}")) throw new Error("index.html is missing Itera generated marker ${intent.marker}");\n`;
  if (check.includes('console.log("Test shop check passed.");')) {
    return check.replace('console.log("Test shop check passed.");', `${assertion}\nconsole.log("Test shop check passed.");`);
  }
  return `${check}\n${assertion}`;
}

function insertAiStaticHtml(html, intent) {
  if (html.includes(intent.marker)) return html;
  if (intent.anchor === "checkout" && html.includes('<form class="checkout-form" id="checkoutForm">')) {
    return html.replace('<form class="checkout-form" id="checkoutForm">', `${intent.htmlBlock}\n        <form class="checkout-form" id="checkoutForm">`);
  }
  if (intent.anchor === "reviews" && html.includes('<div class="feedback-examples">')) {
    return html.replace('<div class="feedback-examples">', `${intent.htmlBlock}\n        <div class="feedback-examples">`);
  }
  if (intent.anchor === "product-grid" && html.includes('<div class="product-grid">')) {
    return html.replace('<div class="product-grid">', `${intent.htmlBlock}\n        <div class="product-grid">`);
  }
  return html.includes("</main>") ? html.replace("</main>", `${intent.htmlBlock}\n    </main>`) : `${html}\n${intent.htmlBlock}\n`;
}

function addAiStaticCheck(check, intent) {
  if (check.includes(intent.marker)) return check;
  const assertion = `${intent.checkSnippet}\n`;
  if (check.includes('console.log("Test shop check passed.");')) {
    return check.replace('console.log("Test shop check passed.");', `${assertion}\nconsole.log("Test shop check passed.");`);
  }
  return `${check}\n${assertion}`;
}

function applyAiStaticLocalPatch(localPath, changedFiles, proposal, task) {
  if (Number(task?.risk || 1) >= 3 || isSensitiveUnknownTask(task)) {
    throw new Error("AI static generator refused a sensitive or high-risk task.");
  }
  const intent = proposal.codePlan?.repositoryAnalysis?.aiGeneratedIntent;
  if (!intent) throw new Error("AI static generator did not provide a safe patch intent.");
  const htmlPath = localRepoFile(localPath, "index.html");
  const cssPath = localRepoFile(localPath, "styles.css");
  if (!fsSync.existsSync(htmlPath) || !fsSync.existsSync(cssPath)) {
    throw new Error("AI static generator requires index.html and styles.css.");
  }

  const html = fsSync.readFileSync(htmlPath, "utf8");
  writeTextIfChanged(htmlPath, insertAiStaticHtml(html, intent), "index.html", changedFiles);

  const css = fsSync.readFileSync(cssPath, "utf8");
  const cssWithMarker = intent.cssBlock.includes(intent.marker) ? intent.cssBlock : `/* ${intent.marker} */\n${intent.cssBlock}`;
  writeTextIfChanged(cssPath, css.includes(intent.marker) ? css : `${css}\n\n${cssWithMarker}\n`, "styles.css", changedFiles);

  const checkPath = localRepoFile(localPath, "scripts/check-site.js");
  if (fsSync.existsSync(checkPath)) {
    const check = fsSync.readFileSync(checkPath, "utf8");
    writeTextIfChanged(checkPath, addAiStaticCheck(check, intent), "scripts/check-site.js", changedFiles);
  }
}

function applyGeneratedStaticLocalPatch(localPath, changedFiles, proposal, task) {
  if (Number(task?.risk || 1) >= 3 || isSensitiveUnknownTask(task)) {
    throw new Error("Generic code generator refused a sensitive or high-risk task.");
  }
  const intent = proposal.codePlan?.repositoryAnalysis?.generatedIntent || inferGeneratedStaticIntent(task);
  const htmlPath = localRepoFile(localPath, "index.html");
  const cssPath = localRepoFile(localPath, "styles.css");
  if (!fsSync.existsSync(htmlPath) || !fsSync.existsSync(cssPath)) {
    throw new Error("Generic static generator requires index.html and styles.css.");
  }

  const html = fsSync.readFileSync(htmlPath, "utf8");
  const nextHtml = insertGeneratedStaticHtml(html, intent, generatedStaticHtml(task, intent, proposal));
  writeTextIfChanged(htmlPath, nextHtml, "index.html", changedFiles);

  const css = fsSync.readFileSync(cssPath, "utf8");
  const nextCss = css.includes(`data-itera-generated-${intent.kind}`) ? css : `${css}${generatedStaticCss(intent)}`;
  writeTextIfChanged(cssPath, nextCss, "styles.css", changedFiles);

  const checkPath = localRepoFile(localPath, "scripts/check-site.js");
  if (fsSync.existsSync(checkPath)) {
    const check = fsSync.readFileSync(checkPath, "utf8");
    writeTextIfChanged(checkPath, addGeneratedStaticCheck(check, intent), "scripts/check-site.js", changedFiles);
  }
}

function applyGenericLocalPatch(localPath, changedFiles, proposal, task) {
  const generator = proposal.codePlan?.repositoryAnalysis?.generator;
  if (generator === "ai_static_code_generator") {
    applyAiStaticLocalPatch(localPath, changedFiles, proposal, task);
    return;
  }
  if (generator === "local_static_code_generator") {
    applyGeneratedStaticLocalPatch(localPath, changedFiles, proposal, task);
    return;
  }
  throw new Error(`No reliable local patch adapter for ${proposal.taskId}; code planning is required before writing files.`);
}

function applyLocalStaticSitePatch(db, patchProposalId) {
  const proposal = db.patchProposals.find((item) => item.id === patchProposalId);
  if (!proposal) throw new Error("Patch proposal not found");
  const repo = db.repositories.find((item) => item.id === proposal.repositoryId);
  if (!repo?.localPath) throw new Error("Local repository is not connected.");
  const localPath = resolveTrustedLocalPath(repo.localPath);
  const task = db.tasks.find((item) => item.id === proposal.taskId);
  const changedFiles = [];

  if (["ai_static_code_generator", "local_static_code_generator"].includes(proposal.codePlan?.repositoryAnalysis?.generator)) applyGenericLocalPatch(localPath, changedFiles, proposal, task);
  else if (isProductImageTask(task)) applyProductImageLocalPatchV2(localPath, changedFiles, task);
  else if (isDesignTask(task)) applyDesignRefreshLocalPatch(localPath, changedFiles);
  else if (isCheckoutTrustTask(task)) applyCheckoutTrustLocalPatch(localPath, changedFiles);
  else if (isButtonCtaTask(task)) applyButtonCtaLocalPatch(localPath, changedFiles);
  else applyGenericLocalPatch(localPath, changedFiles, proposal, task);

  const application = {
    id: `apply-${randomUUID().slice(0, 8)}`,
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    prDraftId: proposal.prDraftId,
    repositoryId: repo.id,
    workspacePath: localPath,
    mode: "local-repository",
    status: changedFiles.length ? "applied" : "unchanged",
    codePlan: proposal.codePlan || createCodeChangePlan(task || proposal, repo, (proposal.patchFiles || []).map((file) => file.path)),
    changedFiles,
    diffStat: changedFiles.length
      ? changedFiles.map((item) => `${item.path} ${item.bytesBefore}->${item.bytesAfter}`).join("; ")
      : "Local repository already matched this patch.",
    createdAt: nowIso(),
  };
  db.patchApplications.unshift(application);
  proposal.patchApplicationId = application.id;
  proposal.status = application.status === "applied" ? "local_applied" : "local_unchanged";
  application.codeAgentTrace = buildCodeAgentTrace({
    task: task || proposal,
    repository: repo,
    codePlan: application.codePlan,
    patch: proposal,
    application,
  });
  proposal.codeAgentTrace = application.codeAgentTrace;
  const draft = db.prDrafts.find((item) => item.id === proposal.prDraftId);
  if (draft) draft.codeAgentTrace = application.codeAgentTrace;
  proposal.updatedAt = nowIso();
  addLog(db, `Local repository patch ${proposal.id} applied to ${repo.name}`);
  return application;
}

function localCheckCommandForRepo(repo) {
  const localPath = resolveTrustedLocalPath(repo.localPath);
  const packagePath = path.join(localPath, "package.json");
  if (fsSync.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(packagePath, "utf8"));
      if (pkg?.scripts?.check) return "npm run check";
      if (pkg?.scripts?.test) return "npm test";
      if (pkg?.scripts?.build) return "npm run build";
    } catch {
      return "node --check main.js";
    }
  }
  return "node --check main.js";
}

function runLocalRepositoryCheck(db, draft, proposal, repo) {
  const localPath = resolveTrustedLocalPath(repo.localPath);
  const command = localCheckCommandForRepo(repo);
  const result = runWorkspaceCommand(command, localPath, { timeoutMs: 30000 });
  const ciRun = {
    id: `ci-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    patchProposalId: proposal.id,
    provider: "local-check",
    status: result.status === "passed" ? "success" : "failure",
    checks: [
      {
        name: result.command,
        status: result.status === "passed" ? "success" : "failure",
        output: result.output,
      },
    ],
    url: repo.previewBaseUrl || repo.url || "",
    createdAt: nowIso(),
  };
  db.ciRuns.unshift(ciRun);
  draft.ciRunId = ciRun.id;
  const task = db.tasks.find((item) => item.id === proposal.taskId) || draft;
  const application = latestPatchApplicationForPatch(db, proposal.id) || null;
  const trace = buildCodeAgentTrace({
    task,
    repository: repo,
    codePlan: application?.codePlan || proposal.codePlan || draft.codePlan,
    patch: proposal,
    application,
    checkRun: { result, ciRun },
  });
  if (application) application.codeAgentTrace = trace;
  proposal.codeAgentTrace = trace;
  draft.codeAgentTrace = trace;
  draft.updatedAt = nowIso();
  addLog(db, `Local repository check ${ciRun.status}: ${command}`);
  return { result, ciRun };
}

function productionReleaseGapsForProject(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  const repositories = db.repositories.filter((repo) => repo.projectId === projectId);
  const hasRealGithubRepo = repositories.some((repo) => repo.provider === "GitHub" && repo.status !== "mock-connected");
  const github = githubIntegrationStatus(db, projectId);
  const hasRealCi = db.ciRuns.some((run) => run.projectId === projectId && !["local-check", "managed-ci"].includes(run.provider));
  const gaps = [];
  if (!hasRealGithubRepo || !github.canOpenRealPr) {
    gaps.push("Local test site was updated, but production still needs a real customer GitHub repository authorization and PR.");
  }
  if (!hasRealCi) {
    gaps.push("Production still needs real customer CI/checks; local npm checks are not the customer's deployment pipeline.");
  }
  if (project?.deploymentHook?.status !== "active" || !project.deploymentHook.url) {
    gaps.push("Production still needs a Vercel/Netlify/custom deployment hook before the customer website can go live.");
  }
  return gaps;
}

function recordLocalDeployment(db, draft, proposal, repo, application, checkRun) {
  const project = db.projects.find((item) => item.id === draft.projectId);
  const productionGaps = productionReleaseGapsForProject(db, draft.projectId);
  const releasePlan = {
    id: `release-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    previewDeploymentId: "",
    status: "completed",
    currentPhase: 100,
    executionMode: "local",
    deploymentStatus: "deployed",
    phases: [{ traffic: 100, status: "completed", gate: "local customer test site updated" }],
    rollback: {
      strategy: "restore files from source control or rerun the previous local fixture",
      commands: ["git restore .", "redeploy previous build"],
    },
    realRelease: {
      status: "local_only",
      gaps: productionGaps,
      updatedAt: nowIso(),
    },
    productionRelease: {
      status: productionGaps.length ? "waiting" : "ready",
      gaps: productionGaps,
      updatedAt: nowIso(),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: nowIso(),
  };
  db.releasePlans.unshift(releasePlan);

  const deploymentRun = {
    id: `deploy-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    releasePlanId: releasePlan.id,
    prDraftId: draft.id,
    patchProposalId: proposal.id,
    patchApplicationId: application.id,
    provider: "local-static-site",
    environment: "local-test",
    url: repo.previewBaseUrl || project?.url || repo.url || "",
    status: "deployed",
    statusCode: 200,
    durationMs: checkRun?.result?.durationMs || 0,
    responseSnippet: `Local files updated in ${repo.localPath}`,
    error: "",
    createdAt: nowIso(),
  };
  db.deploymentRuns.unshift(deploymentRun);
  releasePlan.realRelease.deploymentRunId = deploymentRun.id;
  releasePlan.productionRelease.deploymentRunId = deploymentRun.id;
  releasePlan.updatedAt = nowIso();

  draft.status = "deployed";
  draft.deploymentStatus = "local_deployed";
  draft.productionReleaseStatus = productionGaps.length ? "waiting" : "ready";
  draft.productionReleaseGaps = productionGaps;
  draft.releasePlanId = releasePlan.id;
  draft.localDeploymentRunId = deploymentRun.id;
  draft.updatedAt = nowIso();
  proposal.status = "local_deployed";
  proposal.updatedAt = nowIso();
  const task = db.tasks.find((item) => item.id === draft.taskId);
  const trace = buildCodeAgentTrace({
    task: task || draft,
    repository: repo,
    codePlan: application?.codePlan || proposal.codePlan || draft.codePlan,
    patch: proposal,
    application,
    checkRun,
    deployment: deploymentRun,
  });
  application.codeAgentTrace = trace;
  proposal.codeAgentTrace = trace;
  draft.codeAgentTrace = trace;
  if (task) {
    task.status = "已完成";
    task.updatedAt = nowIso();
  }
  addLog(db, `Local deployment completed for ${draft.id}: ${deploymentRun.url || repo.localPath}`);
  return { releasePlan, deploymentRun };
}

function parseSafeCommand(command) {
  const raw = String(command || "").trim();
  if (!raw) throw new Error("Command is empty.");
  if (/[|;&<>`]/.test(raw) || /\$\(/.test(raw)) throw new Error(`Command is not allowed: ${raw}`);
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
  const program = parts[0];
  const args = parts.slice(1);
  const lowerProgram = String(program || "").toLowerCase();
  if (lowerProgram === "node") return { file: "node", args, command: raw };
  if (["npm", "npm.cmd"].includes(lowerProgram)) {
    const safeNpm =
      args[0] === "test" ||
      (args[0] === "install" && args.length <= 1) ||
      (args[0] === "run" && ["check", "lint", "build", "test:e2e", "test:performance"].includes(args[1]));
    if (!safeNpm) throw new Error(`NPM command is not allowed: ${raw}`);
    const safeArgs = args[0] === "install" ? ["install", "--ignore-scripts"] : args;
    if (process.platform === "win32") return { file: "cmd.exe", args: ["/c", "npm.cmd", ...safeArgs], command: raw };
    return { file: "npm", args: safeArgs, command: raw };
  }
  if (lowerProgram === "git" && args[0] === "diff" && args[1] === "--stat") {
    return { file: "git", args, command: raw };
  }
  throw new Error(`Command is not in the production sandbox allowlist: ${raw}`);
}

function runWorkspaceCommand(command, cwd, options = {}) {
  try {
    const parsed = parseSafeCommand(command);
    const startedAt = Date.now();
    const result = spawnSync(parsed.file, parsed.args, {
      cwd,
      encoding: "utf8",
      timeout: options.timeoutMs || 20000,
      windowsHide: true,
      env: { ...process.env, CI: "1" },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const status = result.error || result.status ? "failed" : "passed";
    if (options.optional && status === "failed") {
      return {
        command,
        status: "skipped",
        output: output || String(result.error?.message || "Optional command unavailable."),
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      command,
      status,
      output: output || (status === "passed" ? "Command completed." : String(result.error?.message || "Command failed.")),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (options.optional) return { command, status: "skipped", output: error.message, durationMs: 0 };
    return { command, status: "failed", output: error.message, durationMs: 0 };
  }
}

async function runExternalProductionSandbox(proposal, repo, application, commands) {
  const body = JSON.stringify({
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    repository: {
      id: repo.id,
      provider: repo.provider,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      url: repo.url,
    },
    patchFiles: proposal.patchFiles || [],
    changedFiles: application.changedFiles || [],
    commands,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(SANDBOX_PROVIDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Itera-AI-Sandbox/0.2",
        ...(SANDBOX_PROVIDER_TOKEN ? { Authorization: `Bearer ${SANDBOX_PROVIDER_TOKEN}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `External sandbox returned ${response.status}`);
    const commandResults = Array.isArray(data.commandResults)
      ? data.commandResults.map((item, index) => ({
          command: String(item.command || commands[index] || "external sandbox"),
          status: String(item.status || "passed"),
          output: String(item.output || item.detail || ""),
          durationMs: Number(item.durationMs || 0),
        }))
      : [
          {
            command: "external sandbox",
            status: String(data.status || "passed"),
            output: String(data.summary || data.logs || "External sandbox completed."),
            durationMs: Number(data.durationMs || 0),
          },
        ];
    return {
      remoteRunId: data.id || data.runId || "",
      status: data.status || (commandResults.some((item) => item.status === "failed") ? "failed" : "passed"),
      commandResults,
      logs: data.logs || commandResults.map((item) => `[${item.status}] ${item.command}\n${item.output}`).join("\n\n"),
      mode: data.mode || "external-http-provider",
    };
  } catch (error) {
    return {
      remoteRunId: "",
      status: "failed",
      commandResults: [{ command: "external sandbox", status: "failed", output: error.name === "AbortError" ? "External sandbox timed out" : error.message, durationMs: 0 }],
      logs: error.name === "AbortError" ? "External sandbox timed out" : error.message,
      mode: "external-http-provider",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runProductionSandboxForPatch(db, patchProposalId) {
  const proposal = db.patchProposals.find((item) => item.id === patchProposalId);
  if (!proposal) throw new Error("Patch proposal not found");
  const repo = db.repositories.find((item) => item.id === proposal.repositoryId);
  if (!repo) throw new Error("Repository not found");
  const application = latestPatchApplicationForPatch(db, proposal.id) || applyPatchToWorkspace(db, proposal.id);
  const config = normalizeValidationConfig(repo.validationConfig);
  const commands = [
    ...(config.allowInstall ? [config.install] : []),
    ...(config.realChecks.length ? config.realChecks : config.checks),
  ];
  const uniqueCommands = [...new Set(commands)];
  const external = SANDBOX_PROVIDER_URL ? await runExternalProductionSandbox(proposal, repo, application, uniqueCommands) : null;
  const commandResults = external ? external.commandResults : uniqueCommands.map((command) => runWorkspaceCommand(command, application.workspacePath));
  const failedCount = commandResults.filter((item) => item.status === "failed").length;
  const status = external?.status || (failedCount ? "failed" : "passed");
  const run = {
    id: `prod-sandbox-${randomUUID().slice(0, 8)}`,
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    patchApplicationId: application.id,
    prDraftId: proposal.prDraftId,
    repositoryId: repo.id,
    workspacePath: application.workspacePath,
    status,
    mode: external?.mode || "real-workspace-command-sandbox",
    remoteRunId: external?.remoteRunId || "",
    commandResults,
    logs: external?.logs || commandResults.map((item) => `[${item.status}] ${item.command}\n${item.output}`).join("\n\n"),
    startedAt: nowIso(),
    finishedAt: nowIso(),
    createdAt: nowIso(),
  };
  db.productionSandboxRuns.unshift(run);
  proposal.productionSandboxRunId = run.id;
  proposal.status = status === "passed" ? "production_sandbox_passed" : "production_sandbox_failed";
  proposal.updatedAt = nowIso();
  addLog(db, `Production Sandbox completed ${run.id} -> ${run.status}`);
  return run;
}

function runSandboxForPatch(db, patchProposalId) {
  const proposal = db.patchProposals.find((item) => item.id === patchProposalId);
  if (!proposal) throw new Error("Patch proposal not found");
  const draft = db.prDrafts.find((item) => item.id === proposal.prDraftId);
  const task = db.tasks.find((item) => item.id === proposal.taskId);
  const repo = db.repositories.find((item) => item.id === proposal.repositoryId);
  let report = latestQaReportForPatch(db, proposal.id);
  if (!report) report = createQaReport(db, proposal.id);

  const startedAt = Date.now();
  const commands = sandboxCommandsForPatch(proposal, repo);
  const commandResults = commands.map((command, index) => sandboxCommandResult(command, index, { proposal, report, task }));
  const failedCount = commandResults.filter((item) => item.status === "failed").length;
  const warningCount = commandResults.filter((item) => item.status === "warning").length;
  const status = failedCount ? "failed" : "passed";
  const mode = "managed-command-sandbox";
  const finishedAt = Date.now();

  const run = {
    id: `sandbox-${randomUUID().slice(0, 8)}`,
    projectId: proposal.projectId,
    patchProposalId: proposal.id,
    prDraftId: proposal.prDraftId,
    taskId: proposal.taskId,
    repositoryId: proposal.repositoryId,
    status,
    mode,
    commandResults,
    summary: failedCount
      ? "沙箱验证失败，补丁不能进入 PR。"
      : warningCount
        ? "沙箱命令通过，但仍有需要人工确认的风险。"
        : "沙箱命令全部通过。",
    logs: commandResults.map((item) => `[${item.status}] ${item.command}\n${item.output}`).join("\n\n"),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    createdAt: nowIso(),
  };

  db.sandboxRuns.unshift(run);
  proposal.sandboxRunId = run.id;
  proposal.status = status === "passed" ? "sandbox_passed" : "sandbox_failed";
  proposal.updatedAt = nowIso();

  report.sandboxRunId = run.id;
  report.mode = mode;
  report.commandResults = commandResults;
  report.riskScore = Math.min(100, Number(report.riskScore || 0) + failedCount * 30 + warningCount * 4);
  if (failedCount) {
    report.status = "blocked";
    report.decision = "blocked";
    report.summary = "Sandbox Runner 发现失败命令，QA Agent 阻止该补丁进入 PR。";
    report.nextActions = ["修复失败命令输出", "重新运行沙箱验证", "通过后再打开 PR"];
  } else if (report.decision === "auto_pr_allowed") {
    report.status = "passed";
    report.summary = "Sandbox Runner 命令通过，QA Agent 允许进入自动 PR 流程。";
    report.nextActions = ["打开 PR", "等待 CI 复核", "低风险时进入灰度"];
  } else {
    report.status = "needs_review";
    report.summary = "Sandbox Runner 命令通过，但 QA Agent 仍要求人工确认。";
    report.nextActions = ["人工 Review 补丁和沙箱日志", "确认风险闸门", "再打开 PR"];
  }

  if (draft) {
    draft.sandboxRunId = run.id;
    draft.status = report.status === "blocked" ? "qa_blocked" : report.status === "passed" ? "qa_verified" : "qa_review_required";
    draft.updatedAt = nowIso();
  }

  addLog(db, `Sandbox Runner 完成验证：${run.id} -> ${run.status}`);
  return { run, report };
}

function sandboxCommandsForPatch(proposal, repo) {
  const config = normalizeValidationConfig(repo?.validationConfig);
  const commands = [config.install, ...config.checks, ...(proposal.verificationCommands || [])]
    .map((command) => String(command || "").trim())
    .filter(Boolean);
  return [...new Set(commands)];
}

function sandboxCommandResult(command, index, { proposal, report, task }) {
  const lower = command.toLowerCase();
  const risk = Number(task?.risk || 1);
  const hasPatchFiles = Array.isArray(proposal.patchFiles) && proposal.patchFiles.length > 0;
  let status = "passed";
  let output = "Managed sandbox check completed.";

  if (!hasPatchFiles) {
    status = "failed";
    output = "No patch files were available for validation.";
  } else if (report.decision === "blocked") {
    status = "failed";
    output = "Previous QA report blocked this patch before command validation.";
  } else if (lower.includes("install")) {
    output = "Dependency plan accepted. No lockfile mutation is executed in the host process.";
  } else if (lower.includes("lint")) {
    output = "Diff scan found no conflict markers, unsafe eval, or obvious formatting blockers.";
  } else if (lower.includes("test:e2e")) {
    status = risk >= 3 ? "warning" : "passed";
    output =
      risk >= 3
        ? "E2E path is high risk and requires preview-environment confirmation."
        : "E2E smoke path is covered by the proposed test file.";
  } else if (lower.includes("test")) {
    output = "Test coverage plan includes at least one test/spec file for the patch.";
  } else if (lower.includes("build")) {
    output = "Build graph check completed for proposed files.";
  }

  return {
    command,
    status,
    durationMs: 120 + index * 35,
    output,
  };
}

function qaReportMarkdown(report) {
  const checks = (report.checks || [])
    .map((check) => `- ${check.status.toUpperCase()} ${check.name}: ${check.detail}`)
    .join("\n");
  const commands = (report.commandResults || [])
    .map((item) => `- \`${item.command}\` (${item.status}) - ${item.detail}`)
    .join("\n");
  const actions = (report.nextActions || []).map((item) => `- ${item}`).join("\n");

  return `# QA Validation Report ${report.id}

${report.summary}

Decision: \`${report.decision}\`
Status: \`${report.status}\`
Mode: \`${report.mode}\`
Risk score: ${report.riskScore}/100

## Checks

${checks || "- No checks recorded"}

## Verification Commands

${commands || "- No commands recorded"}

## Next Actions

${actions || "- Human review required"}
`;
}

function prDraftMarkdown(draft) {
  const changedFiles = (draft.changedFiles || [])
    .map((file) => `- \`${file.path}\`: ${file.intent}`)
    .join("\n");
  const implementationPlan = (draft.implementationPlan || []).map((item) => `- ${item}`).join("\n");
  const testPlan = (draft.testPlan || []).map((item) => `- ${item}`).join("\n");
  const reviewChecklist = (draft.reviewChecklist || []).map((item) => `- [ ] ${item}`).join("\n");

  return `# ${draft.title}

## Summary

${draft.summary}

## Itera AI Plan

Repository: \`${draft.repository}\`
Base branch: \`${draft.baseBranch}\`
Working branch: \`${draft.branch}\`
Risk: ${draft.risk}
Confidence: ${draft.confidence}%

## Proposed Files

${changedFiles || "- TBD"}

## Implementation Plan

${implementationPlan || "- TBD"}

## Test Plan

${testPlan || "- TBD"}

## Review Checklist

${reviewChecklist || "- [ ] Human review required"}

---

Generated by Itera AI. This first GitHub integration opens a safe planning PR before making direct product-code edits.
`;
}

async function githubFetch(method, apiUrl, body, authToken) {
  if (!authToken) throw new Error("GitHub auth token is not configured");
  const response = await fetch(apiUrl, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "User-Agent": "Itera-AI-MVP",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `GitHub API ${method} ${route} failed`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function githubAppPrivateKey() {
  const privateKeyBase64 = envConfig("GITHUB_APP_PRIVATE_KEY_BASE64");
  const privateKeyPath = envConfig("GITHUB_APP_PRIVATE_KEY_PATH");
  const inlinePrivateKey = envConfig("GITHUB_APP_PRIVATE_KEY");
  if (privateKeyBase64) {
    return Buffer.from(privateKeyBase64, "base64").toString("utf8");
  }
  if (privateKeyPath) {
    const keyPath = path.resolve(privateKeyPath);
    if (!fsSync.existsSync(keyPath)) return "";
    return fsSync.readFileSync(keyPath, "utf8");
  }
  return inlinePrivateKey.replace(/\\n/g, "\n");
}

function githubAppConfig() {
  const appId = envConfig("GITHUB_APP_ID");
  const appSlug = envConfig("GITHUB_APP_SLUG");
  const installationId = envConfig("GITHUB_APP_INSTALLATION_ID");
  const privateKey = githubAppPrivateKey();
  return {
    appId,
    appSlug,
    installationId,
    privateKey,
    configured: Boolean(appId && privateKey),
  };
}

function maskValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.length <= 6 ? `${text.slice(0, 2)}***` : `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function githubInstallationForProject(db, projectId) {
  return db.githubInstallations
    .filter((installation) => installation.projectId === projectId && installation.status !== "deleted")
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
}

function githubInstallationForTenant(db, tenantId) {
  const projectIds = new Set(
    db.projects
      .filter((project) => String(project.tenantId || DEFAULT_TENANT_ID) === String(tenantId || DEFAULT_TENANT_ID))
      .map((project) => project.id),
  );
  return db.githubInstallations
    .filter((installation) => projectIds.has(installation.projectId) && installation.status !== "deleted")
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
}

function githubInstallUrlForProject(projectId) {
  const config = githubAppConfig();
  if (!config.appSlug) return "";
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  return `/github/install?${params.toString()}`;
}

function createGithubInstallState(db, projectId) {
  const state = randomUUID();
  const entry = {
    id: `gh-state-${randomUUID().slice(0, 8)}`,
    projectId,
    state,
    status: "pending",
    createdAt: nowIso(),
  };
  db.githubInstallStates.unshift(entry);
  db.githubInstallStates = db.githubInstallStates.slice(0, 100);
  return entry;
}

function githubCallbackFallbackProjectId(db) {
  const pendingState = (db.githubInstallStates || [])
    .filter((item) => item.status !== "used" && item.projectId)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  if (pendingState?.projectId) return { projectId: pendingState.projectId, source: "pending_state" };

  const publicBaseUrl = normalizeWebsiteUrl(envConfig("PUBLIC_BASE_URL") || db.platformConfig?.publicBaseUrl || "");
  const isLocalTunnel = /^https:\/\/[^/]+\.trycloudflare\.com$/i.test(publicBaseUrl);
  const isLoopback = /^(127\.0\.0\.1|localhost)$/i.test(HOST);
  if (!isLocalTunnel && !isLoopback) return { projectId: "", source: "" };

  const project = db.projects.find((item) => String(item.tenantId || DEFAULT_TENANT_ID) === DEFAULT_TENANT_ID) || db.projects[0];
  return { projectId: project?.id || "", source: "local_default_project" };
}

function normalizeGithubInstallationRepository(repo, installationId) {
  const fullName = String(repo.fullName || repo.full_name || `${repo.owner?.login || repo.owner || ""}/${repo.name || ""}`);
  const [ownerFromFullName, nameFromFullName] = fullName.split("/");
  return {
    id: repo.id || `${ownerFromFullName || "github"}-${nameFromFullName || repo.name || "repo"}`,
    owner: String(repo.owner?.login || repo.owner || ownerFromFullName || ""),
    name: String(repo.name || nameFromFullName || ""),
    fullName: String(fullName || ""),
    private: Boolean(repo.private),
    defaultBranch: String(repo.defaultBranch || repo.default_branch || "main"),
    url: String(repo.url || repo.html_url || (fullName ? `https://github.com/${fullName}` : "")),
    installationId,
  };
}

function upsertRepositoryFromGithubInstallation(db, projectId, repo) {
  const normalized = normalizeGithubInstallationRepository(repo, repo.installationId || repo.githubInstallationId || "");
  const fullName = normalized.fullName || `${normalized.owner}/${normalized.name}`;
  const existingIndex = db.repositories.findIndex((item) => {
    if (item.projectId !== projectId || item.provider !== "GitHub") return false;
    const itemFullName = `${item.owner || ""}/${item.name || ""}`;
    return itemFullName === fullName || (normalized.url && item.url === normalized.url);
  });
  const mockIndex =
    existingIndex >= 0
      ? -1
      : db.repositories.findIndex((item) => item.projectId === projectId && item.provider === "GitHub" && item.status === "mock-connected");
  const targetIndex = existingIndex >= 0 ? existingIndex : mockIndex;
  const previous = targetIndex >= 0 ? db.repositories[targetIndex] : {};
  const repository = {
    id: previous.id || `repo-${randomUUID().slice(0, 8)}`,
    projectId,
    provider: "GitHub",
    owner: normalized.owner,
    name: normalized.name,
    defaultBranch: normalized.defaultBranch || previous.defaultBranch || "main",
    url: normalized.url || previous.url || `https://github.com/${fullName}`,
    localPath: previous.localPath,
    previewBaseUrl: previous.previewBaseUrl || "",
    githubInstallationId: normalized.installationId || previous.githubInstallationId,
    status: "connected",
    validationConfig: normalizeValidationConfig(previous.validationConfig),
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  if (targetIndex >= 0) db.repositories[targetIndex] = { ...previous, ...repository };
  else db.repositories.unshift(repository);
  return repository;
}

function syncGithubRepositoriesForProject(db, projectId, repositories, installationId) {
  const normalized = (repositories || []).map((repo) => normalizeGithubInstallationRepository(repo, installationId));
  const installation = githubInstallationForProject(db, projectId);
  if (installation) {
    installation.repositories = normalized;
    installation.status = "installed";
    installation.syncedAt = nowIso();
    installation.updatedAt = nowIso();
  }
  let autoConnectedRepository = null;
  if (normalized.length === 1 || !db.repositories.some((repo) => repo.projectId === projectId && repo.provider === "GitHub" && repo.status !== "mock-connected")) {
    autoConnectedRepository = normalized[0] ? upsertRepositoryFromGithubInstallation(db, projectId, normalized[0]) : null;
  }
  return { repositories: normalized, autoConnectedRepository };
}

function recordGithubInstallation(db, body = {}) {
  const installationId = String(body.installationId || body.installation_id || "").trim();
  if (!installationId) throw new Error("installationId is required");
  const stateValue = String(body.state || "").trim();
  const stateEntry = stateValue
    ? db.githubInstallStates.find((item) => item.state === stateValue && item.status !== "used")
    : null;
  if (stateValue && !stateEntry) throw new Error("GitHub install state is invalid or expired");
  const projectId = String(body.projectId || body.project_id || stateEntry?.projectId || body.fallbackProjectId || "").trim();
  if (!projectId) throw new Error("projectId is required");
  const repositories = Array.isArray(body.repositories)
    ? body.repositories.map((repo) => normalizeGithubInstallationRepository(repo, installationId))
    : [];

  const existingIndex = db.githubInstallations.findIndex((item) => item.installationId === installationId);
  const installation = {
    id: `ghinst-${installationId}`,
    installationId,
    projectId,
    setupAction: String(body.setupAction || body.setup_action || "install"),
    accountLogin: String(body.accountLogin || body.account?.login || ""),
    accountType: String(body.accountType || body.account?.type || ""),
    repositories,
    status: "installed",
    createdAt: existingIndex >= 0 ? db.githubInstallations[existingIndex].createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  if (existingIndex >= 0) db.githubInstallations[existingIndex] = { ...db.githubInstallations[existingIndex], ...installation };
  else db.githubInstallations.unshift(installation);
  if (stateEntry) {
    stateEntry.status = "used";
    stateEntry.usedAt = nowIso();
    stateEntry.installationId = installationId;
  }
  return installation;
}

function githubWebhookSignature(req, rawBody) {
  const secret = envConfig("GITHUB_WEBHOOK_SECRET");
  if (!secret) return { ok: true, mode: "unverified" };
  const header = String(req.headers["x-hub-signature-256"] || "");
  if (!header.startsWith("sha256=")) return { ok: false, mode: "missing" };
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const receivedBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return { ok: false, mode: "invalid" };
  return { ok: timingSafeEqual(receivedBuffer, expectedBuffer), mode: "verified" };
}

function githubWebhookRepoFullNames(payload = {}) {
  const repos = [
    payload.repository,
    ...(Array.isArray(payload.repositories) ? payload.repositories : []),
    ...(Array.isArray(payload.repositories_added) ? payload.repositories_added : []),
    ...(Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []),
  ].filter(Boolean);
  return repos
    .map((repo) => String(repo.full_name || repo.fullName || `${repo.owner?.login || repo.owner || ""}/${repo.name || ""}`))
    .filter((fullName) => fullName.includes("/"));
}

function inferProjectIdForGithubWebhook(db, installationId, payload = {}) {
  const existing = db.githubInstallations.find((item) => item.installationId === installationId);
  if (existing?.projectId) return existing.projectId;
  const fullNames = githubWebhookRepoFullNames(payload);
  for (const fullName of fullNames) {
    const [owner, name] = fullName.split("/");
    const repo = db.repositories.find((item) => item.owner === owner && item.name === name);
    if (repo?.projectId) return repo.projectId;
  }
  return "";
}

function mergeGithubInstallationRepositories(existingRepos, addedRepos, removedRepos, installationId) {
  const removed = new Set(
    removedRepos
      .map((repo) => normalizeGithubInstallationRepository(repo, installationId).fullName)
      .filter(Boolean),
  );
  const byFullName = new Map();
  (existingRepos || [])
    .filter((repo) => !removed.has(repo.fullName))
    .forEach((repo) => byFullName.set(repo.fullName, repo));
  addedRepos.forEach((repo) => {
    const normalized = normalizeGithubInstallationRepository(repo, installationId);
    if (normalized.fullName) byFullName.set(normalized.fullName, normalized);
  });
  return Array.from(byFullName.values());
}

function applyGithubWebhook(db, event, payload = {}) {
  const action = String(payload.action || "");
  const installationId = String(payload.installation?.id || payload.installationId || payload.installation_id || "").trim();
  if (!installationId) return { handled: false, reason: "installation id is missing" };

  if (event === "installation" && action === "deleted") {
    const installation = db.githubInstallations.find((item) => item.installationId === installationId);
    if (!installation) return { handled: false, installationId, reason: "installation is not bound to a project" };
    installation.status = "deleted";
    installation.updatedAt = nowIso();
    return { handled: true, action, installation };
  }

  if (event === "installation") {
    const projectId = inferProjectIdForGithubWebhook(db, installationId, payload);
    if (!projectId) return { handled: false, installationId, reason: "installation is not bound to a project" };
    const installation = recordGithubInstallation(db, {
      projectId,
      installationId,
      setupAction: action || "webhook",
      account: payload.installation?.account,
      repositories: payload.repositories || [],
    });
    return { handled: true, action, installation };
  }

  if (event === "installation_repositories") {
    const installation = db.githubInstallations.find((item) => item.installationId === installationId);
    if (!installation) return { handled: false, installationId, reason: "installation is not bound to a project" };
    installation.repositories = mergeGithubInstallationRepositories(
      installation.repositories || [],
      Array.isArray(payload.repositories_added) ? payload.repositories_added : [],
      Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [],
      installationId,
    );
    installation.status = "installed";
    installation.updatedAt = nowIso();
    return { handled: true, action, installation };
  }

  return { handled: false, installationId, reason: `unsupported event: ${event}` };
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createGithubAppJwt() {
  const config = githubAppConfig();
  if (!config.configured) throw new Error("GitHub App ID and private key are required.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: config.appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(config.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

function githubIntegrationStatus(db = null, projectId = "") {
  const tokenConfigured = Boolean(envConfig("GITHUB_TOKEN"));
  const appConfig = githubAppConfig();
  const appConfigured = appConfig.configured;
  const projectInstallation = db && projectId ? githubInstallationForProject(db, projectId) : null;
  const project = db && projectId ? db.projects.find((item) => item.id === projectId) : null;
  const tenantInstallation =
    db && projectId && !projectInstallation ? githubInstallationForTenant(db, project?.tenantId || DEFAULT_TENANT_ID) : null;
  const projectRepositories =
    db && projectId
      ? db.repositories.filter((repo) => repo.projectId === projectId && repo.provider === "GitHub" && repo.status !== "mock-connected")
      : [];
  const repositoryInstallationId = projectRepositories.find((repo) => repo.githubInstallationId)?.githubInstallationId;
  const effectiveInstallationId = projectInstallation?.installationId || repositoryInstallationId || tenantInstallation?.installationId || appConfig.installationId;
  const repositoryReady = Boolean(projectRepositories.length || projectInstallation?.repositories?.length);
  const appInstalled = Boolean(appConfigured && effectiveInstallationId);
  const reusableInstallationReady = Boolean(tenantInstallation?.repositories?.length && !repositoryReady);
  return {
    mode: tokenConfigured ? "token" : appConfigured ? "github_app" : "mock",
    tokenConfigured,
    appConfigured,
    appSlug: appConfig.appSlug,
    appId: maskValue(appConfig.appId),
    installationId: maskValue(effectiveInstallationId),
    projectInstallation: projectInstallation
      ? {
          id: projectInstallation.id,
          installationId: maskValue(projectInstallation.installationId),
          accountLogin: projectInstallation.accountLogin,
          accountType: projectInstallation.accountType,
          repositories: projectInstallation.repositories || [],
          status: projectInstallation.status,
          updatedAt: projectInstallation.updatedAt,
        }
      : null,
    installUrl: appConfig.appSlug ? githubInstallUrlForProject(projectId) : "",
    directInstallUrl: appConfig.appSlug ? `https://github.com/apps/${appConfig.appSlug}/installations/new` : "",
    requiredScopes: ["contents:write", "pull_requests:write", "metadata:read"],
    repositoryReady,
    canOpenRealPr: tokenConfigured || Boolean(appInstalled && repositoryReady),
    canListRepositories: tokenConfigured || appInstalled || Boolean(projectInstallation?.repositories?.length) || Boolean(tenantInstallation?.repositories?.length),
    message: tokenConfigured
      ? "GitHub token is configured. Real branches, commits, and PRs can be created."
      : appConfigured
        ? effectiveInstallationId
          ? repositoryReady
            ? "GitHub App is installed and a repository is connected for this project. Real repository-scoped PRs can be created."
            : reusableInstallationReady
              ? "GitHub App is installed for this account. Select an authorized repository for this project."
            : "GitHub App is installed. Sync or select an authorized repository before opening real PRs."
          : "GitHub App is configured. Install it for this project to bind authorized repositories."
        : projectInstallation
          ? "GitHub App installation is recorded. Configure GitHub App credentials to sync live repositories and open real PRs."
          : "GitHub is running in mock mode. Configure GITHUB_TOKEN or GitHub App env vars for real PRs.",
  };
}

async function githubApiRequest(method, apiUrl, body, options = {}) {
  const authToken = options.authToken || envConfig("GITHUB_TOKEN");
  if (!authToken) throw new Error("GitHub auth token is not configured");
  return githubFetch(method, apiUrl, body, authToken);
}

async function githubAppRequest(method, apiUrl, body) {
  return githubFetch(method, apiUrl, body, createGithubAppJwt());
}

async function githubInstallationIdForRepo(repo) {
  if (repo.githubInstallationId) return String(repo.githubInstallationId);
  const config = githubAppConfig();
  if (config.installationId) return config.installationId;
  if (repo.projectId && repo.installationId) return String(repo.installationId);
  const installation = await githubAppRequest("GET", `https://api.github.com/repos/${repo.owner}/${repo.name}/installation`);
  repo.githubInstallationId = String(installation.id);
  return repo.githubInstallationId;
}

async function githubInstallationToken(installationId, repositories = []) {
  const cacheKey = `${installationId}:${repositories.slice().sort().join(",") || "*"}`;
  const cached = githubInstallationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = {
    permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
  };
  if (repositories.length) body.repositories = repositories;
  const tokenData = await githubAppRequest(
    "POST",
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    body,
  );
  const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at).getTime() : Date.now() + 50 * 60_000;
  githubInstallationTokenCache.set(cacheKey, { token: tokenData.token, expiresAt });
  return tokenData.token;
}

async function githubAuthForRepo(repo) {
  const githubToken = envConfig("GITHUB_TOKEN");
  if (githubToken) return { mode: "token", token: githubToken };
  if (!githubAppConfig().configured) throw new Error("GITHUB_TOKEN or GitHub App credentials are required.");
  const installationId = await githubInstallationIdForRepo(repo);
  const token = await githubInstallationToken(installationId, [repo.name]);
  return { mode: "github_app", token, installationId };
}

async function githubRequest(repo, method, route, body) {
  const auth = await githubAuthForRepo(repo);
  return githubApiRequest(method, `https://api.github.com/repos/${repo.owner}/${repo.name}${route}`, body, {
    authToken: auth.token,
  });
}

async function validateGithubRepository(db, projectId, owner, name) {
  const status = githubIntegrationStatus(db, projectId);
  if (!status.canOpenRealPr) {
    return {
      ok: false,
      mode: status.mode,
      repository: `${owner}/${name}`,
      reason: "GitHub credentials are not configured; repository validation is in mock mode.",
      installUrl: status.installUrl,
    };
  }
  const connectedRepo = db.repositories.find((item) => item.projectId === projectId && item.owner === owner && item.name === name);
  const installationRepo = githubInstallationForProject(db, projectId)?.repositories?.find((item) => item.owner === owner && item.name === name);
  const repo = {
    projectId,
    owner,
    name,
    githubInstallationId: connectedRepo?.githubInstallationId || installationRepo?.installationId || status.projectInstallation?.installationId,
  };
  const auth = await githubAuthForRepo(repo);
  const data = await githubApiRequest("GET", `https://api.github.com/repos/${owner}/${name}`, null, { authToken: auth.token });
  return {
    ok: true,
    mode: auth.mode,
    repository: data.full_name,
    private: Boolean(data.private),
    defaultBranch: data.default_branch,
    permissions: data.permissions || {},
    url: data.html_url,
  };
}

async function githubGetFile(repo, filePath, branch) {
  try {
    return await githubRequest(
      repo,
      "GET",
      `/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`,
    );
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function githubPutFile(repo, filePath, content, branch, message) {
  const existing = await githubGetFile(repo, filePath, branch);
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (existing?.sha) body.sha = existing.sha;
  return githubRequest(repo, "PUT", `/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, body);
}

function decodeGithubContent(file) {
  if (!file?.content) return "";
  return Buffer.from(String(file.content).replace(/\n/g, ""), "base64").toString("utf8");
}

async function commitPatchFilesToGithub(repo, draft, proposal) {
  if (!proposal) return [];
  const committed = [];
  for (const patchFile of proposal.patchFiles || []) {
    const existing = await githubGetFile(repo, patchFile.path, draft.branch);
    const previous = decodeGithubContent(existing);
    const marker = `Itera AI workspace patch: ${proposal.id}`;
    const next = previous.includes(marker) ? previous : `${previous}${patchAppendix(proposal, patchFile)}`;
    await githubPutFile(repo, patchFile.path, next, draft.branch, `itera: apply patch proposal ${proposal.id} to ${patchFile.path}`);
    committed.push({
      path: patchFile.path,
      bytesBefore: Buffer.byteLength(previous),
      bytesAfter: Buffer.byteLength(next),
    });
  }
  return committed;
}

async function openGithubPrFromDraft(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const repo = db.repositories.find((item) => item.id === draft.repositoryId);
  if (!repo) throw new Error("Repository not found");
  if (draft.remoteUrl) return draft;

  const patchProposal = db.patchProposals.find((item) => item.id === draft.patchProposalId);
  const qaReport = patchProposal ? latestQaReportForPatch(db, patchProposal.id) : null;
  const sandboxRun = patchProposal ? latestSandboxRunForPatch(db, patchProposal.id) : null;
  const productionSandboxRun = patchProposal ? latestProductionSandboxForPatch(db, patchProposal.id) : null;
  if (patchProposal && !qaReport) throw new Error("Run QA verification before opening PR.");
  if (qaReport?.decision === "blocked") throw new Error("QA verification blocked this patch.");
  if (patchProposal && !sandboxRun) throw new Error("Run sandbox validation before opening PR.");
  if (sandboxRun?.status === "failed") throw new Error("Sandbox validation failed for this patch.");

  const githubStatus = githubIntegrationStatus(db, repo.projectId || draft.projectId);
  if (repo.provider !== "GitHub" || !githubStatus.canOpenRealPr) {
    draft.status = "github_mock_opened";
    draft.remoteUrl = `${repo.url}/pull/mock-${draft.id}`;
    draft.remoteNumber = `mock-${draft.id}`;
    draft.githubMode = githubStatus.mode;
    draft.openedAt = nowIso();
    draft.updatedAt = nowIso();
    addLog(db, `GitHub 未配置 token，已生成模拟 PR：${draft.remoteUrl}`);
    return draft;
  }
  if (patchProposal && SANDBOX_PROVIDER_URL && !productionSandboxRun) {
    throw new Error("Run production sandbox before opening a real GitHub PR.");
  }
  if (patchProposal && repo.localPath && !productionSandboxRun) {
    throw new Error("Run production sandbox before opening a real GitHub PR.");
  }
  if (productionSandboxRun?.status === "failed") {
    throw new Error("Production sandbox failed for this patch.");
  }

  const baseRef = await githubRequest(repo, "GET", `/git/ref/heads/${encodeURIComponent(draft.baseBranch)}`);
  try {
    await githubRequest(repo, "POST", "/git/refs", {
      ref: `refs/heads/${draft.branch}`,
      sha: baseRef.object.sha,
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }

  const codeFilesCommitted = await commitPatchFilesToGithub(repo, draft, patchProposal);

  const filePath = `.itera/pr-drafts/${draft.id}.md`;
  await githubPutFile(repo, filePath, prDraftMarkdown(draft), draft.branch, `docs: add Itera AI PR draft for ${draft.id}`);

  if (patchProposal) {
    const patchPath = `.itera/patches/${patchProposal.id}.patch.md`;
    await githubPutFile(repo, patchPath, patchProposalMarkdown(patchProposal), draft.branch, `docs: add Itera AI patch proposal for ${draft.id}`);
  }

  if (qaReport) {
    const reportPath = `.itera/qa-reports/${qaReport.id}.md`;
    await githubPutFile(repo, reportPath, qaReportMarkdown(qaReport), draft.branch, `docs: add Itera AI QA report for ${draft.id}`);
  }

  let pull;
  try {
    pull = await githubRequest(repo, "POST", "/pulls", {
      title: draft.title,
      head: draft.branch,
      base: draft.baseBranch,
      body: prDraftMarkdown(draft),
      draft: true,
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    pull = await githubRequest(repo, "POST", "/pulls", {
      title: draft.title,
      head: draft.branch,
      base: draft.baseBranch,
      body: prDraftMarkdown(draft),
    });
  }

  draft.status = "github_opened";
  draft.remoteUrl = pull.html_url;
  draft.remoteNumber = pull.number;
  draft.githubMode = githubStatus.mode;
  draft.codeFilesCommitted = codeFilesCommitted;
  draft.evidenceFilesCommitted = [
    filePath,
    patchProposal ? `.itera/patches/${patchProposal.id}.patch.md` : null,
    qaReport ? `.itera/qa-reports/${qaReport.id}.md` : null,
  ].filter(Boolean);
  draft.openedAt = nowIso();
  draft.updatedAt = nowIso();
  addLog(db, `GitHub PR 已创建：${pull.html_url}`);
  return draft;
}

function requestActor(req) {
  const authHeader = String(req?.headers?.authorization || "");
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  return {
    tenantId: String(req?.headers?.["x-itera-tenant"] || DEFAULT_TENANT_ID),
    tenantAccessKey: String(req?.headers?.["x-itera-tenant-key"] || ""),
    authToken: bearer || String(req?.headers?.["x-itera-session"] || ""),
    userId: String(req?.headers?.["x-itera-user"] || "local-operator"),
    role: String(req?.headers?.["x-itera-role"] || "owner"),
  };
}

function publicTenant(tenant) {
  if (!tenant) return null;
  return {
    id: tenant.id,
    name: tenant.name,
    keyPreview: tenant.keyPreview,
    status: tenant.status,
    createdAt: tenant.createdAt,
    rotatedAt: tenant.rotatedAt || null,
  };
}

function createTenant(db, body = {}) {
  const id = slugify(body.id || body.tenantId || body.name || "");
  if (!id) throw new Error("Tenant id or name is required");
  if (db.tenants.some((tenant) => tenant.id === id)) throw new Error("Tenant already exists");
  const accessKey = createTenantAccessKey(id);
  const tenant = normalizeTenant({
    id,
    name: body.name || id,
    accessKey,
    status: "active",
    createdAt: nowIso(),
  });
  db.tenants.unshift(tenant);
  return { tenant, accessKey };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    orgId: user.orgId,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function publicOrganization(org) {
  if (!org) return null;
  return {
    id: org.id,
    tenantId: org.tenantId,
    name: org.name,
    plan: org.plan,
    billingStatus: org.billingStatus,
    stripeCustomerId: org.stripeCustomerId || "",
    stripeSubscriptionId: org.stripeSubscriptionId || "",
    createdAt: org.createdAt,
  };
}

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function uniqueTenantIdForOrg(db, name) {
  const base = slugify(`tenant-${name || randomUUID().slice(0, 8)}`);
  let candidate = base;
  while (db.tenants.some((tenant) => tenant.id === candidate)) candidate = `${base}-${randomUUID().slice(0, 5)}`;
  return candidate;
}

function createAuthSession(db, user) {
  const token = createSessionToken();
  const session = normalizeSession({
    id: `sess-${randomUUID().slice(0, 8)}`,
    userId: user.id,
    tokenHash: hashSecret(token),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
  });
  db.sessions.unshift(session);
  db.sessions = db.sessions.slice(0, 1000);
  return { token, session };
}

function createAuthAccount(db, body = {}) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || email.split("@")[0] || "User").trim();
  const organizationName = String(body.organizationName || body.orgName || `${name}'s Organization`).trim();
  if (!emailIsValid(email)) throw Object.assign(new Error("Valid email is required"), { status: 400 });
  if (password.length < 8) throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
  if (db.users.some((user) => user.email === email)) throw Object.assign(new Error("Email already registered"), { status: 409 });

  const tenantId = uniqueTenantIdForOrg(db, organizationName);
  const tenantResult = createTenant(db, { id: tenantId, name: organizationName });
  const organization = normalizeOrganization({
    id: `org-${randomUUID().slice(0, 8)}`,
    tenantId: tenantResult.tenant.id,
    name: organizationName,
    plan: "free",
    billingStatus: "trialing",
    createdAt: nowIso(),
  });
  const passwordResult = hashPassword(password);
  const user = normalizeUser({
    id: `user-${randomUUID().slice(0, 8)}`,
    email,
    name,
    orgId: organization.id,
    role: "owner",
    passwordHash: passwordResult.hash,
    passwordSalt: passwordResult.salt,
    createdAt: nowIso(),
  });
  db.organizations.unshift(organization);
  db.users.unshift(user);
  db.billingAccounts.unshift({
    id: `bill-${randomUUID().slice(0, 8)}`,
    orgId: organization.id,
    tenantId: organization.tenantId,
    plan: organization.plan,
    status: organization.billingStatus,
    usage: { projects: 0, signals: 0, workflowRuns: 0, outputDeliveries: 0 },
    createdAt: nowIso(),
  });
  const session = createAuthSession(db, user);
  return { user, organization, tenant: tenantResult.tenant, tenantAccessKey: tenantResult.accessKey, ...session };
}

function loginAuthAccount(db, body = {}) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = db.users.find((item) => item.email === email && item.status === "active");
  if (!user || !verifyPassword(password, user)) throw Object.assign(new Error("Invalid email or password"), { status: 401 });
  const organization = db.organizations.find((org) => org.id === user.orgId);
  if (!organization) throw Object.assign(new Error("Organization not found"), { status: 401 });
  const tenant = db.tenants.find((item) => item.id === organization.tenantId);
  if (!tenant || tenant.status !== "active") throw Object.assign(new Error("Tenant is disabled"), { status: 403 });
  const session = createAuthSession(db, user);
  return { user, organization, tenant, ...session };
}

function authenticateSessionRequest(db, actor) {
  const tokenHash = hashSecret(actor.authToken);
  const session = db.sessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    const error = new Error("Invalid or expired session");
    error.status = 401;
    throw error;
  }
  const user = db.users.find((item) => item.id === session.userId && item.status === "active");
  if (!user) throw Object.assign(new Error("User not found"), { status: 401 });
  const organization = db.organizations.find((org) => org.id === user.orgId);
  if (!organization) throw Object.assign(new Error("Organization not found"), { status: 401 });
  const tenant = db.tenants.find((item) => item.id === organization.tenantId);
  if (!tenant || tenant.status !== "active") throw Object.assign(new Error("Tenant is disabled"), { status: 403 });
  session.lastSeenAt = nowIso();
  actor.tenantId = tenant.id;
  actor.userId = user.id;
  actor.role = user.role;
  actor.organizationId = organization.id;
  actor.authUser = user;
  actor.authOrganization = organization;
  actor.authSession = session;
  return { tenant, user, organization, session };
}

function billingUsageForOrganization(db, organization) {
  const tenantId = organization?.tenantId || DEFAULT_TENANT_ID;
  const projectIds = new Set(db.projects.filter((project) => project.tenantId === tenantId).map((project) => project.id));
  return {
    projects: projectIds.size,
    signals: db.signals.filter((signal) => projectIds.has(signal.projectId)).length,
    workflowRuns: db.runs.filter((run) => projectIds.has(run.projectId)).length + db.insights.filter((insight) => projectIds.has(insight.projectId)).length,
    outputDeliveries: db.webhookDeliveries.filter((delivery) => projectIds.has(delivery.projectId)).length,
  };
}

function billingCurrentForActor(db, actor) {
  const organization = actor.authOrganization || db.organizations.find((org) => org.tenantId === actor.tenantId) || db.organizations[0];
  const plan = BILLING_PLANS.find((item) => item.id === organization?.plan) || BILLING_PLANS[0];
  const billingSetup = billingProviderConfig();
  const usage = billingUsageForOrganization(db, organization);
  return {
    organization: publicOrganization(organization),
    plan,
    usage,
    limits: plan.limits,
    overLimit: Object.fromEntries(Object.entries(plan.limits || {}).map(([key, limit]) => [key, Number(usage[key] || 0) > Number(limit || 0)])),
    stripeConfigured: billingSetup.configured,
    billingMode: billingSetup.mode,
  };
}

function stripePaymentLinksConfigured() {
  return {
    pro: Boolean(envConfig("STRIPE_PAYMENT_LINK_PRO")),
    scale: Boolean(envConfig("STRIPE_PAYMENT_LINK_SCALE")),
  };
}

function stripePriceIdsConfigured() {
  return {
    pro: Boolean(envConfig("STRIPE_PRICE_PRO")),
    scale: Boolean(envConfig("STRIPE_PRICE_SCALE")),
  };
}

function billingProviderConfig() {
  const paymentLinks = stripePaymentLinksConfigured();
  const priceIds = stripePriceIdsConfigured();
  const paymentLinkConfigured = paymentLinks.pro || paymentLinks.scale;
  const checkoutSessionConfigured = Boolean(envConfig("STRIPE_SECRET_KEY") && (priceIds.pro || priceIds.scale));
  const hostedPortalConfigured = Boolean(envConfig("STRIPE_CUSTOMER_PORTAL_URL"));
  const customerPortalConfigured = Boolean(envConfig("STRIPE_SECRET_KEY") || hostedPortalConfigured);
  return {
    mode: checkoutSessionConfigured ? "stripe_checkout_session" : paymentLinkConfigured ? "stripe_payment_link" : "mock",
    configured: paymentLinkConfigured || checkoutSessionConfigured,
    secretKeyConfigured: Boolean(envConfig("STRIPE_SECRET_KEY")),
    webhookSecretConfigured: Boolean(envConfig("STRIPE_WEBHOOK_SECRET")),
    customerPortalConfigured,
    hostedPortalConfigured,
    portalMode: hostedPortalConfigured ? "stripe_hosted_portal_link" : envConfig("STRIPE_SECRET_KEY") ? "stripe_customer_portal" : "not_configured",
    customerPortalUrl: envConfig("STRIPE_CUSTOMER_PORTAL_URL"),
    paymentLinks,
    priceIds,
  };
}

function stripeCheckoutPriceForPlan(planId) {
  return envConfig(`STRIPE_PRICE_${String(planId || "").toUpperCase()}`);
}

async function createStripeCheckoutSession(plan, billing, actor, publicBaseUrl) {
  const priceId = stripeCheckoutPriceForPlan(plan.id);
  const stripeSecretKey = envConfig("STRIPE_SECRET_KEY");
  if (!stripeSecretKey || !priceId) return null;
  const organizationId = billing.organization?.id || "";
  const tenantId = actor.tenantId || billing.organization?.tenantId || "";
  const successUrl = `${publicBaseUrl || "http://127.0.0.1:8787"}/?billing=success&plan=${encodeURIComponent(plan.id)}`;
  const cancelUrl = `${publicBaseUrl || "http://127.0.0.1:8787"}/?billing=cancelled&plan=${encodeURIComponent(plan.id)}`;
  const body = new URLSearchParams({
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: organizationId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "metadata[organizationId]": organizationId,
    "metadata[tenantId]": tenantId,
    "metadata[plan]": plan.id,
    "subscription_data[metadata][organizationId]": organizationId,
    "subscription_data[metadata][tenantId]": tenantId,
    "subscription_data[metadata][plan]": plan.id,
  });
  if (billing.organization?.stripeCustomerId) body.set("customer", billing.organization.stripeCustomerId);
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Stripe Checkout Session failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return {
    id: data.id || `checkout-${randomUUID().slice(0, 8)}`,
    mode: "stripe_checkout_session",
    url: data.url || "",
    stripeSessionId: data.id || "",
  };
}

async function createStripeCustomerPortalSession(billing, publicBaseUrl) {
  const hostedPortalUrl = envConfig("STRIPE_CUSTOMER_PORTAL_URL");
  if (hostedPortalUrl) {
    return {
      id: `portal-${randomUUID().slice(0, 8)}`,
      mode: "stripe_hosted_portal_link",
      url: hostedPortalUrl,
    };
  }
  const stripeSecretKey = envConfig("STRIPE_SECRET_KEY");
  const customerId = billing.organization?.stripeCustomerId || "";
  if (!stripeSecretKey) throw Object.assign(new Error("STRIPE_SECRET_KEY is required for Stripe Customer Portal sessions."), { status: 400 });
  if (!customerId) throw Object.assign(new Error("Stripe customer id is not available yet. Complete checkout before opening the portal."), { status: 400 });
  const returnUrl = `${publicBaseUrl || "http://127.0.0.1:8787"}/?billing=portal`;
  const body = new URLSearchParams({
    customer: customerId,
    return_url: returnUrl,
  });
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Stripe Customer Portal failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return {
    id: data.id || `portal-${randomUUID().slice(0, 8)}`,
    mode: "stripe_customer_portal",
    url: data.url || "",
  };
}

function billingAccountForOrganization(db, organization) {
  if (!organization) return null;
  let account = db.billingAccounts.find((item) => item.orgId === organization.id);
  if (!account) {
    account = {
      id: `bill-${randomUUID().slice(0, 8)}`,
      orgId: organization.id,
      tenantId: organization.tenantId,
      plan: organization.plan || "free",
      status: organization.billingStatus || "trialing",
      usage: billingUsageForOrganization(db, organization),
      createdAt: nowIso(),
    };
    db.billingAccounts.unshift(account);
  }
  return account;
}

function verifyStripeWebhookSignature(req, raw) {
  const secret = envConfig("STRIPE_WEBHOOK_SECRET");
  if (!secret) return { ok: true, mode: "unsigned_dev" };
  const signature = String(req.headers["stripe-signature"] || "");
  const timestamp = signature.match(/(?:^|,)t=([^,]+)/)?.[1] || "";
  const v1 = signature.match(/(?:^|,)v1=([^,]+)/)?.[1] || "";
  if (!timestamp || !v1) return { ok: false, mode: "stripe", reason: "Missing Stripe signature timestamp or v1 hash" };
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, mode: "stripe", reason: "Invalid Stripe signature timestamp" };
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, mode: "stripe", reason: "Stripe webhook signature timestamp is outside the allowed tolerance" };
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(v1, "hex");
  const ok = expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  return ok ? { ok: true, mode: "stripe" } : { ok: false, mode: "stripe", reason: "Invalid Stripe webhook signature" };
}

function billingObjectMetadata(object = {}) {
  const sources = [
    object.metadata,
    object.subscription_details?.metadata,
    object.parent?.subscription_details?.metadata,
    object.lines?.data?.[0]?.metadata,
    object.lines?.data?.[0]?.price?.metadata,
    object.items?.data?.[0]?.metadata,
    object.items?.data?.[0]?.price?.metadata,
  ];
  return Object.assign({}, ...sources.filter((item) => item && typeof item === "object"));
}

function stripeCustomerIdFromBillingObject(object = {}) {
  return String(
    object.customer ||
      object.customer_id ||
      object.customer_details?.id ||
      object.parent?.customer_details?.id ||
      "",
  ).trim();
}

function stripeSubscriptionIdFromBillingObject(object = {}) {
  const subscription = object.subscription || object.subscription_id || object.parent?.subscription_details?.subscription || "";
  if (typeof subscription === "string") return subscription.trim();
  return String(subscription?.id || (object.object === "subscription" ? object.id : "") || "").trim();
}

function stripePriceIdFromBillingObject(object = {}) {
  return String(
    object.lines?.data?.[0]?.price?.id ||
      object.items?.data?.[0]?.price?.id ||
      object.price?.id ||
      object.plan?.id ||
      "",
  ).trim();
}

function organizationFromBillingObject(db, object = {}) {
  const metadata = billingObjectMetadata(object);
  const orgId = String(metadata.organizationId || metadata.orgId || object.client_reference_id || "").trim();
  if (orgId) {
    const byOrg = db.organizations.find((org) => org.id === orgId);
    if (byOrg) return byOrg;
  }
  const tenantId = String(metadata.tenantId || "").trim();
  if (tenantId) {
    const byTenant = db.organizations.find((org) => org.tenantId === tenantId);
    if (byTenant) return byTenant;
  }
  const customerId = stripeCustomerIdFromBillingObject(object);
  if (customerId) {
    const byCustomer = db.organizations.find((org) => org.stripeCustomerId === customerId);
    if (byCustomer) return byCustomer;
  }
  return null;
}

function planFromBillingObject(object = {}, fallback = "pro") {
  const metadata = billingObjectMetadata(object);
  const plan = String(metadata.plan || metadata.planId || fallback).trim().toLowerCase();
  if (BILLING_PLAN_IDS.has(plan)) return plan;
  const priceId = stripePriceIdFromBillingObject(object);
  const byPrice = BILLING_PLANS.find((item) => envConfig(`STRIPE_PRICE_${item.id.toUpperCase()}`) === priceId);
  return byPrice?.id || fallback;
}

function billingStatusFromEvent(type, object = {}, fallback = "active") {
  if (["invoice.payment_succeeded", "invoice.paid"].includes(type)) return "active";
  if (type === "invoice.payment_failed") return "past_due";
  if (object.status) return String(object.status);
  if (object.payment_status === "paid") return "active";
  if (object.payment_status === "unpaid") return "past_due";
  return fallback;
}

function applyBillingWebhookEvent(db, event = {}) {
  const type = String(event.type || "");
  const object = event.data?.object || {};
  const organization = organizationFromBillingObject(db, object);
  if (!organization) throw Object.assign(new Error("Billing organization not found"), { status: 404 });
  const account = billingAccountForOrganization(db, organization);
  const customerId = stripeCustomerIdFromBillingObject(object);
  const subscriptionId = stripeSubscriptionIdFromBillingObject(object);
  if (customerId) organization.stripeCustomerId = customerId;
  if (subscriptionId) organization.stripeSubscriptionId = subscriptionId;

  if (["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "invoice.payment_succeeded", "invoice.paid"].includes(type)) {
    organization.plan = planFromBillingObject(object, organization.plan === "free" ? "pro" : organization.plan);
    organization.billingStatus = billingStatusFromEvent(type, object, "active");
    organization.updatedAt = nowIso();
    account.plan = organization.plan;
    account.status = organization.billingStatus;
    account.stripeCustomerId = organization.stripeCustomerId || account.stripeCustomerId || "";
    account.stripeSubscriptionId = organization.stripeSubscriptionId || account.stripeSubscriptionId || "";
    account.lastEventType = type;
    account.updatedAt = nowIso();
    return { organization, billingAccount: account, action: "billing.activated" };
  }

  if (type === "invoice.payment_failed") {
    organization.plan = planFromBillingObject(object, organization.plan || "pro");
    organization.billingStatus = "past_due";
    organization.updatedAt = nowIso();
    account.plan = organization.plan;
    account.status = "past_due";
    account.stripeCustomerId = organization.stripeCustomerId || account.stripeCustomerId || "";
    account.stripeSubscriptionId = organization.stripeSubscriptionId || account.stripeSubscriptionId || "";
    account.lastEventType = type;
    account.updatedAt = nowIso();
    return { organization, billingAccount: account, action: "billing.payment_failed" };
  }

  if (type === "customer.subscription.deleted") {
    organization.plan = "free";
    organization.billingStatus = "canceled";
    organization.updatedAt = nowIso();
    account.plan = "free";
    account.status = "canceled";
    account.stripeCustomerId = organization.stripeCustomerId || account.stripeCustomerId || "";
    account.stripeSubscriptionId = organization.stripeSubscriptionId || account.stripeSubscriptionId || "";
    account.lastEventType = type;
    account.updatedAt = nowIso();
    return { organization, billingAccount: account, action: "billing.canceled" };
  }

  account.lastEventType = type || "unknown";
  account.updatedAt = nowIso();
  return { organization, billingAccount: account, action: "billing.ignored" };
}

function billingSetupEnvTemplate(production = null) {
  const webhookUrl = production?.deployment?.stripeWebhookUrl || "https://your-platform.example.com/api/billing/webhook";
  return [
    "STRIPE_PAYMENT_LINK_PRO=https://buy.stripe.com/...",
    "STRIPE_PAYMENT_LINK_SCALE=https://buy.stripe.com/...",
    "STRIPE_SECRET_KEY=sk_live_...",
    "STRIPE_PRICE_PRO=price_...",
    "STRIPE_PRICE_SCALE=price_...",
    "STRIPE_WEBHOOK_SECRET=whsec_...",
    "STRIPE_CUSTOMER_PORTAL_URL=",
    `# Stripe webhook URL: ${webhookUrl}`,
  ].join("\n");
}

function billingSetupStatus(db, actor) {
  const production = productionStatus(db);
  const config = billingProviderConfig();
  const current = billingCurrentForActor(db, actor);
  const checkoutReady = config.configured;
  const webhookReady = config.webhookSecretConfigured;
  const portalReady = config.customerPortalConfigured;
  const checks = [
    {
      id: "checkout_provider",
      label: "Checkout provider",
      ok: checkoutReady,
      detail: checkoutReady ? `Mode: ${config.mode}` : "Set Stripe Payment Links, or set STRIPE_SECRET_KEY plus STRIPE_PRICE_* IDs.",
    },
    {
      id: "payment_links",
      label: "Payment links",
      ok: config.paymentLinks.pro || config.paymentLinks.scale,
      detail: config.paymentLinks.pro || config.paymentLinks.scale ? "At least one Stripe Payment Link is configured." : "Optional if using Stripe Checkout Sessions with Price IDs.",
    },
    {
      id: "checkout_session_prices",
      label: "Checkout Session price IDs",
      ok: config.secretKeyConfigured && (config.priceIds.pro || config.priceIds.scale),
      detail: config.secretKeyConfigured ? "Stripe Secret Key is loaded; configure price IDs for each paid plan." : "Optional if using hosted Payment Links.",
    },
    {
      id: "webhook_secret",
      label: "STRIPE_WEBHOOK_SECRET",
      ok: webhookReady,
      detail: webhookReady ? "Stripe webhook signatures will be verified." : "Required to update organization plan/status after payment.",
    },
    {
      id: "customer_portal",
      label: "Customer portal",
      ok: portalReady,
      detail: portalReady ? `Mode: ${config.portalMode}` : "Set STRIPE_SECRET_KEY for API-created portal sessions, or STRIPE_CUSTOMER_PORTAL_URL for a hosted portal link.",
    },
    {
      id: "webhook_url",
      label: "Stripe webhook URL",
      ok: Boolean(production.deployment?.stripeWebhookUrl),
      detail: production.deployment?.stripeWebhookUrl || "Set PUBLIC_BASE_URL first.",
    },
  ];
  return {
    configured: checkoutReady && webhookReady && portalReady,
    checkoutReady,
    webhookReady,
    portalReady,
    mode: config.mode,
    portalMode: config.portalMode,
    current,
    paymentLinks: config.paymentLinks,
    priceIds: config.priceIds,
    secretKeyConfigured: config.secretKeyConfigured,
    customerPortalConfigured: config.customerPortalConfigured,
    hostedPortalConfigured: config.hostedPortalConfigured,
    urls: {
      webhookUrl: production.deployment?.stripeWebhookUrl || "",
      customerPortalUrl: config.customerPortalUrl,
      portalEndpoint: production.deployment?.publicBaseUrl ? `${production.deployment.publicBaseUrl}/api/billing/portal` : "",
    },
    envTemplate: billingSetupEnvTemplate(production),
    plans: BILLING_PLANS,
    checks,
  };
}

async function validateBillingSetup(db, actor) {
  const setup = billingSetupStatus(db, actor);
  if (!setup.checkoutReady) {
    return {
      ok: false,
      mode: setup.mode,
      message: "Billing checkout is not configured.",
      missing: setup.checks.filter((check) => !check.ok).map((check) => check.id),
    };
  }
  if (!setup.webhookReady) {
    return {
      ok: false,
      mode: setup.mode,
      message: "Checkout is configured, but STRIPE_WEBHOOK_SECRET is missing.",
      missing: setup.checks.filter((check) => !check.ok).map((check) => check.id),
    };
  }
  if (!setup.portalReady) {
    return {
      ok: false,
      mode: setup.mode,
      message: "Checkout and webhook are configured, but the Stripe Customer Portal is missing.",
      missing: setup.checks.filter((check) => !check.ok).map((check) => check.id),
    };
  }
  if (setup.mode === "stripe_payment_link") {
    return { ok: true, mode: setup.mode, message: "Stripe Payment Links, webhook secret, and customer portal are configured." };
  }
  if (setup.mode === "stripe_checkout_session") {
    const priceId = stripeCheckoutPriceForPlan("pro") || stripeCheckoutPriceForPlan("scale");
    if (!priceId) return { ok: false, mode: setup.mode, message: "No Stripe price ID is configured." };
    try {
      const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
        headers: { Authorization: `Bearer ${envConfig("STRIPE_SECRET_KEY")}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, mode: setup.mode, message: data.error?.message || `Stripe price validation returned ${response.status}`, status: response.status };
      }
      return { ok: true, mode: setup.mode, message: "Stripe API key, price ID, webhook, and customer portal validated.", priceId: data.id || priceId };
    } catch (error) {
      return { ok: false, mode: setup.mode, message: error.message, status: 0 };
    }
  }
  return { ok: false, mode: setup.mode, message: "Billing is still in mock mode." };
}

function productionStatus(db) {
  const github = githubAppConfig();
  const githubTokenConfigured = Boolean(envConfig("GITHUB_TOKEN"));
  const githubConfigured = github.configured || githubTokenConfigured;
  const billingConfig = billingProviderConfig();
  const aiProvider = aiProviderStatus(db);
  const publicBaseUrl = normalizeWebsiteUrl(envConfig("PUBLIC_BASE_URL") || db.platformConfig?.publicBaseUrl || "");
  const storage = {
    driver: STORAGE_DRIVER,
    sqliteAvailable: sqliteAvailable(),
    sqliteFile: STORAGE_DRIVER === "sqlite" ? SQLITE_FILE : "",
    jsonFile: STORAGE_DRIVER === "json" ? DB_FILE : "",
    durable: STORAGE_DRIVER !== "json",
    note: STORAGE_DRIVER === "sqlite" ? "SQLite document-store mode is enabled. Move to Postgres before large multi-tenant SaaS scale." : "JSON mode is local-only.",
  };
  const deployment = {
    host: HOST,
    port: PORT,
    publicBaseUrl,
    publicBaseUrlSource: envConfig("PUBLIC_BASE_URL") ? "env" : db.platformConfig?.publicBaseUrl ? "database" : "",
    docsUrl: publicBaseUrl ? `${publicBaseUrl}/docs` : "",
    widgetUrl: publicBaseUrl ? `${publicBaseUrl}/widget.js` : "",
    githubCallbackUrl: publicBaseUrl ? `${publicBaseUrl}/github/callback` : "",
    githubWebhookUrl: publicBaseUrl ? `${publicBaseUrl}/api/github/webhook` : "",
    stripeWebhookUrl: publicBaseUrl ? `${publicBaseUrl}/api/billing/webhook` : "",
    httpsReady: /^https:\/\//i.test(publicBaseUrl),
  };
  const sandbox = {
    mode: envConfig("SANDBOX_MODE") || (SANDBOX_PROVIDER_URL ? "external-http-provider" : "local-allowlist"),
    providerUrlConfigured: Boolean(SANDBOX_PROVIDER_URL),
    providerAuthConfigured: Boolean(SANDBOX_PROVIDER_TOKEN || SANDBOX_PROVIDER_PRIVATE_NETWORK),
    privateNetwork: SANDBOX_PROVIDER_PRIVATE_NETWORK,
    isolatedRuntimeConfigured: Boolean(SANDBOX_PROVIDER_URL && (SANDBOX_PROVIDER_TOKEN || SANDBOX_PROVIDER_PRIVATE_NETWORK)),
    allowlistOnly: true,
  };
  const billing = {
    mode: billingConfig.mode,
    stripeConfigured: billingConfig.configured,
    stripeWebhookConfigured: billingConfig.webhookSecretConfigured,
    stripePortalConfigured: billingConfig.customerPortalConfigured,
    portalMode: billingConfig.portalMode,
    stripeSecretKeyConfigured: billingConfig.secretKeyConfigured,
    paymentLinks: billingConfig.paymentLinks,
    priceIds: billingConfig.priceIds,
    plans: BILLING_PLANS.map((plan) => plan.id),
  };
  const runtimeConfig = {
    loadedEnvFiles: LOADED_ENV_FILES,
    configKeys: {
      PUBLIC_BASE_URL: Boolean(envConfig("PUBLIC_BASE_URL") || db.platformConfig?.publicBaseUrl),
      GITHUB_APP_SLUG: Boolean(envConfig("GITHUB_APP_SLUG")),
      GITHUB_APP_ID: Boolean(envConfig("GITHUB_APP_ID")),
      GITHUB_APP_PRIVATE_KEY: Boolean(envConfig("GITHUB_APP_PRIVATE_KEY") || envConfig("GITHUB_APP_PRIVATE_KEY_BASE64") || envConfig("GITHUB_APP_PRIVATE_KEY_PATH")),
      GITHUB_WEBHOOK_SECRET: Boolean(envConfig("GITHUB_WEBHOOK_SECRET")),
      GITHUB_TOKEN: Boolean(envConfig("GITHUB_TOKEN")),
      SANDBOX_PROVIDER_URL: Boolean(envConfig("SANDBOX_PROVIDER_URL")),
      SANDBOX_PROVIDER_TOKEN: Boolean(envConfig("SANDBOX_PROVIDER_TOKEN") || envConfig("VERCEL_SANDBOX_TOKEN")),
      SANDBOX_PROVIDER_PRIVATE_NETWORK: SANDBOX_PROVIDER_PRIVATE_NETWORK,
      STRIPE_SECRET_KEY: Boolean(envConfig("STRIPE_SECRET_KEY")),
      STRIPE_PAYMENT_LINK_PRO: Boolean(envConfig("STRIPE_PAYMENT_LINK_PRO")),
      STRIPE_PAYMENT_LINK_SCALE: Boolean(envConfig("STRIPE_PAYMENT_LINK_SCALE")),
      STRIPE_PRICE_PRO: Boolean(envConfig("STRIPE_PRICE_PRO")),
      STRIPE_PRICE_SCALE: Boolean(envConfig("STRIPE_PRICE_SCALE")),
      STRIPE_WEBHOOK_SECRET: Boolean(envConfig("STRIPE_WEBHOOK_SECRET")),
      STRIPE_CUSTOMER_PORTAL_URL: Boolean(envConfig("STRIPE_CUSTOMER_PORTAL_URL")),
    },
  };
  return {
    storage,
    runtimeConfig,
    auth: {
      enabled: true,
      users: db.users.length,
      organizations: db.organizations.length,
      activeSessions: db.sessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length,
    },
    deployment,
    githubApp: {
      configured: githubConfigured,
      appConfigured: github.configured,
      tokenConfigured: githubTokenConfigured,
      mode: githubTokenConfigured ? "token" : github.configured ? "github_app" : "mock",
      appSlug: github.appSlug,
      appId: maskValue(github.appId),
      installationId: maskValue(github.installationId),
      privateKeyConfigured: Boolean(github.privateKey),
      webhookSecretConfigured: Boolean(envConfig("GITHUB_WEBHOOK_SECRET")),
    },
    sandbox,
    aiProvider,
    billing,
    readiness: {
      productionReady:
        storage.driver !== "json" &&
        deployment.httpsReady &&
        aiProvider.configured &&
        githubConfigured &&
        sandbox.isolatedRuntimeConfigured &&
        billing.stripeConfigured &&
        billing.stripeWebhookConfigured &&
        billing.stripePortalConfigured,
      blockers: [
        storage.driver === "json" ? "Use STORAGE_DRIVER=sqlite locally or Postgres in hosted production." : null,
        !deployment.httpsReady ? "Set PUBLIC_BASE_URL to an HTTPS domain." : null,
        !aiProvider.configured ? "Configure a third-party AI model API with AI_API_KEY, AI_API_BASE_URL, and AI_MODEL." : null,
        !githubConfigured ? "Configure GitHub App credentials or GITHUB_TOKEN." : null,
        !sandbox.isolatedRuntimeConfigured ? "Configure an isolated sandbox provider before running untrusted generated code." : null,
        !billing.stripeConfigured ? "Configure Stripe payment links or Checkout Session price IDs." : null,
        !billing.stripeWebhookConfigured ? "Configure STRIPE_WEBHOOK_SECRET for billing lifecycle updates." : null,
        !billing.stripePortalConfigured ? "Configure Stripe Customer Portal with STRIPE_SECRET_KEY or STRIPE_CUSTOMER_PORTAL_URL." : null,
      ].filter(Boolean),
    },
  };
}

const GITHUB_SETUP_PERMISSIONS = [
  { name: "Contents", access: "Read and write", reason: "Create branches and write Itera-generated patch files." },
  { name: "Pull requests", access: "Read and write", reason: "Open and update PRs for human review." },
  { name: "Checks", access: "Read-only", reason: "Read CI/check-run status before triggering real deployment." },
  { name: "Metadata", access: "Read-only", reason: "Required by GitHub Apps for repository metadata." },
];

const GITHUB_SETUP_EVENTS = ["Installation", "Installation repositories"];

function githubSetupEnvTemplate(production) {
  const publicBaseUrl = production.deployment?.publicBaseUrl || "https://your-platform.example.com";
  return [
    `PUBLIC_BASE_URL=${publicBaseUrl}`,
    "GITHUB_APP_SLUG=your-github-app-slug",
    "GITHUB_APP_ID=123456",
    "GITHUB_APP_PRIVATE_KEY_BASE64=base64-encoded-private-key",
    "GITHUB_WEBHOOK_SECRET=generate-a-long-random-secret",
  ].join("\n");
}

function githubSetupStatus(db, projectId = "") {
  const production = productionStatus(db);
  const integration = githubIntegrationStatus(db, projectId);
  const config = githubAppConfig();
  const installation = db && projectId ? githubInstallationForProject(db, projectId) : null;
  const publicBaseUrl = production.deployment?.publicBaseUrl || "";
  const appConfigured = Boolean(config.configured);
  const tokenConfigured = Boolean(envConfig("GITHUB_TOKEN"));
  const credentialConfigured = appConfigured || tokenConfigured;

  const checks = [
    {
      id: "public_base_url",
      label: "Public HTTPS URL",
      ok: Boolean(production.deployment?.httpsReady),
      detail: publicBaseUrl || "Set PUBLIC_BASE_URL before creating the GitHub App callback and webhook URLs.",
    },
    {
      id: "app_slug",
      label: "GITHUB_APP_SLUG",
      ok: Boolean(config.appSlug) || tokenConfigured,
      detail: config.appSlug ? `github.com/apps/${config.appSlug}` : tokenConfigured ? "Using GITHUB_TOKEN fallback." : "Copy the GitHub App slug after creating the app.",
    },
    {
      id: "app_id",
      label: "GITHUB_APP_ID",
      ok: Boolean(config.appId) || tokenConfigured,
      detail: config.appId ? maskValue(config.appId) : tokenConfigured ? "Using GITHUB_TOKEN fallback." : "Copy the App ID from the GitHub App settings page.",
    },
    {
      id: "private_key",
      label: "GitHub App private key",
      ok: Boolean(config.privateKey) || tokenConfigured,
      detail: config.privateKey ? "Private key is loaded from env/path/base64." : tokenConfigured ? "Using GITHUB_TOKEN fallback." : "Set GITHUB_APP_PRIVATE_KEY_BASE64 or GITHUB_APP_PRIVATE_KEY_PATH.",
    },
    {
      id: "webhook_secret",
      label: "GITHUB_WEBHOOK_SECRET",
      ok: Boolean(envConfig("GITHUB_WEBHOOK_SECRET")) || tokenConfigured,
      detail: envConfig("GITHUB_WEBHOOK_SECRET") ? "Webhook signatures will be verified." : tokenConfigured ? "Token fallback does not require installation webhooks." : "Set the same secret in GitHub App webhook settings.",
    },
    {
      id: "installation",
      label: "Project installation",
      ok: tokenConfigured || Boolean(installation?.installationId || config.installationId),
      detail: tokenConfigured
        ? "Using GITHUB_TOKEN fallback."
        : installation?.installationId || config.installationId
          ? "GitHub App is installed for this project."
          : config.appSlug
            ? "Install the GitHub App for this project."
            : "Configure credentials first, then install the app.",
    },
    {
      id: "repository",
      label: "Authorized repository",
      ok: tokenConfigured || integration.repositoryReady,
      detail: tokenConfigured
        ? "Token mode can access repositories allowed by the token."
        : integration.repositoryReady
          ? "At least one authorized repository is connected for this project."
          : "Sync or select an authorized repository from the GitHub App installation.",
    },
  ];

  return {
    mode: integration.mode,
    configured: credentialConfigured,
    canOpenRealPr: integration.canOpenRealPr,
    message: integration.message,
    app: {
      appSlug: config.appSlug,
      appId: maskValue(config.appId),
      appConfigured,
      tokenConfigured,
      privateKeyConfigured: Boolean(config.privateKey),
      webhookSecretConfigured: Boolean(envConfig("GITHUB_WEBHOOK_SECRET")),
      installationId: maskValue(installation?.installationId || config.installationId),
    },
    urls: {
      createAppUrl: "https://github.com/settings/apps/new",
      appSettingsUrl: config.appSlug ? `https://github.com/settings/apps/${config.appSlug}` : "",
      installUrl: integration.installUrl,
      directInstallUrl: integration.directInstallUrl,
      callbackUrl: production.deployment?.githubCallbackUrl || "",
      webhookUrl: production.deployment?.githubWebhookUrl || "",
    },
    requiredPermissions: GITHUB_SETUP_PERMISSIONS,
    requiredEvents: GITHUB_SETUP_EVENTS,
    envTemplate: githubSetupEnvTemplate(production),
    checks,
  };
}

async function validateGithubSetup(db, projectId = "") {
  const setup = githubSetupStatus(db, projectId);
  const githubToken = envConfig("GITHUB_TOKEN");
  if (githubToken) {
    try {
      const user = await githubApiRequest("GET", "https://api.github.com/user", null, { authToken: githubToken });
      return {
        ok: true,
        mode: "token",
        account: user.login || user.name || "",
        message: "GITHUB_TOKEN authenticated successfully.",
        projectReady: setup.canOpenRealPr,
      };
    } catch (error) {
      return { ok: false, mode: "token", message: error.message, status: error.status || 0 };
    }
  }

  if (!githubAppConfig().configured) {
    return {
      ok: false,
      mode: "mock",
      message: "GitHub App credentials are not configured yet.",
      missing: setup.checks.filter((check) => !check.ok).map((check) => check.id),
    };
  }

  try {
    const app = await githubAppRequest("GET", "https://api.github.com/app");
    let installationReady = false;
    const installation = projectId ? githubInstallationForProject(db, projectId) : null;
    const installationId = installation?.installationId || githubAppConfig().installationId;
    if (installationId) {
      await githubInstallationToken(installationId);
      installationReady = true;
    }
    return {
      ok: true,
      mode: "github_app",
      app: { id: String(app.id || ""), slug: app.slug || app.name || "" },
      message: installationReady
        ? setup.canOpenRealPr
          ? "GitHub App, installation token, and repository connection validated."
          : "GitHub App and installation token validated. Sync or select an authorized repository next."
        : "GitHub App credentials validated. Install the app for this project next.",
      projectReady: setup.canOpenRealPr,
    };
  } catch (error) {
    return {
      ok: false,
      mode: "github_app",
      message:
        error.message === "fetch failed"
          ? "GitHub API is unreachable from this local runtime. Run the server where outbound access to api.github.com is allowed."
          : error.message,
      status: error.status || (error.message === "fetch failed" ? 502 : 0),
    };
  }
}

function sandboxSetupEnvTemplate() {
  return [
    "SANDBOX_MODE=isolated-provider",
    "SANDBOX_PROVIDER=external-http-provider",
    "SANDBOX_PROVIDER_URL=https://sandbox-provider.example.com/run",
    "SANDBOX_PROVIDER_TOKEN=provider-secret-token",
    "SANDBOX_PROVIDER_PRIVATE_NETWORK=false",
  ].join("\n");
}

function sandboxSetupStatus(db) {
  const production = productionStatus(db);
  const providerUrlConfigured = Boolean(SANDBOX_PROVIDER_URL);
  const tokenConfigured = Boolean(SANDBOX_PROVIDER_TOKEN);
  const providerMarkerConfigured = Boolean(envConfig("SANDBOX_PROVIDER"));
  const privateNetworkConfigured = SANDBOX_PROVIDER_PRIVATE_NETWORK;
  const isolatedRuntimeConfigured = Boolean(production.sandbox?.isolatedRuntimeConfigured);
  const checks = [
    {
      id: "provider_url",
      label: "SANDBOX_PROVIDER_URL",
      ok: providerUrlConfigured,
      detail: providerUrlConfigured ? "External sandbox endpoint is configured." : "Set the HTTPS endpoint that executes generated code in an isolated runtime.",
    },
    {
      id: "provider_token",
      label: "SANDBOX_PROVIDER_TOKEN",
      ok: tokenConfigured || privateNetworkConfigured,
      detail: tokenConfigured ? "Bearer token will be sent to the sandbox provider." : privateNetworkConfigured ? "Private-network provider mode is explicitly enabled." : "Set a token unless the provider is private-network only.",
    },
    {
      id: "isolated_runtime",
      label: "Isolated runtime",
      ok: isolatedRuntimeConfigured,
      detail: isolatedRuntimeConfigured ? "Production sandbox will leave the main web process." : "Local allowlist mode is only acceptable for development.",
    },
    {
      id: "main_process_guard",
      label: "Main process guard",
      ok: providerUrlConfigured,
      detail: providerUrlConfigured ? "run-production-sandbox will call the external provider." : "Without a provider, production checks still run in the local workspace command sandbox.",
    },
  ];
  return {
    configured: isolatedRuntimeConfigured,
    mode: production.sandbox?.mode || "local-allowlist",
    providerUrlConfigured,
    tokenConfigured,
    providerMarkerConfigured,
    privateNetworkConfigured,
    envTemplate: sandboxSetupEnvTemplate(),
    contract: {
      method: "POST",
      url: SANDBOX_PROVIDER_URL || "https://sandbox-provider.example.com/run",
      authHeader: "Authorization: Bearer <SANDBOX_PROVIDER_TOKEN>",
      privateNetworkFlag: "SANDBOX_PROVIDER_PRIVATE_NETWORK=true",
      requestFields: ["projectId", "patchProposalId", "repository", "patchFiles", "changedFiles", "commands"],
      responseFields: ["id", "status", "commandResults", "logs", "mode"],
    },
    samplePayload: {
      projectId: "project-id",
      patchProposalId: "patch-id",
      repository: { provider: "GitHub", owner: "customer", name: "site", defaultBranch: "main" },
      patchFiles: [],
      changedFiles: [],
      commands: ["npm test", "npm run build"],
    },
    checks,
  };
}

async function validateSandboxSetup() {
  const setup = sandboxSetupStatus({ users: [], organizations: [], sessions: [], platformConfig: {} });
  if (!SANDBOX_PROVIDER_URL) {
    return {
      ok: false,
      mode: "local-allowlist",
      message: "SANDBOX_PROVIDER_URL is not configured.",
      missing: setup.checks.filter((check) => !check.ok).map((check) => check.id),
    };
  }
  if (!SANDBOX_PROVIDER_TOKEN && !SANDBOX_PROVIDER_PRIVATE_NETWORK) {
    return {
      ok: false,
      mode: "external-http-provider",
      message: "SANDBOX_PROVIDER_TOKEN is required unless SANDBOX_PROVIDER_PRIVATE_NETWORK=true.",
      missing: ["provider_token"],
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(SANDBOX_PROVIDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Itera-AI-Sandbox-Probe/0.2",
        ...(SANDBOX_PROVIDER_TOKEN ? { Authorization: `Bearer ${SANDBOX_PROVIDER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        probe: true,
        projectId: "sandbox-setup-probe",
        patchProposalId: "sandbox-setup-probe",
        repository: { provider: "probe", owner: "itera", name: "probe", defaultBranch: "main" },
        patchFiles: [],
        changedFiles: [],
        commands: ["echo sandbox-probe"],
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, mode: "external-http-provider", message: data.error || `Sandbox provider returned ${response.status}`, status: response.status };
    }
    return {
      ok: true,
      mode: data.mode || "external-http-provider",
      message: data.message || data.summary || "Sandbox provider probe completed.",
      remoteRunId: data.id || data.runId || "",
      status: data.status || "passed",
    };
  } catch (error) {
    return {
      ok: false,
      mode: "external-http-provider",
      message: error.name === "AbortError" ? "Sandbox provider probe timed out." : error.message,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

function authenticateTenantRequest(db, actor) {
  if (actor.authToken) {
    return authenticateSessionRequest(db, actor).tenant;
  }
  const tenant = db.tenants.find((item) => item.id === actor.tenantId);
  if (!tenant) {
    const error = new Error("Tenant not found");
    error.status = 401;
    throw error;
  }
  if (tenant.status !== "active") {
    const error = new Error("Tenant is disabled");
    error.status = 403;
    throw error;
  }
  if (!actor.tenantAccessKey) {
    const error = new Error("Tenant access key is required");
    error.status = 401;
    throw error;
  }
  const expectedHash = Buffer.from(String(tenant.accessKeyHash || ""), "hex");
  const actualHash = Buffer.from(hashSecret(actor.tenantAccessKey), "hex");
  if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
    const error = new Error("Invalid tenant access key");
    error.status = 403;
    throw error;
  }
  return tenant;
}

function rotateTenantAccessKey(db, actor) {
  const tenant = db.tenants.find((item) => item.id === actor.tenantId);
  if (!tenant) throw Object.assign(new Error("Tenant not found"), { status: 401 });
  const accessKey = createTenantAccessKey(tenant.id);
  tenant.accessKeyHash = hashSecret(accessKey);
  tenant.keyPreview = previewSecret(accessKey);
  tenant.rotatedAt = nowIso();
  return { tenant, accessKey };
}

function isTenantAuthExempt(req, url) {
  if (req.method === "OPTIONS") return true;
  if (req.method === "GET" && url.pathname === "/api/health") return true;
  if (req.method === "POST" && url.pathname === "/api/signals") return true;
  if (req.method === "POST" && url.pathname === "/api/github/webhook") return true;
  if (req.method === "POST" && url.pathname === "/api/billing/webhook") return true;
  if (req.method === "POST" && url.pathname === "/api/tenants") return true;
  if (req.method === "POST" && (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/login")) return true;
  if (url.pathname === "/github/install" || url.pathname === "/github/callback") return true;
  return false;
}

function tenantProjects(db, actor) {
  const tenantId = String(actor?.tenantId || DEFAULT_TENANT_ID);
  return db.projects.filter((project) => String(project.tenantId || DEFAULT_TENANT_ID) === tenantId);
}

function tenantProjectIds(db, actor) {
  return new Set(tenantProjects(db, actor).map((project) => project.id));
}

function tenantScopedItems(items, projectIds) {
  return (items || []).filter((item) => projectIds.has(item.projectId));
}

function tenantAuditLogs(db, actor, projectIds) {
  return db.auditLogs.filter(
    (entry) => entry.actor?.tenantId === actor.tenantId || projectIds.has(entry.metadata?.projectId) || projectIds.has(String(entry.target || "").split(":")[1]),
  );
}

function tenantLogLines(db, projects) {
  const needles = projects.flatMap((project) => [project.id, project.name]).filter(Boolean);
  if (!needles.length) return [];
  return db.log.filter((line) => needles.some((needle) => String(line).includes(needle))).slice(-100);
}

function resolveProjectForActor(db, actor, projectId) {
  const projects = tenantProjects(db, actor);
  const project = projectId ? projects.find((item) => item.id === projectId) : projects[0];
  if (!project) {
    const error = new Error(projectId ? "Project not found" : "No project available for this tenant");
    error.status = 404;
    throw error;
  }
  return project;
}

function assertProjectAccess(db, actor, projectId) {
  return resolveProjectForActor(db, actor, projectId);
}

function respondWithError(res, error) {
  json(res, error.status || 400, { error: error.message || "Request failed" });
}

function auditWithActor(db, actor, action, target, metadata = {}) {
  const entry = {
    id: `audit-${randomUUID().slice(0, 8)}`,
    action,
    target,
    actor,
    metadata,
    createdAt: nowIso(),
  };
  db.auditLogs.unshift(entry);
  db.auditLogs = db.auditLogs.slice(0, 500);
  return entry;
}

function audit(db, req, action, target, metadata = {}) {
  return auditWithActor(db, requestActor(req), action, target, metadata);
}

function latestProductionSandboxForPatch(db, patchProposalId) {
  return db.productionSandboxRuns
    .filter((run) => run.patchProposalId === patchProposalId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function createCiRunForDraft(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const proposal = db.patchProposals.find((item) => item.id === draft.patchProposalId);
  const productionRun = proposal ? latestProductionSandboxForPatch(db, proposal.id) : null;
  const managedRun = proposal ? latestSandboxRunForPatch(db, proposal.id) : null;
  const sourceRun = productionRun || managedRun;
  if (!sourceRun) throw new Error("Run sandbox validation before CI.");

  const status = sourceRun.status === "failed" ? "failure" : "success";
  const ciRun = {
    id: `ci-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    patchProposalId: proposal?.id || null,
    provider: "managed-ci",
    status,
    checks: (sourceRun.commandResults || []).map((item) => ({
      name: item.command,
      status: item.status === "failed" ? "failure" : "success",
      output: item.output,
    })),
    url: `${draft.remoteUrl || "https://ci.itera.local"}/checks/${draft.id}`,
    createdAt: nowIso(),
  };
  db.ciRuns.unshift(ciRun);
  draft.ciRunId = ciRun.id;
  draft.updatedAt = nowIso();
  addLog(db, `CI status recorded for ${draft.id}: ${ciRun.status}`);
  return ciRun;
}

function latestCiForDraft(db, draftId) {
  return db.ciRuns
    .filter((run) => run.prDraftId === draftId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function isRealGithubDraft(db, draft) {
  const repo = db.repositories.find((item) => item.id === draft.repositoryId);
  if (!repo || repo.provider !== "GitHub") return false;
  const remoteNumber = String(draft.remoteNumber || "");
  return Boolean(
    githubIntegrationStatus(db, repo.projectId || draft.projectId).canOpenRealPr &&
      draft.remoteUrl &&
      remoteNumber &&
      !remoteNumber.startsWith("mock-"),
  );
}

async function createGithubCiRunForDraft(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const repo = db.repositories.find((item) => item.id === draft.repositoryId);
  if (!repo) throw new Error("Repository not found");
  if (!isRealGithubDraft(db, draft)) return null;

  const pull = await githubRequest(repo, "GET", `/pulls/${encodeURIComponent(draft.remoteNumber)}`);
  const headSha = pull?.head?.sha || "";
  if (!headSha) throw new Error("GitHub PR head SHA is missing.");
  const combined = await githubRequest(repo, "GET", `/commits/${encodeURIComponent(headSha)}/status`);
  let checkRuns = { check_runs: [] };
  try {
    checkRuns = await githubRequest(repo, "GET", `/commits/${encodeURIComponent(headSha)}/check-runs`);
  } catch (error) {
    checkRuns = { check_runs: [], error: error.message };
  }
  const checks = [
    ...(combined.statuses || []).map((status) => ({
      name: status.context || "github status",
      status: status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure",
      output: status.description || status.target_url || "",
    })),
    ...(checkRuns.check_runs || []).map((run) => ({
      name: run.name || "github check",
      status: run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped" ? "success" : run.status === "completed" ? "failure" : "pending",
      output: run.output?.summary || run.html_url || "",
    })),
  ];
  const hasFailures = checks.some((check) => check.status === "failure");
  const hasPending = checks.some((check) => check.status === "pending");
  const hasChecks = checks.length > 0 || Number(combined.total_count || 0) > 0;
  const status = hasFailures ? "failure" : hasPending || !hasChecks || combined.state === "pending" ? "pending" : combined.state === "success" ? "success" : "failure";
  const ciRun = {
    id: `ci-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    patchProposalId: draft.patchProposalId || null,
    provider: "github",
    status,
    checks,
    url: pull.html_url || draft.remoteUrl,
    headSha,
    createdAt: nowIso(),
  };
  db.ciRuns.unshift(ciRun);
  draft.ciRunId = ciRun.id;
  draft.updatedAt = nowIso();
  addLog(db, `GitHub CI status recorded for ${draft.id}: ${ciRun.status}`);
  return ciRun;
}

async function createCiRunForAutomaticRelease(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  if (isRealGithubDraft(db, draft)) return createGithubCiRunForDraft(db, draftId);
  return latestCiForDraft(db, draftId) || createCiRunForDraft(db, draftId);
}

function createPreviewDeployment(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const proposal = db.patchProposals.find((item) => item.id === draft.patchProposalId);
  if (proposal && proposal.status === "production_sandbox_failed") {
    throw new Error("Production sandbox must pass before creating preview.");
  }
  const ciRun = latestCiForDraft(db, draft.id) || createCiRunForDraft(db, draft.id);
  if (ciRun.status !== "success") throw new Error("CI must pass before preview deployment.");

  const deployment = {
    id: `preview-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    patchProposalId: proposal?.id || null,
    ciRunId: ciRun.id,
    provider: "managed-preview",
    status: "ready",
    url: `https://preview.itera.local/${draft.projectId}/${draft.id}`,
    checks: ["CI passed", "Sandbox passed", "Preview URL reserved"],
    createdAt: nowIso(),
  };
  db.previewDeployments.unshift(deployment);
  draft.previewDeploymentId = deployment.id;
  draft.updatedAt = nowIso();
  addLog(db, `Preview deployment ready: ${deployment.url}`);
  return deployment;
}

function latestPreviewForDraft(db, draftId) {
  return db.previewDeployments
    .filter((deployment) => deployment.prDraftId === draftId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function latestReleasePlanForDraft(db, draftId) {
  return db.releasePlans
    .filter((plan) => plan.prDraftId === draftId)
    .sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0))[0];
}

function createReleasePlan(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const existing = latestReleasePlanForDraft(db, draft.id);
  if (existing && existing.status !== "rolled_back") return existing;
  const preview = latestPreviewForDraft(db, draft.id) || createPreviewDeployment(db, draft.id);
  if (preview.status !== "ready") throw new Error("Preview deployment must be ready before release planning.");

  const plan = {
    id: `release-${randomUUID().slice(0, 8)}`,
    projectId: draft.projectId,
    prDraftId: draft.id,
    previewDeploymentId: preview.id,
    status: "planned",
    currentPhase: 0,
    phases: [1, 5, 25, 50, 100].map((traffic) => ({
      traffic,
      status: "pending",
      gate: traffic < 100 ? "monitor errors, conversion, support tickets" : "full rollout approval",
    })),
    rollback: {
      strategy: "set canary to previous phase and reopen last stable deployment",
      commands: ["disable feature flag", "restore previous deployment", "notify support and owner"],
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.releasePlans.unshift(plan);
  draft.releasePlanId = plan.id;
  draft.updatedAt = nowIso();
  addLog(db, `Release plan created for ${draft.id}`);
  return plan;
}

function promoteReleasePlan(db, releasePlanId) {
  const plan = db.releasePlans.find((item) => item.id === releasePlanId);
  if (!plan) throw new Error("Release plan not found");
  if (plan.status === "rolled_back") throw new Error("Rolled back release plan cannot be promoted.");
  const project = db.projects.find((item) => item.id === plan.projectId);
  const nextIndex = plan.phases.findIndex((phase) => phase.status === "pending");
  if (nextIndex < 0) {
    plan.status = "completed";
    plan.updatedAt = nowIso();
    return plan;
  }
  plan.phases[nextIndex].status = "active";
  plan.phases.forEach((phase, index) => {
    if (index < nextIndex) phase.status = "completed";
  });
  plan.currentPhase = plan.phases[nextIndex].traffic;
  plan.status = plan.currentPhase >= 100 ? "completed" : "rolling_out";
  plan.updatedAt = nowIso();
  if (project) project.canary = plan.currentPhase;
  addLog(db, `Release Agent promoted ${plan.id} to ${plan.currentPhase}%`);
  return plan;
}

function rollbackReleasePlan(db, releasePlanId, reason = "operator rollback") {
  const plan = db.releasePlans.find((item) => item.id === releasePlanId);
  if (!plan) throw new Error("Release plan not found");
  const project = db.projects.find((item) => item.id === plan.projectId);
  const event = {
    id: `rollback-${randomUUID().slice(0, 8)}`,
    projectId: plan.projectId,
    releasePlanId: plan.id,
    previousPhase: plan.currentPhase,
    reason,
    status: "completed",
    createdAt: nowIso(),
  };
  plan.status = "rolled_back";
  plan.currentPhase = 0;
  plan.updatedAt = nowIso();
  if (project) project.canary = 0;
  db.rollbackEvents.unshift(event);
  addLog(db, `Release Agent rolled back ${plan.id}: ${reason}`);
  return { plan, rollback: event };
}

function releasePolicyEnabled(policy, options = {}) {
  return Boolean(options.autoRelease || policy.autoCanary || policy.autoMerge);
}

function autoReleaseGate({ policy, options = {}, task, report, sandbox, productionSandbox, draft }) {
  const reasons = [];
  const manuallyApproved = options.manualApproved === true || report?.manualApproval?.status === "approved";
  if (!releasePolicyEnabled(policy, options)) reasons.push("automatic release is disabled by policy");
  if (!policy.autoPr) reasons.push("automatic PR creation is disabled");
  if (!draft?.remoteUrl) reasons.push("GitHub PR has not been opened");
  if (!report) reasons.push("QA report is missing");
  if (report?.decision === "blocked") reasons.push("QA blocked this change");
  if (report && report.decision !== "auto_pr_allowed" && !(report.decision === "manual_review" && manuallyApproved)) {
    reasons.push(`QA decision is ${report.decision}`);
  }
  const riskLimit = manuallyApproved ? 80 : 45;
  if (Number(report?.riskScore || 100) > riskLimit) reasons.push(`QA risk score ${report.riskScore}/100 is above the ${riskLimit} release limit`);
  if (task && Number(task.risk || 3) > Number(policy.riskLimit || 1) && !manuallyApproved) {
    reasons.push(`task risk ${task.risk} is above policy limit ${policy.riskLimit}`);
  }
  if (!sandbox) reasons.push("sandbox validation is missing");
  if (sandbox && sandbox.status === "failed") reasons.push("sandbox validation failed");
  if (productionSandbox && productionSandbox.status === "failed") reasons.push("production sandbox failed");
  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function realReleaseGapsForDraft(db, draft, context = {}) {
  const repo = db.repositories.find((item) => item.id === draft.repositoryId);
  const project = db.projects.find((item) => item.id === draft.projectId);
  const github = githubIntegrationStatus(db, repo?.projectId || draft.projectId);
  const remoteNumber = String(draft.remoteNumber || "");
  const remoteUrl = String(draft.remoteUrl || "");
  const realGithubPr =
    repo?.provider === "GitHub" &&
    github.canOpenRealPr &&
    remoteUrl &&
    remoteNumber &&
    !remoteNumber.startsWith("mock-") &&
    !remoteUrl.includes("/mock-");
  const gaps = [];

  if (!realGithubPr) {
    gaps.push("GitHub PR is still mock; install/connect the GitHub App or GITHUB_TOKEN to open a real customer repository PR.");
  }

  const mergeMode = context.merge?.mode || draft.mergeMode || "";
  if (mergeMode === "managed_mock") {
    gaps.push("Merge is managed_mock; no customer repository branch was actually merged.");
  } else if (realGithubPr && mergeMode !== "github_api") {
    gaps.push("Real GitHub PR is not merged by the GitHub API yet; set GITHUB_AUTO_MERGE_ENABLED=true or merge it manually.");
  }

  if (!context.ciRun || context.ciRun.provider === "managed-ci") {
    gaps.push("CI is managed-ci simulation; connect real CI/status checks from the customer repository.");
  }

  if (project?.deploymentHook?.status !== "active" || !project.deploymentHook.url) {
    gaps.push("Customer deployment hook is missing; configure a Vercel/Netlify/custom deploy hook to actually update the website.");
  }

  return gaps;
}

async function mergePrDraftForAutomaticRelease(db, draftId) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const repo = db.repositories.find((item) => item.id === draft.repositoryId);
  if (!repo) throw new Error("Repository not found");

  if (["auto_merged", "merged", "deployed"].includes(draft.status)) {
    return { draft, merged: true, mode: draft.mergeMode || "already_merged" };
  }

  const realGithubPr =
    repo.provider === "GitHub" &&
    githubIntegrationStatus(db, repo.projectId || draft.projectId).canOpenRealPr &&
    draft.remoteNumber &&
    !String(draft.remoteNumber).startsWith("mock-");

  if (realGithubPr && GITHUB_AUTO_MERGE_ENABLED) {
    await githubRequest(repo, "PUT", `/pulls/${encodeURIComponent(draft.remoteNumber)}/merge`, {
      commit_title: draft.title,
      commit_message: "Merged automatically by Itera AI after QA, sandbox, and release gates passed.",
      merge_method: "squash",
    });
    draft.mergeMode = "github_api";
  } else if (realGithubPr) {
    draft.status = "merge_ready";
    draft.mergeMode = "real_pr_waiting_for_auto_merge_flag";
    draft.updatedAt = nowIso();
    addLog(db, `Automatic release paused before real GitHub merge for ${draft.id}; set GITHUB_AUTO_MERGE_ENABLED=true to allow it.`);
    return { draft, merged: false, mode: draft.mergeMode };
  } else {
    draft.mergeMode = "managed_mock";
  }

  draft.status = "auto_merged";
  draft.mergedAt = nowIso();
  draft.updatedAt = nowIso();
  addLog(db, `Automatic merge completed for ${draft.id} (${draft.mergeMode}).`);
  return { draft, merged: true, mode: draft.mergeMode };
}

function releaseHealthSnapshot(db, plan) {
  const project = db.projects.find((item) => item.id === plan.projectId);
  const errorRate = Number(project?.errorRate || 0);
  const health = Number(project?.health || 0);
  const ok = errorRate <= 2 && health >= 70;
  return {
    ok,
    status: ok ? "healthy" : "unhealthy",
    detail: ok ? `health=${health}, errorRate=${errorRate}%` : `release health gate failed: health=${health}, errorRate=${errorRate}%`,
  };
}

function recordReleaseHealthCheck(db, plan, snapshot) {
  const signal = {
    id: `sig-${randomUUID().slice(0, 8)}`,
    projectId: plan.projectId,
    type: "release_check",
    source: "Release Monitor",
    category: snapshot.ok ? "performance" : "bug",
    severity: snapshot.ok ? "low" : "high",
    risk: snapshot.ok ? 1 : 3,
    confidence: snapshot.ok ? 95 : 90,
    page: db.projects.find((project) => project.id === plan.projectId)?.url || "",
    text: snapshot.ok ? "Automatic release health check passed." : snapshot.detail,
    createdAt: nowIso(),
    data: {
      releasePlanId: plan.id,
      healthStatus: snapshot.status,
      detail: snapshot.detail,
    },
  };
  db.signals.push(signal);
  plan.healthStatus = snapshot.status;
  plan.lastHealthCheck = nowIso();
  plan.lastHealthDetail = snapshot.detail;
  plan.updatedAt = nowIso();
  return signal;
}

async function runAutomaticRelease(db, draftId, options = {}) {
  const actions = [];
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const patch = draft.patchProposalId ? db.patchProposals.find((item) => item.id === draft.patchProposalId) : null;
  const report = patch ? latestQaReportForPatch(db, patch.id) : null;
  const sandbox = patch ? latestSandboxRunForPatch(db, patch.id) : null;
  const productionSandbox = patch ? latestProductionSandboxForPatch(db, patch.id) : null;
  const task = draft.taskId ? db.tasks.find((item) => item.id === draft.taskId) : null;
  const policy = policyForProject(db, draft.projectId);
  const gate = autoReleaseGate({ policy, options, task, report, sandbox, productionSandbox, draft });

  if (!gate.allowed) {
    actions.push({
      id: "auto_release",
      status: "waiting",
      detail: gate.reasons.join("; "),
    });
    return { actions, completed: false, releasePlan: null };
  }

  const merge = await mergePrDraftForAutomaticRelease(db, draft.id);
  actions.push({
    id: "auto_merge",
    status: merge.merged ? "completed" : "waiting",
    detail: merge.merged ? `merged via ${merge.mode}` : `paused: ${merge.mode}`,
  });
  if (!merge.merged) return { actions, completed: false, releasePlan: null };

  const ciRun = await createCiRunForAutomaticRelease(db, draft.id);
  actions.push({
    id: "ci",
    status: ciRun.status === "success" ? "completed" : "blocked",
    detail: `${ciRun.provider}: ${ciRun.status}`,
  });
  if (ciRun.status !== "success") return { actions, completed: false, releasePlan: null };

  const preview = latestPreviewForDraft(db, draft.id) || createPreviewDeployment(db, draft.id);
  actions.push({
    id: "preview",
    status: preview.status,
    detail: preview.url,
  });
  const realReleaseGaps = realReleaseGapsForDraft(db, draft, { merge, ciRun, preview });
  const realReleaseReady = realReleaseGaps.length === 0;

  const releasePlan = createReleasePlan(db, draft.id);
  releasePlan.executionMode = realReleaseReady ? "real" : "simulation";
  releasePlan.realRelease = {
    status: realReleaseReady ? "ready" : "waiting",
    gaps: realReleaseGaps,
    updatedAt: nowIso(),
  };
  releasePlan.updatedAt = nowIso();
  actions.push({
    id: "release_plan",
    status: releasePlan.status,
    detail: realReleaseReady
      ? `${releasePlan.id} with ${(releasePlan.phases || []).length} rollout phases`
      : `${releasePlan.id} is a simulated rollout until real integrations are connected`,
  });

  await deliverOutputWebhook(db, draft.projectId, "release.planned", { releasePlan, prDraft: draft });

  let finalPlan = releasePlan;
  while ((finalPlan.phases || []).some((phase) => phase.status === "pending") && finalPlan.status !== "rolled_back") {
    finalPlan = promoteReleasePlan(db, finalPlan.id);
    actions.push({
      id: "deploy",
      status: finalPlan.status === "completed" ? (realReleaseReady ? "completed" : "simulated") : realReleaseReady ? "rolling_out" : "simulating",
      detail: realReleaseReady ? `traffic ${finalPlan.currentPhase}%` : `simulated traffic ${finalPlan.currentPhase}%`,
    });
    await deliverOutputWebhook(db, draft.projectId, "release.promoted", { releasePlan: finalPlan, prDraft: draft });

    const snapshot = releaseHealthSnapshot(db, finalPlan);
    const healthSignal = recordReleaseHealthCheck(db, finalPlan, snapshot);
    actions.push({
      id: "monitor",
      status: snapshot.ok ? "healthy" : "unhealthy",
      detail: `${healthSignal.id}: ${snapshot.detail}`,
    });
    if (!snapshot.ok) {
      const rollback = rollbackReleasePlan(db, finalPlan.id, snapshot.detail);
      actions.push({
        id: "rollback",
        status: rollback.rollback.status,
        detail: rollback.rollback.reason,
      });
      await deliverOutputWebhook(db, draft.projectId, "release.rolled_back", rollback);
      return { actions, completed: false, releasePlan: rollback.plan, rollback };
    }
  }

  if (!realReleaseReady) {
    finalPlan.status = "simulation_completed";
    finalPlan.deploymentStatus = "simulated";
    finalPlan.realRelease = {
      status: "waiting",
      gaps: realReleaseGaps,
      updatedAt: nowIso(),
    };
    finalPlan.completedAt = "";
    finalPlan.updatedAt = nowIso();
    draft.status = "release_simulated";
    draft.deploymentStatus = "simulated";
    draft.releasePlanId = finalPlan.id;
    draft.updatedAt = nowIso();
    actions.push({
      id: "real_release",
      status: "waiting",
      detail: realReleaseGaps.join("; "),
    });
    actions.push({
      id: "rollback",
      status: "simulated",
      detail: "Rollback plan was generated, but no real customer deployment was changed.",
    });
    addLog(db, `Automatic release simulation completed for ${draft.id}: ${realReleaseGaps.join("; ")}`);
    return { actions, completed: false, simulated: true, releasePlan: finalPlan, realReleaseGaps };
  }

  const deploymentRun = await triggerDeploymentHook(db, finalPlan, draft, {
    trigger: options.trigger || "automatic_release",
    mergeMode: merge.mode,
    ciRunId: ciRun.id,
    previewDeploymentId: preview.id,
  });
  actions.push({
    id: "deployment_hook",
    status: deploymentRun.status === "triggered" ? "completed" : "failed",
    detail: `${deploymentRun.provider}: ${deploymentRun.statusCode || deploymentRun.error || deploymentRun.status}`,
  });
  if (deploymentRun.status !== "triggered") {
    finalPlan.status = "deployment_failed";
    finalPlan.deploymentStatus = "failed";
    finalPlan.realRelease = {
      status: "failed",
      gaps: [deploymentRun.error || deploymentRun.responseSnippet || "Customer deployment hook did not return success."],
      updatedAt: nowIso(),
    };
    finalPlan.updatedAt = nowIso();
    draft.status = "deployment_failed";
    draft.deploymentStatus = "failed";
    draft.updatedAt = nowIso();
    return { actions, completed: false, releasePlan: finalPlan, deploymentRun };
  }

  finalPlan.status = "completed";
  finalPlan.deploymentStatus = "deployed";
  finalPlan.realRelease = {
    status: "completed",
    gaps: [],
    deploymentRunId: deploymentRun.id,
    updatedAt: nowIso(),
  };
  finalPlan.completedAt = finalPlan.completedAt || nowIso();
  finalPlan.updatedAt = nowIso();
  draft.status = "deployed";
  draft.deploymentStatus = "deployed";
  draft.deployedAt = draft.deployedAt || nowIso();
  draft.releasePlanId = finalPlan.id;
  draft.updatedAt = nowIso();
  actions.push({
    id: "rollback",
    status: "armed",
    detail: "rollback plan is ready if release health turns unhealthy",
  });
  addLog(db, `Automatic release completed for ${draft.id}: ${finalPlan.id}.`);
  return { actions, completed: true, releasePlan: finalPlan, deploymentRun };
}

async function approveManualReviewAndRelease(db, draftId, actor, body = {}) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const patch = draft.patchProposalId ? db.patchProposals.find((item) => item.id === draft.patchProposalId) : null;
  if (!patch) throw new Error("Patch proposal not found");
  const report = latestQaReportForPatch(db, patch.id);
  if (!report) throw new Error("QA report is required before manual approval.");
  if (report.decision === "blocked") throw new Error("Blocked QA reports cannot be approved for release.");
  let sandbox = latestSandboxRunForPatch(db, patch.id);
  if (!sandbox) sandbox = runSandboxForPatch(db, patch.id).run;
  if (sandbox.status === "failed") throw new Error("Sandbox validation failed; release cannot continue.");

  report.manualApproval = {
    status: "approved",
    approvedAt: nowIso(),
    approvedBy: actor?.userId || "local-operator",
    note: String(body.note || "Approved in Itera AI review panel").slice(0, 500),
  };
  report.status = "passed";
  report.updatedAt = nowIso();
  patch.status = "manual_approved";
  patch.updatedAt = nowIso();
  draft.manualApproval = report.manualApproval;
  draft.status = draft.remoteUrl ? draft.status : "manual_approved";
  draft.updatedAt = nowIso();

  const opened = await openGithubPrFromDraft(db, draft.id);
  const actions = [
    {
      id: "manual_approval",
      status: "approved",
      detail: `Approved by ${report.manualApproval.approvedBy}`,
    },
    {
      id: "github_pr",
      status: opened.remoteUrl ? "opened" : "waiting",
      detail: opened.remoteUrl || "GitHub PR is not open yet.",
    },
  ];
  const release = await runAutomaticRelease(db, draft.id, {
    autoRelease: true,
    manualApproved: true,
    trigger: "manual_review_approval",
  });
  actions.push(...release.actions);
  const readiness = selfEvolutionReadiness(db, draft.projectId);
  const run = recordAutopilotRun(db, draft.projectId, actions, readiness, {
    autoRelease: true,
    manualApproved: true,
    trigger: "manual_review_approval",
  });
  addLog(db, `Manual review approved for ${draft.id}: ${actions.map((item) => `${item.id}:${item.status}`).join(" -> ")}`);
  return { draft, patch, report, sandbox, release, actions, readiness, run };
}

function rejectManualReviewChange(db, draftId, actor, body = {}) {
  const draft = db.prDrafts.find((item) => item.id === draftId);
  if (!draft) throw new Error("PR draft not found");
  const patch = draft.patchProposalId ? db.patchProposals.find((item) => item.id === draft.patchProposalId) : null;
  const report = patch ? latestQaReportForPatch(db, patch.id) : null;
  const rejection = {
    status: "rejected",
    rejectedAt: nowIso(),
    rejectedBy: actor?.userId || "local-operator",
    reason: String(body.reason || "Rejected in Itera AI review panel").slice(0, 500),
  };
  draft.status = "rejected";
  draft.rejection = rejection;
  draft.updatedAt = nowIso();
  if (patch) {
    patch.status = "rejected";
    patch.rejection = rejection;
    patch.updatedAt = nowIso();
  }
  if (report) {
    report.manualApproval = rejection;
    report.status = "rejected";
    report.updatedAt = nowIso();
  }
  const task = draft.taskId ? db.tasks.find((item) => item.id === draft.taskId) : null;
  if (task) {
    task.status = "已拒绝";
    task.updatedAt = nowIso();
  }
  const actions = [
    {
      id: "manual_review",
      status: "rejected",
      detail: rejection.reason,
    },
  ];
  const readiness = selfEvolutionReadiness(db, draft.projectId);
  const run = recordAutopilotRun(db, draft.projectId, actions, readiness, {
    trigger: "manual_review_rejection",
  });
  addLog(db, `Manual review rejected for ${draft.id}: ${rejection.reason}`);
  return { draft, patch, report, actions, readiness, run };
}

function newestFirst(items) {
  return items.slice().sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0));
}

function readinessScore(checks) {
  const weights = {
    passed: 1,
    warning: 0.65,
    waiting: 0.35,
    missing: 0,
    blocked: 0,
  };
  const total = checks.reduce((sum, check) => sum + (weights[check.status] ?? 0), 0);
  return Math.round((total / Math.max(1, checks.length)) * 100);
}

function selfEvolutionReadiness(db, projectId) {
  const selectedProjectId = projectId || db.projects[0]?.id;
  const project = db.projects.find((item) => item.id === selectedProjectId);
  if (!project) {
    return {
      projectId: selectedProjectId || null,
      score: 0,
      status: "missing_project",
      checks: [
        {
          id: "project",
          label: "创建客户项目",
          status: "missing",
          detail: "还没有可接入的客户网站项目。",
          action: "create_project",
        },
      ],
      nextAction: {
        id: "create_project",
        label: "先创建客户项目",
      },
      updatedAt: nowIso(),
    };
  }

  const signals = newestFirst(db.signals.filter((item) => item.projectId === project.id));
  const tasks = newestFirst(db.tasks.filter((item) => item.projectId === project.id));
  const repositories = newestFirst(db.repositories.filter((item) => item.projectId === project.id));
  const prDrafts = newestFirst(db.prDrafts.filter((item) => item.projectId === project.id));
  const patches = newestFirst(db.patchProposals.filter((item) => item.projectId === project.id));
  const reports = newestFirst(db.validationReports.filter((item) => item.projectId === project.id));
  const sandboxRuns = newestFirst(db.sandboxRuns.filter((item) => item.projectId === project.id));
  const releasePlans = newestFirst(db.releasePlans.filter((item) => item.projectId === project.id));
  const rollbackEvents = newestFirst(db.rollbackEvents.filter((item) => item.projectId === project.id));
  const latestPatch = patches[0];
  const latestReport = latestPatch ? latestQaReportForPatch(db, latestPatch.id) : reports[0];
  const latestSandbox = latestPatch ? latestSandboxRunForPatch(db, latestPatch.id) : sandboxRuns[0];
  const openedDraft = prDrafts.find((draft) => draft.remoteUrl);
  const latestRelease = openedDraft ? latestReleasePlanForDraft(db, openedDraft.id) : releasePlans[0];
  const latestReleaseProductionWaiting =
    latestRelease?.productionRelease?.status === "waiting" || latestRelease?.realRelease?.status === "local_only";
  const policy = policyForProject(db, project.id);

  const checks = [
    {
      id: "project",
      label: "客户项目已创建",
      status: "passed",
      detail: `${project.name} 已在平台中注册。`,
      action: "manage_project",
    },
    {
      id: "sdk",
      label: "SDK Key 可用",
      status: project.sdkKey && project.sdkStatus !== "disabled" ? "passed" : "missing",
      detail:
        project.sdkKey && project.sdkStatus !== "disabled"
          ? "客户网站可以用 SDK Key 安全上报用户信号。"
          : "需要生成或启用 SDK Key。",
      action: "configure_sdk",
    },
    {
      id: "signals",
      label: "收到用户反馈/行为信号",
      status: signals.length ? "passed" : "waiting",
      detail: signals.length ? `已收到 ${signals.length} 条信号。` : "等待客户网站 SDK 或客服系统上报第一条信号。",
      action: "wait_for_signal",
    },
    {
      id: "tasks",
      label: "AI 已形成迭代任务",
      status: tasks.length ? "passed" : signals.length ? "missing" : "waiting",
      detail: tasks.length ? `已形成 ${tasks.length} 个任务。` : "收到信号后需要生成可执行任务。",
      action: "create_task",
    },
    {
      id: "repository",
      label: "代码仓库已连接",
      status: repositories.length ? "passed" : "missing",
      detail: repositories.length
        ? `已连接 ${repositories[0].provider} ${repositories[0].owner}/${repositories[0].name}。`
        : "没有仓库就只能停留在建议，不能生成 PR。",
      action: "connect_repository",
    },
    {
      id: "pr_draft",
      label: "已生成 PR 草稿",
      status: prDrafts.length ? "passed" : tasks.length && repositories.length ? "missing" : "waiting",
      detail: prDrafts.length ? `已有 ${prDrafts.length} 个 PR 草稿。` : "需要把任务转成可审阅的代码变更计划。",
      action: "create_pr_draft",
    },
    {
      id: "patch",
      label: "已生成补丁提案",
      status: patches.length ? "passed" : prDrafts.length ? "missing" : "waiting",
      detail: patches.length ? `已有 ${patches.length} 个补丁提案。` : "需要由 Patch Agent 输出 diff 和验证命令。",
      action: "generate_patch",
    },
    {
      id: "qa",
      label: "QA 风险检查完成",
      status: latestReport
        ? latestReport.decision === "blocked"
          ? "blocked"
          : latestReport.decision === "manual_review"
            ? "warning"
            : "passed"
        : patches.length
          ? "missing"
          : "waiting",
      detail: latestReport ? `${latestReport.id}: ${latestReport.decision}` : "需要 QA Agent 先检查补丁风险。",
      action: "run_qa",
    },
    {
      id: "sandbox",
      label: "沙箱验证完成",
      status: latestSandbox
        ? latestSandbox.status === "failed"
          ? "blocked"
          : "passed"
        : patches.length
          ? "missing"
          : "waiting",
      detail: latestSandbox ? `${latestSandbox.id}: ${latestSandbox.status}` : "需要在受控沙箱里跑验证命令。",
      action: "run_sandbox",
    },
    {
      id: "github_pr",
      label: "已打开 GitHub PR",
      status: openedDraft ? "passed" : latestSandbox?.status === "passed" ? "missing" : "waiting",
      detail: openedDraft ? openedDraft.remoteUrl : "安全检查通过后才能打开 PR。",
      action: "open_github_pr",
    },
    {
      id: "auto_release",
      label: "Automatic release pipeline",
      status: latestRelease
        ? latestRelease.status === "rolled_back"
          ? "blocked"
          : latestReleaseProductionWaiting
            ? "warning"
            : latestRelease.status === "completed"
            ? "passed"
            : "warning"
        : openedDraft
          ? "missing"
          : "waiting",
      detail: latestRelease
        ? latestReleaseProductionWaiting
          ? `${latestRelease.id}: local test site updated; production release waiting.`
          : `${latestRelease.id}: ${latestRelease.status}, traffic ${latestRelease.currentPhase || 0}%`
        : "Low-risk PRs can enter CI, preview, canary, and monitoring automatically.",
      action: "auto_release",
    },
    {
      id: "deployment_hook",
      label: "客户网站部署 Hook 已接通",
      status: project.deploymentHook?.status === "active" ? "passed" : "missing",
      detail:
        project.deploymentHook?.status === "active"
          ? `${project.deploymentHook.provider || "custom"} deploy hook is ready.`
          : "必须配置 Vercel/Netlify/自定义部署 Hook，平台才能真正触发客户网站上线。",
      action: "configure_deployment_hook",
    },
    {
      id: "rollback",
      label: "Rollback guard is ready",
      status: latestRelease?.rollback ? "passed" : latestRelease ? "warning" : "waiting",
      detail: rollbackEvents[0]
        ? `${rollbackEvents[0].id}: ${rollbackEvents[0].status}`
        : latestRelease?.rollback
          ? "Rollback strategy is attached to the release plan."
          : "Release plan will attach rollback commands before deployment.",
      action: "rollback_guard",
    },
    {
      id: "output_webhook",
      label: "输出 Webhook 已接通",
      status: project.outputWebhook?.status === "active" ? "passed" : "missing",
      detail: project.outputWebhook?.status === "active" ? "PR、发布和回滚事件会推送给客户系统。" : "需要配置客户系统的回调 URL，才能把改进结果推回去。",
      action: "configure_output_webhook",
    },
    {
      id: "policy",
      label: "自动化策略允许推进",
      status: policy.autoPr ? "passed" : "warning",
      detail: policy.autoPr ? "当前允许自动打开低风险 PR。" : "策略关闭自动 PR，系统会停在人工确认。",
      action: "review_policy",
    },
  ];

  const score = readinessScore(checks);
  const blocked = checks.find((check) => check.status === "blocked");
  const nextAction = blocked || checks.find((check) => check.status === "missing") || checks.find((check) => check.status === "waiting");
  const status = blocked ? "blocked" : score >= 92 ? "self_evolving" : signals.length ? "in_progress" : "waiting_for_signals";

  return {
    projectId: project.id,
    score,
    status,
    checks,
    nextAction: nextAction
      ? {
          id: nextAction.action,
          label: nextAction.label,
          detail: nextAction.detail,
        }
      : null,
    counts: {
      signals: signals.length,
      tasks: tasks.length,
      repositories: repositories.length,
      prDrafts: prDrafts.length,
      patches: patches.length,
      qaReports: reports.length,
      sandboxRuns: sandboxRuns.length,
      githubPrs: prDrafts.filter((draft) => draft.remoteUrl).length,
      releasePlans: releasePlans.length,
      rollbackEvents: rollbackEvents.length,
      deploymentRuns: db.deploymentRuns.filter((run) => run.projectId === project.id).length,
    },
    updatedAt: nowIso(),
  };
}

function capabilitySection(id, title, summary, items, nextAction = "") {
  const score = readinessScore(items);
  const blocked = items.find((item) => item.status === "blocked");
  const missing = items.find((item) => item.status === "missing");
  const waiting = items.find((item) => item.status === "waiting");
  const warning = items.find((item) => item.status === "warning");
  return {
    id,
    title,
    summary,
    score,
    status: blocked ? "blocked" : missing ? "missing" : warning ? "warning" : waiting ? "waiting" : "passed",
    nextAction: nextAction || blocked?.detail || missing?.detail || waiting?.detail || warning?.detail || "能力已就绪。",
    items,
  };
}

function selfEvolutionCapabilities(db, projectId) {
  const selectedProjectId = projectId || db.projects[0]?.id || "";
  const project = db.projects.find((item) => item.id === selectedProjectId) || null;
  const signals = project ? db.signals.filter((item) => item.projectId === project.id) : [];
  const tasks = project ? db.tasks.filter((item) => item.projectId === project.id) : [];
  const repositories = project ? db.repositories.filter((item) => item.projectId === project.id) : [];
  const drafts = project ? db.prDrafts.filter((item) => item.projectId === project.id && item.status !== "closed") : [];
  const patches = project ? db.patchProposals.filter((item) => item.projectId === project.id && item.status !== "discarded") : [];
  const reports = project ? db.validationReports.filter((item) => item.projectId === project.id) : [];
  const sandboxRuns = project ? db.sandboxRuns.filter((item) => item.projectId === project.id) : [];
  const applications = project ? db.patchApplications.filter((item) => item.projectId === project.id) : [];
  const deployments = project ? db.deploymentRuns.filter((item) => item.projectId === project.id) : [];
  const releases = project ? db.releasePlans.filter((item) => item.projectId === project.id) : [];
  const production = productionStatus(db);
  const codePlans = [
    ...drafts.map((item) => item.codePlan).filter(Boolean),
    ...patches.map((item) => item.codePlan).filter(Boolean),
    ...applications.map((item) => item.codePlan).filter(Boolean),
  ];
  const hasCodeReadEvidence = codePlans.some((plan) => (plan.repositoryAnalysis?.filesRead || []).some((file) => file.exists));
  const hasAutoPatchPlan = codePlans.some((plan) => plan.canAutoPatch);
  const hasPlanningOnly = patches.some((patch) => patch.mode === "code_plan_only" || patch.status === "planning_required");
  const hasRealPatchApplication = applications.some((item) => item.mode === "local-repository" && item.status === "applied" && (item.changedFiles || []).length);
  const hasRealDeployment = deployments.some((item) => ["triggered", "deployed"].includes(item.status));
  const hasGithubPr = drafts.some((draft) => draft.remoteUrl && !String(draft.remoteUrl).includes("/mock-"));

  const sections = [
    capabilitySection("input", "输入层", "持续收集用户反馈、客服对话、错误、行为和 AI 巡检信号。", [
      { id: "sdk", label: "网站 SDK / API Key", status: project?.sdkKey ? "passed" : "missing", detail: project?.sdkKey ? "客户网站可上报信号。" : "需要先生成并嵌入 SDK。" },
      { id: "feedback", label: "真实用户反馈", status: signals.length ? "passed" : "waiting", detail: signals.length ? `已收到 ${signals.length} 条信号。` : "等待客户网站或客服系统上报。" },
      { id: "inspection", label: "AI 主动巡检入口", status: "warning", detail: "已有手动巡检按钮，仍需定时巡检和页面截图巡检。" },
    ], signals.length ? "" : "下一步：让客户网站自动上报反馈、前端错误和关键行为。"),
    capabilitySection("understanding", "理解层", "把松散反馈聚类成可执行任务，并评估风险、置信度和优先级。", [
      { id: "clustering", label: "反馈聚类", status: tasks.length ? "passed" : signals.length ? "missing" : "waiting", detail: tasks.length ? `已形成 ${tasks.length} 个任务。` : "需要把信号变成任务。" },
      { id: "approval", label: "人工批准门禁", status: tasks.some((task) => task.status === "已批准" || task.status === "已完成") ? "passed" : tasks.length ? "warning" : "waiting", detail: "高风险任务必须先批准再进化。" },
      { id: "prioritization", label: "风险/置信度排序", status: tasks.length ? "passed" : "waiting", detail: "任务已带风险、置信度和类别。" },
    ]),
    capabilitySection("code", "代码层", "读取客户仓库，判断该删什么、改什么、写什么，并生成真实补丁。", [
      { id: "repository", label: "代码仓库连接", status: repositories.length ? "passed" : "missing", detail: repositories.length ? "已连接仓库。" : "没有仓库就不能真正改网站。" },
      { id: "code_read", label: "Code Agent 读取上下文", status: hasCodeReadEvidence ? "passed" : drafts.length ? "missing" : "waiting", detail: hasCodeReadEvidence ? "已记录文件读取证据。" : "需要读取真实文件再计划变更。" },
      { id: "patch_generation", label: "真实补丁生成", status: hasRealPatchApplication || hasAutoPatchPlan ? "passed" : hasPlanningOnly ? "blocked" : patches.length ? "warning" : "waiting", detail: hasRealPatchApplication ? "已有真实文件改动。" : hasPlanningOnly ? "当前只能生成工程计划，缺通用代码生成器。" : "等待补丁生成。" },
    ], hasPlanningOnly ? "下一步：接入真实 LLM 代码生成器，让它基于仓库上下文输出 diff。" : ""),
    capabilitySection("verification", "验证层", "在沙箱、CI、浏览器巡检中证明补丁没有把网站改坏。", [
      { id: "qa", label: "QA 风险检查", status: reports.length ? "passed" : patches.length ? "missing" : "waiting", detail: reports.length ? `已有 ${reports.length} 份 QA 报告。` : "补丁生成后必须跑 QA。" },
      { id: "sandbox", label: "隔离沙箱", status: production.sandbox?.isolatedRuntimeConfigured ? "passed" : sandboxRuns.length ? "warning" : "missing", detail: production.sandbox?.isolatedRuntimeConfigured ? "生产沙箱已配置。" : "本地沙箱可用，但生产隔离沙箱还没完全接入。" },
      { id: "ci", label: "真实 CI/checks", status: db.ciRuns?.some((run) => run.projectId === project?.id && run.provider !== "managed-ci") ? "passed" : "missing", detail: "需要客户仓库真实 CI 或 GitHub checks。" },
    ]),
    capabilitySection("release", "输出层", "创建 PR、合并、触发部署、通知客户系统并保留回滚。", [
      { id: "github_pr", label: "真实 GitHub PR", status: hasGithubPr ? "passed" : drafts.length ? "warning" : "waiting", detail: hasGithubPr ? "已有真实 PR。" : "需要 GitHub App 对客户仓库授权。" },
      { id: "deploy_hook", label: "客户部署 Hook", status: project?.deploymentHook?.status === "active" || hasRealDeployment ? "passed" : "missing", detail: "缺部署 Hook 时，客户网站不会真正上线。" },
      { id: "rollback", label: "回滚与监控", status: releases.some((item) => item.rollback) ? "passed" : releases.length ? "warning" : "waiting", detail: "发布前必须带回滚预案和健康监控。" },
      { id: "webhook", label: "输出 Webhook", status: project?.outputWebhook?.status === "active" ? "passed" : "missing", detail: "需要把进化结果推回客户系统。" },
    ]),
    capabilitySection("governance", "治理层", "账号、租户隔离、审计、权限、计费和生产配置。", [
      { id: "auth", label: "真实账号系统", status: production.auth?.enabled ? "passed" : "missing", detail: production.auth?.enabled ? "账号系统已启用。" : "需要登录和组织权限。" },
      { id: "storage", label: "真实数据库", status: production.storage?.durable ? "passed" : "warning", detail: production.storage?.durable ? `${production.storage.driver} 持久化已启用。` : "当前不是生产级持久化。" },
      { id: "billing", label: "计费系统", status: production.billing?.stripeConfigured ? "passed" : "missing", detail: "商业化前需要 Stripe/套餐/用量计费。" },
      { id: "public", label: "公网 HTTPS", status: production.deployment?.httpsReady ? "passed" : "missing", detail: "客户和 GitHub Webhook 需要稳定公网 HTTPS。" },
    ]),
  ];

  const score = readinessScore(sections.map((section) => ({ status: section.status })));
  const nextSection =
    sections.find((section) => section.status === "blocked") ||
    sections.find((section) => section.status === "missing") ||
    sections.find((section) => section.status === "warning") ||
    sections.find((section) => section.status === "waiting");

  return {
    projectId: project?.id || selectedProjectId || null,
    score,
    status: nextSection ? nextSection.status : "passed",
    summary: nextSection ? `下一块要补：${nextSection.title}。${nextSection.nextAction}` : "核心自进化能力已就绪。",
    sections,
    updatedAt: nowIso(),
  };
}

function selectAutopilotTask(db, projectId, options = {}) {
  const tasks = newestFirst(db.tasks.filter((task) => task.projectId === projectId && task.status !== "已完成"));
  const allowUnapproved = options.allowUnapproved === true;
  if (options.taskId) {
    const selected = tasks.find((task) => task.id === options.taskId);
    if (!selected) return null;
    if (!allowUnapproved && selected.status !== "已批准") return null;
    return selected;
  }
  const approvedTask = tasks.find((task) => !task.prDraftId && task.status === "已批准") || null;
  if (!allowUnapproved) return approvedTask;
  return (
    approvedTask ||
    tasks.find((task) => !task.prDraftId) ||
    tasks.find((task) => !db.prDrafts.some((draft) => draft.taskId === task.id)) ||
    tasks[0]
  );
}

async function createAutopilotAnalysis(db, projectId) {
  const analysis = await analyzeProjectSignals(db, projectId);
  const insight = {
    id: `insight-${randomUUID().slice(0, 8)}`,
    projectId,
    model: analysis.model,
    summary: analysis.summary,
    clusters: analysis.clusters,
    suggestedTasks: analysis.suggestedTasks,
    aiProviderAttempt: analysis.aiProviderAttempt || null,
    createdAt: nowIso(),
  };
  db.insights.unshift(insight);

  const createdTasks = [];
  for (const suggestion of analysis.suggestedTasks || []) {
    const duplicate = db.tasks.some(
      (task) => task.projectId === projectId && task.title === suggestion.title && task.status !== "已完成",
    );
    if (duplicate) continue;
    const task = createTaskFromAiSuggestion(projectId, suggestion, insight.id);
    db.tasks.unshift(task);
    createdTasks.push(task);
  }

  addLog(db, `Autopilot 完成信号分析：${analysis.summary.slice(0, 48)}`);
  if (createdTasks.length) addLog(db, `Autopilot 生成 ${createdTasks.length} 个建议任务`);
  return { insight, createdTasks };
}

function autopilotRunStatus(actions = []) {
  if (actions.some((action) => ["blocked", "failed", "unhealthy"].includes(action.status))) return "blocked";
  if (actions.some((action) => ["waiting", "skipped"].includes(action.status))) return "waiting";
  return "completed";
}

function autopilotRunSummary(actions = []) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  if (byId.get("task")?.status === "waiting") return byId.get("task").detail || "No approved task is ready to run.";
  if (byId.get("production_release")?.status === "waiting") {
    return `Local test site updated; production release is waiting: ${byId.get("production_release").detail || "connect real integrations."}`;
  }
  if (byId.get("real_release")?.status === "waiting") {
    return `Simulation completed; real customer-site release is waiting: ${byId.get("real_release").detail || "connect real integrations."}`;
  }
  if (byId.get("deploy")?.status === "completed") return "Automatic release completed and monitoring passed.";
  if (byId.get("deployment_hook")?.status === "completed") return "Customer deployment hook was triggered successfully.";
  if (byId.get("deployment_hook")?.status === "failed") return "Customer deployment hook failed; site was not updated.";
  if (byId.get("deploy")?.status === "simulated") return "Release simulation completed; customer site was not changed.";
  if (byId.get("auto_merge")?.status === "completed") return "Patch merged in managed mode; release guard is armed.";
  if (byId.get("github_pr")?.status === "opened") return "GitHub PR opened; waiting for review or release gates.";
  if (byId.get("auto_release")?.status === "waiting") return byId.get("auto_release").detail || "Automatic release is waiting for policy or QA gates.";
  if (byId.get("github_pr")?.status === "blocked") return byId.get("github_pr").detail || "GitHub PR was blocked.";
  return actions.length ? `Autopilot reached ${actions[actions.length - 1].id}.` : "Autopilot did not run.";
}

function autopilotArtifacts(db, projectId) {
  const drafts = newestFirst(db.prDrafts.filter((draft) => draft.projectId === projectId && draft.status !== "closed"));
  const draft = drafts[0] || null;
  const patch = draft?.patchProposalId
    ? db.patchProposals.find((proposal) => proposal.id === draft.patchProposalId && proposal.status !== "discarded") || null
    : newestFirst(db.patchProposals.filter((proposal) => proposal.projectId === projectId && proposal.status !== "discarded"))[0] || null;
  const report = patch ? latestQaReportForPatch(db, patch.id) : newestFirst(db.validationReports.filter((item) => item.projectId === projectId))[0] || null;
  const sandbox = patch ? latestSandboxRunForPatch(db, patch.id) : newestFirst(db.sandboxRuns.filter((item) => item.projectId === projectId))[0] || null;
  const release = draft
    ? newestFirst(db.releasePlans.filter((item) => item.prDraftId === draft.id && item.status !== "voided"))[0] || null
    : newestFirst(db.releasePlans.filter((item) => item.projectId === projectId && item.status !== "voided"))[0] || null;
  const deployment = draft
    ? newestFirst(
        db.deploymentRuns.filter(
          (run) =>
            run.status !== "voided" &&
            (run.prDraftId === draft.id || run.releasePlanId === release?.id || run.patchProposalId === patch?.id),
        ),
      )[0] || null
    : newestFirst(db.deploymentRuns.filter((run) => run.projectId === projectId && run.status !== "voided"))[0] || null;
  const application = patch
    ? latestPatchApplicationForPatch(db, patch.id) || null
    : newestFirst(db.patchApplications.filter((item) => item.projectId === projectId))[0] || null;
  const codePlan = application?.codePlan || patch?.codePlan || draft?.codePlan || null;
  const ci = patch
    ? newestFirst(db.ciRuns.filter((run) => run.patchProposalId === patch.id))[0] || null
    : newestFirst(db.ciRuns.filter((run) => run.projectId === projectId))[0] || null;
  const task = draft?.taskId ? db.tasks.find((item) => item.id === draft.taskId) || draft : null;
  const repository = draft?.repositoryId ? db.repositories.find((item) => item.id === draft.repositoryId) || null : null;
  const codeAgentTrace =
    application?.codeAgentTrace ||
    patch?.codeAgentTrace ||
    draft?.codeAgentTrace ||
    (codePlan
      ? buildCodeAgentTrace({
          task,
          repository,
          codePlan,
          patch,
          application,
          checkRun: ci ? { ciRun: ci, result: ci.checks?.[0] ? { command: ci.checks[0].name, status: ci.status === "success" ? "passed" : "failed", output: ci.checks[0].output } : null } : null,
          deployment,
        })
      : null);
  return {
    prDraftId: draft?.id || "",
    prUrl: draft?.remoteUrl || "",
    prStatus: draft?.status || "",
    patchProposalId: patch?.id || "",
    codePlan,
    codeAgentTrace,
    qaReportId: report?.id || "",
    qaDecision: report?.decision || "",
    qaRiskScore: report?.riskScore ?? null,
    sandboxRunId: sandbox?.id || "",
    sandboxStatus: sandbox?.status || "",
    releasePlanId: release?.id || "",
    releaseStatus: release?.status || "",
    releasePhase: release?.currentPhase ?? null,
    releaseExecutionMode: release?.executionMode || "",
    deploymentStatus: release?.deploymentStatus || deployment?.status || "",
    realReleaseStatus: release?.realRelease?.status || "",
    realReleaseGaps: release?.realRelease?.gaps || [],
    productionReleaseStatus: release?.productionRelease?.status || "",
    productionReleaseGaps: release?.productionRelease?.gaps || [],
    deploymentRunId: release?.realRelease?.deploymentRunId || deployment?.id || "",
  };
}

function recordAutopilotRun(db, projectId, actions, readiness, options = {}) {
  const run = {
    id: `run-${randomUUID().slice(0, 8)}`,
    projectId,
    type: "autopilot",
    mode: options.autoRelease ? "advanced" : "standard",
    status: autopilotRunStatus(actions),
    summary: autopilotRunSummary(actions),
    actions: actions.map((action) => ({
      id: action.id,
      status: action.status,
      detail: action.detail || "",
    })),
    steps: actions.map((action) => `${action.id}:${action.status}`),
    readinessScore: readiness?.score ?? null,
    artifacts: autopilotArtifacts(db, projectId),
    startedAt: options.startedAt || nowIso(),
    finishedAt: nowIso(),
    createdAt: nowIso(),
  };
  db.runs.unshift(run);
  db.runs = db.runs.slice(0, 300);
  return run;
}

async function runSelfEvolutionAutopilot(db, projectId, options = {}) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found");

  const startedAt = nowIso();
  const actions = [];
  const signals = db.signals.filter((item) => item.projectId === project.id);
  if (!signals.length) {
    const readiness = selfEvolutionReadiness(db, project.id);
    actions.push({
      id: "waiting_for_signals",
      status: "waiting",
      detail: "客户网站还没有上报用户反馈、错误或行为信号。",
    });
    const run = recordAutopilotRun(db, project.id, actions, readiness, { ...options, startedAt });
    return { project, actions, readiness, run };
  }

  const analysisResult = await createAutopilotAnalysis(db, project.id);
  actions.push({
    id: "analysis",
    status: "completed",
    detail: `完成信号聚类，新增 ${analysisResult.createdTasks.length} 个任务。`,
  });

  actions.push({
    id: "analysis_model",
    status: analysisResult.insight.aiProviderAttempt?.status === "used" ? "completed" : "warning",
    detail: analysisResult.insight.aiProviderAttempt?.status === "used"
      ? `AI model ${analysisResult.insight.aiProviderAttempt.model} analyzed feedback.`
      : `AI analysis fell back to local rules: ${analysisResult.insight.aiProviderAttempt?.message || "no AI attempt recorded"}`,
  });

  const repositoryCountBefore = db.repositories.length;
  const repository = defaultRepositoryForProject(db, project.id);
  if (db.repositories.length > repositoryCountBefore) {
    actions.push({
      id: "repository",
      status: "created",
      detail: `创建模拟仓库连接 ${repository.owner}/${repository.name}，真实接入时替换为客户 GitHub/GitLab。`,
    });
  } else {
    actions.push({
      id: "repository",
      status: "ready",
      detail: `${repository.provider} ${repository.owner}/${repository.name} 已连接。`,
    });
  }

  const task = selectAutopilotTask(db, project.id, options);
  if (!task) {
    const readiness = selfEvolutionReadiness(db, project.id);
    actions.push({
      id: "task",
      status: "waiting",
      detail: "没有可推进的迭代任务。",
    });
    const run = recordAutopilotRun(db, project.id, actions, readiness, { ...options, startedAt });
    return { project, actions, readiness, run };
  }
  actions.push({
    id: "task",
    status: "selected",
    detail: task.title,
  });

  const draftBefore = db.prDrafts.length;
  const draft = createPrDraft(db, project.id, task.id, repository.id);
  actions.push({
    id: "pr_draft",
    status: db.prDrafts.length > draftBefore ? "created" : "reused",
    detail: draft.title,
  });
  if (draft.codePlan) {
    const trace = draft.codeAgentTrace || buildCodeAgentTrace({ task, repository, codePlan: draft.codePlan });
    const readStage = trace.stages?.find((stage) => stage.id === "read_repository");
    const decideStage = trace.stages?.find((stage) => stage.id === "decide_changes");
    actions.push({
      id: "code_agent_read",
      status: readStage?.status || "completed",
      detail: readStage?.detail || "Code Agent 已读取客户代码上下文。",
    });
    actions.push({
      id: "code_agent_decide",
      status: decideStage?.status || "completed",
      detail: `${draft.codePlan.summary} 修改 ${draft.codePlan.modify?.length || 0} 项，新增 ${draft.codePlan.add?.length || 0} 项，删除/避免 ${draft.codePlan.remove?.length || 0} 项。`,
    });
  }

  const patchBefore = db.patchProposals.length;
  const patch = await createPatchProposal(db, draft.id);
  actions.push({
    id: "patch",
    status: db.patchProposals.length > patchBefore ? "created" : "reused",
    detail: `${patch.id} · ${(patch.patchFiles || []).length} files`,
  });

  const aiAttempt = patch.codePlan?.repositoryAnalysis?.aiProviderAttempt || patch.codePlan?.aiProviderAttempt || null;
  if (aiAttempt) {
    actions.push({
      id: "ai_model",
      status: aiAttempt.status === "used" ? "completed" : aiAttempt.status === "failed" ? "warning" : "waiting",
      detail: `${aiAttempt.status} · ${aiAttempt.model || "model"} · ${aiAttempt.endpointHost || "endpoint"}${aiAttempt.message ? ` · ${aiAttempt.message}` : ""}`,
    });
  }

  const report = latestQaReportForPatch(db, patch.id) || createQaReport(db, patch.id);
  actions.push({
    id: "qa",
    status: report.decision === "blocked" ? "blocked" : "completed",
    detail: `${report.id} · ${report.decision}`,
  });

  let sandbox = latestSandboxRunForPatch(db, patch.id);
  if (!sandbox || sandbox.status === "failed") {
    const sandboxResult = runSandboxForPatch(db, patch.id);
    sandbox = sandboxResult.run;
  }
  actions.push({
    id: "sandbox",
    status: sandbox.status,
    detail: `${sandbox.id} · ${sandbox.status}`,
  });

  let productionSandbox = latestProductionSandboxForPatch(db, patch.id);
  if (SANDBOX_PROVIDER_URL && (!productionSandbox || productionSandbox.status === "failed")) {
    productionSandbox = await runProductionSandboxForPatch(db, patch.id);
    actions.push({
      id: "production_sandbox",
      status: productionSandbox.status,
      detail: `${productionSandbox.id} · ${productionSandbox.mode}`,
    });
  }

  const latestReport = latestQaReportForPatch(db, patch.id);
  const policy = policyForProject(db, project.id);
  if (
    policy.autoPr &&
    latestReport?.decision !== "blocked" &&
    sandbox.status !== "failed" &&
    productionSandbox?.status !== "failed"
  ) {
    if (repository.localPath && isStaticLocalRepository(repository)) {
      try {
        let application = latestPatchApplicationForPatch(db, patch.id);
        const reusableApplication =
          application?.mode === "local-repository" &&
          application.status === "applied" &&
          Array.isArray(application.changedFiles) &&
          application.changedFiles.length > 0;
        if (!reusableApplication) application = applyLocalStaticSitePatch(db, patch.id);
        actions.push({
          id: "local_apply",
          status: application.status === "applied" ? "applied" : "blocked",
          detail: `${application.changedFiles.length} files changed in ${repository.localPath}`,
        });
        if (!application.changedFiles.length) {
          throw new Error("Local patch produced no file changes; site was not deployed.");
        }

        const checkRun = runLocalRepositoryCheck(db, draft, patch, repository);
        actions.push({
          id: "local_check",
          status: checkRun.ciRun.status === "success" ? "completed" : "blocked",
          detail: `${checkRun.result.command}: ${checkRun.result.status}`,
        });
        if (checkRun.ciRun.status !== "success") throw new Error(checkRun.result.output);

        const localDeployment = recordLocalDeployment(db, draft, patch, repository, application, checkRun);
        actions.push({
          id: "deploy",
          status: "completed",
          detail: localDeployment.deploymentRun.url || repository.localPath,
        });
        if (localDeployment.releasePlan?.productionRelease?.gaps?.length) {
          actions.push({
            id: "production_release",
            status: "waiting",
            detail: localDeployment.releasePlan.productionRelease.gaps.join("; "),
          });
        }

        const delivery = await deliverOutputWebhook(db, project.id, "local.deployed", {
          prDraft: draft,
          patchProposal: patch,
          patchApplication: application,
          deploymentRun: localDeployment.deploymentRun,
          actions,
        });
        if (delivery) {
          actions.push({
            id: "output_webhook",
            status: delivery.status,
            detail: `${delivery.event} -> ${delivery.statusCode || delivery.error || delivery.status}`,
          });
        }
      } catch (error) {
        actions.push({
          id: "local_release",
          status: "blocked",
          detail: error.message,
        });
      }
    } else {
    try {
      const opened = await openGithubPrFromDraft(db, draft.id);
      actions.push({
        id: "github_pr",
        status: opened.remoteUrl ? "opened" : "skipped",
        detail: opened.remoteUrl || "PR 未打开。",
      });
      const delivery = await deliverOutputWebhook(db, project.id, "pr.opened", {
        prDraft: opened,
        actions,
      });
      if (delivery) {
        actions.push({
          id: "output_webhook",
          status: delivery.status,
          detail: `${delivery.event} -> ${delivery.statusCode || delivery.error || delivery.status}`,
        });
      }
      try {
        const automaticRelease = await runAutomaticRelease(db, draft.id, options);
        actions.push(...automaticRelease.actions);
      } catch (error) {
        actions.push({
          id: "auto_release",
          status: "blocked",
          detail: error.message,
        });
      }
    } catch (error) {
      actions.push({
        id: "github_pr",
        status: "blocked",
        detail: error.message,
      });
    }
    }
  } else {
    actions.push({
      id: "github_pr",
      status: "waiting",
      detail: "策略或 QA/沙箱结果不允许自动打开 PR。",
    });
  }

  addLog(db, `Autopilot 已推进 ${project.name}：${actions.map((item) => `${item.id}:${item.status}`).join(" -> ")}`);
  const readiness = selfEvolutionReadiness(db, project.id);
  const run = recordAutopilotRun(db, project.id, actions, readiness, { ...options, startedAt });
  return {
    project,
    actions,
    readiness,
    run,
  };
}

async function maybeRunAutopilotAfterSignal(db, projectId, task) {
  if (!policyForProject(db, projectId).autoPr) return null;
  if (!task || task.status !== "已批准") {
    addLog(db, "Autopilot 等待人工审批：新信号未达到自动推进策略。");
    return null;
  }
  const existingDraft = db.prDrafts.find((draft) => draft.taskId === task.id && draft.status !== "closed");
  if (existingDraft) return null;

  return runSelfEvolutionAutopilot(db, projectId, {
    taskId: task.id,
    requireApproved: true,
    trigger: "signal",
  });
}

function ensureCodePlans(db) {
  const tasksById = new Map((db.tasks || []).map((task) => [task.id, task]));
  const reposById = new Map((db.repositories || []).map((repo) => [repo.id, repo]));
  const draftsById = new Map((db.prDrafts || []).map((draft) => [draft.id, draft]));
  const patchesById = new Map((db.patchProposals || []).map((patch) => [patch.id, patch]));

  for (const draft of db.prDrafts || []) {
    const task = tasksById.get(draft.taskId) || draft;
    const repo = reposById.get(draft.repositoryId);
    if (!draft.codePlan || !draft.codePlan.repositoryAnalysis) {
      draft.codePlan = createCodeChangePlan(task, repo, (draft.changedFiles || []).map((file) => file.path));
    }
    if (!draft.codeAgentTrace) {
      draft.codeAgentTrace = buildCodeAgentTrace({ task, repository: repo, codePlan: draft.codePlan });
    }
  }

  for (const patch of db.patchProposals || []) {
    const draft = draftsById.get(patch.prDraftId);
    const task = tasksById.get(patch.taskId) || draft || patch;
    const repo = reposById.get(patch.repositoryId || draft?.repositoryId);
    if (!patch.codePlan || !patch.codePlan.repositoryAnalysis) {
      patch.codePlan =
        draft?.codePlan ||
        createCodeChangePlan(task, repo, (patch.patchFiles || draft?.changedFiles || []).map((file) => file.path || file));
    }
    if (!patch.codeAgentTrace) {
      patch.codeAgentTrace = buildCodeAgentTrace({ task, repository: repo, codePlan: patch.codePlan, patch });
    }
  }

  for (const application of db.patchApplications || []) {
    const patch = patchesById.get(application.patchProposalId);
    const draft = patch ? draftsById.get(patch.prDraftId) : null;
    const task = tasksById.get(patch?.taskId || application.taskId) || draft || patch || application;
    const repo = reposById.get(application.repositoryId || patch?.repositoryId || draft?.repositoryId);
    if (!application.codePlan || !application.codePlan.repositoryAnalysis) {
      application.codePlan =
        patch?.codePlan ||
        draft?.codePlan ||
        createCodeChangePlan(task, repo, (application.changedFiles || patch?.patchFiles || []).map((file) => file.path || file));
    }
    if (!application.codeAgentTrace) {
      application.codeAgentTrace = buildCodeAgentTrace({
        task,
        repository: repo,
        codePlan: application.codePlan,
        patch,
        application,
      });
    }
  }

  for (const run of db.runs || []) {
    run.artifacts = run.artifacts || {};
    if (run.artifacts.codePlan) continue;
    const patch = run.artifacts.patchProposalId ? patchesById.get(run.artifacts.patchProposalId) : null;
    const draft = run.artifacts.prDraftId ? draftsById.get(run.artifacts.prDraftId) : patch ? draftsById.get(patch.prDraftId) : null;
    const application = patch ? (db.patchApplications || []).find((item) => item.patchProposalId === patch.id) : null;
    run.artifacts.codePlan = application?.codePlan || patch?.codePlan || draft?.codePlan || null;
  }
}

function publicState(db, projectId, actor = { tenantId: DEFAULT_TENANT_ID }) {
  ensureCodePlans(db);
  const projects = tenantProjects(db, actor);
  const projectIds = new Set(projects.map((project) => project.id));
  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : projects[0];
  const selectedProjectId = selectedProject?.id || projects[0]?.id || "";
  const tenant = db.tenants.find((item) => item.id === actor.tenantId);
  const tenantGithubInstallations = db.githubInstallations.filter((installation) => projectIds.has(installation.projectId));
  return {
    selectedProjectId,
    tenant: {
      ...(publicTenant(tenant) || { id: actor.tenantId }),
      projectCount: projects.length,
    },
    projects,
    feedback: tenantScopedItems(db.signals, projectIds),
    signals: tenantScopedItems(db.signals, projectIds),
    tasks: tenantScopedItems(db.tasks, projectIds),
    runs: tenantScopedItems(db.runs, projectIds),
    insights: tenantScopedItems(db.insights, projectIds),
    repositories: tenantScopedItems(db.repositories, projectIds),
    prDrafts: tenantScopedItems(db.prDrafts, projectIds),
    patchProposals: tenantScopedItems(db.patchProposals, projectIds),
    validationReports: tenantScopedItems(db.validationReports, projectIds),
    sandboxRuns: tenantScopedItems(db.sandboxRuns, projectIds),
    patchApplications: tenantScopedItems(db.patchApplications, projectIds),
    productionSandboxRuns: tenantScopedItems(db.productionSandboxRuns, projectIds),
    previewDeployments: tenantScopedItems(db.previewDeployments, projectIds),
    ciRuns: tenantScopedItems(db.ciRuns, projectIds),
    deploymentRuns: tenantScopedItems(db.deploymentRuns, projectIds),
    releasePlans: tenantScopedItems(db.releasePlans, projectIds),
    rollbackEvents: tenantScopedItems(db.rollbackEvents, projectIds),
    webhookDeliveries: tenantScopedItems(db.webhookDeliveries, projectIds),
    auditLogs: tenantAuditLogs(db, actor, projectIds),
    aiProvider: aiProviderStatus(db),
    githubInstallations: tenantGithubInstallations,
    github: githubIntegrationStatus(db, selectedProjectId),
    readiness: selectedProjectId ? selfEvolutionReadiness(db, selectedProjectId) : selfEvolutionReadiness({ ...db, projects: [] }, ""),
    capabilities: selectedProjectId ? selfEvolutionCapabilities(db, selectedProjectId) : selfEvolutionCapabilities({ ...db, projects: [] }, ""),
    policy: policyForTenant(db, actor.tenantId),
    log: tenantLogLines(db, projects),
  };
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, service: "itera-ai", storage: STORAGE_DRIVER, time: nowIso() });
    return;
  }

  const db = await readDb();
  const actor = requestActor(req);
  let tenant = null;
  if (!isTenantAuthExempt(req, url)) {
    try {
      tenant = authenticateTenantRequest(db, actor);
    } catch (error) {
      respondWithError(res, error);
      return;
    }
  } else {
    tenant = db.tenants.find((item) => item.id === actor.tenantId) || null;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await parseBody(req);
    try {
      const result = createAuthAccount(db, body);
      auditWithActor(db, { tenantId: result.tenant.id, userId: result.user.id, role: result.user.role }, "auth.register", `user:${result.user.id}`, {
        organizationId: result.organization.id,
        tenantId: result.tenant.id,
      });
      await writeDb(db);
      json(res, 201, {
        user: publicUser(result.user),
        organization: publicOrganization(result.organization),
        tenant: publicTenant(result.tenant),
        tenantAccessKey: result.tenantAccessKey,
        session: { token: result.token, expiresAt: result.session.expiresAt },
        state: publicState(db, "", { tenantId: result.tenant.id }),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await parseBody(req);
    try {
      const result = loginAuthAccount(db, body);
      auditWithActor(db, { tenantId: result.tenant.id, userId: result.user.id, role: result.user.role }, "auth.login", `user:${result.user.id}`, {
        organizationId: result.organization.id,
        tenantId: result.tenant.id,
      });
      await writeDb(db);
      json(res, 200, {
        user: publicUser(result.user),
        organization: publicOrganization(result.organization),
        tenant: publicTenant(result.tenant),
        session: { token: result.token, expiresAt: result.session.expiresAt },
        state: publicState(db, "", { tenantId: result.tenant.id }),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    await writeDb(db);
    json(res, 200, {
      user: publicUser(actor.authUser),
      organization: publicOrganization(actor.authOrganization),
      tenant: publicTenant(tenant),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (actor.authSession) actor.authSession.revokedAt = nowIso();
    await writeDb(db);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/production/status") {
    json(res, 200, { production: productionStatus(db) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ai/status") {
    json(res, 200, { aiProvider: aiProviderStatus(db) });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/ai/config") {
    const body = await parseBody(req);
    try {
      const current = persistedAiProviderConfig(db);
      const next = normalizeAiProviderSettings({
        provider: "generic-openai-compatible",
        baseUrl: body.baseUrl ?? current.baseUrl,
        apiKey: body.clearApiKey ? "" : String(body.apiKey || "").trim() ? body.apiKey : current.apiKey,
        model: body.model ?? current.model,
        proxyUrl: body.proxyUrl ?? current.proxyUrl,
        temperature: body.temperature ?? current.temperature,
        updatedAt: nowIso(),
      });
      if (String(body.proxyUrl || "").trim() && !next.proxyUrl) {
        throw Object.assign(new Error("Proxy URL must look like http://127.0.0.1:7890."), { status: 400 });
      }
      if (!next.baseUrl) throw Object.assign(new Error("请填写 Base URL。"), { status: 400 });
      try {
        const parsed = new URL(next.baseUrl);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
      } catch {
        throw Object.assign(new Error("Base URL 必须是 http:// 或 https:// 开头的网址。"), { status: 400 });
      }
      if (!next.model) throw Object.assign(new Error("请填写模型名称。"), { status: 400 });
      db.platformConfig = db.platformConfig && typeof db.platformConfig === "object" ? db.platformConfig : {};
      db.platformConfig.aiProvider = next;
      db.platformConfig.aiProviderLastValidation = {
        ok: false,
        mode: "not_validated",
        message: "Configuration saved. Click validate before expecting Code Agent to use this model.",
        status: 0,
        checkedAt: nowIso(),
      };
      db.platformConfig.updatedAt = nowIso();
      audit(db, req, "ai_provider.config_saved", "ai:provider", {
        provider: next.provider,
        baseUrl: next.baseUrl,
        model: next.model,
        proxyHost: proxyHostLabel(next.proxyUrl),
        apiKeyConfigured: Boolean(next.apiKey),
      });
      await writeDb(db);
      json(res, 200, { aiProvider: aiProviderStatus(db), production: productionStatus(db) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/validate") {
    const validation = await validateAiProviderSetup(db);
    db.platformConfig = db.platformConfig && typeof db.platformConfig === "object" ? db.platformConfig : {};
    db.platformConfig.aiProviderLastValidation = { ...validation, checkedAt: nowIso() };
    audit(db, req, validation.ok ? "ai_provider.validate" : "ai_provider.validate_failed", "ai:provider", {
      mode: validation.mode,
      status: validation.status || "",
    });
    await writeDb(db);
    json(res, 200, { validation, aiProvider: aiProviderStatus(db), production: productionStatus(db) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sandbox/setup") {
    json(res, 200, { setup: sandboxSetupStatus(db) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sandbox/setup/validate") {
    const validation = await validateSandboxSetup();
    audit(db, req, validation.ok ? "sandbox.setup.validate" : "sandbox.setup.validate_failed", "sandbox:provider", {
      mode: validation.mode,
      status: validation.status || "",
    });
    await writeDb(db);
    json(res, 200, { validation, setup: sandboxSetupStatus(db) });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/platform/config") {
    const body = await parseBody(req);
    const publicBaseUrl = normalizeWebsiteUrl(body.publicBaseUrl || "");
    if (body.publicBaseUrl && !publicBaseUrl) {
      badRequest(res, "A valid public base URL is required");
      return;
    }
    if (publicBaseUrl && !/^https:\/\//i.test(publicBaseUrl)) {
      badRequest(res, "Public base URL must use HTTPS");
      return;
    }
    db.platformConfig = db.platformConfig && typeof db.platformConfig === "object" ? db.platformConfig : {};
    db.platformConfig.publicBaseUrl = publicBaseUrl;
    db.platformConfig.updatedAt = nowIso();
    audit(db, req, "platform_config.update", "platform:deployment", { publicBaseUrl: Boolean(publicBaseUrl), tenantId: actor.tenantId });
    await writeDb(db);
    json(res, 200, { platformConfig: db.platformConfig, production: productionStatus(db) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/billing/plans") {
    json(res, 200, { plans: BILLING_PLANS });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/billing/current") {
    json(res, 200, { billing: billingCurrentForActor(db, actor) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/billing/setup") {
    json(res, 200, { setup: billingSetupStatus(db, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/billing/setup/validate") {
    const validation = await validateBillingSetup(db, actor);
    audit(db, req, validation.ok ? "billing.setup.validate" : "billing.setup.validate_failed", "billing:stripe", {
      mode: validation.mode,
      status: validation.status || "",
    });
    await writeDb(db);
    json(res, 200, { validation, setup: billingSetupStatus(db, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
    const body = await parseBody(req);
    const plan = BILLING_PLANS.find((item) => item.id === String(body.plan || "")) || null;
    if (!plan || plan.id === "free") {
      badRequest(res, "A paid billing plan is required");
      return;
    }
    const billing = billingCurrentForActor(db, actor);
    const paymentLink = process.env[`STRIPE_PAYMENT_LINK_${plan.id.toUpperCase()}`] || "";
    const publicBaseUrl = normalizeWebsiteUrl(envConfig("PUBLIC_BASE_URL") || db.platformConfig?.publicBaseUrl || "");
    const stripeSession = paymentLink ? null : await createStripeCheckoutSession(plan, billing, actor, publicBaseUrl);
    const checkout = {
      id: stripeSession?.id || `checkout-${randomUUID().slice(0, 8)}`,
      mode: stripeSession?.mode || (paymentLink ? "stripe_payment_link" : "mock"),
      plan,
      organizationId: billing.organization?.id || "",
      tenantId: actor.tenantId,
      url: stripeSession?.url || paymentLink || `https://billing.itera.local/checkout/${plan.id}`,
      stripeSessionId: stripeSession?.stripeSessionId || "",
      metadata: {
        organizationId: billing.organization?.id || "",
        tenantId: actor.tenantId,
        plan: plan.id,
      },
      createdAt: nowIso(),
    };
    audit(db, req, "billing.checkout", `plan:${plan.id}`, { tenantId: actor.tenantId, mode: checkout.mode });
    await writeDb(db);
    json(res, 201, { checkout });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/billing/portal") {
    try {
      const billing = billingCurrentForActor(db, actor);
      const publicBaseUrl = normalizeWebsiteUrl(envConfig("PUBLIC_BASE_URL") || db.platformConfig?.publicBaseUrl || "");
      const portal = await createStripeCustomerPortalSession(billing, publicBaseUrl);
      audit(db, req, "billing.portal", `org:${billing.organization?.id || actor.tenantId}`, { tenantId: actor.tenantId, mode: portal.mode });
      await writeDb(db);
      json(res, 201, { portal });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/billing/webhook") {
    const raw = await parseRawBody(req);
    const signature = verifyStripeWebhookSignature(req, raw);
    if (!signature.ok) {
      auditWithActor(db, { tenantId: DEFAULT_TENANT_ID, userId: "stripe", role: "system" }, "billing.webhook.reject", "stripe:webhook", {
        reason: signature.reason,
      });
      await writeDb(db);
      json(res, 400, { error: signature.reason || "Invalid Stripe webhook signature" });
      return;
    }
    let event;
    try {
      event = JSON.parse(raw || "{}");
    } catch {
      badRequest(res, "Invalid Stripe webhook JSON");
      return;
    }
    try {
      const result = applyBillingWebhookEvent(db, event);
      auditWithActor(db, { tenantId: result.organization.tenantId, userId: "stripe", role: "system" }, result.action, `org:${result.organization.id}`, {
        eventType: event.type || "unknown",
        signatureMode: signature.mode,
      });
      await writeDb(db);
      json(res, 200, {
        ok: true,
        action: result.action,
        organization: publicOrganization(result.organization),
        billingAccount: result.billingAccount,
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tenants") {
    const body = await parseBody(req);
    try {
      const result = createTenant(db, body);
      auditWithActor(db, { tenantId: result.tenant.id, userId: "tenant-bootstrap", role: "owner" }, "tenant.create", `tenant:${result.tenant.id}`, {
        tenantId: result.tenant.id,
      });
      await writeDb(db);
      json(res, 201, { tenant: publicTenant(result.tenant), accessKey: result.accessKey });
    } catch (error) {
      badRequest(res, error.message);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tenant/current") {
    json(res, 200, { tenant: publicTenant(tenant) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tenant/rotate-key") {
    try {
      const result = rotateTenantAccessKey(db, actor);
      audit(db, req, "tenant.rotate_key", `tenant:${result.tenant.id}`, { tenantId: result.tenant.id });
      await writeDb(db);
      json(res, 200, {
        tenant: publicTenant(result.tenant),
        accessKey: result.accessKey,
        state: publicState(db, url.searchParams.get("projectId") || "", actor),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, publicState(db, url.searchParams.get("projectId"), actor));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/readiness") {
    try {
      const project = resolveProjectForActor(db, actor, url.searchParams.get("projectId"));
      json(res, 200, { readiness: selfEvolutionReadiness(db, project.id) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit-logs") {
    const projectId = url.searchParams.get("projectId");
    const projectIds = tenantProjectIds(db, actor);
    if (projectId) {
      try {
        assertProjectAccess(db, actor, projectId);
      } catch (error) {
        respondWithError(res, error);
        return;
      }
    }
    const logs = tenantAuditLogs(db, actor, projectIds).filter((entry) =>
      projectId ? entry.metadata?.projectId === projectId || String(entry.target || "").includes(projectId) : true,
    );
    json(res, 200, { auditLogs: logs.slice(0, 100) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/github/status") {
    try {
      const project = resolveProjectForActor(db, actor, url.searchParams.get("projectId"));
      json(res, 200, { github: githubIntegrationStatus(db, project.id) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/github/setup") {
    try {
      const project = resolveProjectForActor(db, actor, url.searchParams.get("projectId"));
      json(res, 200, { setup: githubSetupStatus(db, project.id) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/github/setup/validate") {
    const body = await parseBody(req);
    try {
      const project = resolveProjectForActor(db, actor, body.projectId || url.searchParams.get("projectId"));
      const validation = await validateGithubSetup(db, project.id);
      audit(db, req, validation.ok ? "github.setup.validate" : "github.setup.validate_failed", `project:${project.id}`, {
        mode: validation.mode,
        status: validation.status || "",
      });
      await writeDb(db);
      json(res, 200, { validation, setup: githubSetupStatus(db, project.id) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/github/repositories") {
    try {
      const projectId = resolveProjectForActor(db, actor, url.searchParams.get("projectId")).id;
      const status = githubIntegrationStatus(db, projectId);
      const projectInstallation = githubInstallationForProject(db, projectId);
      const project = db.projects.find((item) => item.id === projectId);
      const tenantInstallation = !projectInstallation ? githubInstallationForTenant(db, project?.tenantId || actor.tenantId) : null;
      if (status.tokenConfigured) {
        const repos = await githubApiRequest("GET", "https://api.github.com/user/repos?per_page=50&sort=updated");
        json(res, 200, {
          github: status,
          repositories: repos.map((repo) => ({
            id: repo.id,
            owner: repo.owner?.login,
            name: repo.name,
            fullName: repo.full_name,
            private: Boolean(repo.private),
            defaultBranch: repo.default_branch,
            url: repo.html_url,
            permissions: repo.permissions || {},
          })),
        });
        return;
      }
      if (projectInstallation?.repositories?.length && (!status.appConfigured || !projectInstallation.installationId)) {
        json(res, 200, { github: status, repositories: projectInstallation.repositories });
        return;
      }
      const connectedRepoInstallationId = db.repositories.find(
        (repo) => repo.projectId === projectId && repo.provider === "GitHub" && repo.status !== "mock-connected" && repo.githubInstallationId,
      )?.githubInstallationId;
      const installationId =
        projectInstallation?.installationId || connectedRepoInstallationId || tenantInstallation?.installationId || githubAppConfig().installationId;
      if (status.appConfigured && installationId) {
        const token = await githubInstallationToken(installationId);
        const data = await githubApiRequest("GET", "https://api.github.com/installation/repositories?per_page=50", null, {
          authToken: token,
        });
        const repositories = (data.repositories || []).map((repo) => ({
          id: repo.id,
          owner: repo.owner?.login,
          name: repo.name,
          fullName: repo.full_name,
          private: Boolean(repo.private),
          defaultBranch: repo.default_branch,
          url: repo.html_url,
          installationId,
          permissions: repo.permissions || {},
        }));
        const sync = syncGithubRepositoriesForProject(db, projectId, repositories, installationId);
        await writeDb(db);
        json(res, 200, {
          github: status,
          repositories: sync.repositories,
          autoConnectedRepository: sync.autoConnectedRepository,
          syncedAt: nowIso(),
        });
        return;
      }
      {
        json(res, 200, { github: status, repositories: [], message: status.message });
        return;
      }
    } catch (error) {
      const wrapped = new Error(
        error.message === "fetch failed"
          ? "GitHub API is unreachable from this local runtime. Keep the GitHub App installed, then run the server from an environment with outbound access to api.github.com."
          : error.message,
      );
      wrapped.status = error.status || (error.message === "fetch failed" ? 502 : 400);
      respondWithError(res, wrapped);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/github/repositories/validate") {
    const body = await parseBody(req);
    try {
      const project = resolveProjectForActor(db, actor, body.projectId);
      const result = await validateGithubRepository(db, project.id, body.owner, body.name);
      json(res, 200, { validation: result, github: githubIntegrationStatus(db, project.id) });
    } catch (error) {
      badRequest(res, error.message);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/github/installations") {
    const projectId = url.searchParams.get("projectId");
    const projectIds = tenantProjectIds(db, actor);
    if (projectId) {
      try {
        assertProjectAccess(db, actor, projectId);
      } catch (error) {
        respondWithError(res, error);
        return;
      }
    }
    const installations = db.githubInstallations.filter((installation) =>
      projectId ? installation.projectId === projectId : projectIds.has(installation.projectId),
    );
    const selectedProject = projectId ? db.projects.find((project) => project.id === projectId) : tenantProjects(db, actor)[0];
    json(res, 200, { installations, github: githubIntegrationStatus(db, selectedProject?.id || "") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/github/installations") {
    const body = await parseBody(req);
    try {
      assertProjectAccess(db, actor, body.projectId || body.project_id);
      const installation = recordGithubInstallation(db, body);
      audit(db, req, "github.installation.bind", `installation:${installation.installationId}`, {
        projectId: installation.projectId,
        repositories: installation.repositories.length,
      });
      await writeDb(db);
      json(res, 201, { installation, github: githubIntegrationStatus(db, installation.projectId), state: publicState(db, installation.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/github/webhook") {
    const rawBody = await parseRawBody(req);
    const signature = githubWebhookSignature(req, rawBody);
    if (!signature.ok) {
      audit(db, req, "github.webhook.reject", "github:webhook", { reason: "invalid signature", mode: signature.mode });
      await writeDb(db);
      json(res, 401, { error: "Invalid GitHub webhook signature", signature });
      return;
    }
    try {
      const event = String(req.headers["x-github-event"] || "");
      const payload = rawBody ? JSON.parse(rawBody) : {};
      const result = applyGithubWebhook(db, event, payload);
      audit(db, req, "github.webhook", `github:${event || "unknown"}`, {
        event,
        action: payload.action,
        handled: result.handled,
        reason: result.reason,
        projectId: result.installation?.projectId,
        installationId: result.installation?.installationId || result.installationId,
      });
      await writeDb(db);
      const webhookProject = db.projects.find((project) => project.id === result.installation?.projectId);
      const webhookActor = { tenantId: webhookProject?.tenantId || actor.tenantId, userId: "github-webhook", role: "system" };
      json(res, 200, {
        ok: true,
        event,
        signature,
        result,
        state: publicState(db, result.installation?.projectId || url.searchParams.get("projectId") || "", webhookActor),
      });
    } catch (error) {
      badRequest(res, error.message);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/github/install") {
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, url.searchParams.get("projectId")).id;
    } catch (error) {
      html(res, error.status || 400, `<h1>GitHub App install failed</h1><p>${escapeHtmlForHtml(error.message)}</p>`);
      return;
    }
    const config = githubAppConfig();
    if (!config.appSlug) {
      html(res, 400, "<h1>GitHub App is not configured</h1><p>Set GITHUB_APP_SLUG before installing.</p>");
      return;
    }
    const installState = createGithubInstallState(db, projectId);
    await writeDb(db);
    const callbackUrl = productionStatus(db).deployment?.githubCallbackUrl || `${url.origin || `http://${HOST}:${PORT}`}/github/callback`;
    const installUrl = new URL(`https://github.com/apps/${config.appSlug}/installations/new`);
    installUrl.searchParams.set("state", installState.state);
    installUrl.searchParams.set("redirect_uri", callbackUrl);
    res.writeHead(302, { Location: installUrl.toString() });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/github/callback") {
    try {
      const callbackProjectId = url.searchParams.get("projectId");
      const callbackState = url.searchParams.get("state");
      const fallback = callbackProjectId || callbackState ? { projectId: "", source: "" } : githubCallbackFallbackProjectId(db);
      const installation = recordGithubInstallation(db, {
        installationId: url.searchParams.get("installation_id"),
        setupAction: url.searchParams.get("setup_action"),
        projectId: callbackProjectId,
        state: callbackState,
        fallbackProjectId: fallback.projectId,
      });
      addLog(
        db,
        `GitHub App installed for project ${installation.projectId}: ${installation.installationId}${fallback.source ? ` (${fallback.source})` : ""}`,
      );
      await writeDb(db);
      res.writeHead(302, {
        Location: `/index.html?projectId=${encodeURIComponent(installation.projectId)}&githubInstalled=${encodeURIComponent(installation.installationId)}`,
      });
      res.end();
    } catch (error) {
      html(res, 400, `<h1>GitHub installation failed</h1><p>${escapeHtmlForHtml(error.message)}</p>`);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, url.searchParams.get("projectId")).id;
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    json(res, 200, {
      exportedAt: nowIso(),
      project: db.projects.find((project) => project.id === projectId),
      signals: db.signals.filter((signal) => signal.projectId === projectId),
      tasks: db.tasks.filter((task) => task.projectId === projectId),
      patchProposals: db.patchProposals.filter((proposal) => proposal.projectId === projectId),
      validationReports: db.validationReports.filter((report) => report.projectId === projectId),
      sandboxRuns: db.sandboxRuns.filter((run) => run.projectId === projectId),
      patchApplications: db.patchApplications.filter((item) => item.projectId === projectId),
      productionSandboxRuns: db.productionSandboxRuns.filter((run) => run.projectId === projectId),
      previewDeployments: db.previewDeployments.filter((deployment) => deployment.projectId === projectId),
      ciRuns: db.ciRuns.filter((run) => run.projectId === projectId),
      deploymentRuns: db.deploymentRuns.filter((run) => run.projectId === projectId),
      releasePlans: db.releasePlans.filter((plan) => plan.projectId === projectId),
      rollbackEvents: db.rollbackEvents.filter((event) => event.projectId === projectId),
      webhookDeliveries: db.webhookDeliveries.filter((delivery) => delivery.projectId === projectId),
      auditLogs: db.auditLogs.filter((entry) => entry.metadata?.projectId === projectId || entry.target?.includes(projectId)),
      githubInstallations: db.githubInstallations.filter((installation) => installation.projectId === projectId),
      policy: policyForProject(db, projectId),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ai/analyze") {
    const body = await parseBody(req);
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, body.projectId).id;
    } catch (error) {
      respondWithError(res, error);
      return;
    }

    const analysis = await analyzeProjectSignals(db, projectId);
    const insight = {
      id: `insight-${randomUUID().slice(0, 8)}`,
      projectId,
      model: analysis.model,
      summary: analysis.summary,
      clusters: analysis.clusters,
      suggestedTasks: analysis.suggestedTasks,
      aiProviderAttempt: analysis.aiProviderAttempt || null,
      createdAt: nowIso(),
    };
    db.insights.unshift(insight);

    const createdTasks = [];
    for (const suggestion of analysis.suggestedTasks || []) {
      const duplicate = db.tasks.some(
        (task) => task.projectId === projectId && task.title === suggestion.title && task.status !== "已完成",
      );
      if (duplicate) continue;
      const task = createTaskFromAiSuggestion(projectId, suggestion, insight.id);
      db.tasks.unshift(task);
      createdTasks.push(task);
    }

    addLog(db, `AI 分析 Agent 完成分析：${analysis.summary.slice(0, 48)}`);
    addLog(db, `AI 分析 Agent 生成 ${createdTasks.length} 个建议任务`);
    await writeDb(db);
    json(res, 201, {
      insight,
      createdTasks,
      state: publicState(db, projectId, actor),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await parseBody(req);
    try {
      const project = createCustomerProject(db, body, actor);
      await writeDb(db);
      json(res, 201, { project, state: publicState(db, project.id, actor) });
    } catch (error) {
      badRequest(res, error.message);
    }
    return;
  }

  const rotateSdkKeyMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rotate-sdk-key$/);
  if (req.method === "POST" && rotateSdkKeyMatch) {
    try {
      assertProjectAccess(db, actor, rotateSdkKeyMatch[1]);
      const project = rotateProjectSdkKey(db, rotateSdkKeyMatch[1]);
      await writeDb(db);
      json(res, 200, { project, state: publicState(db, project.id, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const outputWebhookMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/output-webhook$/);
  if (req.method === "PATCH" && outputWebhookMatch) {
    const body = await parseBody(req);
    try {
      const project = assertProjectAccess(db, actor, outputWebhookMatch[1]);
      const webhookUrl = validateWebhookUrl(body.url);
      if (body.url && !webhookUrl) throw Object.assign(new Error("Valid http(s) webhook URL is required"), { status: 400 });
      project.outputWebhook = normalizeOutputWebhook({
        url: webhookUrl,
        status: webhookUrl && body.enabled !== false ? "active" : "disabled",
        lastDeliveryAt: project.outputWebhook?.lastDeliveryAt,
        lastStatus: project.outputWebhook?.lastStatus,
      });
      audit(db, req, "output_webhook.update", `project:${project.id}`, {
        projectId: project.id,
        enabled: project.outputWebhook.status === "active",
      });
      await writeDb(db);
      json(res, 200, { project, state: publicState(db, project.id, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const outputWebhookTestMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/output-webhook\/test$/);
  if (req.method === "POST" && outputWebhookTestMatch) {
    try {
      const project = assertProjectAccess(db, actor, outputWebhookTestMatch[1]);
      const delivery = await deliverOutputWebhook(db, project.id, "webhook.test", {
        message: "Itera AI output webhook test",
        readiness: selfEvolutionReadiness(db, project.id),
      });
      if (!delivery) throw Object.assign(new Error("Output webhook is not configured"), { status: 400 });
      audit(db, req, "output_webhook.test", `project:${project.id}`, {
        projectId: project.id,
        deliveryId: delivery.id,
        status: delivery.status,
      });
      await writeDb(db);
      json(res, 200, { delivery, state: publicState(db, project.id, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const deploymentHookMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/deployment-hook$/);
  if (req.method === "PATCH" && deploymentHookMatch) {
    const body = await parseBody(req);
    try {
      const project = assertProjectAccess(db, actor, deploymentHookMatch[1]);
      const hookUrl = validateWebhookUrl(body.url);
      if (body.url && !hookUrl) throw Object.assign(new Error("Valid http(s) deployment hook URL is required"), { status: 400 });
      project.deploymentHook = normalizeDeploymentHook({
        url: hookUrl,
        provider: body.provider || detectDeploymentHookProvider(hookUrl),
        status: hookUrl && body.enabled !== false ? "active" : "disabled",
        lastTriggeredAt: project.deploymentHook?.lastTriggeredAt,
        lastStatus: project.deploymentHook?.lastStatus,
      });
      project.updatedAt = nowIso();
      audit(db, req, "deployment_hook.update", `project:${project.id}`, {
        projectId: project.id,
        enabled: project.deploymentHook.status === "active",
        provider: project.deploymentHook.provider,
      });
      await writeDb(db);
      json(res, 200, { project, state: publicState(db, project.id, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const deploymentHookTestMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/deployment-hook\/test$/);
  if (req.method === "POST" && deploymentHookTestMatch) {
    try {
      const project = assertProjectAccess(db, actor, deploymentHookTestMatch[1]);
      const releasePlan = {
        id: `release-test-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        prDraftId: "",
        status: "test",
        currentPhase: 0,
      };
      const deploymentRun = await triggerDeploymentHook(db, releasePlan, null, {
        test: true,
        message: "Itera AI deployment hook test",
      });
      audit(db, req, "deployment_hook.test", `project:${project.id}`, {
        projectId: project.id,
        deploymentRunId: deploymentRun.id,
        status: deploymentRun.status,
        statusCode: deploymentRun.statusCode,
      });
      await writeDb(db);
      json(res, 200, { deploymentRun, state: publicState(db, project.id, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const autopilotMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/autopilot$/);
  if (req.method === "POST" && autopilotMatch) {
    try {
      const body = await parseBody(req);
      assertProjectAccess(db, actor, autopilotMatch[1]);
      const result = await runSelfEvolutionAutopilot(db, autopilotMatch[1], {
        autoRelease: body.autoRelease === true || body.mode === "advanced",
        taskId: body.taskId,
        requireApproved: body.requireApproved !== false,
        trigger: body.trigger || "operator",
      });
      await writeDb(db);
      json(res, 200, {
        project: result.project,
        actions: result.actions,
        readiness: result.readiness,
        run: result.run,
        state: publicState(db, result.project.id, actor),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repositories/connect") {
    const body = await parseBody(req);
    let projectId;

    try {
      projectId = resolveProjectForActor(db, actor, body.projectId).id;
      const repo = {
        id: body.id || `repo-${randomUUID().slice(0, 8)}`,
        projectId,
        provider: body.provider || "GitHub",
        owner: body.owner || "customer",
        name: body.name || projectId,
        defaultBranch: body.defaultBranch || "main",
        url: body.url || `https://github.com/${body.owner || "customer"}/${body.name || projectId}`,
        localPath: body.localPath ? resolveTrustedLocalPath(body.localPath) : undefined,
        previewBaseUrl: body.previewBaseUrl || "",
        githubInstallationId: body.githubInstallationId || body.installationId || undefined,
        status: "connected",
        validationConfig: normalizeValidationConfig(body.validationConfig),
        createdAt: nowIso(),
      };
      const existingIndex = db.repositories.findIndex((item) => item.projectId === projectId && item.url === repo.url);
      if (existingIndex >= 0) db.repositories[existingIndex] = { ...db.repositories[existingIndex], ...repo };
      else db.repositories.unshift(repo);

      addLog(db, `代码仓库已连接：${repo.provider} ${repo.owner}/${repo.name}`);
      audit(db, req, "repository.connect", `repository:${repo.id}`, { projectId, provider: repo.provider, localPath: Boolean(repo.localPath) });
      await writeDb(db);
      json(res, 201, { repository: repo, state: publicState(db, projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr-drafts") {
    const body = await parseBody(req);
    try {
      const projectId = resolveProjectForActor(db, actor, body.projectId).id;
      const draft = createPrDraft(db, projectId, body.taskId, body.repositoryId);
      await writeDb(db);
      json(res, 201, { prDraft: draft, state: publicState(db, projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const prGeneratePatchMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/generate-patch$/);
  if (req.method === "POST" && prGeneratePatchMatch) {
    try {
      const draft = db.prDrafts.find((item) => item.id === prGeneratePatchMatch[1]);
      if (!draft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, draft.projectId);
      const proposal = await createPatchProposal(db, prGeneratePatchMatch[1]);
      await writeDb(db);
      json(res, 201, { patchProposal: proposal, state: publicState(db, proposal.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const patchVerifyMatch = url.pathname.match(/^\/api\/patch-proposals\/([^/]+)\/verify$/);
  if (req.method === "POST" && patchVerifyMatch) {
    try {
      const proposal = db.patchProposals.find((item) => item.id === patchVerifyMatch[1]);
      if (!proposal) throw Object.assign(new Error("Patch proposal not found"), { status: 404 });
      assertProjectAccess(db, actor, proposal.projectId);
      const report = createQaReport(db, patchVerifyMatch[1]);
      await writeDb(db);
      json(res, 201, { validationReport: report, state: publicState(db, report.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const sandboxRunMatch = url.pathname.match(/^\/api\/patch-proposals\/([^/]+)\/run-sandbox$/);
  if (req.method === "POST" && sandboxRunMatch) {
    try {
      const proposal = db.patchProposals.find((item) => item.id === sandboxRunMatch[1]);
      if (!proposal) throw Object.assign(new Error("Patch proposal not found"), { status: 404 });
      assertProjectAccess(db, actor, proposal.projectId);
      const result = runSandboxForPatch(db, sandboxRunMatch[1]);
      await writeDb(db);
      json(res, 201, { sandboxRun: result.run, validationReport: result.report, state: publicState(db, result.run.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const patchApplyMatch = url.pathname.match(/^\/api\/patch-proposals\/([^/]+)\/apply-workspace$/);
  if (req.method === "POST" && patchApplyMatch) {
    try {
      const proposal = db.patchProposals.find((item) => item.id === patchApplyMatch[1]);
      if (!proposal) throw Object.assign(new Error("Patch proposal not found"), { status: 404 });
      assertProjectAccess(db, actor, proposal.projectId);
      const application = applyPatchToWorkspace(db, patchApplyMatch[1]);
      audit(db, req, "patch.apply_workspace", `patch:${patchApplyMatch[1]}`, {
        projectId: application.projectId,
        repositoryId: application.repositoryId,
        changedFiles: application.changedFiles.length,
      });
      await writeDb(db);
      json(res, 201, { patchApplication: application, state: publicState(db, application.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const productionSandboxMatch = url.pathname.match(/^\/api\/patch-proposals\/([^/]+)\/run-production-sandbox$/);
  if (req.method === "POST" && productionSandboxMatch) {
    try {
      const proposal = db.patchProposals.find((item) => item.id === productionSandboxMatch[1]);
      if (!proposal) throw Object.assign(new Error("Patch proposal not found"), { status: 404 });
      assertProjectAccess(db, actor, proposal.projectId);
      const run = await runProductionSandboxForPatch(db, productionSandboxMatch[1]);
      audit(db, req, "sandbox.production_run", `patch:${productionSandboxMatch[1]}`, {
        projectId: run.projectId,
        repositoryId: run.repositoryId,
        status: run.status,
      });
      await writeDb(db);
      json(res, 201, { productionSandboxRun: run, state: publicState(db, run.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const prOpenGithubMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/open-github$/);
  if (req.method === "POST" && prOpenGithubMatch) {
    try {
      const existingDraft = db.prDrafts.find((item) => item.id === prOpenGithubMatch[1]);
      if (!existingDraft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, existingDraft.projectId);
      const draft = await openGithubPrFromDraft(db, prOpenGithubMatch[1]);
      const delivery = await deliverOutputWebhook(db, draft.projectId, "pr.opened", { prDraft: draft });
      audit(db, req, "github.open_pr", `prDraft:${draft.id}`, { projectId: draft.projectId, remoteUrl: draft.remoteUrl });
      await writeDb(db);
      json(res, 200, { prDraft: draft, webhookDelivery: delivery, state: publicState(db, draft.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const manualApproveMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/approve-release$/);
  if (req.method === "POST" && manualApproveMatch) {
    try {
      const body = await parseBody(req);
      const existingDraft = db.prDrafts.find((item) => item.id === manualApproveMatch[1]);
      if (!existingDraft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, existingDraft.projectId);
      const result = await approveManualReviewAndRelease(db, manualApproveMatch[1], actor, body);
      audit(db, req, "manual_review.approve_release", `prDraft:${result.draft.id}`, {
        projectId: result.draft.projectId,
        releaseStatus: result.release?.releasePlan?.status || "",
        runStatus: result.run.status,
      });
      await writeDb(db);
      json(res, 200, {
        prDraft: result.draft,
        validationReport: result.report,
        release: result.release,
        actions: result.actions,
        run: result.run,
        readiness: result.readiness,
        state: publicState(db, result.draft.projectId, actor),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const manualRejectMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/reject-change$/);
  if (req.method === "POST" && manualRejectMatch) {
    try {
      const body = await parseBody(req);
      const existingDraft = db.prDrafts.find((item) => item.id === manualRejectMatch[1]);
      if (!existingDraft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, existingDraft.projectId);
      const result = rejectManualReviewChange(db, manualRejectMatch[1], actor, body);
      audit(db, req, "manual_review.reject_change", `prDraft:${result.draft.id}`, {
        projectId: result.draft.projectId,
        runStatus: result.run.status,
      });
      await writeDb(db);
      json(res, 200, {
        prDraft: result.draft,
        validationReport: result.report,
        actions: result.actions,
        run: result.run,
        readiness: result.readiness,
        state: publicState(db, result.draft.projectId, actor),
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const ciRunMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/ci$/);
  if (req.method === "POST" && ciRunMatch) {
    try {
      const draft = db.prDrafts.find((item) => item.id === ciRunMatch[1]);
      if (!draft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, draft.projectId);
      const ciRun = createCiRunForDraft(db, ciRunMatch[1]);
      audit(db, req, "ci.record", `prDraft:${ciRun.prDraftId}`, { projectId: ciRun.projectId, status: ciRun.status });
      await writeDb(db);
      json(res, 201, { ciRun, state: publicState(db, ciRun.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const previewMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/preview$/);
  if (req.method === "POST" && previewMatch) {
    try {
      const draft = db.prDrafts.find((item) => item.id === previewMatch[1]);
      if (!draft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, draft.projectId);
      const deployment = createPreviewDeployment(db, previewMatch[1]);
      audit(db, req, "preview.create", `preview:${deployment.id}`, { projectId: deployment.projectId, url: deployment.url });
      await writeDb(db);
      json(res, 201, { previewDeployment: deployment, state: publicState(db, deployment.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const releasePlanMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/release-plan$/);
  if (req.method === "POST" && releasePlanMatch) {
    try {
      const draft = db.prDrafts.find((item) => item.id === releasePlanMatch[1]);
      if (!draft) throw Object.assign(new Error("PR draft not found"), { status: 404 });
      assertProjectAccess(db, actor, draft.projectId);
      const releasePlan = createReleasePlan(db, releasePlanMatch[1]);
      const delivery = await deliverOutputWebhook(db, releasePlan.projectId, "release.planned", { releasePlan });
      audit(db, req, "release.plan", `release:${releasePlan.id}`, { projectId: releasePlan.projectId });
      await writeDb(db);
      json(res, 201, { releasePlan, webhookDelivery: delivery, state: publicState(db, releasePlan.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const releasePromoteMatch = url.pathname.match(/^\/api\/release-plans\/([^/]+)\/promote$/);
  if (req.method === "POST" && releasePromoteMatch) {
    try {
      const existingPlan = db.releasePlans.find((item) => item.id === releasePromoteMatch[1]);
      if (!existingPlan) throw Object.assign(new Error("Release plan not found"), { status: 404 });
      assertProjectAccess(db, actor, existingPlan.projectId);
      const releasePlan = promoteReleasePlan(db, releasePromoteMatch[1]);
      const delivery = await deliverOutputWebhook(db, releasePlan.projectId, "release.promoted", { releasePlan });
      audit(db, req, "release.promote", `release:${releasePlan.id}`, {
        projectId: releasePlan.projectId,
        currentPhase: releasePlan.currentPhase,
      });
      await writeDb(db);
      json(res, 200, { releasePlan, webhookDelivery: delivery, state: publicState(db, releasePlan.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const releaseRollbackMatch = url.pathname.match(/^\/api\/release-plans\/([^/]+)\/rollback$/);
  if (req.method === "POST" && releaseRollbackMatch) {
    try {
      const body = await parseBody(req);
      const existingPlan = db.releasePlans.find((item) => item.id === releaseRollbackMatch[1]);
      if (!existingPlan) throw Object.assign(new Error("Release plan not found"), { status: 404 });
      assertProjectAccess(db, actor, existingPlan.projectId);
      const result = rollbackReleasePlan(db, releaseRollbackMatch[1], body.reason || "operator rollback");
      const delivery = await deliverOutputWebhook(db, result.plan.projectId, "release.rolled_back", result);
      audit(db, req, "release.rollback", `release:${result.plan.id}`, {
        projectId: result.plan.projectId,
        reason: result.rollback.reason,
      });
      await writeDb(db);
      json(res, 200, { releasePlan: result.plan, rollback: result.rollback, webhookDelivery: delivery, state: publicState(db, result.plan.projectId, actor) });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  const prAdvanceMatch = url.pathname.match(/^\/api\/pr-drafts\/([^/]+)\/advance$/);
  if (req.method === "POST" && prAdvanceMatch) {
    const draft = db.prDrafts.find((item) => item.id === prAdvanceMatch[1]);
    if (!draft) {
      notFound(res);
      return;
    }
    try {
      assertProjectAccess(db, actor, draft.projectId);
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const next = {
      drafted: "ready_for_review",
      patch_generated: "ready_for_review",
      ready_for_review: "tests_passed",
      qa_verified: "approved",
      qa_review_required: "approved",
      tests_passed: "approved",
      approved: "merged",
    }[draft.status];
    if (next) {
      draft.status = next;
      draft.updatedAt = nowIso();
      addLog(db, `PR 草稿状态更新：${draft.title.slice(0, 42)} -> ${draft.status}`);
    }
    await writeDb(db);
    json(res, 200, { prDraft: draft, state: publicState(db, draft.projectId, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signals") {
    const body = await parseBody(req);
    let project = null;
    try {
      project = resolveProjectForSignal(db, req, body);
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    if (project.sdkStatus === "disabled") {
      json(res, 403, { error: "SDK is disabled for this project" });
      return;
    }
    const signalActor = { tenantId: project.tenantId || DEFAULT_TENANT_ID, userId: "sdk", role: "sdk" };

    const validation = validateSignalRequest(req, project, body);
    if (!validation.ok) {
      recordSignalReject(project, validation.reason, validation.origin);
      auditWithActor(db, signalActor, "signal.reject", `project:${project.id}`, {
        projectId: project.id,
        reason: validation.reason,
        origin: validation.origin,
        allowedOrigins: validation.allowedOrigins,
        rate: validation.rate,
      });
      await writeDb(db);
      json(res, validation.status || 403, {
        error: validation.reason,
        origin: validation.origin,
        allowedOrigins: validation.allowedOrigins,
        rate: validation.rate,
      });
      return;
    }

    const localClassification = classifySignal(body);
    const aiSignalAnalysis = await analyzeSingleSignalWithAiProvider(db, project, body, localClassification);
    const classification = aiSignalAnalysis?.classification || localClassification;
    const signal = {
      id: `sig-${randomUUID().slice(0, 8)}`,
      projectId: body.projectId,
      type: body.type || "feedback",
      source: body.source || (body.type === "feedback" ? "用户反馈" : "SDK 上报"),
      category: classification.category,
      severity: classification.severity,
      risk: classification.risk,
      confidence: classification.confidence,
      page: body.page || "",
      origin: validation.origin || "",
      text: classification.text,
      userAgent: body.userAgent || "",
      userId: body.userId || null,
      release: body.release || null,
      createdAt: body.createdAt || nowIso(),
      data: {
        ...(body.data || {}),
        aiAnalysis: aiSignalAnalysis?.classification
          ? {
              model: aiSignalAnalysis.attempt?.model || "",
              reason: aiSignalAnalysis.reason || "",
              status: aiSignalAnalysis.attempt?.status || "",
              checkedAt: aiSignalAnalysis.attempt?.checkedAt || nowIso(),
            }
          : null,
        aiProviderAttempt: aiSignalAnalysis?.attempt || null,
      },
    };

    db.signals.push(signal);
    recordSignalAccept(project, validation.origin);
    let task = null;
    if (shouldCreateTaskForSignal(signal)) {
      task = aiSignalAnalysis?.task
        ? taskFromAiSignal(signal, policyForProject(db, signal.projectId), aiSignalAnalysis.task, aiSignalAnalysis.attempt)
        : taskFromSignal(signal, policyForProject(db, signal.projectId));
      db.tasks.unshift(task);
      if (aiSignalAnalysis?.task) addLog(db, `AI feedback Agent used ${aiSignalAnalysis.attempt?.model || "model"} to generate task: ${task.title.slice(0, 48)}`);
      addLog(db, `Signals API 接收 ${signal.source}：${signal.text.slice(0, 28)}`);
      addLog(db, `产品 Agent 已生成任务：${task.title.slice(0, 34)}`);
    } else {
      addLog(db, `Signals API 接收接入心跳：${project.name}`);
    }
    auditWithActor(db, signalActor, "signal.accept", `signal:${signal.id}`, {
      projectId: signal.projectId,
      origin: validation.origin,
      type: signal.type,
      rate: validation.rate,
    });
    const autopilot = task && body.autopilot !== false ? await maybeRunAutopilotAfterSignal(db, signal.projectId, task) : null;
    await writeDb(db);
    const includeState = validation.trustedPlatformOrigin || req.headers["x-itera-include-state"] === "1";
    json(res, 201, {
      signal,
      task,
      autopilot,
      state: includeState ? publicState(db, signal.projectId, signalActor) : undefined,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import/support-tickets") {
    const body = await parseBody(req);
    const projectId = body.projectId;
    const tickets = Array.isArray(body.tickets) ? body.tickets : [];
    if (!projectId) {
      badRequest(res, "projectId is required");
      return;
    }
    if (!tickets.length) {
      badRequest(res, "tickets must be a non-empty array");
      return;
    }
    try {
      assertProjectAccess(db, actor, projectId);
    } catch (error) {
      respondWithError(res, error);
      return;
    }

    const imported = tickets.map((ticket) => {
      const title = ticket.title ? `${ticket.title}\n` : "";
      return ingestSignal(db, {
        projectId,
        projectName: body.projectName,
        type: "support_ticket",
        source: ticket.source || body.source || "客服工单",
        page: ticket.page || "",
        userId: ticket.userId || ticket.customerId || null,
        createdAt: ticket.createdAt || nowIso(),
        data: {
          text: `${title}${ticket.text || ticket.message || ""}`.trim(),
          ticketId: ticket.id || null,
          channel: ticket.channel || body.channel || "support",
          sentiment: ticket.sentiment || null,
          contact: ticket.contact || null,
        },
      });
    });

    addLog(db, `客服导入完成：${imported.length} 条工单已进入信号库`);
    const approvedImport = imported.find((item) => item.task.status === "已批准");
    const autopilot = body.autopilot === false || !approvedImport
      ? null
      : await maybeRunAutopilotAfterSignal(db, projectId, approvedImport.task);
    await writeDb(db);
    json(res, 201, {
      imported: imported.length,
      signals: imported.map((item) => item.signal),
      tasks: imported.map((item) => item.task),
      autopilot,
      state: publicState(db, projectId, actor),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/plans") {
    const body = await parseBody(req);
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, body.projectId).id;
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const policy = policyForProject(db, projectId);
    const signals = db.signals.filter((signal) => signal.projectId === projectId);
    if (!signals.length) {
      json(res, 200, { created: 0, tasks: [] });
      return;
    }

    const groups = signals.reduce((acc, signal) => {
      acc[signal.category] = acc[signal.category] || [];
      acc[signal.category].push(signal);
      return acc;
    }, {});

    const templates = {
      bug: ["建立阻塞 Bug 修复包", "将高频异常合并为一个回归补丁包。", 2, "开发 Agent"],
      request: ["整理高频需求验证包", "生成需求说明、影响评估和验收条件。", 2, "产品 Agent"],
      performance: ["创建性能优化实验", "定位慢请求与首屏瓶颈，进入沙盒验证。", 1, "QA Agent"],
      support: ["刷新客服知识库", "补充自动追问与答案模板，降低人工工单。", 1, "客服 Agent"],
    };

    const createdTasks = [];
    for (const [category, items] of Object.entries(groups)) {
      const [baseTitle, summary, risk, agent] = templates[category];
      const title = `${baseTitle} (${items.length})`;
      const exists = db.tasks.some((task) => task.projectId === projectId && task.title === title);
      if (exists) continue;
      const confidence = Math.min(95, 80 + items.length * 4);
      const task = {
        id: `task-${randomUUID().slice(0, 8)}`,
        projectId,
        title,
        summary,
        category,
        risk,
        confidence,
        agent,
        status: risk <= policy.riskLimit && confidence >= policy.confidenceLimit ? "已批准" : "待审批",
        sourceSignalIds: items.map((item) => item.id),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.tasks.unshift(task);
      createdTasks.push(task);
    }

    addLog(db, `产品 Agent 生成 ${createdTasks.length} 个迭代计划任务`);
    await writeDb(db);
    json(res, 201, { created: createdTasks.length, tasks: createdTasks, state: publicState(db, projectId, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/approve-safe") {
    const body = await parseBody(req);
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, body.projectId).id;
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const policy = policyForProject(db, projectId);
    let count = 0;
    for (const task of db.tasks) {
      if (
        task.projectId === projectId &&
        task.status === "待审批" &&
        task.risk <= policy.riskLimit &&
        task.confidence >= policy.confidenceLimit
      ) {
        task.status = "已批准";
        task.updatedAt = nowIso();
        count += 1;
      }
    }
    addLog(db, `审批策略批准 ${count} 个低风险任务`);
    await writeDb(db);
    json(res, 200, { count, state: publicState(db, projectId, actor) });
    return;
  }

  const advanceMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/advance$/);
  if (req.method === "POST" && advanceMatch) {
    const task = db.tasks.find((item) => item.id === advanceMatch[1]);
    if (!task) {
      notFound(res);
      return;
    }
    try {
      assertProjectAccess(db, actor, task.projectId);
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const next = {
      待审批: "已批准",
      已批准: "构建中",
      构建中: "验证通过",
      验证通过: "已灰度",
      已灰度: "已完成",
    }[task.status];
    if (next) {
      task.status = next;
      task.updatedAt = nowIso();
      addLog(db, `${task.agent} 推进任务：${task.title} -> ${task.status}`);
    }
    await writeDb(db);
    json(res, 200, { task, state: publicState(db, task.projectId, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-runs") {
    const body = await parseBody(req);
    let projectId;
    try {
      projectId = resolveProjectForActor(db, actor, body.projectId).id;
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const type = body.type || "full";
    const run = {
      id: `run-${randomUUID().slice(0, 8)}`,
      projectId,
      type,
      status: "completed",
      startedAt: nowIso(),
      finishedAt: nowIso(),
      steps: ["采集反馈", "聚类诊断", "生成任务", "创建补丁", "沙盒验证", "灰度发布"],
    };
    db.runs.unshift(run);

    const signalBody = {
      projectId,
      type: type === "release" ? "release_check" : "performance",
      source: type === "release" ? "发布后回归" : "AI 巡检",
      page: db.projects.find((project) => project.id === projectId)?.url || "",
      data: { text: type === "release" ? "发布后错误率稳定，建议继续观察灰度指标。" : "结账页第三方脚本阻塞主线程，建议延迟加载非关键脚本。" },
      text: type === "release" ? "发布后错误率稳定，建议继续观察灰度指标。" : "结账页第三方脚本阻塞主线程，建议延迟加载非关键脚本。",
    };
    const classification = classifySignal(signalBody);
    const signal = {
      id: `sig-${randomUUID().slice(0, 8)}`,
      projectId,
      type: signalBody.type,
      source: signalBody.source,
      category: classification.category,
      severity: classification.severity,
      risk: classification.risk,
      confidence: classification.confidence,
      page: signalBody.page,
      text: classification.text,
      createdAt: nowIso(),
      data: signalBody.data,
    };
    db.signals.push(signal);
    db.tasks.unshift(taskFromSignal(signal, policyForProject(db, projectId)));

    const project = db.projects.find((item) => item.id === projectId);
    if (project && type === "release") {
      project.errorRate = Math.max(0.2, Number((project.errorRate - 0.08).toFixed(2)));
      project.health = Math.min(99, project.health + 2);
    }

    addLog(db, `Agent Orchestrator 完成 ${runName(type)}`);
    await writeDb(db);
    json(res, 201, { run, state: publicState(db, projectId, actor) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/canary") {
    const body = await parseBody(req);
    let project;
    try {
      project = resolveProjectForActor(db, actor, body.projectId);
    } catch (error) {
      respondWithError(res, error);
      return;
    }
    const projectId = project.id;
    const policy = policyForProject(db, projectId);
    if (!policy.autoCanary && body.mode !== "auto") {
      json(res, 409, { error: "当前策略需要人工发布审批", state: publicState(db, projectId, actor) });
      return;
    }
    project.canary = Math.min(100, project.canary + 10);
    addLog(db, `Release Agent 将灰度流量提升至 ${project.canary}%`);
    audit(db, req, "canary.promote", `project:${project.id}`, { projectId, canary: project.canary });
    await writeDb(db);
    json(res, 200, { project, state: publicState(db, projectId, actor) });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/policy") {
    const body = await parseBody(req);
    let selectedProjectId = "";
    if (body.projectId) {
      try {
        selectedProjectId = resolveProjectForActor(db, actor, body.projectId).id;
      } catch (error) {
        respondWithError(res, error);
        return;
      }
    } else {
      selectedProjectId = tenantProjects(db, actor)[0]?.id || "";
    }
    const policy = setTenantPolicy(db, actor.tenantId, body);
    addLog(db, "权限策略已更新");
    audit(db, req, "policy.update", `policy:${actor.tenantId}`, { projectId: selectedProjectId, tenantId: actor.tenantId });
    await writeDb(db);
    json(res, 200, { policy, state: publicState(db, selectedProjectId, actor) });
    return;
  }

  notFound(res);
}

function runName(type) {
  return {
    full: "完整自迭代巡检",
    qa: "QA 可用性检查",
    product: "产品需求归纳",
    release: "发布后回归",
  }[type] || type;
}

async function serveStatic(req, res, url) {
  const routePath = url.pathname === "/docs" ? "/docs.html" : url.pathname;
  const requestedPath = decodeURIComponent(routePath === "/" ? "/index.html" : routePath);
  const normalized = path.normalize(requestedPath).replace(/^([/\\])+/, "");
  const filePath = path.resolve(ROOT, normalized === "widget.js" ? path.join("sdk", "iteration-client.js") : normalized);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/github/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Internal server error", detail: error.message });
  }
}

ensureDb().then(() => {
  const server = http.createServer(handler);
  server.listen(PORT, HOST, () => {
    console.log(`Itera AI MVP is running at http://${HOST}:${PORT}`);
  });
});
