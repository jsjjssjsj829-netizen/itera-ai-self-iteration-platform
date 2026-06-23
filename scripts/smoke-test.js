const { spawn, spawnSync } = require("node:child_process");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 8791;
const webhookPort = 8792;
const sqlitePort = 8793;
const baseUrl = `http://127.0.0.1:${port}`;
let defaultTenantHeaders = {
  "X-Itera-Tenant": "tenant-local",
  "X-Itera-Tenant-Key": "tnk_tenant-local_dev",
  "X-Itera-User": "smoke-runner",
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function waitForHealthUrl(healthUrl) {
  const started = Date.now();
  while (Date.now() - started < 6000) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return response.json();
    } catch {
      await wait(150);
    }
  }
  throw new Error("Server did not become healthy.");
}

async function waitForHealth() {
  return waitForHealthUrl(`${baseUrl}/api/health`);
}

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...defaultTenantHeaders,
      ...(options && options.headers),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${pathname}`);
  return data;
}

function startWebhookReceiver() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {}
      deliveries.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw,
        body: parsed,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(webhookPort, "127.0.0.1", () => {
      resolve({
        deliveries,
        url: `http://127.0.0.1:${webhookPort}/itera-output`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function verifyWebhookSignature(delivery, sdkKey) {
  const expected = `sha256=${createHmac("sha256", sdkKey).update(delivery.raw).digest("hex")}`;
  return delivery.headers["x-itera-signature-256"] === expected;
}

function smokeEnv(overrides = {}) {
  const env = { ...process.env };
  [
    "PUBLIC_BASE_URL",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_BASE64",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_TOKEN",
    "SANDBOX_PROVIDER_URL",
    "SANDBOX_PROVIDER_TOKEN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PAYMENT_LINK_PRO",
    "STRIPE_PAYMENT_LINK_SCALE",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_SCALE",
    "STRIPE_CUSTOMER_PORTAL_URL",
  ].forEach((key) => {
    env[key] = "";
  });
  return { ...env, ...overrides };
}

function prepareSmokeRepository(projectId) {
  const repoDir = path.join(root, "data", "smoke-fixtures", projectId);
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "tests", "e2e"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          lint: "node scripts/ci-smoke.js",
          test: "node scripts/ci-smoke.js",
          build: "node scripts/ci-build.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "scripts", "ci-smoke.js"), "console.log('fixture checks passed');\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "scripts", "ci-build.js"), "console.log('fixture build passed');\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "pages", "checkout.tsx"), "export const checkout = true;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "lib", "analytics.ts"), "export const analytics = true;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "tests", "e2e", "checkout.spec.ts"), "export const checkoutSpec = true;\n", "utf8");
  return repoDir;
}

function prepareStaticSmokeRepository(projectId) {
  const repoDir = path.join(root, "data", "smoke-fixtures", `${projectId}-static`);
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          check: "node scripts/check-site.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "index.html"),
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Smoke Static Shop</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <section class="product-grid">
        <article class="product-card"><h2>台灯</h2><strong>¥199</strong></article>
        <article class="product-card"><h2>水杯</h2><strong>¥49</strong></article>
      </section>
      <section class="feedback-examples"><p>用户评价</p></section>
    </main>
  </body>
</html>
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "styles.css"),
    `.product-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.product-card { padding: 12px; border: 1px solid #ddd; }
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "scripts", "check-site.js"),
    `const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
