const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");

function parseEnv(raw) {
  const env = {};
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = normalized.indexOf("=");
    if (eq <= 0) return;
    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  });
  return env;
}

function value(env, key) {
  return String(env[key] || "").trim();
}

function isPlaceholder(text) {
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

function has(env, key) {
  return !isPlaceholder(value(env, key));
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.local. Copy .env.local.example to .env.local and fill real external config.");
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(envPath, "utf8"));
const githubAppReady = has(env, "GITHUB_APP_SLUG") && has(env, "GITHUB_APP_ID") && has(env, "GITHUB_APP_PRIVATE_KEY_BASE64");
const githubTokenReady = has(env, "GITHUB_TOKEN");
const paymentLinksReady = has(env, "STRIPE_PAYMENT_LINK_PRO") || has(env, "STRIPE_PAYMENT_LINK_SCALE");
const checkoutSessionReady = has(env, "STRIPE_SECRET_KEY") && (has(env, "STRIPE_PRICE_PRO") || has(env, "STRIPE_PRICE_SCALE"));
const sandboxPrivateNetworkReady = /^true$/i.test(value(env, "SANDBOX_PROVIDER_PRIVATE_NETWORK"));
const stripePortalReady = has(env, "STRIPE_SECRET_KEY") || has(env, "STRIPE_CUSTOMER_PORTAL_URL");

const checks = [
  check("Storage is SQLite", value(env, "STORAGE_DRIVER").toLowerCase() === "sqlite", "Set STORAGE_DRIVER=sqlite for local durable mode."),
  check("Public HTTPS URL", /^https:\/\//i.test(value(env, "PUBLIC_BASE_URL")) && !isPlaceholder(value(env, "PUBLIC_BASE_URL")), "Set PUBLIC_BASE_URL to the public HTTPS URL of this platform."),
  check("GitHub credentials", githubAppReady || githubTokenReady, "Set GitHub App fields, or GITHUB_TOKEN for early testing."),
  check("GitHub webhook secret", githubTokenReady || has(env, "GITHUB_WEBHOOK_SECRET"), "Set GITHUB_WEBHOOK_SECRET when using GitHub App webhooks."),
  check("Isolated sandbox provider", has(env, "SANDBOX_PROVIDER_URL"), "Set SANDBOX_PROVIDER_URL to a real isolated runtime endpoint."),
  check("Sandbox auth", has(env, "SANDBOX_PROVIDER_TOKEN") || has(env, "VERCEL_SANDBOX_TOKEN") || sandboxPrivateNetworkReady, "Set a sandbox provider token unless SANDBOX_PROVIDER_PRIVATE_NETWORK=true."),
  check("Stripe checkout", paymentLinksReady || checkoutSessionReady, "Set Stripe Payment Links, or STRIPE_SECRET_KEY plus STRIPE_PRICE_* IDs."),
  check("Stripe webhook secret", has(env, "STRIPE_WEBHOOK_SECRET"), "Set STRIPE_WEBHOOK_SECRET so payments update plan state."),
  check("Stripe customer portal", stripePortalReady, "Set STRIPE_SECRET_KEY for API portal sessions, or STRIPE_CUSTOMER_PORTAL_URL for a hosted portal link."),
];

const blockers = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: blockers.length === 0, checks, blockers }, null, 2));
process.exit(blockers.length ? 1 : 0);
