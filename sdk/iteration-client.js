(function () {
  const bootstrapScript = document.currentScript;
  const DEFAULTS = {
    projectId: "",
    projectName: "",
    sdkKey: "",
    endpoint: "/api/signals",
    enableFeedbackWidget: true,
    captureErrors: true,
    capturePerformance: true,
    captureApiFailures: true,
    captureRageClicks: true,
    userId: null,
    release: null,
  };

  let config = null;
  let widget = null;
  let originalFetch = null;
  let originalXhrOpen = null;
  let originalXhrSend = null;
  let lastClicks = [];
  let sentVitals = {};
  const WIDGET_STYLE = `
      .itera-ai-widget {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        font-family: Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
      }
      .itera-ai-panel {
        width: min(360px, calc(100vw - 36px));
        margin-bottom: 10px;
        padding: 12px;
        color: #17212b;
        background: #ffffff;
        border: 1px solid #dbe2ea;
        border-radius: 8px;
        box-shadow: 0 18px 40px rgba(31, 41, 55, 0.18);
      }
      .itera-ai-title {
        display: block;
        margin-bottom: 10px;
        font-weight: 700;
      }
      .itera-ai-grid {
        display: grid;
        gap: 8px;
      }
      .itera-ai-grid label {
        display: grid;
        gap: 5px;
        color: #677586;
        font-size: 12px;
      }
      .itera-ai-grid select,
      .itera-ai-grid input,
      .itera-ai-grid textarea {
        width: 100%;
        min-height: 34px;
        padding: 8px 9px;
        color: #17212b;
        background: #ffffff;
        border: 1px solid #c7d0da;
        border-radius: 8px;
        font: inherit;
        box-sizing: border-box;
      }
      .itera-ai-grid textarea {
        min-height: 98px;
        resize: vertical;
      }
      .itera-ai-row {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
      }
      .itera-ai-button {
        min-height: 36px;
        padding: 0 12px;
        border: 1px solid #174fab;
        border-radius: 8px;
        color: #ffffff;
        background: #1d5fd1;
        font: inherit;
        cursor: pointer;
      }
      .itera-ai-button:disabled {
        opacity: 0.64;
        cursor: wait;
      }
      .itera-ai-button.secondary {
        color: #17212b;
        background: #f7f9fb;
        border-color: #dbe2ea;
      }
      .itera-ai-status {
        min-height: 18px;
        margin-top: 8px;
        color: #5d6978;
        font-size: 12px;
        line-height: 1.45;
      }
      .itera-ai-status[data-tone="success"] {
        color: #147043;
      }
      .itera-ai-status[data-tone="error"] {
        color: #b42318;
      }
      .itera-ai-trigger {
        min-width: 118px;
        min-height: 40px;
        border-radius: 8px;
        border: 1px solid #174fab;
        color: #ffffff;
        background: #1d5fd1;
        box-shadow: 0 12px 26px rgba(29, 95, 209, 0.24);
        font: inherit;
        cursor: pointer;
      }
      .itera-ai-hidden {
        display: none;
      }
    `;

  function now() {
    return new Date().toISOString();
  }

  function safeUrl(value) {
    try {
      return new URL(value, location.href).href;
    } catch {
      return String(value || "");
    }
  }

  function endpointUrl() {
    return safeUrl(config && config.endpoint);
  }

  function endpointFromScript(script) {
    if (!script || !script.src) return DEFAULTS.endpoint;
    try {
      return new URL("/api/signals", script.src).href;
    } catch {
      return DEFAULTS.endpoint;
    }
  }

  function readScriptConfig(script) {
    if (!script || !script.dataset) return null;
    const data = script.dataset;
    const sdkKey = data.key || data.sdkKey || data.apiKey || "";
    if (!sdkKey && !data.projectId) return null;
    return {
      projectId: data.projectId || "",
      projectName: data.projectName || "",
      sdkKey,
      endpoint: data.endpoint || endpointFromScript(script),
      enableFeedbackWidget: data.feedbackWidget !== "false",
      captureErrors: data.captureErrors !== "false",
      capturePerformance: data.capturePerformance !== "false",
      captureApiFailures: data.captureApiFailures !== "false",
      captureRageClicks: data.captureRageClicks !== "false",
      userId: data.userId || null,
      release: data.release || null,
    };
  }

  function shouldIgnoreUrl(url) {
    return !url || safeUrl(url) === endpointUrl();
  }

  function baseContext() {
    return {
      title: document.title,
      referrer: document.referrer,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      screen: {
        width: window.screen && window.screen.width,
        height: window.screen && window.screen.height,
      },
      connection:
        navigator.connection && {
          effectiveType: navigator.connection.effectiveType,
          downlink: navigator.connection.downlink,
          rtt: navigator.connection.rtt,
        },
    };
  }

  function payload(type, data) {
    return {
      type,
      projectId: config.projectId,
      projectName: config.projectName,
      sdkKey: config.sdkKey,
      userId: config.userId,
      release: config.release,
      page: location.href,
      userAgent: navigator.userAgent,
      createdAt: now(),
      data: Object.assign({ context: baseContext() }, data || {}),
    };
  }

  function send(type, data, options) {
    if (!config || !config.endpoint || (!config.projectId && !config.sdkKey)) return Promise.resolve(false);
    const sendOptions = options || {};
    const body = JSON.stringify(payload(type, data));

    if (sendOptions.beacon !== false && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(config.endpoint, new Blob([body], { type: "application/json" }));
      if (ok) return Promise.resolve(true);
    }

    return fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Itera-SDK-Key": config.sdkKey || "",
      },
      body,
      keepalive: true,
    })
      .then(function (response) {
        return response.ok;
      })
      .catch(function () {
        return false;
      });
  }

  function injectStyle() {
    if (document.getElementById("itera-ai-widget-style")) return;
    const style = document.createElement("style");
    style.id = "itera-ai-widget-style";
    style.textContent = WIDGET_STYLE;
    document.head.appendChild(style);
  }

  function createWidget() {
    if (widget) return;
    widget = document.createElement("div");
    widget.setAttribute("data-itera-widget-host", "");
    const root = widget.attachShadow ? widget.attachShadow({ mode: "open" }) : widget;
    if (root === widget) injectStyle();
    if (root !== widget) {
      const style = document.createElement("style");
      style.textContent = WIDGET_STYLE;
      root.appendChild(style);
    }
    const container = document.createElement("div");
    container.className = "itera-ai-widget";
    container.innerHTML = `
      <div class="itera-ai-panel itera-ai-hidden" data-panel>
        <strong class="itera-ai-title">反馈给产品团队</strong>
        <div class="itera-ai-grid">
          <label>
            类型
            <select data-type>
              <option value="bug">遇到问题</option>
              <option value="request">功能建议</option>
              <option value="confusing">不好理解</option>
              <option value="praise">体验不错</option>
            </select>
          </label>
          <label>
            体验评分
            <select data-rating>
              <option value="5">5 - 很顺畅</option>
              <option value="4">4 - 基本可用</option>
              <option value="3">3 - 有点卡住</option>
              <option value="2">2 - 很不顺</option>
              <option value="1">1 - 无法完成</option>
            </select>
          </label>
          <label>
            反馈内容
            <textarea data-text placeholder="请描述你遇到的问题、想要的功能，或当时正在做什么。"></textarea>
          </label>
          <label>
            联系方式，可选
            <input data-contact placeholder="邮箱 / 手机 / 用户 ID" />
          </label>
        </div>
        <div class="itera-ai-status" data-status aria-live="polite"></div>
        <div class="itera-ai-row">
          <button class="itera-ai-button secondary" data-close type="button">取消</button>
          <button class="itera-ai-button" data-send type="button">发送反馈</button>
        </div>
      </div>
      <button class="itera-ai-trigger" data-open type="button">反馈</button>
    `;
    root.appendChild(container);
    document.body.appendChild(widget);

    const panel = root.querySelector("[data-panel]");
    const text = root.querySelector("[data-text]");
    const type = root.querySelector("[data-type]");
    const rating = root.querySelector("[data-rating]");
    const contact = root.querySelector("[data-contact]");
    const status = root.querySelector("[data-status]");
    const sendButton = root.querySelector("[data-send]");

    function setStatus(message, tone) {
      status.textContent = message || "";
      if (tone) status.setAttribute("data-tone", tone);
      else status.removeAttribute("data-tone");
    }

    root.querySelector("[data-open]").addEventListener("click", function () {
      panel.classList.toggle("itera-ai-hidden");
      setStatus("", "");
      text.focus();
    });
    root.querySelector("[data-close]").addEventListener("click", function () {
      panel.classList.add("itera-ai-hidden");
    });
    sendButton.addEventListener("click", function () {
      const value = text.value.trim();
      if (!value) {
        setStatus("请先填写反馈内容。", "error");
        text.focus();
        return;
      }
      sendButton.disabled = true;
      sendButton.textContent = "发送中...";
      setStatus("正在提交到自进化平台...", "");
      send("feedback", {
        text: value,
        feedbackType: type.value,
        rating: Number(rating.value),
        contact: contact.value.trim() || null,
      }, { beacon: false }).then(function (ok) {
        if (!ok) {
          setStatus("发送失败：请确认自进化平台正在运行，或稍后重试。", "error");
          return;
        }
        text.value = "";
        contact.value = "";
        setStatus("已提交，产品团队会在自进化平台看到这条反馈。", "success");
        window.setTimeout(function () {
          panel.classList.add("itera-ai-hidden");
          setStatus("", "");
        }, 700);
      }).finally(function () {
        sendButton.disabled = false;
        sendButton.textContent = "发送反馈";
      });
    });
  }

  function captureErrors() {
    window.addEventListener("error", function (event) {
      send("client_error", {
        text: event.message,
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error && event.error.stack,
      });
    });

    window.addEventListener("unhandledrejection", function (event) {
      const reason = event.reason || {};
      send("unhandled_rejection", {
        text: reason.message || String(reason),
        message: reason.message || String(reason),
        stack: reason.stack,
      });
    });
  }

  function capturePerformance() {
    window.addEventListener("load", function () {
      window.setTimeout(function () {
        const navigation = performance.getEntriesByType("navigation")[0];
        const paint = performance.getEntriesByType("paint");
        send("performance", {
          text: "页面加载性能采样",
          loadTime: navigation ? Math.round(navigation.loadEventEnd) : null,
          domContentLoaded: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
          transferSize: navigation ? navigation.transferSize : null,
          paints: paint.map(function (entry) {
            return { name: entry.name, startTime: Math.round(entry.startTime) };
          }),
        });
      }, 0);
    });

    if ("PerformanceObserver" in window) {
      try {
        const observer = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (entry.entryType === "largest-contentful-paint") {
              sendVital("lcp", Math.round(entry.startTime), "最大内容渲染耗时偏高");
            }
            if (entry.entryType === "layout-shift" && !entry.hadRecentInput) {
              sendVital("cls", Number(entry.value.toFixed(4)), "页面布局发生明显偏移");
            }
            if (entry.entryType === "longtask" && entry.duration > 120) {
              sendVital("longtask", Math.round(entry.duration), "主线程长任务阻塞交互");
            }
          });
        });
        observer.observe({ entryTypes: ["largest-contentful-paint", "layout-shift", "longtask"] });
      } catch {}
    }
  }

  function sendVital(name, value, text) {
    const key = `${name}:${Math.round(Number(value) || 0)}`;
    if (sentVitals[key]) return;
    sentVitals[key] = true;
    send("performance", { text, metric: name, value });
  }

  function captureApiFailures() {
    if (!originalFetch && window.fetch) {
      originalFetch = window.fetch;
      window.fetch = function () {
        const started = Date.now();
        const input = arguments[0];
        const init = arguments[1] || {};
        const url = typeof input === "string" ? input : input && input.url;
        const method = init.method || (input && input.method) || "GET";

        return originalFetch.apply(this, arguments).then(
          function (response) {
            if (!response.ok && !shouldIgnoreUrl(url)) {
              send("api_failure", {
                text: `接口请求失败：${response.status} ${safeUrl(url)}`,
                url: safeUrl(url),
                method,
                status: response.status,
                duration: Date.now() - started,
              });
            }
            return response;
          },
          function (error) {
            if (!shouldIgnoreUrl(url)) {
              send("api_failure", {
                text: `接口请求异常：${safeUrl(url)}`,
                url: safeUrl(url),
                method,
                message: error && error.message,
                duration: Date.now() - started,
              });
            }
            throw error;
          },
        );
      };
    }

    if (!originalXhrOpen && window.XMLHttpRequest) {
      originalXhrOpen = XMLHttpRequest.prototype.open;
      originalXhrSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__itera = { method, url: safeUrl(url), started: Date.now() };
        return originalXhrOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        this.addEventListener("loadend", function () {
          const meta = this.__itera;
          if (!meta || shouldIgnoreUrl(meta.url) || this.status < 400) return;
          send("api_failure", {
            text: `接口请求失败：${this.status} ${meta.url}`,
            url: meta.url,
            method: meta.method,
            status: this.status,
            duration: Date.now() - meta.started,
          });
        });
        return originalXhrSend.apply(this, arguments);
      };
    }
  }

  function captureRageClicks() {
    document.addEventListener(
      "click",
      function (event) {
        const point = { x: event.clientX, y: event.clientY, at: Date.now() };
        lastClicks = lastClicks.filter(function (item) {
          return point.at - item.at < 1800;
        });
        lastClicks.push(point);

        const nearby = lastClicks.filter(function (item) {
          return Math.abs(item.x - point.x) < 28 && Math.abs(item.y - point.y) < 28;
        });

        if (nearby.length >= 4) {
          const target = event.target;
          send("behavior", {
            text: "用户在同一区域连续点击，疑似按钮无响应或流程卡住。",
            behavior: "rage_click",
            x: point.x,
            y: point.y,
            target:
              target &&
              {
                tag: target.tagName,
                id: target.id || null,
                text: (target.innerText || target.value || "").slice(0, 80),
              },
          });
          lastClicks = [];
        }
      },
      true,
    );
  }

  function restorePatches() {
    if (originalFetch) {
      window.fetch = originalFetch;
      originalFetch = null;
    }
    if (originalXhrOpen) {
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
      originalXhrOpen = null;
      originalXhrSend = null;
    }
  }

  window.SelfIteratingAI = {
    init: function (options) {
      config = Object.assign({}, DEFAULTS, options || {});
      if (!config.projectId && !config.sdkKey) {
        console.warn("[SelfIteratingAI] projectId or sdkKey is required.");
        return;
      }
      if (config.enableFeedbackWidget) createWidget();
      if (config.captureErrors) captureErrors();
      if (config.capturePerformance) capturePerformance();
      if (config.captureApiFailures) captureApiFailures();
      if (config.captureRageClicks) captureRageClicks();
      send("sdk_loaded", { text: "SDK 首次心跳已加载", title: document.title, heartbeat: true });
    },
    feedback: function (text, extra) {
      return send("feedback", Object.assign({ text }, extra || {}), { beacon: false });
    },
    track: send,
    destroy: function () {
      if (widget) widget.remove();
      widget = null;
      restorePatches();
      config = null;
    },
  };

  const autoConfig = readScriptConfig(bootstrapScript);
  if (autoConfig) {
    window.SelfIteratingAI.init(autoConfig);
  }
})();