if (!html.includes("product-grid")) throw new Error("missing product grid");
if (!css.includes("product-card")) throw new Error("missing product card css");
console.log("Test shop check passed.");
`,
    "utf8",
  );
  return repoDir;
}

async function main() {
  const webhookReceiver = await startWebhookReceiver();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: smokeEnv({ PORT: String(port), STRIPE_CUSTOMER_PORTAL_URL: "https://billing.example.com/portal" }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealth();
    const docsResponse = await fetch(`${baseUrl}/docs`);
    const docsHtml = await docsResponse.text();
    if (!docsResponse.ok || !docsHtml.includes("Itera AI 网站自进化接入文档")) {
      throw new Error("Public integration docs route did not render.");
    }

    const sqliteSmokeFile = path.join(root, "data", `smoke-${Date.now().toString(36)}.sqlite`);
    const migration = spawnSync(process.execPath, ["scripts/db-migrate.js"], {
      cwd: root,
      env: smokeEnv({ SQLITE_FILE: sqliteSmokeFile }),
      encoding: "utf8",
    });
    if (migration.status !== 0) {
      throw new Error(`SQLite migration failed: ${migration.stderr || migration.stdout}`);
    }
    const sqliteChild = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: smokeEnv({ PORT: String(sqlitePort), STORAGE_DRIVER: "sqlite", SQLITE_FILE: sqliteSmokeFile }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sqliteOutput = "";
    sqliteChild.stdout.on("data", (chunk) => {
      sqliteOutput += chunk.toString();
    });
    sqliteChild.stderr.on("data", (chunk) => {
      sqliteOutput += chunk.toString();
    });
    try {
      const sqliteHealth = await waitForHealthUrl(`http://127.0.0.1:${sqlitePort}/api/health`);
      if (sqliteHealth.storage !== "sqlite") {
        throw new Error(`SQLite storage server did not report sqlite driver: ${JSON.stringify(sqliteHealth)}`);
      }
    } catch (error) {
      console.error(sqliteOutput);
      throw error;
    } finally {
      await stopChild(sqliteChild);
      fs.rmSync(sqliteSmokeFile, { force: true });
      fs.rmSync(`${sqliteSmokeFile}-shm`, { force: true });
      fs.rmSync(`${sqliteSmokeFile}-wal`, { force: true });
    }

    const authSuffix = Date.now().toString(36);
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `owner-${authSuffix}@example.com`,
        password: "correct-horse-123",
        name: "Smoke Owner",
        organizationName: `Smoke Org ${authSuffix}`,
      }),
    });
    if (!registered.session?.token || !registered.user?.id || !registered.organization?.tenantId) {
      throw new Error("Auth register did not return a session, user, and organization.");
    }
    const authHeaders = { Authorization: `Bearer ${registered.session.token}` };
    const authMe = await request("/api/auth/me", { headers: authHeaders });
    if (authMe.user?.email !== registered.user.email || authMe.organization?.id !== registered.organization.id) {
      throw new Error("Auth session did not resolve the current user.");
    }
    const authProject = await request("/api/projects", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: `Auth Project ${authSuffix}`,
        url: "https://auth-project.example.com",
      }),
    });
    if (authProject.project.tenantId !== registered.organization.tenantId) {
      throw new Error("Bearer-auth project was not assigned to the user's tenant.");
    }
    await request("/api/auth/logout", { method: "POST", headers: authHeaders });
    try {
      await request("/api/auth/me", { headers: authHeaders });
      throw new Error("Revoked session was accepted.");
    } catch (error) {
      if (!String(error.message).includes("Invalid or expired session")) throw error;
    }
    const loggedIn = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: registered.user.email,
        password: "correct-horse-123",
      }),
    });
    if (!loggedIn.session?.token) {
      throw new Error("Auth login did not return a new session.");
    }

    const smokeTenant = await request("/api/tenants", {
      method: "POST",
      body: JSON.stringify({
        id: `smoke-root-${Date.now().toString(36)}`,
        name: "Smoke Root Tenant",
      }),
    });
    defaultTenantHeaders = {
      "X-Itera-Tenant": smokeTenant.tenant.id,
      "X-Itera-Tenant-Key": smokeTenant.accessKey,
      "X-Itera-User": "smoke-runner",
    };

    const production = await request("/api/production/status");
    if (!production.production?.auth?.enabled || !Array.isArray(production.production.readiness.blockers)) {
      throw new Error("Production status endpoint did not report auth and readiness blockers.");
    }
    const platformConfig = await request("/api/platform/config", {
      method: "PATCH",
      body: JSON.stringify({ publicBaseUrl: "https://platform-smoke.example.com" }),
    });
    if (!platformConfig.production?.deployment?.httpsReady || !platformConfig.production.deployment.docsUrl.endsWith("/docs")) {
      throw new Error("Platform deployment config did not produce HTTPS deployment URLs.");
    }
    if (platformConfig.production.readiness.blockers.some((item) => String(item).includes("PUBLIC_BASE_URL"))) {
      throw new Error("PUBLIC_BASE_URL blocker remained after setting platform deployment config.");
    }
    const expectedGithubCallbackUrl = platformConfig.production?.deployment?.githubCallbackUrl;
    if (!expectedGithubCallbackUrl) {
      throw new Error("Platform deployment config did not produce a GitHub callback URL.");
    }
    const setupProject = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: `GitHub Setup ${authSuffix}`,
        url: "https://github-setup.example.com",
      }),
    });
    const githubSetup = await request(`/api/github/setup?projectId=${encodeURIComponent(setupProject.project.id)}`);
    if (githubSetup.setup?.urls?.callbackUrl !== expectedGithubCallbackUrl) {
      throw new Error("GitHub setup did not use the configured public callback URL.");
    }
    if (!githubSetup.setup.checks.some((check) => check.id === "installation" && check.ok === false)) {
      throw new Error("GitHub setup did not report missing installation before credentials are configured.");
    }
    const githubSetupValidation = await request("/api/github/setup/validate", {
      method: "POST",
      body: JSON.stringify({ projectId: setupProject.project.id }),
    });
    if (githubSetup.setup?.app?.appConfigured) {
      if (githubSetupValidation.validation?.mode !== "github_app") {
        throw new Error("GitHub setup validation should use GitHub App mode when credentials are configured.");
      }
    } else if (githubSetupValidation.validation?.ok !== false || githubSetupValidation.validation?.mode !== "mock") {
      throw new Error("GitHub setup validation should stay in mock mode without credentials.");
    }
    const githubCallbackInstallationId = `smoke-callback-${Date.now().toString(36)}`;
    const githubCallback = await fetch(
      `${baseUrl}/github/callback?installation_id=${encodeURIComponent(githubCallbackInstallationId)}&setup_action=install&projectId=${encodeURIComponent(setupProject.project.id)}`,
      { redirect: "manual" },
    );
    const githubCallbackLocation = githubCallback.headers.get("location") || "";
    if (githubCallback.status !== 302 || !githubCallbackLocation.includes(`projectId=${encodeURIComponent(setupProject.project.id)}`)) {
      throw new Error("GitHub callback did not bind explicit projectId and redirect back to the project.");
    }
    const sandboxSetup = await request("/api/sandbox/setup");
    if (sandboxSetup.setup?.configured !== false || !sandboxSetup.setup.checks.some((check) => check.id === "provider_url" && check.ok === false)) {
      throw new Error("Sandbox setup should report a missing external provider in local mode.");
    }
    const sandboxSetupValidation = await request("/api/sandbox/setup/validate", { method: "POST" });
    if (sandboxSetupValidation.validation?.ok !== false || sandboxSetupValidation.validation?.mode !== "local-allowlist") {
      throw new Error("Sandbox setup validation should fail safely without SANDBOX_PROVIDER_URL.");
    }
    const billingSetup = await request("/api/billing/setup");
    if (billingSetup.setup?.checkoutReady !== false || billingSetup.setup?.webhookReady !== false) {
      throw new Error("Billing setup should report missing Stripe checkout and webhook configuration in local mode.");
    }
    const billingSetupValidation = await request("/api/billing/setup/validate", { method: "POST" });
    if (billingSetupValidation.validation?.ok !== false || billingSetupValidation.validation?.mode !== "mock") {
      throw new Error("Billing setup validation should fail safely without Stripe configuration.");
    }
    const billingPlans = await request("/api/billing/plans");
    if (!billingPlans.plans.some((plan) => plan.id === "pro")) {
      throw new Error("Billing plans did not include the Pro plan.");
    }
    const billingCurrent = await request("/api/billing/current");
    if (!billingCurrent.billing?.usage) {
      throw new Error("Billing current endpoint did not return usage.");
    }
    const checkout = await request("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: "pro" }),
    });
    if (!checkout.checkout?.url) {
      throw new Error("Billing checkout did not return a checkout URL.");
    }
    const billingWebhook = await request("/api/billing/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "checkout.session.completed",
        data: {
          object: {
            customer: `cus_${authSuffix}`,
            status: "active",
            metadata: {
              organizationId: registered.organization.id,
              tenantId: registered.organization.tenantId,
              plan: "pro",
            },
          },
        },
      }),
    });
    if (billingWebhook.organization?.plan !== "pro" || billingWebhook.organization?.billingStatus !== "active") {
      throw new Error("Billing webhook did not activate the Pro plan.");
    }
    const billingPortal = await request("/api/billing/portal", {
      method: "POST",
      headers: { Authorization: `Bearer ${loggedIn.session.token}` },
    });
    if (billingPortal.portal?.url !== "https://billing.example.com/portal") {
      throw new Error("Billing portal endpoint did not return the configured customer portal URL.");
    }
    const billingPaymentFailed = await request("/api/billing/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "invoice.payment_failed",
        data: {
          object: {
            customer: `cus_${authSuffix}`,
            lines: { data: [{ metadata: { plan: "pro" } }] },
          },
        },
      }),
    });
    if (billingPaymentFailed.organization?.billingStatus !== "past_due") {
      throw new Error("Billing invoice.payment_failed did not mark the organization as past_due.");
    }
    const billingInvoicePaid = await request("/api/billing/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "invoice.payment_succeeded",
        data: {
          object: {
            customer: `cus_${authSuffix}`,
            lines: { data: [{ metadata: { plan: "pro" } }] },
          },
        },
      }),
    });
    if (billingInvoicePaid.organization?.billingStatus !== "active") {
      throw new Error("Billing invoice.payment_succeeded did not restore active status.");
    }
    const billingAfterWebhook = await request("/api/billing/current", { headers: { Authorization: `Bearer ${loggedIn.session.token}` } });
    if (billingAfterWebhook.billing?.plan?.id !== "pro") {
      throw new Error("Billing current endpoint did not reflect the webhook-updated plan.");
    }

    const quickProject = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: `Quick Onboarding ${Date.now().toString(36)}`,
        url: "quick-onboarding.example.com",
      }),
    });
    if (!quickProject.project?.sdkKey || !quickProject.project.url.startsWith("https://quick-onboarding.example.com")) {
      throw new Error("Quick onboarding did not generate a normalized project URL and SDK key.");
    }
    const widgetResponse = await fetch(`${baseUrl}/widget.js`);
    const widgetSource = await widgetResponse.text();
    if (!widgetResponse.ok || !widgetSource.includes("readScriptConfig") || !widgetSource.includes("data-itera-widget-host")) {
      throw new Error("Widget alias did not serve the auto-init SDK.");
    }
    const keyOnlyHeartbeat = await request("/api/signals", {
      method: "POST",
      headers: { Origin: "https://quick-onboarding.example.com" },
      body: JSON.stringify({
        sdkKey: quickProject.project.sdkKey,
        type: "sdk_loaded",
        page: quickProject.project.url,
        data: {
          text: "Key-only widget heartbeat.",
          heartbeat: true,
        },
      }),
    });
    if (!keyOnlyHeartbeat.signal || keyOnlyHeartbeat.signal.projectId !== quickProject.project.id) {
      throw new Error("Key-only widget heartbeat did not resolve the project from the SDK key.");
    }
    const quickSignal = await request("/api/signals", {
      method: "POST",
      body: JSON.stringify({
        projectId: quickProject.project.id,
        projectName: quickProject.project.name,
        sdkKey: quickProject.project.sdkKey,
        type: "connection_test",
        source: "Smoke Quick Onboarding",
        page: quickProject.project.url,
        data: {
          text: "Quick onboarding connection test.",
        },
      }),
    });
    if (!quickSignal.signal || quickSignal.signal.projectId !== quickProject.project.id) {
      throw new Error("Quick onboarding SDK key did not accept a test signal.");
    }
    try {
      await request("/api/signals", {
        method: "POST",
        body: JSON.stringify({
          projectId: quickProject.project.id,
          type: "connection_test",
          data: { text: "This should require an SDK key." },
        }),
      });
      throw new Error("Missing SDK key was accepted.");
    } catch (error) {
      if (!String(error.message).includes("SDK key is required")) throw error;
    }
    try {
      await request("/api/signals", {
        method: "POST",
        body: JSON.stringify({
          projectId: quickProject.project.id,
          sdkKey: "invalid-key",
          type: "connection_test",
          data: { text: "This should be rejected." },
        }),
      });
      throw new Error("Invalid SDK key was accepted.");
    } catch (error) {
      if (!String(error.message).includes("Invalid SDK key")) throw error;
    }
    try {
      await request("/api/signals", {
        method: "POST",
        headers: { Origin: "https://evil.example.com" },
        body: JSON.stringify({
          projectId: quickProject.project.id,
          sdkKey: quickProject.project.sdkKey,
          type: "connection_test",
          page: quickProject.project.url,
          data: { text: "This should be blocked by origin validation." },
        }),
      });
      throw new Error("Disallowed origin was accepted.");
    } catch (error) {
      if (!String(error.message).includes("Origin is not allowed")) throw error;
    }
    const quickState = await request(`/api/state?projectId=${quickProject.project.id}`);
    const quickProjectState = quickState.projects.find((item) => item.id === quickProject.project.id);
    if (!quickProjectState?.ingestion || quickProjectState.ingestion.acceptedSignals < 1 || quickProjectState.ingestion.rejectedSignals < 3) {
      throw new Error("Quick onboarding ingestion health did not record accepted and rejected signals.");
    }

    const tenantSuffix = Date.now().toString(36);
    const tenantA = await request("/api/tenants", {
      method: "POST",
      body: JSON.stringify({ id: `tenant-a-${tenantSuffix}`, name: "Tenant A" }),
    });
    const tenantB = await request("/api/tenants", {
      method: "POST",
      body: JSON.stringify({ id: `tenant-b-${tenantSuffix}`, name: "Tenant B" }),
    });
    let tenantAHeaders = { "X-Itera-Tenant": tenantA.tenant.id, "X-Itera-Tenant-Key": tenantA.accessKey, "X-Itera-User": "owner-a" };
    const tenantBHeaders = { "X-Itera-Tenant": tenantB.tenant.id, "X-Itera-Tenant-Key": tenantB.accessKey, "X-Itera-User": "owner-b" };
    try {
      await request("/api/state", {
        headers: { "X-Itera-Tenant": tenantA.tenant.id, "X-Itera-Tenant-Key": "", "X-Itera-User": "owner-a" },
      });
      throw new Error("Missing tenant access key was accepted.");
    } catch (error) {
      if (!String(error.message).includes("Tenant access key is required")) throw error;
    }
    try {
      await request("/api/state", {
        headers: { "X-Itera-Tenant": tenantA.tenant.id, "X-Itera-Tenant-Key": "wrong-key", "X-Itera-User": "owner-a" },
      });
      throw new Error("Invalid tenant access key was accepted.");
    } catch (error) {
      if (!String(error.message).includes("Invalid tenant access key")) throw error;
    }
    const tenantAProject = await request("/api/projects", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        name: `Tenant A Site ${tenantSuffix}`,
        url: "https://tenant-a.example.com",
      }),
    });
    const tenantBProject = await request("/api/projects", {
      method: "POST",
      headers: tenantBHeaders,
      body: JSON.stringify({
        name: `Tenant B Site ${tenantSuffix}`,
        url: "https://tenant-b.example.com",
      }),
    });
    if (tenantAProject.project.tenantId !== tenantAHeaders["X-Itera-Tenant"] || tenantBProject.project.tenantId !== tenantBHeaders["X-Itera-Tenant"]) {
      throw new Error("Tenant-owned projects were not assigned to the request tenant.");
    }
    const tenantAState = await request("/api/state", { headers: tenantAHeaders });
    const tenantBState = await request("/api/state", { headers: tenantBHeaders });
    if (!tenantAState.projects.some((item) => item.id === tenantAProject.project.id) || tenantAState.projects.some((item) => item.id === tenantBProject.project.id)) {
      throw new Error("Tenant A state leaked or missed tenant projects.");
    }
    if (!tenantBState.projects.some((item) => item.id === tenantBProject.project.id) || tenantBState.projects.some((item) => item.id === tenantAProject.project.id)) {
      throw new Error("Tenant B state leaked or missed tenant projects.");
    }
    const oldTenantAHeaders = { ...tenantAHeaders };
    const rotatedTenantA = await request("/api/tenant/rotate-key", { method: "POST", headers: tenantAHeaders });
    tenantAHeaders = { ...tenantAHeaders, "X-Itera-Tenant-Key": rotatedTenantA.accessKey };
    try {
      await request("/api/state", { headers: oldTenantAHeaders });
      throw new Error("Old tenant access key was accepted after rotation.");
    } catch (error) {
      if (!String(error.message).includes("Invalid tenant access key")) throw error;
    }
    const tenantAStateAfterRotation = await request("/api/state", { headers: tenantAHeaders });
    if (!tenantAStateAfterRotation.projects.some((item) => item.id === tenantAProject.project.id)) {
      throw new Error("Rotated tenant access key could not read Tenant A state.");
    }
    const tenantAPolicy = await request("/api/policy", {
      method: "PATCH",
      headers: tenantAHeaders,
      body: JSON.stringify({
        projectId: tenantAProject.project.id,
        autoPr: false,
        autoCanary: false,
        riskLimit: 1,
        confidenceLimit: 82,
      }),
    });
    if (tenantAPolicy.policy.autoPr !== false) {
      throw new Error("Tenant A policy update did not persist.");
    }
    const tenantBPolicyState = await request("/api/state", { headers: tenantBHeaders });
    if (tenantBPolicyState.policy.autoPr !== true) {
      throw new Error("Tenant A policy leaked into Tenant B.");
    }
    try {
      await request(`/api/snapshot?projectId=${tenantAProject.project.id}`, { headers: tenantBHeaders });
      throw new Error("Tenant B accessed Tenant A snapshot.");
    } catch (error) {
      if (!String(error.message).includes("Project not found")) throw error;
    }
    try {
      await request(`/api/projects/${tenantAProject.project.id}/rotate-sdk-key`, { method: "POST", headers: tenantBHeaders });
      throw new Error("Tenant B rotated Tenant A API key.");
    } catch (error) {
      if (!String(error.message).includes("Project not found")) throw error;
    }
    const tenantASignal = await request("/api/signals", {
      method: "POST",
      body: JSON.stringify({
        projectId: tenantAProject.project.id,
        sdkKey: tenantAProject.project.sdkKey,
        type: "feedback",
        source: "Tenant A SDK",
        page: "https://tenant-a.example.com/dashboard",
        data: { text: "Tenant A signal should route to tenant A only." },
      }),
    });
    if (!tenantASignal.signal || tenantASignal.state) {
      throw new Error("Public SDK signal should be accepted without returning tenant state.");
    }
    if (tenantASignal.autopilot) {
      throw new Error("Tenant A signal triggered autopilot despite tenant policy disabling autoPr.");
    }
    const tenantAStateAfterSignal = await request(`/api/state?projectId=${tenantAProject.project.id}`, { headers: tenantAHeaders });
    const tenantBStateAfterSignal = await request(`/api/state?projectId=${tenantBProject.project.id}`, { headers: tenantBHeaders });
    if (!tenantAStateAfterSignal.signals.some((item) => item.id === tenantASignal.signal.id)) {
      throw new Error("Tenant A signal was not visible to Tenant A.");
    }
    if (tenantBStateAfterSignal.signals.some((item) => item.id === tenantASignal.signal.id)) {
      throw new Error("Tenant B could see Tenant A signal.");
    }

    const projectId = `smoke-site-${Date.now().toString(36)}`;
    const projectCreate = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        id: projectId,
        name: "Smoke Test 网站",
        url: "https://smoke.example.com",
        env: "staging",
        allowedOrigins: ["https://smoke.example.com"],
      }),
    });

    if (!projectCreate.project || !projectCreate.project.sdkKey) {
      throw new Error("Project creation did not return an SDK key.");
    }
    const webhookConfig = await request(`/api/projects/${projectId}/output-webhook`, {
      method: "PATCH",
      body: JSON.stringify({ url: webhookReceiver.url, enabled: true }),
    });
    if (webhookConfig.project.outputWebhook?.status !== "active") {
      throw new Error("Output webhook was not activated.");
    }
    const webhookTest = await request(`/api/projects/${projectId}/output-webhook/test`, { method: "POST" });
    if (!webhookTest.delivery || webhookTest.delivery.status !== "delivered") {
      throw new Error("Output webhook test delivery did not succeed.");
    }
    const receivedTest = webhookReceiver.deliveries.find((delivery) => delivery.headers["x-itera-event"] === "webhook.test");
    if (!receivedTest || !verifyWebhookSignature(receivedTest, projectCreate.project.sdkKey)) {
      throw new Error("Output webhook test was not received with a valid signature.");
    }

    const before = await request(`/api/state?projectId=${projectId}`);
    const beforeSignals = before.signals.filter((item) => item.projectId === projectId).length;
    const beforeTasks = before.tasks.filter((item) => item.projectId === projectId).length;

    const created = await request("/api/signals", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        projectName: "Smoke Test 网站",
        sdkKey: projectCreate.project.sdkKey,
        type: "feedback",
        source: "Smoke Test SDK",
        page: "https://smoke.example.com/checkout",
        data: {
          text: "支付按钮点击后没有反应，用户无法完成订单。",
        },
      }),
    });

    if (!created.signal || !created.task) {
      throw new Error("Signal API did not return signal and task.");
    }

    const after = await request(`/api/state?projectId=${projectId}`);
    const afterSignals = after.signals.filter((item) => item.projectId === projectId).length;
    const afterTasks = after.tasks.filter((item) => item.projectId === projectId).length;

    if (afterSignals !== beforeSignals + 1) {
      throw new Error(`Expected one new signal, got ${afterSignals - beforeSignals}.`);
    }

    if (afterTasks !== beforeTasks + 1) {
      throw new Error(`Expected one new task, got ${afterTasks - beforeTasks}.`);
    }

    const advanced = await request(`/api/tasks/${created.task.id}/advance`, { method: "POST" });
    if (advanced.task.status !== "已批准") {
      throw new Error(`Expected task status 已批准, got ${advanced.task.status}.`);
    }

    const supportImport = await request("/api/import/support-tickets", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        projectName: "Smoke Test 网站",
        source: "Smoke Support",
        tickets: [
          {
            id: `smoke-ticket-${Date.now()}`,
            title: "客服反馈支付失败",
            text: "用户点击支付按钮后没有任何提示，无法完成订单。",
            channel: "support",
            page: "https://smoke.example.com/checkout",
          },
        ],
      }),
    });

    if (supportImport.imported !== 1 || supportImport.tasks.length !== 1) {
      throw new Error("Support import did not create one signal and task.");
    }

    const analysis = await request("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });

    if (!analysis.insight || !Array.isArray(analysis.insight.clusters)) {
      throw new Error("AI analysis did not return an insight with clusters.");
    }

    if (!analysis.insight.clusters.length) {
      throw new Error("AI analysis did not produce any clusters.");
    }

    const repoDir = prepareSmokeRepository(projectId);
    const githubInstallation = await request("/api/github/installations", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        installationId: `smoke-install-${Date.now().toString(36)}`,
        setupAction: "install",
        account: { login: "smoke-org", type: "Organization" },
        repositories: [
          {
            owner: "smoke",
            name: "smoke-site",
            fullName: "smoke/smoke-site",
            defaultBranch: "main",
            url: "https://github.com/smoke/smoke-site",
            private: false,
          },
        ],
      }),
    });
    if (!githubInstallation.installation || githubInstallation.installation.projectId !== projectId) {
      throw new Error("GitHub App installation was not recorded for the smoke project.");
    }

    const githubInstallations = await request(`/api/github/installations?projectId=${projectId}`);
    if (!githubInstallations.installations.some((item) => item.installationId === githubInstallation.installation.installationId)) {
      throw new Error("GitHub installation list did not include the recorded installation.");
    }
    const githubWebhookAdd = await request("/api/github/webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": "installation_repositories" },
      body: JSON.stringify({
        action: "added",
        installation: { id: githubInstallation.installation.installationId },
        repositories_added: [
          {
            full_name: "smoke/extra-site",
            name: "extra-site",
            owner: { login: "smoke" },
            default_branch: "main",
            html_url: "https://github.com/smoke/extra-site",
          },
        ],
        repositories_removed: [],
      }),
    });
    if (!githubWebhookAdd.result?.handled) {
      throw new Error("GitHub webhook did not add an authorized repository.");
    }
    const githubAfterWebhookAdd = await request(`/api/github/installations?projectId=${projectId}`);
    const addedInstallation = githubAfterWebhookAdd.installations.find((item) => item.installationId === githubInstallation.installation.installationId);
    if (!addedInstallation?.repositories.some((item) => item.fullName === "smoke/extra-site")) {
      throw new Error("GitHub webhook repository add was not persisted.");
    }
    const githubWebhookRemove = await request("/api/github/webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": "installation_repositories" },
      body: JSON.stringify({
        action: "removed",
        installation: { id: githubInstallation.installation.installationId },
        repositories_added: [],
        repositories_removed: [{ full_name: "smoke/extra-site", name: "extra-site", owner: { login: "smoke" } }],
      }),
    });
    if (!githubWebhookRemove.result?.handled) {
      throw new Error("GitHub webhook did not remove an authorized repository.");
    }
    const githubAfterWebhookRemove = await request(`/api/github/installations?projectId=${projectId}`);
    const removedInstallation = githubAfterWebhookRemove.installations.find((item) => item.installationId === githubInstallation.installation.installationId);
    if (removedInstallation?.repositories.some((item) => item.fullName === "smoke/extra-site")) {
      throw new Error("GitHub webhook repository removal was not persisted.");
    }

    const githubRepos = await request(`/api/github/repositories?projectId=${projectId}`);
    const authorizedRepo = githubRepos.repositories.find((item) => item.owner === "smoke" && item.name === "smoke-site");
    if (!authorizedRepo) {
      throw new Error("GitHub authorized repository list did not include smoke/smoke-site.");
    }

    const repo = await request("/api/repositories/connect", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        provider: "GitHub",
        owner: authorizedRepo.owner,
        name: authorizedRepo.name,
        defaultBranch: authorizedRepo.defaultBranch || "main",
        url: authorizedRepo.url || "https://github.com/smoke/smoke-site",
        githubInstallationId: authorizedRepo.installationId,
        localPath: repoDir,
        validationConfig: {
          checks: ["npm run lint", "npm test", "npm run build"],
          realChecks: ["node scripts/ci-smoke.js", "npm run lint", "npm test", "npm run build"],
        },
      }),
    });

    if (!repo.repository || repo.repository.status !== "connected") {
      throw new Error("Repository connection did not succeed.");
    }

    const githubStatus = await request(`/api/github/status?projectId=${projectId}`);
    if (!githubStatus.github || !["mock", "token", "github_app"].includes(githubStatus.github.mode)) {
      throw new Error("GitHub status endpoint did not return a valid mode.");
    }
    if (!githubStatus.github.projectInstallation) {
      throw new Error("GitHub status did not include the project installation.");
    }

    const githubValidation = await request("/api/github/repositories/validate", {
      method: "POST",
      body: JSON.stringify({ projectId, owner: "smoke", name: "smoke-site" }),
    });
    if (!githubValidation.validation || typeof githubValidation.validation.ok !== "boolean") {
      throw new Error("GitHub repository validation did not return a validation result.");
    }

    const prDraft = await request("/api/pr-drafts", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        taskId: created.task.id,
        repositoryId: repo.repository.id,
      }),
    });

    if (!prDraft.prDraft || !prDraft.prDraft.changedFiles.length) {
      throw new Error("PR draft did not include changed files.");
    }

    const prAdvanced = await request(`/api/pr-drafts/${prDraft.prDraft.id}/advance`, { method: "POST" });
    if (prAdvanced.prDraft.status !== "ready_for_review") {
      throw new Error(`Expected PR draft status ready_for_review, got ${prAdvanced.prDraft.status}.`);
    }

    const patchProposal = await request(`/api/pr-drafts/${prDraft.prDraft.id}/generate-patch`, { method: "POST" });
    if (!patchProposal.patchProposal || !patchProposal.patchProposal.patchFiles.length) {
      throw new Error("Patch proposal did not include any patch files.");
    }

    const qaReport = await request(`/api/patch-proposals/${patchProposal.patchProposal.id}/verify`, { method: "POST" });
    if (!qaReport.validationReport || !qaReport.validationReport.checks.length) {
      throw new Error("QA verification did not return a validation report.");
    }
    if (qaReport.validationReport.decision === "blocked") {
      throw new Error("QA verification blocked the smoke patch unexpectedly.");
    }

    const sandboxRun = await request(`/api/patch-proposals/${patchProposal.patchProposal.id}/run-sandbox`, { method: "POST" });
    if (!sandboxRun.sandboxRun || !sandboxRun.sandboxRun.commandResults.length) {
      throw new Error("Sandbox run did not return command results.");
    }
    if (sandboxRun.sandboxRun.status === "failed") {
      throw new Error("Sandbox run failed unexpectedly.");
    }

    const githubPr = await request(`/api/pr-drafts/${prDraft.prDraft.id}/open-github`, { method: "POST" });
    if (!githubPr.prDraft.remoteUrl) {
      throw new Error("GitHub PR open step did not return a remote URL.");
    }

    const patchApplication = await request(`/api/patch-proposals/${patchProposal.patchProposal.id}/apply-workspace`, {
      method: "POST",
    });
    if (!patchApplication.patchApplication || !patchApplication.patchApplication.changedFiles.length) {
      throw new Error("Workspace patch application did not change files.");
    }

    const productionSandbox = await request(`/api/patch-proposals/${patchProposal.patchProposal.id}/run-production-sandbox`, {
      method: "POST",
    });
    if (!productionSandbox.productionSandboxRun || productionSandbox.productionSandboxRun.status !== "passed") {
      throw new Error("Production sandbox did not pass.");
    }

    const ciRun = await request(`/api/pr-drafts/${prDraft.prDraft.id}/ci`, { method: "POST" });
    if (!ciRun.ciRun || ciRun.ciRun.status !== "success") {
      throw new Error("Managed CI status did not succeed.");
    }

    const preview = await request(`/api/pr-drafts/${prDraft.prDraft.id}/preview`, { method: "POST" });
    if (!preview.previewDeployment || preview.previewDeployment.status !== "ready") {
      throw new Error("Preview deployment was not ready.");
    }

    const releasePlan = await request(`/api/pr-drafts/${prDraft.prDraft.id}/release-plan`, { method: "POST" });
    if (!releasePlan.releasePlan || !releasePlan.releasePlan.phases.length) {
      throw new Error("Release plan did not include rollout phases.");
    }

    const promotedRelease = await request(`/api/release-plans/${releasePlan.releasePlan.id}/promote`, { method: "POST" });
    if (!promotedRelease.releasePlan || promotedRelease.releasePlan.currentPhase <= 0) {
      throw new Error("Release plan did not promote to a canary phase.");
    }

    const rollback = await request(`/api/release-plans/${releasePlan.releasePlan.id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ reason: "smoke rollback" }),
    });
    if (!rollback.rollback || rollback.releasePlan.status !== "rolled_back") {
      throw new Error("Rollback did not complete.");
    }
    const receivedEvents = webhookReceiver.deliveries.map((delivery) => delivery.headers["x-itera-event"]);
    for (const event of ["pr.opened", "release.planned", "release.promoted", "release.rolled_back"]) {
      if (!receivedEvents.includes(event)) {
        throw new Error(`Output webhook did not receive ${event}.`);
      }
    }
    const invalidSignature = webhookReceiver.deliveries.find((delivery) => !verifyWebhookSignature(delivery, projectCreate.project.sdkKey));
    if (invalidSignature) {
      throw new Error(`Output webhook signature was invalid for ${invalidSignature.headers["x-itera-event"]}.`);
    }
    const webhookState = await request(`/api/state?projectId=${projectId}`);
    const webhookDeliveryCount = webhookState.webhookDeliveries.filter((delivery) => delivery.projectId === projectId).length;
    if (webhookDeliveryCount < 5) {
      throw new Error("Output webhook deliveries were not persisted in project state.");
    }

    const deploymentHook = await request(`/api/projects/${projectId}/deployment-hook`, {
      method: "PATCH",
      body: JSON.stringify({ url: webhookReceiver.url, provider: "custom", enabled: true }),
    });
    if (deploymentHook.project?.deploymentHook?.status !== "active") {
      throw new Error("Deployment hook was not saved as active.");
    }
    const deploymentHookTest = await request(`/api/projects/${projectId}/deployment-hook/test`, { method: "POST" });
    if (deploymentHookTest.deploymentRun?.status !== "triggered") {
      throw new Error("Deployment hook test did not trigger successfully.");
    }
    const deploymentEvent = webhookReceiver.deliveries.find((delivery) => delivery.headers["x-itera-event"] === "deployment.trigger");
    if (!deploymentEvent || !verifyWebhookSignature(deploymentEvent, projectCreate.project.sdkKey)) {
      throw new Error("Deployment hook did not receive a signed deployment.trigger event.");
    }

    const auditLogs = await request(`/api/audit-logs?projectId=${projectId}`);
    if (!auditLogs.auditLogs || auditLogs.auditLogs.length < 5) {
      throw new Error("Audit logs did not capture production actions.");
    }

    const readiness = await request(`/api/readiness?projectId=${projectId}`);
    if (!readiness.readiness || readiness.readiness.score < 85) {
      throw new Error(`Expected readiness score >= 85, got ${readiness.readiness?.score}.`);
    }

    const autopilotProjectId = `autopilot-site-${Date.now().toString(36)}`;
    const autopilotProject = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        id: autopilotProjectId,
        name: "Smoke Autopilot Site",
        url: "https://autopilot.example.com",
        env: "staging",
        allowedOrigins: ["https://autopilot.example.com"],
      }),
    });
    const autopilotRepoDir = prepareStaticSmokeRepository(autopilotProjectId);
    const autopilotRepository = await request("/api/repositories/connect", {
      method: "POST",
      body: JSON.stringify({
        projectId: autopilotProjectId,
        provider: "GitHub",
        owner: "smoke",
        name: `${autopilotProjectId}-static`,
        defaultBranch: "main",
        url: `https://github.com/smoke/${autopilotProjectId}-static`,
        localPath: autopilotRepoDir,
        validationConfig: {
          checks: ["npm run check"],
          realChecks: ["npm run check"],
        },
      }),
    });
    if (!autopilotRepository.repository || autopilotRepository.repository.status !== "connected") {
      throw new Error("Autopilot static repository connection did not succeed.");
    }

    const autopilotSignal = await request("/api/signals", {
      method: "POST",
      body: JSON.stringify({
        projectId: autopilotProjectId,
        projectName: "Smoke Autopilot Site",
        sdkKey: autopilotProject.project.sdkKey,
        type: "feedback",
        source: "Smoke Autopilot SDK",
        page: "https://autopilot.example.com/products",
        data: {
          text: "移动端商品卡片间距太拥挤，价格经常看漏。",
        },
      }),
    });
    if (!autopilotSignal.autopilot || !autopilotSignal.autopilot.actions.some((item) => item.id === "code_agent_read")) {
      throw new Error("Signal ingestion did not trigger autopilot for a safe approved task.");
    }

    const autopilot = await request(`/api/projects/${autopilotProjectId}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ autoRelease: true, mode: "advanced" }),
    });
    const autopilotDraft = autopilot.state.prDrafts.find((item) => item.projectId === autopilotProjectId);
    const autopilotPatch = autopilot.state.patchProposals.find((item) => item.projectId === autopilotProjectId);
    const autopilotQa = autopilot.state.validationReports.find((item) => item.projectId === autopilotProjectId);
    const autopilotSandbox = autopilot.state.sandboxRuns.find((item) => item.projectId === autopilotProjectId);
    const autopilotDeployment = autopilot.state.deploymentRuns.find((item) => item.projectId === autopilotProjectId);
    const autopilotTrace =
      autopilot.run?.artifacts?.codeAgentTrace ||
      autopilotDraft?.codeAgentTrace ||
      autopilotPatch?.codeAgentTrace ||
      null;
    if (!autopilotDraft || !autopilotPatch || !autopilotQa || !autopilotSandbox) {
      throw new Error("Autopilot did not create the expected PR draft, patch, QA report, and sandbox run.");
    }
    if (!autopilotTrace || !Array.isArray(autopilotTrace.stages) || autopilotTrace.stages.length < 5) {
      throw new Error("Autopilot did not expose an auditable Code Agent trace.");
    }
    if (!autopilotDraft.remoteUrl && !["deployed", "triggered"].includes(autopilotDeployment?.status)) {
      throw new Error("Autopilot did not open a PR or record a local/customer deployment.");
    }
    if (!autopilot.readiness || autopilot.readiness.score < 75) {
      throw new Error(`Expected autopilot readiness score >= 75 for local code-agent flow, got ${autopilot.readiness?.score}.`);
    }
    const autopilotRelease = autopilot.state.releasePlans.find((item) => item.projectId === autopilotProjectId);
    if (!autopilotRelease || autopilotRelease.status !== "completed" || autopilotRelease.deploymentStatus !== "deployed") {
      throw new Error("Advanced autopilot should update the local customer test site when a readable local repository is connected.");
    }
    if (autopilotRelease.productionRelease?.status !== "waiting") {
      throw new Error("Advanced autopilot did not expose the production-release waiting gate for real integrations.");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          health: "ok",
          publicDocs: true,
          quickOnboardingProject: quickProject.project.id,
          keyOnlyWidgetSignal: keyOnlyHeartbeat.signal.id,
          quickOnboardingSignal: quickSignal.signal.id,
          quickOnboardingAccepted: quickProjectState.ingestion.acceptedSignals,
          quickOnboardingRejected: quickProjectState.ingestion.rejectedSignals,
          authUser: registered.user.id,
          authOrganization: registered.organization.id,
          authProject: authProject.project.id,
          sqliteMigration: true,
          sqliteStorageServer: true,
          productionReady: production.production.readiness.productionReady,
          productionBlockers: production.production.readiness.blockers.length,
          platformHttpsConfigured: platformConfig.production.deployment.httpsReady,
          platformDocsUrl: platformConfig.production.deployment.docsUrl,
          billingCheckoutMode: checkout.checkout.mode,
          billingWebhookAction: billingWebhook.action,
          billingPortalMode: billingPortal.portal.mode,
          billingPaymentFailedAction: billingPaymentFailed.action,
          billingInvoicePaidAction: billingInvoicePaid.action,
          billingPlanAfterWebhook: billingAfterWebhook.billing.plan.id,
          smokeTenant: smokeTenant.tenant.id,
          tenantAProject: tenantAProject.project.id,
          tenantBProject: tenantBProject.project.id,
          tenantAuth: true,
          tenantKeyRotated: true,
          tenantIsolation: true,
          tenantPolicyIsolated: true,
          project: projectCreate.project.id,
          sdkKeyCreated: Boolean(projectCreate.project.sdkKey),
          createdSignal: created.signal.id,
          createdTask: created.task.id,
          taskStatusAfterAdvance: advanced.task.status,
          importedSupportTickets: supportImport.imported,
          analysisModel: analysis.insight.model,
          analysisClusters: analysis.insight.clusters.length,
          aiCreatedTasks: analysis.createdTasks.length,
          githubInstallation: githubInstallation.installation.installationId,
          githubWebhookAdd: githubWebhookAdd.result.handled,
          githubWebhookRemove: githubWebhookRemove.result.handled,
          authorizedRepos: githubRepos.repositories.length,
          repository: repo.repository.url,
          repositoryInstallation: repo.repository.githubInstallationId,
          githubMode: githubStatus.github.mode,
          githubValidationOk: githubValidation.validation.ok,
          prDraft: prDraft.prDraft.id,
          prDraftStatus: prAdvanced.prDraft.status,
          patchProposal: patchProposal.patchProposal.id,
          patchFiles: patchProposal.patchProposal.patchFiles.length,
          qaReport: qaReport.validationReport.id,
          qaDecision: qaReport.validationReport.decision,
          qaRiskScore: qaReport.validationReport.riskScore,
          sandboxRun: sandboxRun.sandboxRun.id,
          sandboxStatus: sandboxRun.sandboxRun.status,
          sandboxCommands: sandboxRun.sandboxRun.commandResults.length,
          githubStatus: githubPr.prDraft.status,
          githubUrl: githubPr.prDraft.remoteUrl,
          outputWebhookUrl: webhookReceiver.url,
          outputWebhookEvents: receivedEvents,
          outputWebhookDeliveries: webhookDeliveryCount,
          deploymentHook: deploymentHook.project.deploymentHook.status,
          deploymentHookTest: deploymentHookTest.deploymentRun.status,
          workspaceApplication: patchApplication.patchApplication.id,
          productionSandbox: productionSandbox.productionSandboxRun.id,
          productionSandboxStatus: productionSandbox.productionSandboxRun.status,
          ciStatus: ciRun.ciRun.status,
          previewUrl: preview.previewDeployment.url,
          releasePlan: releasePlan.releasePlan.id,
          promotedPhase: promotedRelease.releasePlan.currentPhase,
          rollback: rollback.rollback.id,
          auditLogs: auditLogs.auditLogs.length,
          readinessScore: readiness.readiness.score,
          autopilotProject: autopilotProjectId,
          signalTriggeredAutopilot: autopilotSignal.autopilot.actions.map((item) => `${item.id}:${item.status}`),
          autopilotActions: autopilot.actions.map((item) => `${item.id}:${item.status}`),
          autopilotReadinessScore: autopilot.readiness.score,
          autopilotGithubUrl: autopilotDraft.remoteUrl,
          autopilotCodeAgentStatus: autopilotTrace.status,
          autopilotCodeAgentStages: autopilotTrace.stages.length,
          autopilotDeployment: autopilotDeployment?.status || "",
          autopilotRelease: autopilotRelease.id,
          autopilotReleaseStatus: autopilotRelease.status,
          autopilotDeploymentStatus: autopilotRelease.deploymentStatus,
          autopilotRealReleaseStatus: autopilotRelease.realRelease?.status,
          autopilotRealReleaseGaps: autopilotRelease.realRelease?.gaps || [],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    await stopChild(child);
    await webhookReceiver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
