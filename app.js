(() => {
  const UI_KEY = "itera-ai-ui-v2";
  const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:8787/api" : "/api";
  const DEFAULT_TENANT_ID = "tenant-local";
  const DEFAULT_TENANT_ACCESS_KEY = "tnk_tenant-local_dev";

  const agents = [
    { name: "反馈助手", role: "收集和补充问题" },
    { name: "产品助手", role: "整理优先级" },
    { name: "检查助手", role: "复现和测试" },
    { name: "改动助手", role: "生成代码改动" },
    { name: "审核助手", role: "判断风险" },
    { name: "发布助手", role: "小范围发布和回滚" },
  ];

  const pipeline = ["收到反馈", "判断问题", "生成任务", "生成改动", "安全测试", "发布上线"];

  const offlineData = {
    selectedProjectId: "a-site",
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
      },
    ],
    feedback: [
      {
        id: "sig-offline-1",
        projectId: "a-site",
        source: "离线演示",
        category: "bug",
        severity: "高",
        risk: 3,
        confidence: 88,
        text: "移动端支付按钮偶尔没有反应，用户刷新后才成功。",
        createdAt: "2026-06-17T09:42:00.000Z",
      },
    ],
    tasks: [
      {
        id: "task-offline-1",
        projectId: "a-site",
        title: "修复移动端支付按钮无响应",
        summary: "复现点击态丢失，补充测试并生成待发布改动。",
        category: "bug",
        risk: 3,
        confidence: 88,
        agent: "改动助手",
        status: "待审批",
      },
    ],
    runs: [],
    insights: [],
    repositories: [],
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
    tenant: {
      id: DEFAULT_TENANT_ID,
      name: "Local Tenant",
      keyPreview: DEFAULT_TENANT_ACCESS_KEY,
      status: "active",
      projectCount: 1,
    },
    github: {
      mode: "mock",
      tokenConfigured: false,
      appConfigured: false,
      canOpenRealPr: false,
    },
    githubSetup: {
      mode: "mock",
      configured: false,
      canOpenRealPr: false,
      message: "GitHub setup is not connected.",
      app: {},
      urls: {},
      checks: [],
      requiredPermissions: [],
      requiredEvents: [],
      envTemplate: "",
    },
    sandboxSetup: {
      mode: "local-allowlist",
      configured: false,
      providerUrlConfigured: false,
      tokenConfigured: false,
      envTemplate: "",
      checks: [],
      contract: {},
      samplePayload: {},
    },
    billingSetup: {
      mode: "mock",
      configured: false,
      checkoutReady: false,
      webhookReady: false,
      portalReady: false,
      checks: [],
      envTemplate: "",
      plans: [],
      urls: {},
      current: null,
    },
    readiness: null,
    policy: {
      autoPr: true,
      autoCanary: true,
      autoMerge: true,
      riskLimit: 1,
      confidenceLimit: 82,
    },
    productionStatus: {
      storage: { driver: "offline", durable: false },
      auth: { enabled: true, users: 0, organizations: 0, activeSessions: 0 },
      deployment: { publicBaseUrl: "", httpsReady: false },
      aiProvider: { configured: false, mode: "local_heuristic", provider: "openai-compatible", model: "", message: "AI API is not configured." },
      githubApp: { configured: false, mode: "mock" },
      sandbox: { mode: "local-allowlist", isolatedRuntimeConfigured: false },
      billing: { mode: "mock", stripeConfigured: false, stripeWebhookConfigured: false, stripePortalConfigured: false },
      readiness: { productionReady: false, blockers: ["启动 API 后查看真实生产阻塞项。"] },
    },
    log: ["[离线] 启动演示数据。运行 `npm start` 后会连接真实 API。"],
  };

  const savedUi = loadUiState();
  const initialSearchParams = new URLSearchParams(location.search);
  const initialProjectId = initialSearchParams.get("projectId");
  const initialView = initialSearchParams.get("view");
  const initialLocalTenant = initialSearchParams.get("localTenant") === "1";
  const initialGithubInstalled = initialSearchParams.get("githubInstalled");
  let state = {
    ...offlineData,
    activeView: initialView || savedUi.activeView || "overview",
    selectedProjectId: initialProjectId || savedUi.selectedProjectId || offlineData.selectedProjectId,
    mode: savedUi.mode || "assist",
    feedbackFilter: savedUi.feedbackFilter || "all",
    copiedSnippetProjectId: savedUi.copiedSnippetProjectId || "",
    tenantCredentials: {
      tenantId: initialLocalTenant ? DEFAULT_TENANT_ID : savedUi.tenantId || DEFAULT_TENANT_ID,
      tenantAccessKey: initialLocalTenant ? DEFAULT_TENANT_ACCESS_KEY : savedUi.tenantAccessKey || DEFAULT_TENANT_ACCESS_KEY,
    },
    auth: {
      sessionToken: initialLocalTenant ? "" : savedUi.auth?.sessionToken || "",
      sessionExpiresAt: initialLocalTenant ? "" : savedUi.auth?.sessionExpiresAt || "",
      user: initialLocalTenant ? null : savedUi.auth?.user || null,
      organization: initialLocalTenant ? null : savedUi.auth?.organization || null,
      tenant: initialLocalTenant ? null : savedUi.auth?.tenant || null,
    },
    githubInstallations: [],
    githubRepositories: [],
    apiConnected: false,
  };

  let runTimer = null;
  let runningIndex = -1;
  let pollingTimer = null;
  let lastSyncedAt = null;
  let aiProviderDraft = null;
  let forceRenderAiProviderPanel = false;
  let deferredRenderTimer = null;
  let renderAfterEditing = false;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function readAiProviderFormDraft() {
    const form = $("#aiProviderConfigForm");
    if (!form) return null;
    return {
      baseUrl: $("#aiBaseUrlInput")?.value || "",
      model: $("#aiModelInput")?.value || "",
      apiKey: $("#aiApiKeyInput")?.value || "",
      proxyUrl: $("#aiProxyUrlInput")?.value || "",
      temperature: $("#aiTemperatureInput")?.value || "0.2",
      clearApiKey: Boolean($("#aiClearKeyInput")?.checked),
    };
  }

  function rememberAiProviderDraft() {
    aiProviderDraft = readAiProviderFormDraft() || aiProviderDraft;
  }

  function isEditingAiProviderForm() {
    return Boolean(document.activeElement?.closest?.("#aiProviderConfigForm"));
  }

  function isEditingAnyFormControl() {
    const element = document.activeElement;
    if (!element?.matches) return false;
    return Boolean(element.closest("form") && element.matches("input, textarea, select"));
  }

  function scheduleRenderAfterEditing() {
    renderAfterEditing = true;
    if (deferredRenderTimer) return;
    deferredRenderTimer = window.setInterval(() => {
      if (isEditingAnyFormControl()) return;
      window.clearInterval(deferredRenderTimer);
      deferredRenderTimer = null;
      if (!renderAfterEditing) return;
      renderAfterEditing = false;
      render();
    }, 400);
  }

  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveUiState() {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        activeView: state.activeView,
        selectedProjectId: state.selectedProjectId,
        mode: state.mode,
        feedbackFilter: state.feedbackFilter,
        copiedSnippetProjectId: state.copiedSnippetProjectId || "",
        tenantId: state.tenantCredentials?.tenantId || DEFAULT_TENANT_ID,
        tenantAccessKey: state.tenantCredentials?.tenantAccessKey || DEFAULT_TENANT_ACCESS_KEY,
        auth: state.auth || {},
      }),
    );
  }

  async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Itera-Tenant": state.tenantCredentials?.tenantId || DEFAULT_TENANT_ID,
        "X-Itera-Tenant-Key": state.tenantCredentials?.tenantAccessKey || DEFAULT_TENANT_ACCESS_KEY,
        "X-Itera-User": "local-operator",
        ...(state.auth?.sessionToken ? { Authorization: `Bearer ${state.auth.sessionToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "API request failed");
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function refreshState(showConnectionToast = false) {
    try {
      const data = await apiRequest(`/state?projectId=${encodeURIComponent(state.selectedProjectId)}`);
      const ui = {
        activeView: state.activeView,
        mode: state.mode,
        feedbackFilter: state.feedbackFilter,
        copiedSnippetProjectId: state.copiedSnippetProjectId,
        tenantCredentials: state.tenantCredentials,
        auth: state.auth,
      };
      state = {
        ...state,
        ...data,
        ...ui,
        apiConnected: true,
        selectedProjectId: state.selectedProjectId || data.selectedProjectId,
      };
      try {
        const production = await apiRequest("/production/status");
        state.productionStatus = production.production || state.productionStatus;
      } catch {}
      try {
        const githubSetup = await apiRequest(`/github/setup?projectId=${encodeURIComponent(state.selectedProjectId || data.selectedProjectId || "")}`);
        state.githubSetup = githubSetup.setup || state.githubSetup;
      } catch {}
      try {
        const sandboxSetup = await apiRequest("/sandbox/setup");
        state.sandboxSetup = sandboxSetup.setup || state.sandboxSetup;
      } catch {}
      try {
        const billingSetup = await apiRequest("/billing/setup");
        state.billingSetup = billingSetup.setup || state.billingSetup;
      } catch {}
      lastSyncedAt = new Date();
      if (showConnectionToast) showToast("已连接真实 API");
    } catch (error) {
      if (error.status === 401 && state.auth?.sessionToken) {
        state.auth = { sessionToken: "", sessionExpiresAt: "", user: null, organization: null, tenant: null };
        state.tenantCredentials = {
          tenantId: DEFAULT_TENANT_ID,
          tenantAccessKey: DEFAULT_TENANT_ACCESS_KEY,
        };
      }
      state.apiConnected = false;
      if (showConnectionToast) showToast("API 未连接，当前使用离线演示数据");
    }
    saveUiState();
    if (isEditingAnyFormControl()) {
      rememberAiProviderDraft();
      scheduleRenderAfterEditing();
      return;
    }
    render();
  }

  function startRealtimeRefresh() {
    if (pollingTimer) window.clearInterval(pollingTimer);
    pollingTimer = window.setInterval(() => {
      if (document.hidden || runTimer) return;
      refreshState(false);
    }, 3000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshState(false);
    });
  }

  function emptyProject() {
    return {
      id: "",
      name: "请先创建项目",
      url: "",
      env: "production",
      health: 0,
      conversion: 0,
      errorRate: 0,
      canary: 0,
    };
  }

  function activeProject() {
    return state.projects.find((project) => project.id === state.selectedProjectId) || state.projects[0] || emptyProject();
  }

  function projectFeedback() {
    const project = activeProject();
    return projectFeedbackFor(project.id);
  }

  function projectTasks() {
    const project = activeProject();
    return projectTasksFor(project.id);
  }

  function projectFeedbackFor(projectId) {
    return (state.feedback || state.signals || []).filter((item) => item.projectId === projectId);
  }

  function projectTasksFor(projectId) {
    return (state.tasks || []).filter((task) => task.projectId === projectId);
  }

  function projectActivityTime(projectId) {
    const items = [...projectFeedbackFor(projectId), ...projectTasksFor(projectId)];
    return items.reduce((latest, item) => {
      const time = new Date(item.createdAt || item.updatedAt || 0).getTime();
      return Number.isFinite(time) && time > latest ? time : latest;
    }, 0);
  }

  function latestProjectWithTasks(exceptProjectId = "") {
    return (state.projects || [])
      .filter((project) => project.id !== exceptProjectId && projectTasksFor(project.id).length)
      .sort((a, b) => projectActivityTime(b.id) - projectActivityTime(a.id))[0];
  }

  function projectById(projectId) {
    return (state.projects || []).find((project) => project.id === projectId) || null;
  }

  function newestItem(items = []) {
    return items
      .slice()
      .sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0))[0];
  }

  function latestSignalAcrossProjects() {
    return newestItem(state.signals || state.feedback || []);
  }

  function projectRepositories() {
    const project = activeProject();
    return (state.repositories || []).filter((repo) => repo.projectId === project.id);
  }

  function projectPrDrafts() {
    const project = activeProject();
    return (state.prDrafts || []).filter((draft) => draft.projectId === project.id);
  }

  function projectPatchProposals() {
    const project = activeProject();
    return (state.patchProposals || []).filter((proposal) => proposal.projectId === project.id);
  }

  function projectValidationReports() {
    const project = activeProject();
    return (state.validationReports || []).filter((report) => report.projectId === project.id);
  }

  function projectSandboxRuns() {
    const project = activeProject();
    return (state.sandboxRuns || []).filter((run) => run.projectId === project.id);
  }

  function projectPatchApplications() {
    const project = activeProject();
    return (state.patchApplications || []).filter((item) => item.projectId === project.id);
  }

  function projectProductionSandboxRuns() {
    const project = activeProject();
    return (state.productionSandboxRuns || []).filter((run) => run.projectId === project.id);
  }

  function projectPreviewDeployments() {
    const project = activeProject();
    return (state.previewDeployments || []).filter((deployment) => deployment.projectId === project.id);
  }

  function projectCiRuns() {
    const project = activeProject();
    return (state.ciRuns || []).filter((run) => run.projectId === project.id);
  }

  function projectDeploymentRuns() {
    const project = activeProject();
    return (state.deploymentRuns || []).filter((run) => run.projectId === project.id);
  }

  function projectReleasePlans() {
    const project = activeProject();
    return (state.releasePlans || []).filter((plan) => plan.projectId === project.id);
  }

  function projectRuns() {
    const project = activeProject();
    return (state.runs || [])
      .filter((run) => run.projectId === project.id)
      .sort((a, b) => new Date(b.finishedAt || b.createdAt || b.startedAt || 0) - new Date(a.finishedAt || a.createdAt || a.startedAt || 0));
  }

  function projectWebhookDeliveries() {
    const project = activeProject();
    return (state.webhookDeliveries || [])
      .filter((delivery) => delivery.projectId === project.id)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  function projectAuditLogs() {
    const project = activeProject();
    return (state.auditLogs || []).filter((entry) => entry.metadata?.projectId === project.id || String(entry.target || "").includes(project.id));
  }

  function projectGithubInstallations() {
    const project = activeProject();
    return (state.githubInstallations || [])
      .filter((installation) => installation.projectId === project.id && installation.status !== "deleted")
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  }

  function projectAuthorizedGithubRepositories() {
    const github = state.github || {};
    const installation = github.projectInstallation || projectGithubInstallations()[0];
    return state.githubRepositories?.length ? state.githubRepositories : installation?.repositories || [];
  }

  function activeReadiness() {
    const project = activeProject();
    if (state.readiness?.projectId === project.id) return state.readiness;
    const checks = [
      ["project", "客户项目已创建", project.id ? "passed" : "missing"],
      ["sdk", "接入代码可用", projectSdkKey(project) ? "passed" : "missing"],
      ["signals", "已收到用户反馈", projectFeedback().length ? "passed" : "waiting"],
      ["tasks", "AI 已整理成任务", projectTasks().length ? "passed" : "waiting"],
      ["repository", "网站代码已连接", projectRepositories().length ? "passed" : "missing"],
      ["pr_draft", "已生成待发布改动", projectPrDrafts().length ? "passed" : "waiting"],
      ["patch", "已生成代码改动", projectPatchProposals().length ? "passed" : "waiting"],
      ["qa", "风险检查完成", projectValidationReports().length ? "passed" : "waiting"],
      ["sandbox", "安全测试完成", projectSandboxRuns().length ? "passed" : "waiting"],
      ["github_pr", "已提交到代码仓库", projectPrDrafts().some((draft) => draft.remoteUrl) ? "passed" : "waiting"],
      ["output_webhook", "结果通知已接通", activeProject().outputWebhook?.status === "active" ? "passed" : "missing"],
    ].map(([id, label, status]) => ({
      id,
      label,
      status,
      detail: status === "passed" ? "已完成" : "等待真实 API 推进",
      action: id,
    }));
    const score = Math.round((checks.filter((check) => check.status === "passed").length / checks.length) * 100);
    const nextAction = checks.find((check) => check.status !== "passed");
    return {
      projectId: project.id,
      score,
      status: score >= 90 ? "self_evolving" : projectFeedback().length ? "in_progress" : "waiting_for_signals",
      checks,
      nextAction: nextAction
        ? {
            id: nextAction.action,
            label: nextAction.label,
            detail: nextAction.detail,
          }
        : null,
      updatedAt: new Date().toISOString(),
    };
  }

  function patchForDraft(draftId) {
    return (state.patchProposals || []).find((proposal) => proposal.prDraftId === draftId);
  }

  function reportForPatch(patchId) {
    return projectValidationReports()
      .filter((report) => report.patchProposalId === patchId)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  }

  function sandboxRunForPatch(patchId) {
    return projectSandboxRuns()
      .filter((run) => run.patchProposalId === patchId)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  }

  function categoryLabel(category) {
    return {
      bug: "Bug",
      request: "需求",
      performance: "性能",
      support: "客服",
    }[category] || "信号";
  }

  function riskLabel(risk) {
    return {
      1: "低风险",
      2: "中风险",
      3: "高风险",
    }[risk] || "待判断";
  }

  function riskClass(risk) {
    return {
      1: "risk-low",
      2: "risk-mid",
      3: "risk-high",
    }[risk] || "risk-mid";
  }

  function modeLabel(mode) {
    return {
      observe: "观察记录",
      assist: "协同审批",
      auto: "自动进化",
    }[mode] || "协同审批";
  }

  function nextTaskAction(status) {
    return {
      待审批: "批准",
      已批准: "开始进化",
      构建中: "验证",
      验证通过: "发布",
      已灰度: "完成",
      已完成: "完成",
    }[status] || "推进";
  }

  function taskStatusLabel(status) {
    return {
      待审批: "等待确认",
      已批准: "已确认，等待执行",
      构建中: "正在生成改动",
      验证通过: "测试通过，等待发布",
      已灰度: "小范围发布中",
      已完成: "已完成",
    }[status] || status;
  }

  function taskProgress(task) {
    if (task.status === "待审批") {
      return { tone: "waiting", label: "等待确认", detail: "这条反馈还没确认，系统不会改网站。" };
    }
    const draft = (state.prDrafts || []).find((item) => item.id === task.prDraftId || item.taskId === task.id);
    const patch = draft
      ? (state.patchProposals || []).find((item) => item.id === draft.patchProposalId || item.prDraftId === draft.id)
      : (state.patchProposals || []).find((item) => item.taskId === task.id);
    const application = patch ? (state.patchApplications || []).find((item) => item.patchProposalId === patch.id) : null;
    const release = draft ? (state.releasePlans || []).find((item) => item.prDraftId === draft.id) : null;
    const deployment = (state.deploymentRuns || []).find(
      (item) => item.releasePlanId === release?.id || item.prDraftId === draft?.id || item.patchProposalId === patch?.id,
    );
    const run = (state.runs || []).find((item) => item.artifacts?.prDraftId === draft?.id || item.artifacts?.patchProposalId === patch?.id);
    const gaps = run?.artifacts?.realReleaseGaps || release?.realRelease?.gaps || [];

    if (deployment?.provider === "local-static-site" && deployment?.status === "deployed") {
      const productionGaps = run?.artifacts?.productionReleaseGaps || release?.productionRelease?.gaps || gaps;
      return {
        tone: productionGaps.length ? "warning" : "done",
        label: productionGaps.length ? "本地测试网站已更新，生产未上线" : "本地测试网站已更新",
        detail: productionGaps.length
          ? `测试商城文件已更新并通过本地校验；客户生产站还缺：${productionGaps[0]}`
          : "文件已经写入测试商城，并通过本地校验；刷新测试网站即可查看变化。",
      };
    }
    if (deployment?.status === "triggered" || deployment?.status === "deployed" || release?.deploymentStatus === "deployed") {
      return { tone: "done", label: "真实网站已触发部署", detail: "部署 Hook 已执行，刷新客户网站查看最终效果。" };
    }
    if (application?.status === "applied") {
      return { tone: "done", label: "已应用到本地工作区", detail: `已改 ${application.changedFiles?.length || 0} 个文件，正在等待校验或部署记录。` };
    }
    if (run?.artifacts?.releaseExecutionMode === "simulation" || run?.artifacts?.realReleaseStatus === "waiting") {
      return {
        tone: "warning",
        label: "只跑完模拟发布，真实网站未更新",
        detail: gaps.length ? userFacingReleaseGap(gaps[0]) : "缺少真实代码授权、自动检查或部署入口，所以没有改到客户网站。",
      };
    }
    if (draft?.remoteUrl && String(draft.remoteUrl).includes("/mock-")) {
      return { tone: "warning", label: "只是演示改动，真实网站未更新", detail: "还没有连接真实代码仓库，所以不会修改真实网站。" };
    }
    if (patch) {
      return { tone: "working", label: "已生成代码改动", detail: "还没有写入网站或发布。" };
    }
    if (task.status === "已批准") {
      return { tone: "waiting", label: "已确认，等待开始进化", detail: "点击“开始进化”后才会生成代码改动和发布记录。" };
    }
    return { tone: "waiting", label: "尚未改动网站", detail: "还没有生成可以落地的代码改动。" };
  }

  function codePlanForTask(task) {
    const draft = (state.prDrafts || []).find((item) => item.id === task.prDraftId || item.taskId === task.id);
    const patch = draft
      ? (state.patchProposals || []).find((item) => item.id === draft.patchProposalId || item.prDraftId === draft.id)
      : (state.patchProposals || []).find((item) => item.taskId === task.id);
    const application = patch ? (state.patchApplications || []).find((item) => item.patchProposalId === patch.id) : null;
    return application?.codePlan || patch?.codePlan || draft?.codePlan || null;
  }

  function renderChangeEvidencePanel({ application, patch, deployment, codePlan, run }) {
    const files = application?.changedFiles?.length
      ? application.changedFiles.map((file) => file.path || file)
      : patch?.patchFiles?.map((file) => file.path).filter(Boolean) || [];
    const actions = Array.isArray(run?.actions) ? run.actions : [];
    const generator = codePlan?.repositoryAnalysis?.generator || "not_recorded";
    const localApply = actions.find((action) => action.id === "local_apply");
    const localCheck = actions.find((action) => action.id === "local_check");
    const deploy = actions.find((action) => action.id === "deploy") || deployment;

    if (!files.length && !patch && !application && !run) return "";

    return `
      <div class="change-evidence-panel">
        <div class="change-evidence-head">
          <div>
            <small>真实改动证据</small>
            <strong>${escapeHtml(application?.status === "applied" ? "已写入客户代码" : patch ? "已生成代码补丁" : "等待生成代码")}</strong>
          </div>
          <span class="tag">${escapeHtml(generator)}</span>
        </div>
        <div class="change-evidence-grid">
          <div>
            <small>变更文件</small>
            <strong>${files.length} 个</strong>
            <span>${files.length ? files.map((file) => escapeHtml(file)).join(" · ") : "还没有真实文件改动"}</span>
          </div>
          <div>
            <small>写入结果</small>
            <strong>${escapeHtml(localApply?.status || application?.status || "等待")}</strong>
            <span>${escapeHtml(localApply?.detail || (application ? `${application.changedFiles?.length || 0} files changed` : "批准后才会写入工作区"))}</span>
          </div>
          <div>
            <small>检查结果</small>
            <strong>${escapeHtml(localCheck?.status || "等待")}</strong>
            <span>${escapeHtml(localCheck?.detail || "等待本地检查")}</span>
          </div>
          <div>
            <small>页面结果</small>
            <strong>${escapeHtml(deploy?.status || deployment?.status || "等待")}</strong>
            <span>${escapeHtml(deploy?.detail || deployment?.url || "等待部署/本地页面刷新")}</span>
          </div>
        </div>
      </div>
    `;
  }

  function planItems(items, limit = 3) {
    return Array.isArray(items) ? items.filter(Boolean).slice(0, limit) : [];
  }

  function renderTaskCodePlan(plan) {
    if (!plan) return "";
    return `
      <div class="task-code-plan">
        <strong>AI 代码思考</strong>
        <small>${escapeHtml(plan.summary || "已生成代码变更计划。")}</small>
        <div class="task-plan-tags">
          <span>改 ${Number(plan.modify?.length || 0)}</span>
          <span>新增 ${Number(plan.add?.length || 0)}</span>
          <span>删除/避免 ${Number((plan.remove?.length || 0) + (plan.avoid?.length || 0))}</span>
        </div>
      </div>
    `;
  }

  function renderCodePlanList(title, items) {
    const rows = planItems(items, 5);
    if (!rows.length) return "";
    return `
      <div class="code-plan-list">
        <strong>${escapeHtml(title)}</strong>
        ${rows.map((item) => `<small>${escapeHtml(item)}</small>`).join("")}
      </div>
    `;
  }

  function renderCodeEvidence(plan) {
    const analysis = plan?.repositoryAnalysis;
    if (!analysis) return "";
    const files = planItems(analysis.filesRead, 4);
    return `
      <div class="code-evidence">
        <div class="code-evidence-head">
          <strong>Code Agent 读取证据</strong>
          <span class="check-status ${escapeHtml(analysis.status || "waiting")}">${Number(analysis.confidence || 0)}%</span>
        </div>
        <small>${escapeHtml(analysis.summary || "等待读取仓库上下文。")}</small>
        ${
          files.length
            ? `<div class="code-evidence-files">
                ${files
                  .map(
                    (file) => `
                      <div class="code-evidence-file">
                        <strong>${escapeHtml(file.path)}</strong>
                        <small>${file.exists ? `${Number(file.lines || 0)} 行 · ${Number(file.bytes || 0)} bytes` : "文件不存在或等待生成"}</small>
                        ${(file.evidence || [])
                          .slice(0, 2)
                          .map((item) => `<code>L${Number(item.line || 0)} ${escapeHtml(item.text || "")}</code>`)
                          .join("")}
                      </div>
                    `,
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>
    `;
  }

  function renderCodePlanPanel(plan) {
    if (!plan) return "";
    const guardrails = [...planItems(plan.remove, 3), ...planItems(plan.avoid, 4)];
    const verification = [...planItems(plan.verification, 3), ...planItems(plan.acceptanceCriteria, 3)];
    return `
      <div class="code-plan-card">
        <div class="code-plan-head">
          <span class="tag">AI 代码思考</span>
          <strong>${escapeHtml(plan.summary || "已生成代码变更计划。")}</strong>
        </div>
        <div class="code-plan-grid">
          ${renderCodePlanList("问题判断", plan.diagnosis)}
          ${renderCodePlanList("应该修改", plan.modify)}
          ${renderCodePlanList("应该新增", plan.add)}
          ${renderCodePlanList("删除或避免", guardrails)}
          ${renderCodePlanList("验证标准", verification)}
        </div>
        ${renderCodeEvidence(plan)}
      </div>
    `;
  }

  function renderCodeAgentTracePanel(trace) {
    if (!trace) return "";
    const stages = Array.isArray(trace.stages) ? trace.stages : [];
    const changedFiles = Array.isArray(trace.changedFiles) ? trace.changedFiles : [];
    const blockers = Array.isArray(trace.blockers) ? trace.blockers.filter(Boolean) : [];
    return `
      <section class="code-agent-card">
        <div class="code-agent-head">
          <div>
            <small>代码改动 Agent</small>
            <strong>${escapeHtml(trace.summary || "等待代码改动 Agent 运行。")}</strong>
            <span>${escapeHtml(trace.repository || "未连接仓库")} · ${escapeHtml(trace.generator || "未选择生成器")} · 置信度 ${Number(trace.confidence || 0)}%</span>
          </div>
          <span class="check-status ${escapeHtml(trace.status || "waiting")}">${escapeHtml(checkStatusLabel(trace.status || "waiting"))}</span>
        </div>
        <div class="code-agent-stages">
          ${stages
            .map(
              (stage, index) => `
                <div class="code-agent-stage">
                  <b>${index + 1}</b>
                  <div>
                    <div class="code-agent-stage-title">
                      <strong>${escapeHtml(stage.title || stage.id)}</strong>
                      <span class="check-status ${escapeHtml(stage.status || "waiting")}">${escapeHtml(checkStatusLabel(stage.status || "waiting"))}</span>
                    </div>
                    <small>${escapeHtml(stage.detail || "")}</small>
                    ${
                      stage.evidence?.length
                        ? `<div class="code-agent-evidence">
                            ${stage.evidence.slice(0, 4).map((item) => `<code>${escapeHtml(item)}</code>`).join("")}
                          </div>`
                        : ""
                    }
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
        ${
          changedFiles.length
            ? `<div class="code-agent-files">
                <small>本次真实写入文件</small>
                ${changedFiles.map((file) => `<code>${escapeHtml(file.path)} · ${Number(file.bytesBefore || 0)} -> ${Number(file.bytesAfter || 0)} bytes</code>`).join("")}
              </div>`
            : ""
        }
        ${
          blockers.length
            ? `<div class="code-agent-blockers">
                <small>阻断原因</small>
                ${blockers.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
              </div>`
            : ""
        }
      </section>
    `;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function slugify(value) {
    return (
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `project-${Date.now().toString(36)}`
    );
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
      const parsed = new URL(candidate);
      return parsed.href.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function projectSdkKey(project) {
    if (!project?.id) return "";
    return project.sdkKey || `sdk-${project.id || "project"}-local`;
  }

  function platformRuntimeUrls() {
    const base = location.protocol === "file:" ? "http://127.0.0.1:8787" : location.origin;
    return {
      endpoint: `${base}/api/signals`,
      sdkSrc: `${base}/widget.js`,
    };
  }

  function buildEmbedSnippet(project) {
    const { sdkSrc } = platformRuntimeUrls();
    return `<script src="${sdkSrc}" data-key="${escapeHtml(projectSdkKey(project))}" defer></script>`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
  }

  function isLoggedIn() {
    return Boolean(state.auth?.sessionToken && state.auth?.user);
  }

  function renderAccountMenu() {
    const user = state.auth?.user;
    const organization = state.auth?.organization;
    if (!$("#accountMenu")) return;
    $("#accountMenu").innerHTML = isLoggedIn()
      ? `
          <div class="account-card">
            <span>
              <strong>${escapeHtml(user.name || user.email)}</strong>
              <small>${escapeHtml(organization?.name || user.email || "")}</small>
            </span>
            <button class="row-action secondary" type="button" data-auth-logout>退出</button>
          </div>
        `
      : `<button class="primary-action" type="button" data-open-auth="login">登录 / 注册</button>`;
  }

  function switchAuthMode(mode) {
    const nextMode = mode === "register" ? "register" : "login";
    $("#authForm").dataset.mode = nextMode;
    $("#authTitle").textContent = nextMode === "register" ? "注册账号" : "登录账号";
    $("#authSubmitBtn").textContent = nextMode === "register" ? "注册并进入" : "登录";
    $("#authPassword").autocomplete = nextMode === "register" ? "new-password" : "current-password";
    $$("#authModeTabs [data-auth-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.authMode === nextMode);
    });
  }

  function openAuthModal(mode = "login") {
    switchAuthMode(mode);
    $("#authModal").hidden = false;
    window.setTimeout(() => $("#authEmail").focus(), 0);
  }

  function closeAuthModal() {
    $("#authModal").hidden = true;
  }

  function applyAuthResult(result) {
    state.auth = {
      sessionToken: result.session?.token || "",
      sessionExpiresAt: result.session?.expiresAt || "",
      user: result.user || null,
      organization: result.organization || null,
      tenant: result.tenant || null,
    };
    if (result.tenant?.id) state.tenantCredentials.tenantId = result.tenant.id;
    if (result.tenantAccessKey) state.tenantCredentials.tenantAccessKey = result.tenantAccessKey;
    if (result.state) {
      const ui = {
        activeView: state.activeView,
        mode: state.mode,
        feedbackFilter: state.feedbackFilter,
        copiedSnippetProjectId: state.copiedSnippetProjectId,
        tenantCredentials: state.tenantCredentials,
        auth: state.auth,
      };
      state = {
        ...state,
        ...result.state,
        ...ui,
        apiConnected: true,
        selectedProjectId: result.state.selectedProjectId || result.state.projects?.[0]?.id || "",
      };
    }
  }

  async function submitAuthForm(event) {
    event.preventDefault();
    const mode = $("#authForm").dataset.mode;
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    if (!email || !password) {
      showToast("请填写邮箱和密码");
      return;
    }
    if (mode === "register" && password.length < 8) {
      showToast("密码至少 8 位");
      return;
    }
    const payload =
      mode === "register"
        ? {
            email,
            password,
            name: $("#authName").value.trim() || email.split("@")[0],
            organizationName: $("#authOrganization").value.trim() || `${email.split("@")[0]} 的组织`,
          }
        : { email, password };
    try {
      const result = await apiRequest(mode === "register" ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applyAuthResult(result);
      saveUiState();
      closeAuthModal();
      $("#authForm").reset();
      if (!state.projects.length) switchView("integrations");
      await refreshState(false);
      showToast(mode === "register" ? "账号已创建，请创建第一个项目" : "登录成功");
    } catch (error) {
      showToast(error.data?.error || (mode === "register" ? "注册失败" : "登录失败"));
    }
    render();
  }

  async function logoutAuth() {
    try {
      if (state.auth?.sessionToken) await apiRequest("/auth/logout", { method: "POST" });
    } catch {}
    state.auth = { sessionToken: "", sessionExpiresAt: "", user: null, organization: null, tenant: null };
    state.tenantCredentials = {
      tenantId: DEFAULT_TENANT_ID,
      tenantAccessKey: DEFAULT_TENANT_ACCESS_KEY,
    };
    state.selectedProjectId = "a-site";
    saveUiState();
    await refreshState(false);
    showToast("已退出登录");
    render();
  }

  function addLocalLog(message) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    state.log.push(`[${time}] ${message}`);
    state.log = state.log.slice(-120);
  }

  function renderActiveView() {
    $$(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === state.activeView);
    });
    $$(".view").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === state.activeView);
    });
  }

  function renderProjectHeader() {
    const project = activeProject();
    $("#projectSelect").innerHTML = state.projects.length
      ? state.projects
          .map((item) => {
            const signalCount = projectFeedbackFor(item.id).length;
            const taskCount = projectTasksFor(item.id).length;
            const suffix = signalCount || taskCount ? ` · ${signalCount}反馈/${taskCount}任务` : "";
            return `<option value="${escapeHtml(item.id)}" ${item.id === project.id ? "selected" : ""}>${escapeHtml(item.name + suffix)}</option>`;
          })
          .join("")
      : `<option value="">请先创建项目</option>`;
    $("#projectSelect").disabled = !state.projects.length;
    $("#projectUrl").textContent = project.url || "未配置 URL";
    const syncText = lastSyncedAt
      ? `已实时同步 ${lastSyncedAt.toLocaleTimeString("zh-CN", { hour12: false })}`
      : "等待同步";
    $("#projectEnv").textContent = `${project.env || "production"} · ${state.apiConnected ? `API 已连接 · ${syncText}` : "离线演示"}`;
    $("#sidebarMode").textContent = modeLabel(state.mode);
    $("#healthPill").textContent = project.health >= 90 ? "稳定" : project.health >= 80 ? "注意" : "风险";
    $("#healthPill").style.color = project.health >= 90 ? "var(--green)" : project.health >= 80 ? "var(--amber)" : "var(--red)";
    $$(".segmented [data-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === state.mode);
    });
  }

  function renderActivityBanner() {
    const banner = $("#activityBanner");
    if (!banner) return;
    if (!state.apiConnected) {
      banner.classList.add("is-visible");
      banner.innerHTML = `
        <div>
          <strong>当前正在显示离线演示数据</strong>
          <span>还没有连上本地真实 API，所以这里不会显示测试商城提交的真实反馈和任务。</span>
        </div>
        <button class="row-action" type="button" data-refresh-state>重新连接 API</button>
      `;
      return;
    }
    const latestSignal = latestSignalAcrossProjects();
    const signalProject = latestSignal ? projectById(latestSignal.projectId) : null;
    if (!latestSignal || !signalProject) {
      banner.classList.remove("is-visible");
      banner.innerHTML = "";
      return;
    }

    const currentProject = activeProject();
    const signalCount = projectFeedbackFor(signalProject.id).length;
    const taskCount = projectTasksFor(signalProject.id).length;
    const latestTask = newestItem(projectTasksFor(signalProject.id));
    const text = latestSignal.text || "已收到新的用户反馈";
    const isCurrentProject = signalProject.id === currentProject.id;

    banner.classList.add("is-visible");
    banner.innerHTML = `
      <div>
        <strong>${isCurrentProject ? "最新反馈已进入当前项目" : "最新反馈没有在当前项目里"}</strong>
        <span>${escapeHtml(signalProject.name)} · ${signalCount} 条反馈 / ${taskCount} 个任务 · ${escapeHtml(text.slice(0, 58))}</span>
        ${latestTask ? `<span>等待处理：${escapeHtml(latestTask.title)}</span>` : ""}
      </div>
      ${
        isCurrentProject
          ? `<button class="row-action" type="button" data-jump="iterations">去确认</button>`
          : `<button class="row-action" type="button" data-switch-project="${escapeHtml(signalProject.id)}">切换到这个项目</button>`
      }
    `;
  }

  function renderMetrics() {
    const project = activeProject();
    const feedback = projectFeedback();
    const tasks = projectTasks();
    const approved = tasks.filter((task) => task.status !== "待审批").length;
    const bugCount = feedback.filter((item) => item.category === "bug").length;

    const metrics = [
      ["产品健康", `${project.health || 0}%`, `错误率 ${Number(project.errorRate || 0).toFixed(2)}%`],
      ["新反馈", feedback.length, `${bugCount} 个问题反馈`],
      ["待处理", tasks.length, `${approved} 个已开始处理`],
      ["转化率", `${Number(project.conversion || 0).toFixed(1)}%`, `小范围发布 ${project.canary || 0}%`],
    ];

    $("#metricGrid").innerHTML = metrics
      .map(
        ([label, value, note]) => `
          <article class="metric">
            <span>${label}</span>
            <strong>${value}</strong>
            <small>${note}</small>
          </article>
        `,
      )
      .join("");
  }

  function renderLoopMap() {
    const feedback = projectFeedback();
    const tasks = projectTasks();
    const project = activeProject();
    const steps = [
      ["收集", feedback.length, "用户反馈和网站问题", "blue"],
      ["判断", new Set(feedback.map((item) => item.category)).size, "AI 判断影响和优先级", "teal"],
      ["排队", tasks.length, "生成等待确认的任务", "amber"],
      ["修改", tasks.filter((task) => ["构建中", "验证通过", "已灰度", "已完成"].includes(task.status)).length, "生成代码改动和说明", "violet"],
      ["测试", tasks.filter((task) => ["验证通过", "已灰度", "已完成"].includes(task.status)).length, "检查页面是否真的变好", "green"],
      ["发布", project.canary || 0, "小范围上线，异常可回退", "red"],
    ];

    $("#loopMap").innerHTML = steps
      .map(
        ([name, count, note, tone]) => `
          <div class="loop-step" data-tone="${tone}">
            <span class="step-count">${count}</span>
            <strong>${name}</strong>
            <small>${note}</small>
          </div>
        `,
      )
      .join("");
  }

  function renderTopology() {
    $("#agentCount").textContent = `${agents.length} 个助手`;
    $("#topology").innerHTML = agents
      .map(
        (agent) => `
          <div class="agent-node">
            <strong>${agent.name}</strong>
            <span>${agent.role}</span>
          </div>
        `,
      )
      .join("");
  }

  function renderInsights() {
    const project = activeProject();
    const insights = (state.insights || []).filter((item) => item.projectId === project.id);
    const latest = insights[0];

    if (!latest) {
      $("#insightMeta").textContent = "等待分析";
      $("#insightPanel").innerHTML = `
        <div class="insight-item insight-summary">
          <strong>还没有 AI 分析结果</strong>
          <small>点击“自动整理反馈”，系统会把用户反馈整理成可确认的任务。</small>
        </div>
      `;
      return;
    }

    $("#insightMeta").textContent = `${latest.model || "AI"} · ${formatDate(latest.createdAt)}`;
    const clusters = latest.clusters || [];
    $("#insightPanel").innerHTML = `
      <div class="insight-item insight-summary">
        <strong>${escapeHtml(latest.summary)}</strong>
        <div class="insight-clusters">
          ${clusters
            .slice(0, 6)
            .map(
              (cluster) => `
                <span class="tag">
                  <span class="priority ${cluster.priority}">${cluster.priority}</span>
                  &nbsp;${escapeHtml(cluster.title)}
                </span>
              `,
            )
            .join("")}
        </div>
      </div>
      ${
        clusters.length
          ? clusters
              .slice(0, 3)
              .map(
                (cluster) => `
                  <div class="insight-item">
                    <div class="item-topline">
                      <strong>${escapeHtml(cluster.title)}</strong>
                      <span class="tag ${cluster.category}">${categoryLabel(cluster.category)}</span>
                    </div>
                    <small><span class="priority ${cluster.priority}">${cluster.priority}</span> · ${escapeHtml(cluster.impact)}</small>
                    <small>${escapeHtml(cluster.recommendation)}</small>
                  </div>
                `,
              )
              .join("")
          : ""
      }
    `;
  }

  function renderCapabilityRadar() {
    const radar = state.capabilities || {};
    const sections = Array.isArray(radar.sections) ? radar.sections : [];
    const score = Number(radar.score || 0);
    $("#capabilityRadarMeta").textContent = sections.length ? `${score}% · ${checkStatusLabel(radar.status)}` : "等待 API";
    if (!sections.length) {
      $("#capabilityRadar").innerHTML = `
        <div class="capability-summary">
          <strong>等待能力检查</strong>
          <small>连接本地 API 后，这里会主动列出自进化平台还缺哪些能力。</small>
        </div>
      `;
      return;
    }
    $("#capabilityRadar").innerHTML = `
      <div class="capability-summary">
        <div>
          <small>平台能力完整度</small>
          <strong>${score}%</strong>
          <span>${escapeHtml(radar.summary || "")}</span>
        </div>
      </div>
      <div class="capability-sections">
        ${sections
          .map(
            (section) => `
              <div class="capability-section">
                <div class="capability-section-head">
                  <span>
                    <strong>${escapeHtml(section.title)}</strong>
                    <small>${escapeHtml(section.summary || "")}</small>
                  </span>
                  <span class="check-status ${escapeHtml(section.status)}">${Number(section.score || 0)}%</span>
                </div>
                <div class="capability-items">
                  ${(section.items || [])
                    .map(
                      (item) => `
                        <div class="capability-item">
                          <span>
                            <strong>${escapeHtml(item.label)}</strong>
                            <small>${escapeHtml(item.detail || "")}</small>
                          </span>
                          <span class="check-status ${escapeHtml(item.status)}">${escapeHtml(checkStatusLabel(item.status))}</span>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderOverviewLists() {
    const feedback = projectFeedback().slice().reverse().slice(0, 4);
    const tasks = projectTasks().slice(0, 4);
    const alternateProject = tasks.length ? null : latestProjectWithTasks(activeProject().id);

    $("#signalList").innerHTML = feedback.length
      ? feedback
          .map(
            (item) => `
              <div class="signal-item">
                <div class="item-topline">
                  <strong>${escapeHtml(item.source)}</strong>
                  <span class="tag ${item.category}">${categoryLabel(item.category)}</span>
                </div>
                <small>${escapeHtml(item.text)}</small>
              </div>
            `,
          )
          .join("")
      : `<div class="signal-item"><small>暂无信号</small></div>`;

    $("#overviewQueue").innerHTML = tasks.length
      ? tasks
          .map(
            (task) => `
              <div class="queue-item">
                <div class="task-topline">
                  <strong>${escapeHtml(task.title)}</strong>
                  <span class="tag ${riskClass(task.risk)}">${riskLabel(task.risk)}</span>
                </div>
                <small>${taskStatusLabel(task.status)} · ${task.confidence}%</small>
              </div>
            `,
          )
          .join("")
      : alternateProject
        ? `
          <div class="queue-item">
            <small>当前项目暂无任务，但 ${escapeHtml(alternateProject.name)} 已有 ${projectTasksFor(alternateProject.id).length} 个任务。</small>
            <button class="row-action" type="button" data-switch-project="${escapeHtml(alternateProject.id)}">切换查看</button>
          </div>
        `
        : `<div class="queue-item"><small>暂无任务</small></div>`;
  }

  function renderReleaseGuard() {
    const project = activeProject();
    const guard = [
      ["测试通过", 92, "92%"],
      ["错误稳定", Math.max(10, 100 - Number(project.errorRate || 0) * 80), `${Number(project.errorRate || 0).toFixed(2)}%`],
      ["发布范围", project.canary || 0, `${project.canary || 0}%`],
      ["回滚预案", 100, "就绪"],
    ];

    $("#releaseGuard").innerHTML = guard
      .map(
        ([label, value, text]) => `
          <div class="guard-row">
            <strong>${label}</strong>
            <div class="bar"><span style="width:${value}%"></span></div>
            <small>${text}</small>
          </div>
        `,
      )
      .join("");
  }

  function renderFeedback() {
    const filter = state.feedbackFilter;
    const items = projectFeedback()
      .filter((item) => filter === "all" || item.category === filter)
      .slice()
      .reverse();

    $$("#feedbackFilters button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.filter === filter);
    });

    $("#feedbackList").innerHTML = items.length
      ? items
          .map(
            (item) => `
              <article class="feedback-item">
                <div class="item-topline">
                  <strong>${escapeHtml(item.source)}</strong>
                  <span class="tag ${item.category}">${categoryLabel(item.category)}</span>
                </div>
                <p>${escapeHtml(item.text)}</p>
                <div class="tag-row">
                  <span class="tag">严重度 ${item.severity}</span>
                  <span class="tag">置信度 ${item.confidence || "-"}%</span>
                  <span class="tag">${formatDate(item.createdAt)}</span>
                </div>
              </article>
            `,
          )
          .join("")
      : `<article class="feedback-item"><p>当前筛选下暂无信号。</p></article>`;
  }

  function renderTasks() {
    const tasks = projectTasks();
    const alternateProject = tasks.length ? null : latestProjectWithTasks(activeProject().id);
    $("#iterationTable").innerHTML = `
      <div class="table-head">
        <span>任务</span>
        <span>类型</span>
        <span>风险</span>
        <span>置信度</span>
        <span>状态</span>
        <span>操作</span>
      </div>
      ${
        tasks.length
          ? tasks
              .map(
                (task) => {
                  const progress = taskProgress(task);
                  const codePlan = codePlanForTask(task);
                  const codePlanDetails = codePlan
                    ? `<details class="admin-details compact-admin-details">
                        <summary>查看改动思路</summary>
                        <div class="admin-details-body">${renderTaskCodePlan(codePlan)}</div>
                      </details>`
                    : "";
                  return `
                    <div class="table-row">
                      <div class="task-title">
                        <strong>${escapeHtml(task.title)}</strong>
                        <small>${escapeHtml(task.summary)}</small>
                        <small class="task-progress-note ${escapeHtml(progress.tone)}">
                          ${escapeHtml(progress.label)}：${escapeHtml(progress.detail)}
                        </small>
                        ${codePlanDetails}
                      </div>
                      <span class="tag ${task.category}">${categoryLabel(task.category)}</span>
                      <span class="tag ${riskClass(task.risk)}">${riskLabel(task.risk)}</span>
                      <span>${task.confidence}% · ${escapeHtml(String(task.agent || "").replace(/Agent/g, "助手").replace("开发", "改动"))}</span>
                      <span>${taskStatusLabel(task.status)}</span>
                      <span class="table-actions">
                        <button class="row-action" data-task-action="${task.id}" ${task.status === "已完成" ? "disabled" : ""}>${nextTaskAction(task.status)}</button>
                        <button class="row-action secondary" data-pr-draft="${task.id}">${task.prDraftId ? "查看改动" : "生成改动"}</button>
                      </span>
                    </div>
                  `;
                },
              )
              .join("")
          : alternateProject
            ? `
              <div class="table-row">
                <div class="task-title">
                  <strong>当前项目暂无任务</strong>
                  <small>${escapeHtml(alternateProject.name)} 已有 ${projectTasksFor(alternateProject.id).length} 个任务，可能是测试商城反馈进入了另一个项目。</small>
                </div>
                <span></span><span></span><span></span><span></span>
                <span class="table-actions">
                  <button class="row-action" type="button" data-switch-project="${escapeHtml(alternateProject.id)}">切换查看</button>
                </span>
              </div>
            `
            : `<div class="table-row"><div class="task-title"><strong>暂无任务</strong><small>反馈聚类后会进入这里。</small></div></div>`
      }
    `;
  }

  function actionLabel(id) {
    const manualLabels = {
      manual_approval: "人工确认",
      manual_rejection: "人工拒绝",
      real_release: "真实发布检查",
      production_release: "上线缺口",
      deployment_hook: "通知客户网站发布",
    };
    if (manualLabels[id]) return manualLabels[id];
    return {
      waiting_for_signals: "等待反馈",
      analysis: "AI 分析",
      repository: "仓库连接",
      task: "选择任务",
      pr_draft: "生成待发布改动",
      code_plan: "分析要改哪里",
      code_agent_read: "读取客户代码",
      code_agent_decide: "决定修改方案",
      patch: "生成代码改动",
      qa: "风险检查",
      sandbox: "安全测试",
      production_sandbox: "真实环境测试",
      github_pr: "提交到代码仓库",
      local_apply: "写入网站代码",
      local_check: "本地检查",
      output_webhook: "通知客户系统",
      auto_release: "自动发布门禁",
      auto_merge: "自动合并",
      ci: "自动检查",
      preview: "生成预览",
      release_plan: "发布计划",
      deploy: "小范围发布",
      monitor: "健康监控",
      rollback: "回滚预案",
      started: "开始运行",
    }[id] || id;
  }

  function userFacingActionDetail(action) {
    const raw = String(action?.detail || "").trim();
    if (!raw) return "";
    if (/https?:\/\//i.test(raw)) return "已生成记录，管理员可在技术细节中查看。";
    if (/\b(mock-|patch-|run-|sandbox-|pr-|ci-|deploy-)/i.test(raw)) return "已完成，技术编号已隐藏。";
    return raw
      .replace(/\bQA\b/g, "风险检查")
      .replace(/\bPR\b/g, "发布记录")
      .replace(/\bCI\b/g, "自动检查")
      .replace(/\bSandbox\b/gi, "安全测试");
  }

  function userFacingReleaseGap(value) {
    return String(value || "")
      .replace(/GitHub PR/gi, "发布记录")
      .replace(/\bmanaged_mock\b/gi, "演示模式")
      .replace(/\bmock\b/gi, "演示模式")
      .replace(/\bCI\b/g, "自动检查")
      .replace(/部署 Hook/g, "部署入口")
      .replace(/GitHub/g, "代码仓库")
      .replace(/\bPR\b/g, "发布记录");
  }

  function runStatusLabel(status) {
    return {
      running: "运行中",
      completed: "已完成",
      waiting: "已暂停",
      blocked: "被阻断",
      failed: "失败",
    }[status] || status || "未知";
  }

  function renderEvolutionRunPanel() {
    const project = activeProject();
    const activeRun = state.evolutionProgress?.projectId === project.id ? state.evolutionProgress : null;
    const latestRun = activeRun || projectRuns().find((run) => run.type === "autopilot") || null;
    const latestDraft = projectPrDrafts()[0];
    const openedDraft = projectPrDrafts().find((draft) => draft.remoteUrl);
    const evidenceDraft = latestDraft?.remoteUrl ? latestDraft : openedDraft || latestDraft;
    const latestPatch = projectPatchProposals()[0];
    const latestApplication = latestPatch ? projectPatchApplications().find((item) => item.patchProposalId === latestPatch.id) : projectPatchApplications()[0];
    const latestReport = latestPatch ? projectValidationReports().find((report) => report.patchProposalId === latestPatch.id) : projectValidationReports()[0];
    const latestSandbox = latestPatch ? projectSandboxRuns().find((run) => run.patchProposalId === latestPatch.id) : projectSandboxRuns()[0];
    const latestDeployment = latestPatch
      ? projectDeploymentRuns().find((run) => run.patchProposalId === latestPatch.id || run.prDraftId === evidenceDraft?.id)
      : projectDeploymentRuns()[0];
    const latestRelease = evidenceDraft ? projectReleasePlans().find((plan) => plan.prDraftId === evidenceDraft.id) : projectReleasePlans()[0];
    const latestCi = evidenceDraft ? projectCiRuns().find((run) => run.prDraftId === evidenceDraft.id) : projectCiRuns()[0];
    const latestPreview = evidenceDraft ? projectPreviewDeployments().find((deployment) => deployment.prDraftId === evidenceDraft.id) : projectPreviewDeployments()[0];
    const artifacts = latestRun?.artifacts || {};
    const latestCodePlan = artifacts.codePlan || latestApplication?.codePlan || latestPatch?.codePlan || latestDraft?.codePlan || null;
    const latestCodeAgentTrace =
      artifacts.codeAgentTrace ||
      latestApplication?.codeAgentTrace ||
      latestPatch?.codeAgentTrace ||
      latestDraft?.codeAgentTrace ||
      null;
    const prUrl = artifacts.prUrl || evidenceDraft?.remoteUrl || "";
    const qaDecision = artifacts.qaDecision || latestReport?.decision || "";
    const releaseStatus = artifacts.releaseStatus || latestRelease?.status || "";
    const releasePhase = artifacts.releasePhase ?? latestRelease?.currentPhase ?? 0;
    const realReleaseStatus = artifacts.realReleaseStatus || latestRelease?.realRelease?.status || "";
    const realReleaseGaps = Array.isArray(artifacts.realReleaseGaps)
      ? artifacts.realReleaseGaps
      : Array.isArray(latestRelease?.realRelease?.gaps)
        ? latestRelease.realRelease.gaps
        : [];
    const productionReleaseStatus = artifacts.productionReleaseStatus || latestRelease?.productionRelease?.status || "";
    const productionReleaseGaps = Array.isArray(artifacts.productionReleaseGaps)
      ? artifacts.productionReleaseGaps
      : Array.isArray(latestRelease?.productionRelease?.gaps)
        ? latestRelease.productionRelease.gaps
        : [];
    const legacySimulationGaps = [];
    if (!realReleaseStatus && releaseStatus === "completed") {
      if (String(evidenceDraft?.remoteNumber || "").startsWith("mock-") || String(evidenceDraft?.remoteUrl || "").includes("/mock-")) {
        legacySimulationGaps.push("发布记录是演示模式，未改动客户代码仓库");
      }
      if (evidenceDraft?.mergeMode === "managed_mock") legacySimulationGaps.push("代码合并是演示模式，未真实合并代码");
      if (latestCi?.provider === "managed-ci") legacySimulationGaps.push("自动检查是演示结果");
      if (latestPreview?.provider === "managed-preview") legacySimulationGaps.push("预览/部署是演示地址");
    }
    const simulationGaps = realReleaseGaps.length ? realReleaseGaps : legacySimulationGaps;
    const localOnlyRelease = realReleaseStatus === "local_only" || productionReleaseStatus === "waiting";
    const releaseIsSimulation =
      releaseStatus === "simulation_completed" ||
      realReleaseStatus === "waiting" ||
      (releaseStatus === "completed" && legacySimulationGaps.length > 0);
    const autoReleaseWaiting = (latestRun?.actions || []).find((action) => action.id === "auto_release" && action.status === "waiting");
    const reviewDraft = latestDraft || evidenceDraft;
    const manualApprovalStatus = latestReport?.manualApproval?.status || "";
    const manualReviewNeedsAction =
      qaDecision === "manual_review" &&
      !["approved", "rejected"].includes(manualApprovalStatus) &&
      reviewDraft?.id;
    const latestRunDeployCompleted = (latestRun?.actions || []).some((action) => action.id === "deploy" && action.status === "completed");
    const latestRunBlocked = latestRun?.status === "blocked" && !latestRunDeployCompleted;

    let headline = "还没有运行记录";
    let detail = "提交反馈后点击“批准并开始进化”，这里会显示本次是否生成改动、是否提交发布记录、是否上线。";
    let status = "waiting";

    if (activeRun) {
      headline = "正在运行自进化";
      detail = "系统正在分析反馈、生成代码改动并执行安全测试。完成后这里会显示最终结果。";
      status = "running";
    } else if (latestRunBlocked) {
      headline = "本次进化被阻断";
      detail = latestRun.summary || "最新运行没有完成写入和部署，测试商城不会发生变化。";
      status = "blocked";
    } else if (localOnlyRelease) {
      headline = "本地测试站已更新，生产站待接入";
      detail = `测试商城已经被真实改代码并通过本地检查；客户线上站还缺：${(productionReleaseGaps.length ? productionReleaseGaps : realReleaseGaps).map(userFacingReleaseGap).join("；") || "真实代码授权、自动检查和部署入口"}`;
      status = "waiting";
    } else if (releaseIsSimulation) {
      headline = "模拟发布已跑完，真实网站还没有更新";
      detail = `系统完成的是演示链路，不是客户网站真实上线。还缺：${simulationGaps.map(userFacingReleaseGap).join("；") || "真实代码授权、自动检查和部署配置"}`;
      status = "waiting";
    } else if (releaseStatus === "completed") {
      headline = "已完成自动发布";
      detail = `代码改动已通过自动链路发布，当前发布范围 ${Number(releasePhase || 100)}%。回滚预案已就绪。`;
      status = "completed";
    } else if (prUrl) {
      headline = "已生成代码改动，但还没有上线";
      detail = qaDecision === "manual_review"
        ? "系统已经生成代码改动，但风险检查要求人工确认，所以不会直接更新用户网站。"
        : autoReleaseWaiting?.detail || "系统已经提交代码改动，等待发布检查或人工确认后才会更新用户网站。";
      status = qaDecision === "manual_review" || autoReleaseWaiting ? "waiting" : latestRun?.status || "waiting";
    } else if (latestRun) {
      headline = latestRun.status === "blocked" ? "本次进化被阻断" : "本次进化已运行";
      detail = latestRun.summary || "系统已运行，但目前还没有生成可合并的代码改动。";
      status = latestRun.status || "waiting";
    } else if (latestPatch || latestReport || latestSandbox) {
      headline = "已有补丁和验证记录";
      detail = "系统曾生成过改动、风险检查和安全测试记录，但没有留下完整运行记录。再次点击后会保存完整链路。";
      status = "waiting";
    }

    const actions = latestRun?.actions?.length
      ? latestRun.actions
      : [
          latestReport ? { id: "qa", status: latestReport.decision === "manual_review" ? "warning" : latestReport.status, detail: qaDecisionLabel(latestReport.decision) } : null,
          latestSandbox ? { id: "sandbox", status: latestSandbox.status, detail: "安全测试已完成" } : null,
          prUrl ? { id: "github_pr", status: "opened", detail: "改动已提交，等待发布" } : null,
          latestRelease ? { id: "deploy", status: latestRelease.status, detail: `${latestRelease.currentPhase || 0}%` } : null,
        ].filter(Boolean);
    const manualReviewActions = manualReviewNeedsAction
      ? `<button class="row-action" type="button" data-review-approve="${escapeHtml(reviewDraft.id)}">确认安全，继续上线</button>
         <button class="row-action secondary" type="button" data-review-reject="${escapeHtml(reviewDraft.id)}">拒绝本次改动</button>`
      : "";
    const technicalEvidence = latestCodePlan || latestApplication || latestPatch || latestDeployment || latestRun
      ? `
        <details class="admin-details compact-admin-details">
          <summary>查看技术细节</summary>
          <div class="admin-details-body">
            ${renderCodePlanPanel(latestCodePlan)}
            ${renderChangeEvidencePanel({
              application: latestApplication,
              patch: latestPatch,
              deployment: latestDeployment,
              codePlan: latestCodePlan,
              run: latestRun,
            })}
          </div>
        </details>
      `
      : "";

    $("#evolutionRunMeta").textContent = latestRun ? `${runStatusLabel(status)} · ${formatDate(latestRun.finishedAt || latestRun.startedAt || latestRun.createdAt)}` : runStatusLabel(status);
    $("#evolutionRunPanel").innerHTML = `
      <div class="evolution-result ${escapeHtml(status)}">
        <div>
          <small>${escapeHtml(runStatusLabel(status))}</small>
          <strong>${escapeHtml(headline)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
        <div class="evolution-proof">
          ${manualReviewActions}
          ${prUrl ? `<a class="row-action" href="${escapeHtml(prUrl)}" target="_blank" rel="noreferrer">查看发布记录</a>` : ""}
          ${latestRelease ? `<span class="tag">发布进度：${Number(releasePhase || latestRelease.currentPhase || 0)}%</span>` : ""}
          ${latestReport ? `<span class="tag">风险检查：${escapeHtml(qaDecisionLabel(qaDecision || latestReport.decision))}</span>` : ""}
          ${latestSandbox ? `<span class="tag">安全测试：${escapeHtml(sandboxStatusLabel(latestSandbox.status))}</span>` : ""}
        </div>
      </div>
      ${renderCodeAgentTracePanel(latestCodeAgentTrace)}
      ${technicalEvidence}
      <div class="evolution-steps">
        ${
          actions.length
            ? actions
                .map(
                  (action) => `
                    <div class="evolution-step">
                      <span class="check-status ${escapeHtml(action.status)}">${escapeHtml(checkStatusLabel(action.status))}</span>
                      <div>
                        <strong>${escapeHtml(actionLabel(action.id))}</strong>
                        <small>${escapeHtml(userFacingActionDetail(action))}</small>
                      </div>
                    </div>
                  `,
                )
                .join("")
            : `<div class="evolution-step"><span class="check-status waiting">等待</span><div><strong>等待运行</strong><small>还没有本项目的自进化记录。</small></div></div>`
        }
      </div>
    `;
  }

  function renderPipeline() {
    $("#runState").textContent = runTimer ? "运行中" : "空闲";
    $("#pipelineSteps").innerHTML = pipeline
      .map((step, index) => {
        const statusClass = index < runningIndex ? "is-done" : index === runningIndex ? "is-active" : "";
        return `
          <div class="pipeline-step ${statusClass}">
            <span class="step-dot">${index + 1}</span>
            <div>
              <strong>${step}</strong>
              <small>${agentForStep(index)}</small>
            </div>
            <span class="quiet">${index < runningIndex ? "完成" : index === runningIndex ? "运行" : "等待"}</span>
          </div>
        `;
      })
      .join("");
    $("#agentLog").textContent = (state.log || []).join("\n");
    $("#agentLog").scrollTop = $("#agentLog").scrollHeight;
  }

  function agentForStep(index) {
    return ["客服助手", "产品助手", "产品助手", "改动助手", "风险检查助手", "发布助手"][index];
  }

  function renderIntegrations() {
    const project = activeProject();
    const githubStatus = state.github?.canOpenRealPr
      ? "真实发布可用"
      : state.github?.appConfigured
        ? "App 待安装"
        : "Mock 模式";
    const connectors = [
      ["Signals API", "SDK 上报、客服、日志统一入口", state.apiConnected ? "已接入" : "待启动"],
      ["JSON 数据库", "本地 data/db.json 持久化", state.apiConnected ? "已接入" : "离线"],
      ["代码仓库", "读取代码、提交改动、审核发布", githubStatus],
      ["Vercel / CI/CD", "预览环境、部署、回滚", "下一阶段"],
      ["客服系统", "对话、工单、满意度", "可扩展"],
    ];

    $("#connectorList").innerHTML = connectors
      .map(
        ([name, note, status]) => `
          <div class="connector-item">
            <div>
              <strong>${name}</strong>
              <small>${note}</small>
            </div>
            <span class="tag connector-status">${status}</span>
          </div>
        `,
      )
      .join("");

    $("#copySdkBtn").disabled = !project.id;
    $("#sdkSnippet").textContent = project.id ? buildEmbedSnippet(project) : "创建项目后，这里会自动生成一行完整嵌入代码。";

    renderFirstRunGuide();
    renderProjectAccess();
    renderReadiness();
    renderRepositories();
    renderPrDrafts();
    renderPatchProposals();
    renderProductionOps();
  }

  function renderFirstRunGuide() {
    const project = activeProject();
    const hasProject = Boolean(project.id);
    const hasKey = Boolean(projectSdkKey(project));
    const copied = hasProject && state.copiedSnippetProjectId === project.id;
    const connected = hasProject && (Number(project.ingestion?.acceptedSignals || 0) > 0 || projectFeedback().length > 0);
    const steps = [
      {
        number: 1,
        title: "创建接入项目",
        detail: hasProject ? `${project.name} 已创建` : "填写产品名称和网站网址",
        done: hasProject,
        current: !hasProject,
      },
      {
        number: 2,
        title: "生成 API Key",
        detail: hasKey ? "Key 已绑定到该网站" : "提交后自动生成",
        done: hasKey,
        current: hasProject && !hasKey,
      },
      {
        number: 3,
        title: "复制嵌入代码",
        detail: copied ? "代码已复制，可以粘贴到客户网站" : "复制一行脚本到网站模板",
        done: copied,
        current: hasKey && !copied,
      },
      {
        number: 4,
        title: "确认接入成功",
        detail: connected ? "平台已收到网站信号" : "粘贴代码后刷新网站，或先发送测试信号",
        done: connected,
        current: copied && !connected,
      },
    ];
    const completed = steps.filter((step) => step.done).length;
    const nextAction = !hasProject
      ? { label: "填写产品信息", action: "focus-form" }
      : !copied
        ? { label: "复制嵌入代码", action: "copy-snippet" }
        : !connected
          ? { label: "发送测试信号", action: "test-signal" }
          : { label: "手动推进", action: "run-autopilot" };
    $("#firstRunGuide").innerHTML = `
      <div class="guide-summary">
        <div>
          <small>首次接入进度</small>
          <strong>${completed}/4 步完成</strong>
          <small>${connected ? "这个网站已经接入，可以开始进入自进化链路。" : "按下面步骤完成后，客户网站就会开始向平台发送真实信号。"}</small>
        </div>
        <button class="row-action ${connected ? "" : "secondary"}" type="button" data-guide-action="${nextAction.action}">${nextAction.label}</button>
      </div>
      <div class="guide-step-list">
        ${steps
          .map(
            (step) => `
              <div class="guide-step ${step.done ? "is-done" : ""} ${step.current ? "is-current" : ""}">
                <b>${step.done ? "✓" : step.number}</b>
                <span>
                  <strong>${escapeHtml(step.title)}</strong>
                  <small>${escapeHtml(step.detail)}</small>
                </span>
                <span class="check-status ${step.done ? "passed" : step.current ? "waiting" : "missing"}">${step.done ? "完成" : step.current ? "当前" : "待完成"}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderProjectAccess() {
    const project = activeProject();
    if (!project.id) {
      $("#projectAccessMeta").textContent = "等待创建项目";
      $("#projectAccessPanel").innerHTML = `
        <div class="access-result">
          <div>
            <small>当前接入产品</small>
            <strong>还没有项目</strong>
            <span>注册后第一步是填写产品名称和网站网址，系统会自动生成 API Key 和嵌入代码。</span>
          </div>
          <span class="check-status missing">待创建</span>
        </div>
      `;
      return;
    }
    const origins = Array.isArray(project.allowedOrigins) && project.allowedOrigins.length
      ? project.allowedOrigins
      : [originFromUrl(project.url)].filter(Boolean);
    const feedbackCount = projectFeedback().length;
    const taskCount = projectTasks().length;
    const ingestion = project.ingestion || {};
    const tenant = state.tenant || {};
    const tenantId = tenant.id || state.tenantCredentials?.tenantId || DEFAULT_TENANT_ID;
    const tenantKeyPreview = tenant.keyPreview || "configured";
    const outputWebhook = project.outputWebhook || {};
    const deploymentHook = project.deploymentHook || {};
    const webhookDeliveries = projectWebhookDeliveries().slice(0, 3);
    const deploymentRuns = projectDeploymentRuns().slice(0, 3);
    const sdkActive = projectSdkKey(project) && project.sdkStatus !== "disabled";
    const repos = projectRepositories();
    const connectedRepo = repos[0] || null;
    const authorizedRepos = projectAuthorizedGithubRepositories();
    const githubHint = connectedRepo
      ? `已连接 ${connectedRepo.owner}/${connectedRepo.name}，可以生成真实 PR。下一步去批准要进化的问题。`
      : authorizedRepos.length
        ? `已发现 ${authorizedRepos.length} 个授权仓库，点击“连接这个仓库”即可完成绑定。`
        : "先点击“刷新我的 GitHub 仓库”，找到 itera-test-site 后再连接。";
    const githubStatusLabel = connectedRepo ? "代码仓库已连接" : authorizedRepos.length ? "待连接仓库" : "等待同步仓库";
    const githubStatusClass = connectedRepo ? "passed" : authorizedRepos.length ? "warning" : "missing";
    const githubPrimaryAction = connectedRepo
      ? `<button class="row-action" type="button" data-go-view="iterations">下一步：去批准进化</button>`
      : authorizedRepos.length
        ? `<button class="row-action" type="button" data-github-connect-index="0">连接这个仓库</button>`
        : `<button class="row-action" type="button" data-github-load-repos>刷新我的 GitHub 仓库</button>`;
    const lastSignalLabel = ingestion.lastSignalAt ? formatDate(ingestion.lastSignalAt) : feedbackCount ? "已收到信号" : "等待首个信号";
    $("#projectAccessMeta").textContent = sdkActive ? "API Key 已生成" : "等待生成";
    $("#projectAccessPanel").innerHTML = `
      <div class="access-result ${sdkActive ? "is-ready" : ""}">
        <div>
          <small>当前接入产品</small>
          <strong>${escapeHtml(project.name)}</strong>
          <span>${escapeHtml(project.url || "未填写网址")}</span>
        </div>
        <span class="check-status ${sdkActive ? "passed" : "missing"}">${sdkActive ? "Key 可用" : "待生成"}</span>
      </div>
      <div class="connector-item github-status-card">
        <div>
          <strong>连接客户网站代码</strong>
          <small>${escapeHtml(githubHint)}</small>
        </div>
        <span class="table-actions">
          <span class="check-status ${githubStatusClass}">${escapeHtml(githubStatusLabel)}</span>
          ${githubPrimaryAction}
          <button class="row-action secondary" type="button" data-github-refresh>刷新 GitHub 授权状态</button>
          <button class="row-action secondary" type="button" data-github-load-repos>重新同步仓库</button>
        </span>
      </div>
      <div class="project-access-grid">
        <div class="access-stat">
          <small>API Key</small>
          <strong>${escapeHtml(projectSdkKey(project))}</strong>
        </div>
        <div class="access-stat">
          <small>Project ID</small>
          <strong>${escapeHtml(project.id)}</strong>
        </div>
        <div class="access-stat">
          <small>接入自检</small>
          <strong>${escapeHtml(lastSignalLabel)}</strong>
        </div>
        <div class="access-stat">
          <small>通过 / 拦截</small>
          <strong>${Number(ingestion.acceptedSignals || feedbackCount)} / ${Number(ingestion.rejectedSignals || 0)}</strong>
        </div>
        <div class="access-stat">
          <small>租户</small>
          <strong>${escapeHtml(tenantId)}</strong>
        </div>
        <div class="access-stat">
          <small>后台 Key</small>
          <strong>${escapeHtml(tenantKeyPreview)}</strong>
        </div>
        <div class="access-stat">
          <small>输出 Webhook</small>
          <strong>${outputWebhook.status === "active" ? "已启用" : "未配置"}</strong>
        </div>
        <div class="access-stat">
          <small>真实部署 Hook</small>
          <strong>${deploymentHook.status === "active" ? "已启用" : "未配置"}</strong>
        </div>
      </div>
      <div class="origin-list">
        ${
          origins.length
            ? origins.map((origin) => `<span class="tag">${escapeHtml(origin)}</span>`).join("")
            : `<span class="tag">未配置允许域名</span>`
        }
        ${ingestion.lastAcceptedOrigin ? `<span class="tag risk-low">最近来源：${escapeHtml(ingestion.lastAcceptedOrigin)}</span>` : ""}
        ${ingestion.lastRejectedReason ? `<span class="tag risk-high">最近拦截：${escapeHtml(ingestion.lastRejectedReason)}</span>` : ""}
      </div>
      <div class="webhook-config">
        <div>
          <strong>输出 Webhook</strong>
          <small>把改动、发布、回滚结果推送到客户系统</small>
        </div>
        <label>
          回调 URL
          <input id="outputWebhookUrl" type="url" placeholder="https://customer.example.com/evolveops/webhook" value="${escapeHtml(outputWebhook.url || "")}" />
        </label>
        <span class="table-actions">
          <button class="row-action secondary" type="button" data-save-output-webhook="${escapeHtml(project.id)}">保存 Webhook</button>
          <button class="row-action secondary" type="button" data-test-output-webhook="${escapeHtml(project.id)}">发送测试</button>
        </span>
        <div class="webhook-deliveries">
          ${
            webhookDeliveries.length
              ? webhookDeliveries
                  .map(
                    (delivery) => `
                      <div class="webhook-delivery">
                        <span class="tag ${delivery.status === "delivered" ? "risk-low" : "risk-high"}">${escapeHtml(delivery.status)}</span>
                        <strong>${escapeHtml(delivery.event)}</strong>
                        <small>${escapeHtml(formatDate(delivery.createdAt))} · ${escapeHtml(String(delivery.statusCode || delivery.error || ""))}</small>
                      </div>
                    `,
                  )
                  .join("")
              : `<small class="quiet">暂无输出投递记录</small>`
          }
        </div>
      </div>
      <div class="webhook-config">
        <div>
          <strong>真实部署 Hook</strong>
          <small>用于触发客户网站自己的部署系统，例如 Vercel Deploy Hook、Netlify Build Hook 或自定义部署接口</small>
        </div>
        <label>
          部署 Hook URL
          <input id="deploymentHookUrl" type="url" placeholder="https://api.vercel.com/v1/integrations/deploy/..." value="${escapeHtml(deploymentHook.url || "")}" />
        </label>
        <label>
          类型
          <select id="deploymentHookProvider">
            ${["custom", "vercel", "netlify", "github_actions"].map((provider) => `<option value="${provider}" ${deploymentHook.provider === provider ? "selected" : ""}>${provider}</option>`).join("")}
          </select>
        </label>
        <span class="table-actions">
          <button class="row-action secondary" type="button" data-save-deployment-hook="${escapeHtml(project.id)}">保存部署 Hook</button>
          <button class="row-action secondary" type="button" data-test-deployment-hook="${escapeHtml(project.id)}">发送测试部署</button>
        </span>
        <div class="webhook-deliveries">
          ${
            deploymentRuns.length
              ? deploymentRuns
                  .map(
                    (run) => `
                      <div class="webhook-delivery">
                        <span class="tag ${run.status === "triggered" ? "risk-low" : "risk-high"}">${escapeHtml(run.status)}</span>
                        <strong>${escapeHtml(run.provider || "deploy")}</strong>
                        <small>${escapeHtml(formatDate(run.createdAt))} · ${escapeHtml(String(run.statusCode || run.error || ""))}</small>
                      </div>
                    `,
                  )
                  .join("")
              : `<small class="quiet">暂无真实部署触发记录</small>`
          }
        </div>
      </div>
      <span class="table-actions">
        <button class="row-action secondary" type="button" data-copy-sdk-key="${escapeHtml(projectSdkKey(project))}">复制 API Key</button>
        <button class="row-action secondary" type="button" data-copy-project-id="${escapeHtml(project.id)}">复制 Project ID</button>
        <button class="row-action secondary" type="button" data-copy-tenant-key="${escapeHtml(state.tenantCredentials?.tenantAccessKey || "")}">复制后台 Key</button>
        <button class="row-action secondary" type="button" data-rotate-tenant-key>轮换后台 Key</button>
        <button class="row-action secondary" type="button" data-test-sdk-connection="${escapeHtml(project.id)}">发送测试信号</button>
        <button class="row-action secondary" type="button" data-rotate-sdk-key="${escapeHtml(project.id)}">轮换 API Key</button>
      </span>
    `;
  }

  function renderReadiness() {
    const project = activeProject();
    const readiness = activeReadiness();
    const next = readiness.nextAction;
    const score = Number(readiness.score || 0);
    const checks = readiness.checks || [];
    const statusLabel = {
      self_evolving: "自进化中",
      in_progress: "推进中",
      waiting_for_signals: "等待信号",
      blocked: "被阻塞",
      missing_project: "未创建项目",
    }[readiness.status] || readiness.status || "待检查";

    $("#readinessPanel").innerHTML = `
      <div class="readiness-summary">
        <div>
          <small>自进化就绪度</small>
          <strong>${score}%</strong>
          <span>${escapeHtml(statusLabel)}</span>
        </div>
        <button class="primary-action" type="button" data-run-autopilot="${escapeHtml(project.id)}">手动推进</button>
      </div>
      ${
        next
          ? `<div class="readiness-next">
              <small>下一步</small>
              <strong>${escapeHtml(next.label || "")}</strong>
              <span>${escapeHtml(next.detail || "")}</span>
            </div>`
          : ""
      }
      <div class="readiness-checks">
        ${checks
          .map(
            (check) => `
              <div class="readiness-check">
                <div>
                  <strong>${escapeHtml(check.label)}</strong>
                  <small>${escapeHtml(check.detail || "")}</small>
                </div>
                <span class="check-status ${escapeHtml(check.status)}">${checkStatusLabel(check.status)}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderRepositories() {
    const repos = projectRepositories();
    const github = state.github || {};
    const installation = github.projectInstallation || projectGithubInstallations()[0];
    const authorizedRepos = projectAuthorizedGithubRepositories();
    const installHref = github.installUrl || github.directInstallUrl;
    const installationMeta = installation
      ? `
          <small>已绑定安装：${escapeHtml(installation.accountLogin || "GitHub App")} · ${escapeHtml(installation.status || "installed")} · ${escapeHtml(formatDate(installation.updatedAt))}</small>
          <small>授权仓库：${(installation.repositories || authorizedRepos || []).length} 个 · installation ${escapeHtml(installation.installationId || "")}</small>
        `
      : "";
    const githubCard = `
      <div class="connector-item github-status-card">
        <div>
          <strong>GitHub 授权：${escapeHtml(github.mode || "mock")}</strong>
          <small>${escapeHtml(github.message || "未配置真实 GitHub 授权，当前会生成 mock PR。")}</small>
          ${installationMeta}
          ${installHref ? `<small><a href="${escapeHtml(installHref)}" target="_blank" rel="noreferrer">安装或重新授权 GitHub App</a></small>` : ""}
        </div>
        <span class="table-actions">
          <button class="row-action secondary" type="button" data-github-refresh>刷新</button>
          <button class="row-action secondary" type="button" data-github-load-repos>同步授权仓库</button>
          ${repos[0] ? `<button class="row-action secondary" type="button" data-github-validate="${escapeHtml(repos[0].owner)}/${escapeHtml(repos[0].name)}">验证仓库</button>` : ""}
        </span>
      </div>
    `;
    const authorizedRepoCards = authorizedRepos.length
      ? authorizedRepos
          .map((repo, index) => {
            const owner = repo.owner || repo.fullName?.split("/")?.[0] || "";
            const name = repo.name || repo.fullName?.split("/")?.[1] || "";
            const alreadyConnected = repos.some((item) => item.owner === owner && item.name === name);
            return `
              <div class="connector-item github-authorized-repo">
                <div>
                  <strong>授权仓库 · ${escapeHtml(owner)}/${escapeHtml(name)}</strong>
                  <small>${escapeHtml(repo.url || `https://github.com/${owner}/${name}`)} · ${escapeHtml(repo.defaultBranch || "main")}${repo.private ? " · private" : ""}</small>
                </div>
                <span class="table-actions">
                  <button class="row-action secondary" type="button" data-github-validate="${escapeHtml(owner)}/${escapeHtml(name)}">验证</button>
                  <button class="row-action" type="button" data-github-connect-index="${index}" ${alreadyConnected ? "disabled" : ""}>${alreadyConnected ? "已连接" : "连接"}</button>
                </span>
              </div>
            `;
          })
          .join("")
      : `<div class="connector-item"><div><strong>暂无授权仓库</strong><small>安装 GitHub App 或点击“同步授权仓库”后，这里会显示客户已授权的代码仓库。</small></div></div>`;
    const repoCards = repos.length
      ? repos
          .map(
            (repo) => `
              <div class="connector-item">
                <div>
                  <strong>${escapeHtml(repo.provider)} · ${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</strong>
                  <small>${escapeHtml(repo.url)} · ${escapeHtml(repo.defaultBranch)}</small>
                  ${repo.localPath ? `<small>本地仓库：${escapeHtml(repo.localPath)}</small>` : ""}
                </div>
                <span class="tag connector-status">${escapeHtml(repo.status)}</span>
              </div>
            `,
          )
          .join("")
      : `<div class="connector-item"><div><strong>未连接网站代码</strong><small>先连接代码，AI 才能把任务变成可以发布的改动。</small></div></div>`;
    $("#repoList").innerHTML = `${githubCard}${authorizedRepoCards}${repoCards}`;
  }

  function renderPrDrafts() {
    const drafts = projectPrDrafts();
    $("#prDraftMeta").textContent = drafts.length ? `${drafts.length} 个待发布改动` : "等待生成";
    $("#prDraftList").innerHTML = drafts.length
      ? drafts
          .slice(0, 6)
          .map((draft) => {
            const patch = patchForDraft(draft.id);
            const report = patch ? reportForPatch(patch.id) : null;
            const changedFiles = (draft.changedFiles || []).map((file) => file.path || file).filter(Boolean);
            const changedCount = patch?.patchFiles?.length || changedFiles.length || 0;
            const repositoryLabel = [draft.repository, draft.branch].filter(Boolean).join(" / ");
            const needsManualReview =
              report?.decision === "manual_review" &&
              !["approved", "rejected"].includes(report.manualApproval?.status || "");
            const visibleStatus = patch
              ? `已准备 ${changedCount} 个改动点`
              : "等待生成具体改动";
            const technicalDetails = [
              repositoryLabel ? `<small>代码仓库：${escapeHtml(repositoryLabel)}</small>` : "",
              changedFiles.length ? `<small>涉及文件：${changedFiles.map((file) => escapeHtml(file)).join(" · ")}</small>` : "",
              patch ? `<small>改动编号：${escapeHtml(patch.id)} · ${(patch.patchFiles || []).length} 个文件</small>` : "",
              draft.remoteUrl
                ? `<small><a href="${escapeHtml(draft.remoteUrl)}" target="_blank" rel="noreferrer">代码仓库记录：${escapeHtml(String(draft.remoteNumber || draft.remoteUrl))}</a></small>`
                : "",
              renderTaskCodePlan(draft.codePlan || patch?.codePlan),
            ]
              .filter(Boolean)
              .join("");
            return `
              <div class="connector-item pr-draft-item has-details">
                <div class="connector-main-row">
                  <div class="customer-summary">
                    <strong>${escapeHtml(draft.title)}</strong>
                    <small>${escapeHtml(visibleStatus)} · ${escapeHtml(prStatusLabel(draft.status))}</small>
                    <small>${report ? `风险检查：${escapeHtml(qaDecisionLabel(report.decision))}` : "下一步：生成改动并运行检查"}</small>
                  </div>
                  <span class="table-actions">
                    ${
                      needsManualReview
                        ? `<button class="row-action" type="button" data-review-approve="${escapeHtml(draft.id)}">确认上线</button>
                           <button class="row-action secondary" type="button" data-review-reject="${escapeHtml(draft.id)}">拒绝</button>`
                        : ""
                    }
                    <button class="row-action secondary" data-pr-generate-patch="${escapeHtml(draft.id)}">${patch ? "查看改动" : "生成改动"}</button>
                    <button class="row-action secondary" data-pr-open-github="${escapeHtml(draft.id)}">${draft.remoteUrl ? "已提交" : "提交改动"}</button>
                    <button class="row-action" data-pr-advance="${escapeHtml(draft.id)}">${prStatusLabel(draft.status)}</button>
                  </span>
                </div>
                <details class="admin-details compact-admin-details">
                  <summary>查看技术细节</summary>
                  <div class="admin-details-body">${technicalDetails || "<small>暂无技术细节。</small>"}</div>
                </details>
              </div>
            `;
          })
          .join("")
      : `<div class="connector-item"><div><strong>暂无待发布改动</strong><small>在“批准进化”里点击“生成改动”。</small></div></div>`;
  }

  function renderPatchProposals() {
    const proposals = projectPatchProposals();
    const latest = proposals[0];
    const reports = projectValidationReports();
    const sandboxRuns = projectSandboxRuns();
    $("#patchProposalMeta").textContent = proposals.length
      ? `${proposals.length} 个改动已准备 · ${reports.length} 次检查 · ${sandboxRuns.length} 次安全测试`
      : "等待生成";

    if (!latest) {
      $("#patchProposalPanel").innerHTML = `
        <div class="connector-item">
          <div>
            <strong>暂无代码改动</strong>
            <small>先在“待发布改动”里点击“生成改动”，系统会输出文件变化和检查步骤。</small>
          </div>
        </div>
      `;
      return;
    }

    const firstFile = (latest.patchFiles || [])[0];
    const latestReport = reportForPatch(latest.id);
    const latestSandboxRun = sandboxRunForPatch(latest.id);
    const fileCount = (latest.patchFiles || []).length;
    const safetyLabel = latestReport
      ? `风险检查：${qaDecisionLabel(latestReport.decision)}`
      : "下一步：运行风险检查";
    const sandboxLabel = latestSandboxRun ? `安全测试：${sandboxStatusLabel(latestSandboxRun.status)}` : "安全测试：未运行";
    $("#patchProposalPanel").innerHTML = `
      <div class="connector-item has-details">
        <div class="connector-main-row">
          <div class="customer-summary">
            <strong>${escapeHtml(latest.summary)}</strong>
            <small>已准备 ${fileCount} 个改动点 · ${escapeHtml(latest.status)}</small>
            <small>${escapeHtml(safetyLabel)} · ${escapeHtml(sandboxLabel)}</small>
          </div>
          <span class="table-actions">
            <button class="row-action" data-patch-verify="${escapeHtml(latest.id)}">${latestReport ? "重新检查" : "运行风险检查"}</button>
            <button class="row-action secondary" data-patch-run-sandbox="${escapeHtml(latest.id)}">${latestSandboxRun ? "重跑安全测试" : "运行安全测试"}</button>
          </span>
        </div>
        <details class="admin-details compact-admin-details">
          <summary>查看技术细节</summary>
          <div class="admin-details-body">
            <small>改动编号：${escapeHtml(latest.id)} · ${escapeHtml(latest.status)}</small>
            <small>验证命令：${(latest.verificationCommands || []).map((item) => escapeHtml(item)).join(" · ") || "暂无"}</small>
            ${renderCodePlanPanel(latest.codePlan)}
            ${latestReport ? renderQaReport(latestReport, latestSandboxRun) : renderEmptyQaReport()}
            ${
              firstFile
                ? `<div class="patch-file">
                    <strong>${escapeHtml(firstFile.path)}</strong>
                    <pre class="patch-code">${escapeHtml(firstFile.diff)}</pre>
                  </div>`
                : ""
            }
          </div>
        </details>
      </div>
    `;
  }

  function renderProductionOps() {
    const latestPatch = projectPatchProposals()[0];
    const latestDraft = latestPatch
      ? projectPrDrafts().find((draft) => draft.id === latestPatch.prDraftId)
      : projectPrDrafts()[0];
    const latestApplication = latestPatch
      ? projectPatchApplications().find((item) => item.patchProposalId === latestPatch.id)
      : projectPatchApplications()[0];
    const latestProdSandbox = latestPatch
      ? projectProductionSandboxRuns().find((run) => run.patchProposalId === latestPatch.id)
      : projectProductionSandboxRuns()[0];
    const latestCi = latestDraft ? projectCiRuns().find((run) => run.prDraftId === latestDraft.id) : projectCiRuns()[0];
    const latestPreview = latestDraft
      ? projectPreviewDeployments().find((deployment) => deployment.prDraftId === latestDraft.id)
      : projectPreviewDeployments()[0];
    const latestRelease = latestDraft
      ? projectReleasePlans().find((plan) => plan.prDraftId === latestDraft.id)
      : projectReleasePlans()[0];
    const latestDeploymentRun = latestRelease
      ? projectDeploymentRuns().find((run) => run.releasePlanId === latestRelease.id)
      : projectDeploymentRuns()[0];
    const releaseGaps = Array.isArray(latestRelease?.productionRelease?.gaps)
      ? latestRelease.productionRelease.gaps
      : Array.isArray(latestRelease?.realRelease?.gaps)
        ? latestRelease.realRelease.gaps
        : [];
    const releaseIsLocalOnly =
      latestRelease?.realRelease?.status === "local_only" || latestRelease?.productionRelease?.status === "waiting";
    const releaseIsSimulated =
      latestRelease?.status === "simulation_completed" ||
      latestRelease?.deploymentStatus === "simulated" ||
      latestRelease?.realRelease?.status === "waiting";
    const auditRows = projectAuditLogs().slice(0, 5);
    const releaseVisibleText = latestRelease
      ? releaseIsLocalOnly
        ? "测试网站已更新，真实线上站未发布"
        : releaseIsSimulated
          ? "流程演示完成，真实网站未更新"
          : "正在按真实发布流程推进"
      : "等待生成发布计划";
    const technicalOpsDetails = `
      <details class="admin-details compact-admin-details">
        <summary>查看技术细节</summary>
        <div class="admin-details-body">
          ${latestApplication ? `<small>写入记录：${escapeHtml(latestApplication.id)} · ${escapeHtml(latestApplication.status)}</small>` : ""}
          ${latestProdSandbox ? `<small>安全测试：${escapeHtml(latestProdSandbox.id)} · ${sandboxStatusLabel(latestProdSandbox.status)} · ${(latestProdSandbox.commandResults || []).length} 条检查</small>` : ""}
          ${latestCi ? `<small>自动检查：${escapeHtml(latestCi.id || "")} · ${escapeHtml(latestCi.status || "")}</small>` : ""}
          ${latestPreview ? `<small>预览地址：<a href="${escapeHtml(latestPreview.url)}" target="_blank" rel="noreferrer">${escapeHtml(latestPreview.url)}</a></small>` : ""}
          ${latestRelease ? `<small>发布计划：${escapeHtml(latestRelease.id)} · ${escapeHtml(latestRelease.status)} · ${Number(latestRelease.currentPhase || 0)}%</small>` : ""}
          ${
            latestDeploymentRun
              ? `<small>部署触发：${escapeHtml(latestDeploymentRun.status)} · ${escapeHtml(String(latestDeploymentRun.statusCode || latestDeploymentRun.error || latestDeploymentRun.provider || ""))}</small>`
              : ""
          }
          <div class="audit-list">
            ${
              auditRows.length
                ? auditRows
                    .map(
                      (entry) => `
                        <div class="audit-row">
                          <span>
                            <strong>${escapeHtml(entry.action)}</strong>
                            <small>${escapeHtml(entry.actor?.userId || "local-operator")} · ${formatDate(entry.createdAt)}</small>
                          </span>
                          <span class="tag">${escapeHtml(entry.target || "")}</span>
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="audit-row"><span><strong>暂无审计记录</strong><small>生产操作会在这里留痕。</small></span></div>`
            }
          </div>
          ${latestProdSandbox?.logs ? `<pre class="sandbox-log">${escapeHtml(latestProdSandbox.logs)}</pre>` : ""}
        </div>
      </details>
    `;

    $("#productionOpsMeta").textContent = latestRelease
      ? `${releaseVisibleText} · ${latestRelease.currentPhase || 0}%`
      : latestProdSandbox
        ? `安全测试：${sandboxStatusLabel(latestProdSandbox.status)}`
        : "等待改动";

    if (!latestPatch && !latestDraft) {
      $("#productionOpsPanel").innerHTML = `
        <div class="connector-item">
          <div>
            <strong>等待生成代码改动</strong>
            <small>生成改动后，这里会出现测试、预览、发布和回滚操作。</small>
          </div>
        </div>
      `;
      return;
    }

    $("#productionOpsPanel").innerHTML = `
      <div class="production-grid">
        <div class="production-card">
          <small>写入代码</small>
          <strong>${latestApplication ? "已写入" : "未写入"}</strong>
          <span>${latestApplication ? `${latestApplication.changedFiles.length} 个改动已写入测试环境` : "批准后才会写入测试环境"}</span>
          ${latestPatch ? `<button class="row-action secondary" data-patch-apply-workspace="${latestPatch.id}">写入工作区</button>` : ""}
        </div>
        <div class="production-card">
          <small>安全测试</small>
          <strong>${latestProdSandbox ? sandboxStatusLabel(latestProdSandbox.status) : "未运行"}</strong>
          <span>${latestProdSandbox ? `${latestProdSandbox.commandResults.length} 项检查已完成` : "上线前需要先跑安全测试"}</span>
          ${latestPatch ? `<button class="row-action secondary" data-patch-run-production-sandbox="${latestPatch.id}">运行真实测试</button>` : ""}
        </div>
        <div class="production-card">
          <small>预览</small>
          <strong>${latestPreview ? "已生成" : latestCi ? "检查中" : "未生成"}</strong>
          <span>${latestPreview ? `<a href="${escapeHtml(latestPreview.url)}" target="_blank" rel="noreferrer">打开预览页面</a>` : "检查通过后生成预览页面"}</span>
          ${latestDraft ? `<button class="row-action secondary" data-pr-create-preview="${latestDraft.id}">创建预览</button>` : ""}
        </div>
        <div class="production-card">
          <small>发布 / 回滚</small>
          <strong>${latestRelease ? `${Number(latestRelease.currentPhase || 0)}%` : "未开始"}</strong>
          <span>${latestRelease ? `${releaseVisibleText}${releaseGaps.length ? `：${releaseGaps[0]}` : ""}` : "生成发布计划后才能上线"}</span>
          <span class="table-actions">
            ${latestDraft ? `<button class="row-action secondary" data-pr-create-release-plan="${latestDraft.id}">生成发布计划</button>` : ""}
            ${latestRelease ? `<button class="row-action" data-release-promote="${latestRelease.id}">推进</button>` : ""}
            ${latestRelease ? `<button class="row-action secondary" data-release-rollback="${latestRelease.id}">回滚</button>` : ""}
          </span>
        </div>
      </div>
      ${technicalOpsDetails}
    `;
  }

  function productionEnvTemplate() {
    return [
      "NODE_ENV=production",
      "HOST=0.0.0.0",
      "PORT=8787",
      "PUBLIC_BASE_URL=https://your-platform.example.com",
      "STORAGE_DRIVER=sqlite",
      "SQLITE_FILE=./data/itera.sqlite",
      "AI_API_BASE_URL=https://api.openai.com/v1",
      "AI_API_KEY=",
      "AI_MODEL=gpt-4.1-mini",
      "AI_TEMPERATURE=0.2",
      "GITHUB_APP_SLUG=",
      "GITHUB_APP_ID=",
      "GITHUB_APP_PRIVATE_KEY_BASE64=",
      "GITHUB_WEBHOOK_SECRET=",
      "GITHUB_TOKEN=",
      "SANDBOX_PROVIDER=external-http-provider",
      "SANDBOX_PROVIDER_URL=",
      "SANDBOX_PROVIDER_TOKEN=",
      "SANDBOX_PROVIDER_PRIVATE_NETWORK=false",
      "STRIPE_PAYMENT_LINK_PRO=",
      "STRIPE_PAYMENT_LINK_SCALE=",
      "STRIPE_PRICE_PRO=",
      "STRIPE_PRICE_SCALE=",
      "STRIPE_WEBHOOK_SECRET=",
      "STRIPE_CUSTOMER_PORTAL_URL=",
    ].join("\n");
  }

  function readinessStatus(ok) {
    return ok ? "passed" : "missing";
  }

  function renderAiProviderSetupPanel() {
    if (!forceRenderAiProviderPanel && isEditingAiProviderForm()) {
      rememberAiProviderDraft();
      return;
    }
    forceRenderAiProviderPanel = false;
    const production = state.productionStatus || offlineData.productionStatus;
    const provider = state.aiProvider || production.aiProvider || {
      configured: false,
      mode: "local_heuristic",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      temperature: 0.2,
      endpointHost: "",
      message: "AI API is not configured.",
    };
    const envTemplate = [
      "AI_API_BASE_URL=https://api.openai.com/v1",
      "AI_API_KEY=your-api-key",
      "AI_MODEL=gpt-4.1-mini",
      "AI_TEMPERATURE=0.2",
      "AI_HTTP_PROXY=",
      "",
      "# 也可以直接填写第三方中转站给你的完整 endpoint：",
      "# AI_API_BASE_URL=https://api.example.com/v1/chat/completions",
      "# AI_API_BASE_URL=https://api.example.com/v1/responses",
    ].join("\n");
    const checks = [
      { label: "API Key", ok: provider.apiKeyConfigured, detail: "AI_API_KEY" },
      { label: "Base URL", ok: provider.baseUrlConfigured, detail: "AI_API_BASE_URL" },
      { label: "Model", ok: Boolean(provider.model), detail: provider.model || "AI_MODEL" },
    ];
    const missingAiItems = checks.filter((check) => !check.ok).map((check) => check.label);
    const aiStatusText = provider.configured ? "已接入" : missingAiItems.length ? `未接入：缺少 ${missingAiItems.join("、")}` : "未接入";
    const draft = aiProviderDraft || {};
    const baseUrlValue = draft.baseUrl ?? provider.baseUrl ?? "https://api.openai.com/v1";
    const modelValue = draft.model ?? provider.model ?? "gpt-4.1-mini";
    const apiKeyValue = draft.apiKey ?? "";
    const proxyUrlValue = draft.proxyUrl ?? provider.proxyUrl ?? "";
    const temperatureValue = draft.temperature ?? provider.temperature ?? 0.2;
    const clearKeyChecked = draft.clearApiKey ? "checked" : "";

    $("#aiProviderSetupPanel").innerHTML = `
      <div class="panel-heading">
        <div>
          <h2>AI 大模型 API</h2>
          <span class="quiet">填写一次即可启用反馈分析、任务拆解和低风险静态站补丁生成。</span>
        </div>
        <div class="github-setup-actions">
          <button class="row-action" type="button" data-validate-ai-provider>验证 API</button>
        </div>
      </div>

      <div class="github-setup-layout">
        <div class="github-setup-block">
          <form class="ai-provider-form" id="aiProviderConfigForm">
            <label class="ai-form-field">
              <span class="ai-form-label">Base URL</span>
              <span class="ai-form-control">
                <input id="aiBaseUrlInput" inputmode="url" autocomplete="off" placeholder="https://api.example.com/v1 或 https://api.example.com/v1/responses" value="${escapeHtml(baseUrlValue)}" />
                <small>第三方 API 给你的接口地址，支持 /v1、/v1/chat/completions 或 /v1/responses。</small>
              </span>
            </label>
            <label class="ai-form-field">
              <span class="ai-form-label">模型名称</span>
              <span class="ai-form-control">
                <input id="aiModelInput" autocomplete="off" placeholder="例如：gpt-4.1-mini、deepseek-chat、claude-sonnet-4" value="${escapeHtml(modelValue)}" />
              </span>
            </label>
            <label class="ai-form-field">
              <span class="ai-form-label">Proxy</span>
              <span class="ai-form-control">
                <input id="aiProxyUrlInput" inputmode="url" autocomplete="off" placeholder="http://127.0.0.1:7890" value="${escapeHtml(proxyUrlValue)}" />
                <small>Optional. If your computer uses Clash/VPN proxy, fill the local HTTP proxy here.</small>
              </span>
            </label>
            <label class="ai-form-field">
              <span class="ai-form-label">API Key</span>
              <span class="ai-form-control">
                <input id="aiApiKeyInput" type="password" autocomplete="off" placeholder="${provider.apiKeyConfigured ? "已保存，留空不改" : "粘贴你的 API Key"}" value="${escapeHtml(apiKeyValue)}" />
                <small>${provider.apiKeyConfigured ? "Key 已保存；如果只是改地址或模型，这里可以留空。" : "第一次接入必须粘贴 API Key，否则状态仍会是未接入。"}</small>
              </span>
            </label>
            <label class="ai-form-field">
              <span class="ai-form-label">温度</span>
              <span class="ai-form-control">
                <input id="aiTemperatureInput" type="number" min="0" max="1" step="0.1" value="${escapeHtml(temperatureValue)}" />
                <small>建议保持 0.2，让改代码更稳定。</small>
              </span>
            </label>
            <div class="ai-form-footer">
              <label class="ai-clear-key">
                <input id="aiClearKeyInput" type="checkbox" ${clearKeyChecked} />
                <span>清空已保存 Key</span>
              </label>
              <button class="primary-action" type="submit">保存 AI 配置</button>
            </div>
          </form>
        </div>

        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>状态</strong>
            <span class="check-status ${provider.configured ? "passed" : "missing"}">${escapeHtml(aiStatusText)}</span>
          </div>
          <div class="github-check-list">
            ${checks
              .map(
                (check) => `
                  <div class="github-check-row">
                    <span>
                      <strong>${escapeHtml(check.label)}</strong>
                      <small>${escapeHtml(check.detail || "")}</small>
                    </span>
                    <span class="check-status ${check.ok ? "passed" : "missing"}">${check.ok ? "已配置" : "待配置"}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
          <div class="setup-block-title">
            <strong>接入参数</strong>
            <span class="tag">通用 API</span>
          </div>
          <div class="github-url-list">
            <div class="github-url-row">
              <span><strong>接口域名</strong><code>${escapeHtml(provider.endpointHost || "未配置")}</code></span>
            </div>
            <div class="github-url-row">
              <span><strong>模型名称</strong><code>${escapeHtml(provider.model || "未配置")}</code></span>
            </div>
          </div>
        </div>
      </div>

      <div class="github-setup-meta">
        <div>
          <strong>当前能力</strong>
          <span>${provider.configured ? "可调用第三方模型进行复杂分析和低风险代码补丁生成" : "只能使用本地规则兜底，不能独立完成复杂代码推理"}</span>
        </div>
        <div>
          <strong>说明</strong>
          <span>${escapeHtml(provider.message || "")}</span>
        </div>
      </div>
    `;
  }

  function renderGithubSetupPanel() {
    const setup = state.githubSetup || offlineData.githubSetup || {};
    const app = setup.app || {};
    const urls = setup.urls || {};
    const checks = Array.isArray(setup.checks) && setup.checks.length ? setup.checks : [];
    const permissions = Array.isArray(setup.requiredPermissions) ? setup.requiredPermissions : [];
    const events = Array.isArray(setup.requiredEvents) ? setup.requiredEvents : [];
    const envTemplate = setup.envTemplate || [
      "PUBLIC_BASE_URL=https://your-platform.example.com",
      "GITHUB_APP_SLUG=your-github-app-slug",
      "GITHUB_APP_ID=123456",
      "GITHUB_APP_PRIVATE_KEY_BASE64=base64-encoded-private-key",
      "GITHUB_WEBHOOK_SECRET=generate-a-long-random-secret",
    ].join("\n");
    const installHref = urls.installUrl || urls.directInstallUrl;

    $("#githubSetupPanel").innerHTML = `
      <div class="panel-heading">
        <div>
          <h2>GitHub App 授权</h2>
          <span class="quiet">${escapeHtml(setup.message || "配置真实 GitHub 授权后，平台才能打开真实 PR。")}</span>
        </div>
        <div class="github-setup-actions">
          ${urls.createAppUrl ? `<a class="row-action secondary" href="${escapeHtml(urls.createAppUrl)}" target="_blank" rel="noreferrer">创建 App</a>` : ""}
          ${urls.appSettingsUrl ? `<a class="row-action secondary" href="${escapeHtml(urls.appSettingsUrl)}" target="_blank" rel="noreferrer">App 设置</a>` : ""}
          ${installHref ? `<a class="row-action" href="${escapeHtml(installHref)}" target="_blank" rel="noreferrer">安装授权</a>` : ""}
          <button class="row-action secondary" type="button" data-validate-github-setup>验证</button>
        </div>
      </div>

      <div class="github-setup-layout">
        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>状态</strong>
            <span class="check-status ${setup.canOpenRealPr ? "passed" : "missing"}">${setup.canOpenRealPr ? "可打开真实 PR" : setup.mode || "mock"}</span>
          </div>
          <div class="github-check-list">
            ${
              checks.length
                ? checks
                    .map(
                      (check) => `
                        <div class="github-check-row">
                          <span>
                            <strong>${escapeHtml(check.label)}</strong>
                            <small>${escapeHtml(check.detail || "")}</small>
                          </span>
                          <span class="check-status ${check.ok ? "passed" : "missing"}">${check.ok ? "通过" : "待配置"}</span>
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="github-check-row"><span><strong>等待 API 状态</strong><small>启动后端后会显示 GitHub 配置项。</small></span></div>`
            }
          </div>
        </div>

        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>GitHub 填写项</strong>
            <button class="row-action secondary" type="button" data-copy-github-setup-env>复制变量</button>
          </div>
          <div class="github-url-list">
            <div class="github-url-row">
              <span><strong>Callback URL</strong><code id="githubCallbackUrlText">${escapeHtml(urls.callbackUrl || "先配置公网 HTTPS 地址")}</code></span>
              <button class="row-action secondary" type="button" data-copy-github-url="githubCallbackUrlText">复制</button>
            </div>
            <div class="github-url-row">
              <span><strong>Webhook URL</strong><code id="githubWebhookUrlText">${escapeHtml(urls.webhookUrl || "先配置公网 HTTPS 地址")}</code></span>
              <button class="row-action secondary" type="button" data-copy-github-url="githubWebhookUrlText">复制</button>
            </div>
          </div>
          <pre class="github-env-template" id="githubSetupEnvTemplate">${escapeHtml(envTemplate)}</pre>
        </div>
      </div>

      <div class="github-setup-meta">
        <div>
          <strong>权限</strong>
          <span>${permissions.map((item) => `${escapeHtml(item.name)}: ${escapeHtml(item.access)}`).join(" · ") || "Contents / Pull requests / Metadata"}</span>
        </div>
        <div>
          <strong>事件</strong>
          <span>${events.map((event) => escapeHtml(event)).join(" · ") || "Installation · Installation repositories"}</span>
        </div>
        <div>
          <strong>凭证</strong>
          <span>App ${app.appConfigured ? "已加载" : "未加载"} · Token ${app.tokenConfigured ? "已加载" : "未加载"} · Webhook Secret ${app.webhookSecretConfigured ? "已加载" : "未加载"}</span>
        </div>
      </div>
    `;
  }

  function renderSandboxSetupPanel() {
    const setup = state.sandboxSetup || offlineData.sandboxSetup || {};
    const checks = Array.isArray(setup.checks) && setup.checks.length ? setup.checks : [];
    const contract = setup.contract || {};
    const samplePayload = setup.samplePayload || {};
    const envTemplate = setup.envTemplate || [
      "SANDBOX_MODE=isolated-provider",
      "SANDBOX_PROVIDER=external-http-provider",
      "SANDBOX_PROVIDER_URL=https://sandbox-provider.example.com/run",
      "SANDBOX_PROVIDER_TOKEN=provider-secret-token",
      "SANDBOX_PROVIDER_PRIVATE_NETWORK=false",
    ].join("\n");

    $("#sandboxSetupPanel").innerHTML = `
      <div class="panel-heading">
        <div>
          <h2>隔离沙箱 Provider</h2>
          <span class="quiet">生产环境必须把生成代码的执行放到独立运行时，不能留在主 Web 进程里。</span>
        </div>
        <div class="github-setup-actions">
          <button class="row-action secondary" type="button" data-copy-sandbox-env>复制变量</button>
          <button class="row-action" type="button" data-validate-sandbox-setup>验证沙箱</button>
        </div>
      </div>

      <div class="github-setup-layout">
        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>状态</strong>
            <span class="check-status ${setup.configured ? "passed" : "missing"}">${escapeHtml(setup.mode || "local-allowlist")}</span>
          </div>
          <div class="github-check-list">
            ${
              checks.length
                ? checks
                    .map(
                      (check) => `
                        <div class="github-check-row">
                          <span>
                            <strong>${escapeHtml(check.label)}</strong>
                            <small>${escapeHtml(check.detail || "")}</small>
                          </span>
                          <span class="check-status ${check.ok ? "passed" : "missing"}">${check.ok ? "通过" : "待配置"}</span>
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="github-check-row"><span><strong>等待 API 状态</strong><small>启动后端后会显示沙箱配置项。</small></span></div>`
            }
          </div>
        </div>

        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>Provider 契约</strong>
            <span class="tag">${escapeHtml(contract.method || "POST")}</span>
          </div>
          <div class="github-url-list">
            <div class="github-url-row">
              <span><strong>Endpoint</strong><code>${escapeHtml(contract.url || "https://sandbox-provider.example.com/run")}</code></span>
            </div>
            <div class="github-url-row">
              <span><strong>返回字段</strong><code>${escapeHtml((contract.responseFields || ["status", "commandResults", "logs"]).join(", "))}</code></span>
            </div>
          </div>
          <pre class="github-env-template" id="sandboxSetupEnvTemplate">${escapeHtml(envTemplate)}</pre>
        </div>
      </div>

      <div class="github-setup-meta">
        <div>
          <strong>请求字段</strong>
          <span>${escapeHtml((contract.requestFields || ["projectId", "patchFiles", "commands"]).join(" · "))}</span>
        </div>
        <div>
          <strong>认证</strong>
          <span>${setup.tokenConfigured ? "Bearer token 已加载" : "等待 SANDBOX_PROVIDER_TOKEN 或私网 provider"}</span>
        </div>
        <div>
          <strong>探针 payload</strong>
          <span>${escapeHtml(JSON.stringify(samplePayload).slice(0, 180))}</span>
        </div>
      </div>
    `;
  }

  function renderBillingSetupPanel() {
    const setup = state.billingSetup || offlineData.billingSetup || {};
    const checks = Array.isArray(setup.checks) && setup.checks.length ? setup.checks : [];
    const plans = Array.isArray(setup.plans) ? setup.plans : [];
    const envTemplate = setup.envTemplate || [
      "STRIPE_PAYMENT_LINK_PRO=https://buy.stripe.com/...",
      "STRIPE_PAYMENT_LINK_SCALE=https://buy.stripe.com/...",
      "STRIPE_SECRET_KEY=sk_live_...",
      "STRIPE_PRICE_PRO=price_...",
      "STRIPE_PRICE_SCALE=price_...",
      "STRIPE_WEBHOOK_SECRET=whsec_...",
      "STRIPE_CUSTOMER_PORTAL_URL=",
    ].join("\n");

    $("#billingSetupPanel").innerHTML = `
      <div class="panel-heading">
        <div>
          <h2>Stripe 计费</h2>
          <span class="quiet">客户订阅、套餐限制和付款回调需要真实 Stripe checkout 与 webhook。</span>
        </div>
        <div class="github-setup-actions">
          <button class="row-action secondary" type="button" data-copy-billing-env>复制变量</button>
          <button class="row-action" type="button" data-validate-billing-setup>验证计费</button>
        </div>
      </div>

      <div class="github-setup-layout">
        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>状态</strong>
            <span class="check-status ${setup.configured ? "passed" : "missing"}">${escapeHtml(setup.mode || "mock")}</span>
          </div>
          <div class="github-check-list">
            ${
              checks.length
                ? checks
                    .map(
                      (check) => `
                        <div class="github-check-row">
                          <span>
                            <strong>${escapeHtml(check.label)}</strong>
                            <small>${escapeHtml(check.detail || "")}</small>
                          </span>
                          <span class="check-status ${check.ok ? "passed" : "missing"}">${check.ok ? "通过" : "待配置"}</span>
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="github-check-row"><span><strong>等待 API 状态</strong><small>启动后端后会显示计费配置项。</small></span></div>`
            }
          </div>
        </div>

        <div class="github-setup-block">
          <div class="setup-block-title">
            <strong>套餐与 Webhook</strong>
            <span class="tag">${setup.webhookReady ? "Webhook ready" : "Webhook missing"}</span>
          </div>
          <div class="github-url-list">
            <div class="github-url-row">
              <span><strong>Stripe Webhook URL</strong><code id="billingWebhookUrlText">${escapeHtml(setup.urls?.webhookUrl || "先配置公网 HTTPS 地址")}</code></span>
              <button class="row-action secondary" type="button" data-copy-billing-url="billingWebhookUrlText">复制</button>
            </div>
            <div class="github-url-row">
              <span><strong>Customer Portal</strong><code id="billingPortalUrlText">${escapeHtml(setup.urls?.portalEndpoint || setup.urls?.customerPortalUrl || "not configured")}</code></span>
              <button class="row-action secondary" type="button" data-copy-billing-url="billingPortalUrlText">Copy</button>
              <button class="row-action" type="button" data-open-billing-portal>Open</button>
            </div>
            <div class="github-url-row">
              <span><strong>当前套餐</strong><code>${escapeHtml(setup.current?.plan?.name || "Free")} · ${escapeHtml(setup.current?.organization?.billingStatus || "trialing")}</code></span>
            </div>
          </div>
          <pre class="github-env-template" id="billingSetupEnvTemplate">${escapeHtml(envTemplate)}</pre>
        </div>
      </div>

      <div class="github-setup-meta">
        ${(plans.length ? plans : [{ id: "free", name: "Free", monthlyPrice: 0 }, { id: "pro", name: "Pro", monthlyPrice: 49 }, { id: "scale", name: "Scale", monthlyPrice: 199 }])
          .map(
            (plan) => `
              <div>
                <strong>${escapeHtml(plan.name || plan.id)}</strong>
                <span>$${Number(plan.monthlyPrice || 0)}/月 · ${(plan.limits ? Object.entries(plan.limits).map(([key, value]) => `${escapeHtml(key)} ${escapeHtml(value)}`).join(" · ") : "等待套餐限制")}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderProductionReadiness() {
    const production = state.productionStatus || offlineData.productionStatus;
    const blockers = production.readiness?.blockers || [];
    const ready = Boolean(production.readiness?.productionReady);
    const checks = [
      {
        title: "数据保存",
        status: readinessStatus(production.storage?.durable || production.storage?.driver === "sqlite"),
        value: production.storage?.driver || "unknown",
        detail: production.storage?.note || "需要能长期保存客户项目、反馈和进化记录。",
      },
      {
        title: "公开访问地址",
        status: readinessStatus(production.deployment?.httpsReady),
        value: production.deployment?.publicBaseUrl || "未配置",
        detail: "客户网站和外部服务需要能访问这个平台。",
      },
      {
        title: "AI 大模型 API",
        status: readinessStatus(production.aiProvider?.configured),
        value: production.aiProvider?.model || production.aiProvider?.mode || "local_heuristic",
        detail: production.aiProvider?.configured ? "第三方大模型 API 已配置，平台可调用模型分析反馈并生成低风险静态补丁。" : "未配置时只能用本地规则，不能真正独立进行复杂代码推理。",
      },
      {
        title: "代码仓库连接",
        status: readinessStatus(production.githubApp?.configured),
        value: production.githubApp?.mode || "mock",
        detail: production.githubApp?.configured ? "已具备向真实代码仓库提交改动的权限。" : "未配置时只能生成演示改动。",
      },
      {
        title: "安全测试环境",
        status: readinessStatus(production.sandbox?.isolatedRuntimeConfigured),
        value: production.sandbox?.mode || "local",
        detail: production.sandbox?.providerUrlConfigured ? "已配置独立测试环境。" : "真实客户代码需要放到独立环境里测试。",
      },
      {
        title: "付款与套餐",
        status: readinessStatus(production.billing?.stripeConfigured && production.billing?.stripeWebhookConfigured && production.billing?.stripePortalConfigured),
        value: production.billing?.mode || "mock",
        detail: production.billing?.stripePortalConfigured ? "付款、套餐和客户账单入口已配置。" : "需要配置付款链接、回调和客户账单入口。",
      },
    ];
    const passed = checks.filter((check) => check.status === "passed").length;
    $("#productionReadinessSummary").innerHTML = `
      <div class="production-summary ${ready ? "is-ready" : ""}">
        <div>
          <small>上线准备</small>
          <strong>${passed}/${checks.length} 项通过</strong>
          <span>${ready ? "当前环境已满足给真实客户使用的基础要求。" : "当前还有缺口，先不要给真实客户承诺全自动上线。"}</span>
        </div>
        <span class="check-status ${ready ? "passed" : "blocked"}">${ready ? "可上线" : `${blockers.length} 项阻塞`}</span>
      </div>
    `;
    if ($("#publicBaseUrlInput") && document.activeElement !== $("#publicBaseUrlInput")) {
      $("#publicBaseUrlInput").value = production.deployment?.publicBaseUrl || "";
    }
    const deploymentUrls = [
      ["公开接入文档", production.deployment?.docsUrl],
      ["客户 Widget 脚本", production.deployment?.widgetUrl],
      ["GitHub Callback", production.deployment?.githubCallbackUrl],
      ["GitHub Webhook", production.deployment?.githubWebhookUrl],
      ["Stripe Webhook", production.deployment?.stripeWebhookUrl],
    ].filter(([, value]) => value);
    $("#deploymentUrlGrid").innerHTML = deploymentUrls.length
      ? deploymentUrls
          .map(
            ([label, value], index) => `
              <div class="deploy-url-row">
                <span>
                  <strong>${escapeHtml(label)}</strong>
                  <code id="deployUrl-${index}">${escapeHtml(value)}</code>
                </span>
                <button class="row-action secondary" type="button" data-copy-deploy-url="deployUrl-${index}">复制</button>
              </div>
            `,
          )
          .join("")
      : `<div class="deploy-url-row is-empty"><span><strong>等待公网域名</strong><code>保存 HTTPS 地址后自动生成这些 URL。</code></span></div>`;
    renderAiProviderSetupPanel();
    renderGithubSetupPanel();
    renderSandboxSetupPanel();
    renderBillingSetupPanel();
    $("#productionReadinessGrid").innerHTML = checks
      .map(
        (check) => `
          <div class="production-status-card">
            <div>
              <small>${escapeHtml(check.title)}</small>
              <strong>${escapeHtml(check.value)}</strong>
              <span>${escapeHtml(check.detail)}</span>
            </div>
            <span class="check-status ${check.status}">${check.status === "passed" ? "通过" : "待配置"}</span>
          </div>
        `,
      )
      .join("");
    $("#productionBlockers").innerHTML = blockers.length
      ? blockers
          .map(
            (blocker, index) => `
              <div class="blocker-row">
                <b>${index + 1}</b>
                <span>${escapeHtml(blocker)}</span>
              </div>
            `,
          )
          .join("")
      : `<div class="blocker-row is-empty"><span>没有阻塞项。</span></div>`;
    const loadedEnvFiles = production.runtimeConfig?.loadedEnvFiles || [];
    const envRows = [
      [loadedEnvFiles.length ? `已加载 ${loadedEnvFiles.map((item) => item.file).join(", ")}` : ".env.local / .env.production", loadedEnvFiles.length > 0],
      ["平台公开网址", production.deployment?.httpsReady],
      ["持久保存数据", production.storage?.driver === "sqlite"],
      ["AI 模型 API", production.aiProvider?.configured],
      ["代码仓库权限", production.githubApp?.configured],
      ["独立安全测试环境", production.sandbox?.isolatedRuntimeConfigured],
      ["付款链接或套餐价格", production.billing?.stripeConfigured],
      ["付款状态回调", production.billing?.stripeWebhookConfigured],
      ["客户账单入口", production.billing?.stripePortalConfigured],
    ];
    $("#productionEnvChecklist").innerHTML = `
      ${envRows
        .map(
          ([name, ok]) => `
            <div class="env-row">
              <code>${escapeHtml(name)}</code>
              <span class="check-status ${ok ? "passed" : "missing"}">${ok ? "已配置" : "待配置"}</span>
            </div>
          `,
        )
        .join("")}
      <a class="ghost-button full-width" href="/PRODUCTION.md" target="_blank" rel="noreferrer">查看高级上线清单</a>
    `;
  }

  function renderEmptyQaReport() {
    return `
      <div class="qa-report is-empty">
        <div>
          <strong>等待 QA Agent 验证</strong>
          <small>运行后会生成风险评分、检查项和是否允许进入 PR 的决策。</small>
        </div>
      </div>
    `;
  }

  function renderQaReport(report, sandboxRun) {
    const commandResults = sandboxRun?.commandResults || report.commandResults || [];
    return `
      <div class="qa-report">
        <div class="qa-report-head">
          <div>
            <strong>${escapeHtml(report.summary)}</strong>
            <small>${escapeHtml(report.id)} · ${qaStatusLabel(report.status)} · 风险分 ${Number(report.riskScore || 0)}/100</small>
            ${sandboxRun ? `<small>沙箱：${escapeHtml(sandboxRun.id)} · ${sandboxStatusLabel(sandboxRun.status)} · ${escapeHtml(sandboxRun.mode || "")}</small>` : ""}
          </div>
          <span class="decision-pill ${qaDecisionClass(report.decision)}">${qaDecisionLabel(report.decision)}</span>
        </div>
        <div class="qa-check-list">
          ${(report.checks || [])
            .map(
              (check) => `
                <div class="qa-check-row">
                  <span>
                    <strong>${escapeHtml(check.name)}</strong>
                    <small>${escapeHtml(check.detail)}</small>
                  </span>
                  <span class="check-status ${escapeHtml(check.status)}">${checkStatusLabel(check.status)}</span>
                </div>
              `,
            )
            .join("")}
        </div>
        ${
          commandResults.length
            ? `<div class="sandbox-command-list">
                ${commandResults
                  .map(
                    (item) => `
                      <div class="sandbox-command-row">
                        <span>
                          <strong>${escapeHtml(item.command)}</strong>
                          <small>${escapeHtml(item.output || item.detail || "")}</small>
                        </span>
                        <span class="check-status ${escapeHtml(item.status)}">${checkStatusLabel(item.status)}</span>
                      </div>
                    `,
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${sandboxRun?.logs ? `<pre class="sandbox-log">${escapeHtml(sandboxRun.logs)}</pre>` : ""}
        <div class="qa-next-actions">
          ${(report.nextActions || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  function sandboxStatusLabel(status) {
    return {
      passed: "通过",
      failed: "失败",
      running: "运行中",
    }[status] || status;
  }

  function qaStatusLabel(status) {
    return {
      passed: "验证通过",
      needs_review: "需要人工 Review",
      blocked: "已阻断",
    }[status] || status;
  }

  function qaDecisionLabel(decision) {
    return {
      auto_pr_allowed: "可自动继续",
      manual_review: "人工确认",
      blocked: "阻断",
    }[decision] || decision;
  }

  function qaDecisionClass(decision) {
    return {
      auto_pr_allowed: "is-pass",
      manual_review: "is-review",
      blocked: "is-blocked",
    }[decision] || "is-review";
  }

  function checkStatusLabel(status) {
    const extraLabels = {
      approved: "已确认",
      rejected: "已拒绝",
      simulated: "模拟完成",
      simulating: "模拟中",
      simulation_completed: "模拟完成",
      running: "运行中",
      opened: "已打开",
      ready: "就绪",
      ready_to_patch: "可生成改动",
      needs_repository: "缺仓库",
      repository_blocked: "仓库阻断",
      needs_code_generation: "需代码生成",
      rolling_out: "小范围发布中",
      healthy: "健康",
      armed: "已就绪",
      completed: "完成",
      selected: "已选择",
      created: "已生成",
      reused: "已复用",
      applied: "已写入",
      unchanged: "无变化",
      patch_ready: "补丁就绪",
      written: "已写入",
      verified: "已验证",
      planned: "已计划",
    };
    if (extraLabels[status]) return extraLabels[status];
    return {
      passed: "通过",
      warning: "注意",
      waiting: "等待",
      missing: "缺失",
      blocked: "阻塞",
      failed: "失败",
    }[status] || status;
  }

  function prStatusLabel(status) {
    return {
      drafted: "提交审核",
      ready_for_review: "跑测试",
      tests_passed: "批准",
      approved: "合并",
      merged: "已合并",
      closed: "已关闭",
      github_opened: "已提交代码仓库",
      github_mock_opened: "演示提交",
      patch_generated: "改动已生成",
      qa_verified: "检查通过",
      qa_review_required: "人工确认",
      qa_blocked: "检查阻断",
    }[status] || status;
  }

  function renderPolicy() {
    $("#policyPr").checked = state.policy.autoPr;
    $("#policyCanary").checked = state.policy.autoCanary;
    $("#riskLimit").value = state.policy.riskLimit;
    $("#confidenceLimit").value = state.policy.confidenceLimit;
    $("#riskLimitLabel").textContent = riskLabel(state.policy.riskLimit);
    $("#confidenceLabel").textContent = `${state.policy.confidenceLimit}%`;

    const rows = [
      ["低风险", "AI 可生成改动，测试通过后可小范围发布"],
      ["中风险", "AI 可生成改动，必须人工确认后发布"],
      ["高风险", "只生成方案和改动建议，不自动发布"],
      ["安全/支付/权限", "必须人工确认，并准备回滚方案"],
    ];
    $("#approvalMatrix").innerHTML = rows
      .map(
        ([title, note]) => `
          <div class="matrix-row">
            <span>
              <strong>${title}</strong>
              <small>${note}</small>
            </span>
            <span class="tag">默认</span>
          </div>
        `,
      )
      .join("");
  }

  function render() {
    renderActiveView();
    renderAccountMenu();
    renderProjectHeader();
    renderActivityBanner();
    renderMetrics();
    renderLoopMap();
    renderTopology();
    renderInsights();
    renderCapabilityRadar();
    renderOverviewLists();
    renderReleaseGuard();
    renderFeedback();
    renderTasks();
    renderEvolutionRunPanel();
    renderPipeline();
    renderIntegrations();
    renderPolicy();
    renderProductionReadiness();
  }

  function switchView(view) {
    state.activeView = view;
    saveUiState();
    render();
  }

  async function switchProject(projectId, view = "") {
    if (!projectId) return;
    state.selectedProjectId = projectId;
    if (view) state.activeView = view;
    saveUiState();
    await refreshState();
  }

  async function createProjectFromForm(event) {
    event.preventDefault();
    const name = $("#newProjectName").value.trim();
    const url = normalizeWebsiteUrl($("#newProjectUrl").value);
    if (!name) {
      showToast("请输入产品名称");
      return;
    }
    if (!url) {
      showToast("请输入有效的网站网址");
      return;
    }

    const env = "production";
    const allowedOrigins = [originFromUrl(url)].filter(Boolean);

    try {
      const result = await apiRequest("/projects", {
        method: "POST",
        body: JSON.stringify({ name, url, env, allowedOrigins }),
      });
      state = { ...state, ...result.state, selectedProjectId: result.project.id, copiedSnippetProjectId: "", apiConnected: true };
      $("#projectForm").reset();
      saveUiState();
      showToast("API Key 已生成，嵌入代码已填好");
    } catch (error) {
      const id = slugify(name);
      const project = {
        id,
        name,
        url,
        env,
        health: 80,
        conversion: 0,
        errorRate: 0,
        canary: 0,
        allowedOrigins,
        sdkKey: `sdk-${id}-offline`,
        sdkStatus: "active",
        createdAt: new Date().toISOString(),
      };
      state.projects.unshift(project);
      state.selectedProjectId = id;
      state.copiedSnippetProjectId = "";
      $("#projectForm").reset();
      saveUiState();
      addLocalLog(`离线创建客户项目：${project.name}`);
      showToast(error.data?.error || "API 未连接，已生成离线 API Key");
    }
    render();
  }

  async function rotateSdkKey(projectId) {
    try {
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/rotate-sdk-key`, { method: "POST" });
      state = { ...state, ...result.state, selectedProjectId: result.project.id, apiConnected: true };
      showToast("API Key 已轮换");
    } catch (error) {
      const project = state.projects.find((item) => item.id === projectId);
      if (project) {
        project.sdkKey = `sdk-${project.id}-offline-${Date.now().toString(36)}`;
        project.sdkStatus = "active";
        project.updatedAt = new Date().toISOString();
        showToast("API 未连接，已轮换离线 key");
      } else {
        showToast(error.data?.error || "轮换失败");
      }
    }
    render();
  }

  async function rotateTenantKey() {
    try {
      const result = await apiRequest("/tenant/rotate-key", { method: "POST" });
      const credentials = {
        tenantId: result.tenant?.id || state.tenantCredentials?.tenantId || DEFAULT_TENANT_ID,
        tenantAccessKey: result.accessKey,
      };
      state = {
        ...state,
        ...(result.state || {}),
        tenant: result.tenant || result.state?.tenant || state.tenant,
        tenantCredentials: credentials,
        apiConnected: true,
      };
      saveUiState();
      showToast("后台访问 Key 已轮换");
    } catch (error) {
      showToast(error.data?.error || "后台访问 Key 轮换失败");
    }
    render();
  }

  async function saveOutputWebhook(projectId) {
    const input = $("#outputWebhookUrl");
    const url = input ? input.value.trim() : "";
    try {
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/output-webhook`, {
        method: "PATCH",
        body: JSON.stringify({ url, enabled: Boolean(url) }),
      });
      state = { ...state, ...result.state, selectedProjectId: result.project.id, apiConnected: true };
      showToast(url ? "输出 Webhook 已保存" : "输出 Webhook 已关闭");
    } catch (error) {
      showToast(error.data?.error || "保存输出 Webhook 失败");
    }
    render();
  }

  async function testOutputWebhook(projectId) {
    try {
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/output-webhook/test`, { method: "POST" });
      state = { ...state, ...result.state, selectedProjectId: projectId, apiConnected: true };
      showToast(`Webhook 测试：${result.delivery.status}`);
    } catch (error) {
      showToast(error.data?.error || "Webhook 测试失败");
    }
    render();
  }

  async function saveDeploymentHook(projectId) {
    const input = $("#deploymentHookUrl");
    const providerInput = $("#deploymentHookProvider");
    const url = input ? input.value.trim() : "";
    const provider = providerInput ? providerInput.value : "custom";
    try {
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/deployment-hook`, {
        method: "PATCH",
        body: JSON.stringify({ url, provider, enabled: Boolean(url) }),
      });
      state = { ...state, ...result.state, selectedProjectId: result.project.id, apiConnected: true };
      showToast(url ? "真实部署 Hook 已保存" : "真实部署 Hook 已关闭");
    } catch (error) {
      showToast(error.data?.error || "保存真实部署 Hook 失败");
    }
    render();
  }

  async function testDeploymentHook(projectId) {
    try {
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/deployment-hook/test`, { method: "POST" });
      state = { ...state, ...result.state, selectedProjectId: projectId, apiConnected: true };
      showToast(`部署 Hook 测试：${result.deploymentRun.status}`);
    } catch (error) {
      showToast(error.data?.error || "部署 Hook 测试失败");
    }
    render();
  }

  async function testSdkConnection(projectId) {
    const project = state.projects.find((item) => item.id === projectId) || activeProject();
    try {
      const result = await apiRequest("/signals", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          projectName: project.name,
          sdkKey: projectSdkKey(project),
          type: "connection_test",
          source: "接入自检",
          page: project.url,
          data: {
            text: "接入自检：API Key、Project ID 与 Signals API 已连通。",
          },
        }),
      });
      state = { ...state, ...result.state, selectedProjectId: project.id, apiConnected: true };
      showToast("接入自检通过，已收到测试信号");
    } catch (error) {
      showToast(error.data?.error || "接入自检失败");
    }
    render();
  }

  function markEvolutionRunning(projectId, detail = "正在启动高级自动模式") {
    state.evolutionProgress = {
      projectId,
      type: "autopilot",
      status: "running",
      mode: "advanced",
      startedAt: new Date().toISOString(),
      actions: [{ id: "started", status: "running", detail }],
    };
    render();
  }

  async function runAutopilot(projectId, options = {}) {
    try {
      markEvolutionRunning(projectId, options.taskId ? "正在根据已批准任务启动自进化" : "正在启动高级自动模式");
      showToast("Autopilot 正在推进自进化链路");
      const result = await apiRequest(`/projects/${encodeURIComponent(projectId)}/autopilot`, {
        method: "POST",
        body: JSON.stringify({ autoRelease: true, mode: "advanced", requireApproved: true, ...options }),
      });
      state = {
        ...state,
        ...result.state,
        readiness: result.readiness,
        selectedProjectId: result.project.id,
        evolutionProgress: null,
        apiConnected: true,
      };
      saveUiState();
      render();
      const waitingTask = (result.actions || []).find((action) => action.id === "task" && action.status === "waiting");
      if (waitingTask) {
        showToast(waitingTask.detail || "没有可推进的已批准任务");
        return;
      }
      const progressed = (result.actions || []).filter((action) => !["waiting", "skipped"].includes(action.status)).length;
      showToast(`自进化已推进 ${progressed} 步`);
    } catch (error) {
      showToast(error.data?.error || "请先启动 API 服务");
    }
  }

  async function copyTextToClipboard(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
    } catch {
      showToast("当前浏览器不支持直接复制");
    }
  }

  async function copyProjectId(projectId) {
    await copyTextToClipboard(projectId, "Project ID 已复制");
  }

  async function copySdkKey(sdkKey) {
    await copyTextToClipboard(sdkKey, "API Key 已复制");
  }

  async function submitFeedbackSignal(text, source, options = {}) {
    const project = activeProject();
    const result = await apiRequest("/signals", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        sdkKey: projectSdkKey(project),
        type: "feedback",
        source,
        page: project.url,
        autopilot: options.autopilot === true,
        data: { text },
      }),
    });
    state = { ...state, ...result.state, selectedProjectId: project.id, apiConnected: true };
    if (options.showToast !== false) showToast("反馈已提交，点击“批准并开始进化”即可继续");
    return result;
  }

  async function addFeedbackFromForm(event) {
    event.preventDefault();
    const text = $("#feedbackText").value.trim();
    if (!text) {
      showToast("请输入反馈内容");
      return;
    }

    const source = $("#feedbackSource").value;
    try {
      await submitFeedbackSignal(text, source);
    } catch (error) {
      if (error.data?.error) {
        showToast(error.data.error);
        return;
      }
      const item = makeOfflineSignal(text, source);
      state.feedback.push(item);
      state.tasks.unshift(makeOfflineTask(item));
      addLocalLog(`离线归类新信号：${categoryLabel(item.category)} / ${item.severity}`);
      showToast("API 未连接，已写入离线演示队列");
    }

    $("#feedbackText").value = "";
    saveUiState();
    render();
  }

  function makeOfflineSignal(text, source) {
    const category = /报错|失败|按钮|无法|没有反应|500|支付/.test(text)
      ? "bug"
      : /慢|卡顿|加载|性能|首屏/.test(text)
        ? "performance"
        : /希望|功能|支持|建议|需要/.test(text)
          ? "request"
          : "support";
    const risk = /支付|登录|权限|数据|删除|500/.test(text) ? 3 : category === "support" ? 1 : 2;
    return {
      id: `offline-${Date.now()}`,
      projectId: activeProject().id,
      source,
      category,
      severity: risk === 3 ? "高" : risk === 2 ? "中" : "低",
      risk,
      confidence: 84,
      text,
      createdAt: new Date().toISOString(),
    };
  }

  function makeOfflineTask(signal) {
    return {
      id: `offline-task-${Date.now()}`,
      projectId: signal.projectId,
      title: `处理新信号：${signal.text.slice(0, 18)}`,
      summary: signal.text,
      category: signal.category,
      risk: signal.risk,
      confidence: signal.confidence,
      agent: signal.category === "request" ? "产品 Agent" : "开发 Agent",
      status: "待审批",
    };
  }

  async function generatePlanFromFeedback() {
    try {
      const project = activeProject();
      markEvolutionRunning(project.id, "正在提交反馈并启动高级自动模式");
      const pendingText = $("#feedbackText")?.value.trim() || "";
      const source = $("#feedbackSource")?.value || "控制台反馈";
      let submittedFeedback = false;
      if (pendingText) {
        await submitFeedbackSignal(pendingText, source, { showToast: false });
        $("#feedbackText").value = "";
        submittedFeedback = true;
      }
      const result = await apiRequest("/ai/analyze", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      const created = result.createdTasks?.length || 0;
      const approval = await apiRequest("/tasks/approve-safe", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id }),
      });
      state = { ...state, ...approval.state, apiConnected: true };
      const autopilot = await apiRequest(`/projects/${encodeURIComponent(project.id)}/autopilot`, {
        method: "POST",
        body: JSON.stringify({ autoRelease: true, mode: "advanced" }),
      });
      state = {
        ...state,
        ...autopilot.state,
        readiness: autopilot.readiness,
        selectedProjectId: project.id,
        evolutionProgress: null,
        apiConnected: true,
      };
      const progressed = (autopilot.actions || []).filter((action) => !["waiting", "skipped"].includes(action.status)).length;
      showToast(
        submittedFeedback
          ? `反馈已提交，自进化已推进 ${progressed} 步`
          : `AI 已归类 ${created} 个任务，自进化已推进 ${progressed} 步`,
      );
    } catch (error) {
      if (error.data?.error) {
        showToast(error.data.error);
        return;
      }
      addLocalLog("离线模式下无法调用 AI 分析 API");
      showToast("请先运行 `npm start` 启动 API");
    }
    render();
  }

  async function importSupportTickets() {
    const project = activeProject();
    const tickets = [
      {
        id: `support-${Date.now()}-1`,
        title: "支付失败",
        text: "用户反馈结账页点击支付后没有任何提示，重复三次仍然无法完成订单。",
        channel: "在线客服",
        page: `${project.url || ""}/checkout`,
        sentiment: "negative",
      },
      {
        id: `support-${Date.now()}-2`,
        title: "找不到常用地址",
        text: "多名用户询问是否能保存常用收货地址，避免每次重复填写。",
        channel: "客服工单",
        page: `${project.url || ""}/profile`,
        sentiment: "neutral",
      },
      {
        id: `support-${Date.now()}-3`,
        title: "页面加载慢",
        text: "移动端商品详情页打开很慢，用户以为页面卡死后直接离开。",
        channel: "邮件",
        page: `${project.url || ""}/products`,
        sentiment: "negative",
      },
    ];

    try {
      const result = await apiRequest("/import/support-tickets", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          projectName: project.name,
          source: "客服系统导入",
          tickets,
        }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`已导入 ${result.imported} 条客服工单`);
    } catch {
      tickets.forEach((ticket) => {
        const item = makeOfflineSignal(`${ticket.title}\n${ticket.text}`, "客服系统导入");
        state.feedback.push(item);
        state.tasks.unshift(makeOfflineTask(item));
      });
      addLocalLog(`离线导入 ${tickets.length} 条客服工单`);
      showToast("API 未连接，已导入离线演示工单");
    }
    render();
  }

  async function approveSafeTasks() {
    const project = activeProject();
    try {
      markEvolutionRunning(project.id, "正在批准低风险任务并启动高级自动模式");
      const result = await apiRequest("/tasks/approve-safe", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      const autopilot = await apiRequest(`/projects/${encodeURIComponent(project.id)}/autopilot`, {
        method: "POST",
        body: JSON.stringify({ autoRelease: true, mode: "advanced" }),
      });
      state = {
        ...state,
        ...autopilot.state,
        readiness: autopilot.readiness,
        selectedProjectId: project.id,
        evolutionProgress: null,
        apiConnected: true,
      };
      const progressed = (autopilot.actions || []).filter((action) => !["waiting", "skipped"].includes(action.status)).length;
      showToast(result.count ? `已批准 ${result.count} 个任务，自进化已推进 ${progressed} 步` : `自进化已推进 ${progressed} 步`);
    } catch (error) {
      showToast(error.data?.error || "请先启动 API 服务");
    }
    render();
  }

  async function advanceTask(taskId) {
    const currentTask = state.tasks.find((item) => item.id === taskId);
    if (currentTask?.status === "已批准") {
      await runAutopilot(currentTask.projectId, { taskId, requireApproved: true });
      return;
    }
    try {
      const result = await apiRequest(`/tasks/${encodeURIComponent(taskId)}/advance`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
    } catch {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.status === "已完成") return;
      const next = {
        待审批: "已批准",
        已批准: "构建中",
        构建中: "验证通过",
        验证通过: "发布中",
        已灰度: "已完成",
      }[task.status];
      task.status = next || task.status;
      addLocalLog(`离线推进任务：${task.title} -> ${task.status}`);
    }
    render();
  }

  async function promoteCanary() {
    try {
      const result = await apiRequest("/canary", {
        method: "POST",
        body: JSON.stringify({ projectId: activeProject().id, mode: state.mode }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("发布范围已扩大");
    } catch (error) {
      showToast(error.data?.error || "当前策略需要人工发布审批");
    }
    render();
  }

  async function connectExampleRepository() {
    const project = activeProject();
    try {
      const result = await apiRequest("/repositories/connect", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          projectName: project.name,
          provider: "GitHub",
          owner: "customer",
          name: project.id,
          defaultBranch: "main",
          url: `https://github.com/customer/${project.id}`,
        }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("示例仓库已连接");
    } catch {
      showToast("请先启动 API 服务");
    }
    render();
  }

  async function refreshGithubStatus() {
    try {
      const result = await apiRequest(`/github/status?projectId=${encodeURIComponent(activeProject().id)}`);
      state.github = result.github;
      state.apiConnected = true;
      showToast(`GitHub 模式：${result.github.mode}`);
    } catch (error) {
      showToast(error.data?.error || "刷新 GitHub 状态失败");
    }
    render();
  }

  async function validateGithubRepository(owner, name) {
    try {
      const result = await apiRequest("/github/repositories/validate", {
        method: "POST",
        body: JSON.stringify({ projectId: activeProject().id, owner, name }),
      });
      state.github = result.github;
      showToast(result.validation.ok ? "GitHub 仓库验证通过" : result.validation.reason);
    } catch (error) {
      showToast(error.data?.error || "GitHub 仓库验证失败");
    }
    render();
  }

  async function loadGithubRepositories() {
    try {
      const result = await apiRequest(`/github/repositories?projectId=${encodeURIComponent(activeProject().id)}`);
      state.github = result.github;
      state.githubRepositories = result.repositories || [];
      state.apiConnected = true;
      showToast(state.githubRepositories.length ? `已同步 ${state.githubRepositories.length} 个授权仓库` : result.message || "暂未同步到授权仓库");
    } catch (error) {
      showToast(error.data?.error || "同步授权仓库失败");
    }
    render();
  }

  async function connectGithubRepository(index) {
    const repo = projectAuthorizedGithubRepositories()[Number(index)] || {};
    const owner = repo.owner || repo.fullName?.split("/")?.[0];
    const name = repo.name || repo.fullName?.split("/")?.[1];
    if (!owner || !name) {
      showToast("授权仓库缺少 owner/name，无法连接");
      return;
    }
    try {
      const result = await apiRequest("/repositories/connect", {
        method: "POST",
        body: JSON.stringify({
          projectId: activeProject().id,
          provider: "GitHub",
          owner,
          name,
          defaultBranch: repo.defaultBranch || "main",
          url: repo.url || `https://github.com/${owner}/${name}`,
          githubInstallationId: repo.installationId,
        }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`已连接 ${owner}/${name}`);
    } catch (error) {
      showToast(error.data?.error || "连接授权仓库失败");
    }
    render();
  }

  async function generatePrDraft(taskId) {
    const repo = projectRepositories()[0];
    try {
      const result = await apiRequest("/pr-drafts", {
        method: "POST",
        body: JSON.stringify({
          projectId: activeProject().id,
          taskId,
          repositoryId: repo && repo.id,
        }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      switchView("integrations");
      showToast("已生成待发布改动");
    } catch (error) {
      showToast(error.data?.error || "生成待发布改动失败");
    }
    render();
  }

  async function advancePrDraft(draftId) {
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/advance`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("待发布改动状态已推进");
    } catch {
      showToast("推进待发布改动失败");
    }
    render();
  }

  async function generatePatchProposal(draftId) {
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/generate-patch`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      switchView("integrations");
      showToast("已生成代码改动");
    } catch (error) {
      showToast(error.data?.error || "生成代码改动失败");
    }
    render();
  }

  async function verifyPatchProposal(patchId) {
    try {
      const result = await apiRequest(`/patch-proposals/${encodeURIComponent(patchId)}/verify`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      switchView("integrations");
      showToast(`风险检查已完成：${qaDecisionLabel(result.validationReport.decision)}`);
    } catch (error) {
      showToast(error.data?.error || "风险检查失败");
    }
    render();
  }

  async function runSandboxForPatch(patchId) {
    try {
      const result = await apiRequest(`/patch-proposals/${encodeURIComponent(patchId)}/run-sandbox`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      switchView("integrations");
      showToast(`Sandbox Runner 已完成：${sandboxStatusLabel(result.sandboxRun.status)}`);
    } catch (error) {
      showToast(error.data?.error || "安全测试失败");
    }
    render();
  }

  async function applyPatchWorkspace(patchId) {
    try {
      const result = await apiRequest(`/patch-proposals/${encodeURIComponent(patchId)}/apply-workspace`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`补丁已应用到工作区：${result.patchApplication.changedFiles.length} 个文件`);
    } catch (error) {
      showToast(error.data?.error || "应用工作区补丁失败");
    }
    render();
  }

  async function runProductionSandbox(patchId) {
    try {
      const result = await apiRequest(`/patch-proposals/${encodeURIComponent(patchId)}/run-production-sandbox`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`真实环境测试已完成：${sandboxStatusLabel(result.productionSandboxRun.status)}`);
    } catch (error) {
      showToast(error.data?.error || "真实环境测试失败");
    }
    render();
  }

  async function createPreview(draftId) {
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/preview`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("预览环境已创建");
    } catch (error) {
      showToast(error.data?.error || "创建预览失败");
    }
    render();
  }

  async function createReleasePlanForDraft(draftId) {
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/release-plan`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`发布计划已创建：${result.releasePlan.phases.length} 个阶段`);
    } catch (error) {
      showToast(error.data?.error || "创建发布计划失败");
    }
    render();
  }

  async function promoteReleasePlan(releasePlanId) {
    try {
      const result = await apiRequest(`/release-plans/${encodeURIComponent(releasePlanId)}/promote`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(`发布范围已推进到 ${result.releasePlan.currentPhase}%`);
    } catch (error) {
      showToast(error.data?.error || "推进发布失败");
    }
    render();
  }

  async function rollbackReleasePlan(releasePlanId) {
    try {
      const result = await apiRequest(`/release-plans/${encodeURIComponent(releasePlanId)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ reason: "operator requested rollback" }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("发布已回滚");
    } catch (error) {
      showToast(error.data?.error || "回滚失败");
    }
    render();
  }

  async function openGithubPr(draftId) {
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/open-github`, { method: "POST" });
      state = { ...state, ...result.state, apiConnected: true };
      showToast(result.prDraft.status === "github_mock_opened" ? "未配置真实代码授权，已生成演示发布记录" : "发布记录已提交");
    } catch (error) {
      showToast(error.data?.error || "提交发布记录失败");
    }
    render();
  }

  async function approveManualReviewRelease(draftId) {
    const project = activeProject();
    try {
      markEvolutionRunning(project.id, "正在确认人工审核并继续上线");
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/approve-release`, {
        method: "POST",
        body: JSON.stringify({ note: "Approved from Itera AI console" }),
      });
      state = {
        ...state,
        ...result.state,
        readiness: result.readiness,
        selectedProjectId: project.id,
        evolutionProgress: null,
        apiConnected: true,
      };
      const blocked = (result.actions || []).find((action) => ["waiting", "blocked", "failed"].includes(action.status));
      showToast(blocked ? `已确认，但发布暂停：${blocked.detail || blocked.id}` : "已确认安全，系统已继续上线流程");
    } catch (error) {
      state.evolutionProgress = null;
      showToast(error.data?.error || "确认上线失败");
    }
    render();
  }

  async function rejectManualReviewChange(draftId) {
    if (!window.confirm("确定拒绝本次改动吗？拒绝后系统会保留记录，但不会继续上线。")) return;
    const project = activeProject();
    try {
      const result = await apiRequest(`/pr-drafts/${encodeURIComponent(draftId)}/reject-change`, {
        method: "POST",
        body: JSON.stringify({ reason: "Rejected from Itera AI console" }),
      });
      state = {
        ...state,
        ...result.state,
        readiness: result.readiness,
        selectedProjectId: project.id,
        evolutionProgress: null,
        apiConnected: true,
      };
      showToast("已拒绝本次改动，系统不会继续上线");
    } catch (error) {
      showToast(error.data?.error || "拒绝改动失败");
    }
    render();
  }

  function startRun(type = $("#runType").value) {
    if (runTimer) {
      showToast("已有 Agent 运行中");
      return;
    }

    switchView("agents");
    runningIndex = 0;
    addLocalLog(`启动 ${runName(type)}`);
    render();

    runTimer = window.setInterval(async () => {
      addLocalLog(`${agentForStep(runningIndex)} 完成：${pipeline[runningIndex]}`);
      runningIndex += 1;

      if (runningIndex >= pipeline.length) {
        window.clearInterval(runTimer);
        runTimer = null;
        runningIndex = pipeline.length;
        await completeRun(type);
      }

      render();
    }, 650);
  }

  function runName(type) {
    return {
      full: "完整自迭代巡检",
      qa: "可用性检查",
      product: "产品需求归纳",
      release: "发布后回归",
    }[type];
  }

  async function completeRun(type) {
    try {
      const result = await apiRequest("/agent-runs", {
        method: "POST",
        body: JSON.stringify({ projectId: activeProject().id, type }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("Agent 运行完成，已写入数据库");
    } catch {
      addLocalLog(`${runName(type)} 已完成，但 API 未连接`);
      showToast("Agent 运行完成，当前为离线模拟");
    }
  }

  async function exportSnapshot() {
    let snapshot;
    try {
      snapshot = await apiRequest(`/snapshot?projectId=${encodeURIComponent(activeProject().id)}`);
    } catch {
      snapshot = {
        exportedAt: new Date().toISOString(),
        project: activeProject(),
        signals: projectFeedback(),
        tasks: projectTasks(),
        policy: state.policy,
      };
    }
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeProject().id}-iteration-snapshot.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("快照已导出");
  }

  async function copySdkSnippet() {
    const text = $("#sdkSnippet").textContent;
    await copyTextToClipboard(text, "嵌入代码已复制");
    const project = activeProject();
    if (project.id) {
      state.copiedSnippetProjectId = project.id;
      saveUiState();
      render();
    }
  }

  async function handleGuideAction(action) {
    const project = activeProject();
    if (action === "focus-form") {
      $("#newProjectName").focus();
      showToast("先填写产品名称和网站网址");
      return;
    }
    if (action === "copy-snippet") {
      await copySdkSnippet();
      return;
    }
    if (action === "test-signal") {
      if (!project.id) {
        showToast("请先创建项目");
        return;
      }
      await testSdkConnection(project.id);
      return;
    }
    if (action === "run-autopilot") {
      if (!project.id) {
        showToast("请先创建项目");
        return;
      }
      await runAutopilot(project.id);
    }
  }

  async function refreshProductionStatus() {
    try {
      const result = await apiRequest("/production/status");
      state.productionStatus = result.production;
      await refreshGithubSetup(false);
      await refreshSandboxSetup(false);
      await refreshBillingSetup(false);
      showToast("生产检查已刷新");
    } catch (error) {
      showToast(error.data?.error || "生产检查刷新失败");
    }
    render();
  }

  async function saveDeploymentConfig(event) {
    event.preventDefault();
    const publicBaseUrl = $("#publicBaseUrlInput").value.trim();
    try {
      const result = await apiRequest("/platform/config", {
        method: "PATCH",
        body: JSON.stringify({ publicBaseUrl }),
      });
      state.productionStatus = result.production;
      await refreshGithubSetup(false);
      await refreshSandboxSetup(false);
      await refreshBillingSetup(false);
      showToast(publicBaseUrl ? "公网域名已保存" : "公网域名已清空");
    } catch (error) {
      showToast(error.data?.error || "保存公网域名失败");
    }
    render();
  }

  async function validateAiProviderSetup() {
    try {
      const result = await apiRequest("/ai/validate", { method: "POST" });
      state.aiProvider = result.aiProvider || state.aiProvider;
      state.productionStatus = result.production || state.productionStatus;
      aiProviderDraft = null;
      forceRenderAiProviderPanel = true;
      renderAfterEditing = false;
      showToast(result.validation?.message || (result.validation?.ok ? "AI API 验证通过" : "AI API 仍需配置"));
    } catch (error) {
      showToast(error.data?.error || "AI API 验证失败");
    }
    render();
  }

  async function saveAiProviderConfig(event) {
    event.preventDefault();
    rememberAiProviderDraft();
    const body = {
      baseUrl: (aiProviderDraft?.baseUrl || "").trim(),
      model: (aiProviderDraft?.model || "").trim(),
      apiKey: (aiProviderDraft?.apiKey || "").trim(),
      proxyUrl: (aiProviderDraft?.proxyUrl || "").trim(),
      temperature: Number(aiProviderDraft?.temperature || 0.2),
      clearApiKey: Boolean(aiProviderDraft?.clearApiKey),
    };
    try {
      const result = await apiRequest("/ai/config", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      state.aiProvider = result.aiProvider || state.aiProvider;
      state.productionStatus = result.production || state.productionStatus;
      aiProviderDraft = null;
      forceRenderAiProviderPanel = true;
      renderAfterEditing = false;
      const savedProvider = result.aiProvider || {};
      if (savedProvider.configured) {
        showToast("AI API 已接入");
      } else if (!savedProvider.apiKeyConfigured) {
        showToast("已保存地址和模型，但还缺 API Key");
      } else {
        showToast("AI API 配置已保存，但仍需补全配置");
      }
    } catch (error) {
      showToast(error.data?.error || "保存 AI API 配置失败");
    }
    render();
  }

  async function copyAiProviderEnv() {
    const text = $("#aiProviderEnvTemplate")?.textContent || [
      "AI_API_BASE_URL=https://api.openai.com/v1",
      "AI_API_KEY=your-api-key",
      "AI_MODEL=gpt-4.1-mini",
      "AI_TEMPERATURE=0.2",
      "AI_HTTP_PROXY=",
    ].join("\n");
    await copyTextToClipboard(text, "AI API 环境变量已复制");
  }

  async function refreshGithubSetup(showMessage = true) {
    const project = activeProject();
    if (!project.id) return;
    try {
      const result = await apiRequest(`/github/setup?projectId=${encodeURIComponent(project.id)}`);
      state.githubSetup = result.setup || state.githubSetup;
      if (showMessage) showToast("GitHub 授权状态已刷新");
    } catch (error) {
      if (showMessage) showToast(error.data?.error || "GitHub 授权状态刷新失败");
    }
    render();
  }

  async function validateGithubSetup() {
    const project = activeProject();
    if (!project.id) {
      showToast("请先创建项目");
      return;
    }
    try {
      const result = await apiRequest("/github/setup/validate", {
        method: "POST",
        body: JSON.stringify({ projectId: project.id }),
      });
      state.githubSetup = result.setup || state.githubSetup;
      showToast(result.validation?.message || (result.validation?.ok ? "GitHub 授权验证通过" : "GitHub 授权仍需配置"));
    } catch (error) {
      showToast(error.data?.error || "GitHub 授权验证失败");
    }
    render();
  }

  async function copyGithubSetupEnv() {
    const text = $("#githubSetupEnvTemplate")?.textContent || state.githubSetup?.envTemplate || "";
    await copyTextToClipboard(text, "GitHub 环境变量已复制");
  }

  async function copyGithubSetupUrl(targetId) {
    const text = document.getElementById(targetId)?.textContent || "";
    await copyTextToClipboard(text, "GitHub URL 已复制");
  }

  async function refreshSandboxSetup(showMessage = true) {
    try {
      const result = await apiRequest("/sandbox/setup");
      state.sandboxSetup = result.setup || state.sandboxSetup;
      if (showMessage) showToast("沙箱状态已刷新");
    } catch (error) {
      if (showMessage) showToast(error.data?.error || "沙箱状态刷新失败");
    }
    render();
  }

  async function validateSandboxSetup() {
    try {
      const result = await apiRequest("/sandbox/setup/validate", { method: "POST" });
      state.sandboxSetup = result.setup || state.sandboxSetup;
      showToast(result.validation?.message || (result.validation?.ok ? "安全测试环境验证通过" : "安全测试环境仍需配置"));
    } catch (error) {
      showToast(error.data?.error || "安全测试环境验证失败");
    }
    render();
  }

  async function copySandboxSetupEnv() {
    const text = $("#sandboxSetupEnvTemplate")?.textContent || state.sandboxSetup?.envTemplate || "";
    await copyTextToClipboard(text, "沙箱环境变量已复制");
  }

  async function refreshBillingSetup(showMessage = true) {
    try {
      const result = await apiRequest("/billing/setup");
      state.billingSetup = result.setup || state.billingSetup;
      if (showMessage) showToast("计费状态已刷新");
    } catch (error) {
      if (showMessage) showToast(error.data?.error || "计费状态刷新失败");
    }
    render();
  }

  async function validateBillingSetup() {
    try {
      const result = await apiRequest("/billing/setup/validate", { method: "POST" });
      state.billingSetup = result.setup || state.billingSetup;
      showToast(result.validation?.message || (result.validation?.ok ? "计费验证通过" : "计费仍需配置"));
    } catch (error) {
      showToast(error.data?.error || "计费验证失败");
    }
    render();
  }

  async function copyBillingSetupEnv() {
    const text = $("#billingSetupEnvTemplate")?.textContent || state.billingSetup?.envTemplate || "";
    await copyTextToClipboard(text, "计费环境变量已复制");
  }

  async function copyBillingSetupUrl(targetId) {
    const text = document.getElementById(targetId)?.textContent || "";
    await copyTextToClipboard(text, "计费 URL 已复制");
  }

  async function openBillingPortal() {
    try {
      const result = await apiRequest("/billing/portal", { method: "POST" });
      const portalUrl = result.portal?.url || "";
      if (!portalUrl) {
        showToast("Stripe portal did not return a URL");
        return;
      }
      window.open(portalUrl, "_blank", "noopener");
      showToast("Stripe portal opened");
    } catch (error) {
      showToast(error.data?.error || "Stripe portal is not ready");
    }
  }

  async function copyProductionEnvTemplate() {
    await copyTextToClipboard(productionEnvTemplate(), "生产环境变量模板已复制");
  }

  async function savePolicy() {
    state.policy.autoPr = $("#policyPr").checked;
    state.policy.autoCanary = $("#policyCanary").checked;
    state.policy.autoMerge = $("#policyCanary").checked;
    state.policy.riskLimit = Number($("#riskLimit").value);
    state.policy.confidenceLimit = Number($("#confidenceLimit").value);

    try {
      const result = await apiRequest("/policy", {
        method: "PATCH",
        body: JSON.stringify({ ...state.policy, projectId: activeProject().id }),
      });
      state = { ...state, ...result.state, apiConnected: true };
      showToast("策略已保存到 API");
    } catch {
      showToast("策略已保存到离线状态");
    }
    render();
  }

  function bindEvents() {
    $$(".nav-item").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    $$("[data-jump]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.jump));
    });
    $("#projectSelect").addEventListener("change", async (event) => {
      await switchProject(event.target.value);
    });
    $("#activityBanner").addEventListener("click", (event) => {
      const refreshButton = event.target.closest("[data-refresh-state]");
      if (refreshButton) {
        refreshState(true);
        return;
      }
      const switchButton = event.target.closest("[data-switch-project]");
      if (switchButton) {
        switchProject(switchButton.dataset.switchProject, "iterations");
        return;
      }
      const jumpButton = event.target.closest("[data-jump]");
      if (!jumpButton) return;
      switchView(jumpButton.dataset.jump);
    });
    $$(".segmented [data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        saveUiState();
        render();
      });
    });
    $("#feedbackForm").addEventListener("submit", addFeedbackFromForm);
    $("#projectForm").addEventListener("submit", createProjectFromForm);
    $("#importSupportBtn").addEventListener("click", importSupportTickets);
    $("#clusterFeedbackBtn").addEventListener("click", generatePlanFromFeedback);
    $("#planFromFeedbackBtn").addEventListener("click", generatePlanFromFeedback);
    $("#approveSafeBtn").addEventListener("click", approveSafeTasks);
    $("#promoteCanaryBtn").addEventListener("click", promoteCanary);
    $("#runInspectionBtn").addEventListener("click", () => startRun("qa"));
    $("#startRunBtn").addEventListener("click", () => startRun());
    $("#clearLogBtn").addEventListener("click", () => {
      state.log = [];
      render();
    });
    $("#exportSnapshotBtn").addEventListener("click", exportSnapshot);
    $("#copySdkBtn").addEventListener("click", copySdkSnippet);
    $("#firstRunGuide").addEventListener("click", (event) => {
      const guideButton = event.target.closest("[data-guide-action]");
      if (!guideButton) return;
      handleGuideAction(guideButton.dataset.guideAction);
    });
    $("#accountMenu").addEventListener("click", (event) => {
      const openButton = event.target.closest("[data-open-auth]");
      if (openButton) {
        openAuthModal(openButton.dataset.openAuth || "login");
        return;
      }
      const logoutButton = event.target.closest("[data-auth-logout]");
      if (!logoutButton) return;
      logoutAuth();
    });
    $("#authForm").addEventListener("submit", submitAuthForm);
    $("#authModeTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-auth-mode]");
      if (!button) return;
      switchAuthMode(button.dataset.authMode);
    });
    $("#authCloseBtn").addEventListener("click", closeAuthModal);
    $("#authCancelBtn").addEventListener("click", closeAuthModal);
    $("#authModal").addEventListener("click", (event) => {
      if (event.target.id === "authModal") closeAuthModal();
    });
    $("#connectRepoBtn").addEventListener("click", connectExampleRepository);
    $("#repoList").addEventListener("click", (event) => {
      const refreshButton = event.target.closest("[data-github-refresh]");
      if (refreshButton) {
        refreshGithubStatus();
        return;
      }
      const loadReposButton = event.target.closest("[data-github-load-repos]");
      if (loadReposButton) {
        loadGithubRepositories();
        return;
      }
      const connectButton = event.target.closest("[data-github-connect-index]");
      if (connectButton) {
        connectGithubRepository(connectButton.dataset.githubConnectIndex);
        return;
      }
      const validateButton = event.target.closest("[data-github-validate]");
      if (!validateButton) return;
      const [owner, name] = validateButton.dataset.githubValidate.split("/");
      validateGithubRepository(owner, name);
    });
    $("#projectAccessPanel").addEventListener("click", (event) => {
      const refreshButton = event.target.closest("[data-github-refresh]");
      if (refreshButton) {
        refreshGithubStatus();
        return;
      }
      const loadReposButton = event.target.closest("[data-github-load-repos]");
      if (loadReposButton) {
        loadGithubRepositories();
        return;
      }
      const connectButton = event.target.closest("[data-github-connect-index]");
      if (connectButton) {
        connectGithubRepository(connectButton.dataset.githubConnectIndex);
        return;
      }
      const goViewButton = event.target.closest("[data-go-view]");
      if (goViewButton) {
        switchView(goViewButton.dataset.goView);
        return;
      }
      const copyButton = event.target.closest("[data-copy-project-id]");
      if (copyButton) {
        copyProjectId(copyButton.dataset.copyProjectId);
        return;
      }
      const copySdkButton = event.target.closest("[data-copy-sdk-key]");
      if (copySdkButton) {
        copySdkKey(copySdkButton.dataset.copySdkKey);
        return;
      }
      const copyTenantButton = event.target.closest("[data-copy-tenant-key]");
      if (copyTenantButton) {
        copyToClipboard(copyTenantButton.dataset.copyTenantKey || "");
        showToast("后台访问 Key 已复制");
        return;
      }
      const rotateTenantButton = event.target.closest("[data-rotate-tenant-key]");
      if (rotateTenantButton) {
        rotateTenantKey();
        return;
      }
      const saveWebhookButton = event.target.closest("[data-save-output-webhook]");
      if (saveWebhookButton) {
        saveOutputWebhook(saveWebhookButton.dataset.saveOutputWebhook);
        return;
      }
      const testWebhookButton = event.target.closest("[data-test-output-webhook]");
      if (testWebhookButton) {
        testOutputWebhook(testWebhookButton.dataset.testOutputWebhook);
        return;
      }
      const saveDeploymentHookButton = event.target.closest("[data-save-deployment-hook]");
      if (saveDeploymentHookButton) {
        saveDeploymentHook(saveDeploymentHookButton.dataset.saveDeploymentHook);
        return;
      }
      const testDeploymentHookButton = event.target.closest("[data-test-deployment-hook]");
      if (testDeploymentHookButton) {
        testDeploymentHook(testDeploymentHookButton.dataset.testDeploymentHook);
        return;
      }
      const testButton = event.target.closest("[data-test-sdk-connection]");
      if (testButton) {
        testSdkConnection(testButton.dataset.testSdkConnection);
        return;
      }
      const rotateButton = event.target.closest("[data-rotate-sdk-key]");
      if (!rotateButton) return;
      rotateSdkKey(rotateButton.dataset.rotateSdkKey);
    });
    $("#readinessPanel").addEventListener("click", (event) => {
      const autopilotButton = event.target.closest("[data-run-autopilot]");
      if (!autopilotButton) return;
      runAutopilot(autopilotButton.dataset.runAutopilot);
    });
    $("#feedbackFilters").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      state.feedbackFilter = button.dataset.filter;
      saveUiState();
      render();
    });
    $("#overviewQueue").addEventListener("click", (event) => {
      const switchButton = event.target.closest("[data-switch-project]");
      if (!switchButton) return;
      switchProject(switchButton.dataset.switchProject, "tasks");
    });
    $("#iterationTable").addEventListener("click", (event) => {
      const switchButton = event.target.closest("[data-switch-project]");
      if (switchButton) {
        switchProject(switchButton.dataset.switchProject, "tasks");
        return;
      }
      const prButton = event.target.closest("[data-pr-draft]");
      if (prButton) {
        generatePrDraft(prButton.dataset.prDraft);
        return;
      }
      const button = event.target.closest("[data-task-action]");
      if (!button) return;
      advanceTask(button.dataset.taskAction);
    });
    $("#prDraftList").addEventListener("click", (event) => {
      const approveButton = event.target.closest("[data-review-approve]");
      if (approveButton) {
        approveManualReviewRelease(approveButton.dataset.reviewApprove);
        return;
      }
      const rejectButton = event.target.closest("[data-review-reject]");
      if (rejectButton) {
        rejectManualReviewChange(rejectButton.dataset.reviewReject);
        return;
      }
      const patchButton = event.target.closest("[data-pr-generate-patch]");
      if (patchButton) {
        generatePatchProposal(patchButton.dataset.prGeneratePatch);
        return;
      }
      const githubButton = event.target.closest("[data-pr-open-github]");
      if (githubButton) {
        openGithubPr(githubButton.dataset.prOpenGithub);
        return;
      }
      const button = event.target.closest("[data-pr-advance]");
      if (!button) return;
      advancePrDraft(button.dataset.prAdvance);
    });
    $("#evolutionRunPanel").addEventListener("click", (event) => {
      const approveButton = event.target.closest("[data-review-approve]");
      if (approveButton) {
        approveManualReviewRelease(approveButton.dataset.reviewApprove);
        return;
      }
      const rejectButton = event.target.closest("[data-review-reject]");
      if (!rejectButton) return;
      rejectManualReviewChange(rejectButton.dataset.reviewReject);
    });
    $("#patchProposalPanel").addEventListener("click", (event) => {
      const verifyButton = event.target.closest("[data-patch-verify]");
      if (verifyButton) {
        verifyPatchProposal(verifyButton.dataset.patchVerify);
        return;
      }
      const sandboxButton = event.target.closest("[data-patch-run-sandbox]");
      if (!sandboxButton) return;
      runSandboxForPatch(sandboxButton.dataset.patchRunSandbox);
    });
    $("#productionOpsPanel").addEventListener("click", (event) => {
      const applyButton = event.target.closest("[data-patch-apply-workspace]");
      if (applyButton) {
        applyPatchWorkspace(applyButton.dataset.patchApplyWorkspace);
        return;
      }
      const prodSandboxButton = event.target.closest("[data-patch-run-production-sandbox]");
      if (prodSandboxButton) {
        runProductionSandbox(prodSandboxButton.dataset.patchRunProductionSandbox);
        return;
      }
      const previewButton = event.target.closest("[data-pr-create-preview]");
      if (previewButton) {
        createPreview(previewButton.dataset.prCreatePreview);
        return;
      }
      const releaseButton = event.target.closest("[data-pr-create-release-plan]");
      if (releaseButton) {
        createReleasePlanForDraft(releaseButton.dataset.prCreateReleasePlan);
        return;
      }
      const promoteButton = event.target.closest("[data-release-promote]");
      if (promoteButton) {
        promoteReleasePlan(promoteButton.dataset.releasePromote);
        return;
      }
      const rollbackButton = event.target.closest("[data-release-rollback]");
      if (!rollbackButton) return;
      rollbackReleasePlan(rollbackButton.dataset.releaseRollback);
    });
    $("#riskLimit").addEventListener("input", (event) => {
      state.policy.riskLimit = Number(event.target.value);
      renderPolicy();
    });
    $("#confidenceLimit").addEventListener("input", (event) => {
      state.policy.confidenceLimit = Number(event.target.value);
      renderPolicy();
    });
    $("#policyPr").addEventListener("change", (event) => {
      state.policy.autoPr = event.target.checked;
    });
    $("#policyCanary").addEventListener("change", (event) => {
      state.policy.autoCanary = event.target.checked;
      state.policy.autoMerge = event.target.checked;
    });
    $("#savePolicyBtn").addEventListener("click", savePolicy);
    $("#refreshProductionBtn").addEventListener("click", refreshProductionStatus);
    $("#copyProductionEnvBtn").addEventListener("click", copyProductionEnvTemplate);
    $("#deploymentConfigForm").addEventListener("submit", saveDeploymentConfig);
    $("#aiProviderSetupPanel").addEventListener("submit", (event) => {
      if (event.target.closest("#aiProviderConfigForm")) saveAiProviderConfig(event);
    });
    $("#aiProviderSetupPanel").addEventListener("input", (event) => {
      if (!event.target.closest("#aiProviderConfigForm")) return;
      rememberAiProviderDraft();
    });
    $("#aiProviderSetupPanel").addEventListener("change", (event) => {
      if (!event.target.closest("#aiProviderConfigForm")) return;
      rememberAiProviderDraft();
    });
    $("#aiProviderSetupPanel").addEventListener("click", (event) => {
      const validateButton = event.target.closest("[data-validate-ai-provider]");
      if (validateButton) {
        if (aiProviderDraft) {
          showToast("请先保存 AI 配置，再验证 API");
          return;
        }
        validateAiProviderSetup();
        return;
      }
      const envButton = event.target.closest("[data-copy-ai-provider-env]");
      if (!envButton) return;
      copyAiProviderEnv();
    });
    $("#githubSetupPanel").addEventListener("click", (event) => {
      const validateButton = event.target.closest("[data-validate-github-setup]");
      if (validateButton) {
        validateGithubSetup();
        return;
      }
      const envButton = event.target.closest("[data-copy-github-setup-env]");
      if (envButton) {
        copyGithubSetupEnv();
        return;
      }
      const urlButton = event.target.closest("[data-copy-github-url]");
      if (!urlButton) return;
      copyGithubSetupUrl(urlButton.dataset.copyGithubUrl);
    });
    $("#sandboxSetupPanel").addEventListener("click", (event) => {
      const validateButton = event.target.closest("[data-validate-sandbox-setup]");
      if (validateButton) {
        validateSandboxSetup();
        return;
      }
      const envButton = event.target.closest("[data-copy-sandbox-env]");
      if (!envButton) return;
      copySandboxSetupEnv();
    });
    $("#billingSetupPanel").addEventListener("click", (event) => {
      const validateButton = event.target.closest("[data-validate-billing-setup]");
      if (validateButton) {
        validateBillingSetup();
        return;
      }
      const envButton = event.target.closest("[data-copy-billing-env]");
      if (envButton) {
        copyBillingSetupEnv();
        return;
      }
      const portalButton = event.target.closest("[data-open-billing-portal]");
      if (portalButton) {
        openBillingPortal();
        return;
      }
      const urlButton = event.target.closest("[data-copy-billing-url]");
      if (!urlButton) return;
      copyBillingSetupUrl(urlButton.dataset.copyBillingUrl);
    });
    $("#deploymentUrlGrid").addEventListener("click", (event) => {
      const button = event.target.closest("[data-copy-deploy-url]");
      if (!button) return;
      const target = document.getElementById(button.dataset.copyDeployUrl);
      copyTextToClipboard(target?.textContent || "", "部署 URL 已复制");
    });
  }

  bindEvents();
  render();
  refreshState(true).then(() => {
    if (!initialGithubInstalled) return;
    showToast("GitHub App 安装已绑定，正在同步授权仓库");
    loadGithubRepositories();
  });
  startRealtimeRefresh();
})();
