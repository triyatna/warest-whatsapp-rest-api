(() => {
  const SPEC_URL = "/docs/openapi.json";
  const CODES_URL = "/docs/code-table.json";
  const LOGIN_ROUTE = "/login";

  const state = {
    auth: null,
    swagger: null,
    statusEl: null,
    usernameEl: null,
    roleEl: null,
    codeTableBody: null,
    codeTableSection: null,
    authStateEl: null,
    isAdmin: false,
  };

  const resolveAdminFlag = (source = {}) => {
    if (typeof source.isAdmin === "boolean") return source.isAdmin;
    const role = typeof source.role === "string" ? source.role : "";
    return role.toLowerCase() === "admin";
  };

  const waitFor = (predicate) =>
    new Promise((resolve) => {
      const check = () => {
        const value = predicate();
        if (value) {
          resolve(value);
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });

  const redirectToLogin = (reason = "") => {
    const params = new URLSearchParams({ next: "/docs" });
    if (reason) params.set("reason", reason);
    window.location.replace(`${LOGIN_ROUTE}?${params.toString()}`);
  };

  const setStatus = (msg) => {
    if (!state.statusEl) return;
    state.statusEl.textContent = msg || "";
    state.statusEl.classList.toggle("hidden", !msg);
  };

  const setSwaggerAuthState = ({ status = "ok", message = "" } = {}) => {
    if (!state.authStateEl) return;
    if (!message) {
      state.authStateEl.textContent = "";
      state.authStateEl.classList.add("hidden");
      return;
    }
    state.authStateEl.textContent = message;
    state.authStateEl.dataset.status = status;
    state.authStateEl.classList.remove("hidden");
  };

  const updateUserMeta = (session = {}) => {
    const fromStore = state.auth?.getSession?.() || {};
    const merged = { ...fromStore, ...session };
    const adminFlag = resolveAdminFlag(merged);
    state.isAdmin = adminFlag;
    state.role = adminFlag ? "admin" : "user";
    if (state.usernameEl) {
      state.usernameEl.textContent =
        merged.username || fromStore.username || "user";
    }
    if (state.roleEl) {
      state.roleEl.textContent = adminFlag ? "admin" : "user";
    }
  };

  const requireSession = () => {
    const session = state.auth?.getSession?.() || {};
    if (!session.apiKey) {
      redirectToLogin("Please sign in to view the docs.");
      throw new Error("NO_SESSION");
    }
    updateUserMeta(session);
    return session;
  };

  const requestHeaders = () => {
    const key = state.auth?.getSession?.().apiKey || "";
    const headers = {};
    if (key) {
      headers["X-WAREST-API-KEY"] = key;
      headers.Authorization = `Bearer ${key}`;
    }
    return headers;
  };

  const applySwaggerApiKey = (key) => {
    if (
      !state.swagger ||
      typeof state.swagger.preauthorizeApiKey !== "function"
    ) {
      if (!key) {
        setSwaggerAuthState({
          status: "warn",
          message:
            "Warest is not yet authorized. Click Authorize and paste your API key.",
        });
        return;
      }
      setSwaggerAuthState({
        status: "warn",
        message:
          "Unable to pre-authorize Warest automatically. Use the Authorize button.",
      });
      return;
    }
    if (!key) {
      setSwaggerAuthState({
        status: "warn",
        message:
          "Warest is not yet authorized. Click Authorize and paste your API key.",
      });
      return;
    }
    try {
      state.swagger.preauthorizeApiKey("ApiKeyAuth", key);
      setSwaggerAuthState({
        status: "ok",
        message: "Warest requests are authorized with your API key.",
      });
    } catch (err) {
      console.warn("[docs] Warest preauthorize failed", err);
      setSwaggerAuthState({
        status: "warn",
        message:
          "Failed to apply your API key automatically. Use the Authorize button.",
      });
    }
  };

  const handleUnauthorized = (reason = "Session expired") => {
    setStatus(`${reason}. Redirecting to login...`);
    setSwaggerAuthState({
      status: "warn",
      message: "Warest authorization cleared. Redirecting to login...",
    });
    setTimeout(() => redirectToLogin(reason), 600);
  };

  const fetchCodeTable = async () => {
    try {
      const resp = await fetch(CODES_URL, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...requestHeaders(),
        },
        credentials: "include",
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          handleUnauthorized("Login required");
          return;
        }
        throw new Error(`Failed to load code reference (${resp.status})`);
      }
      const data = await resp.json();
      renderCodeTable(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[docs] code table error", err);
      setStatus("Unable to load code reference table.");
    }
  };

  const renderCodeTable = (rows) => {
    if (!state.codeTableBody || !state.codeTableSection) return;
    state.codeTableBody.innerHTML = "";
    if (!rows.length) {
      state.codeTableSection.classList.add("hidden");
      return;
    }
    for (const row of rows) {
      const description = row.description || row.message || "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${row.app_code || "-"}</td>
        <td>${row.app_name || "-"}</td>
        <td>${description}</td>
        <td>${row.http_status || "-"}</td>
        <td>${row.category || "-"}</td>`;
      state.codeTableBody.appendChild(tr);
    }
    state.codeTableSection.classList.remove("hidden");
  };

  const mountSwagger = async (session) => {
    const SwaggerUI = await waitFor(() => window.SwaggerUIBundle);
    setStatus("Loading OpenAPI spec...");
    setSwaggerAuthState({
      status: session?.apiKey ? "ok" : "warn",
      message: session?.apiKey
        ? "Preparing Warest with your API key..."
        : "Warest is not yet authorized. Click Authorize and paste your API key.",
    });
    const ui = SwaggerUI({
      dom_id: "#swagger-ui",
      url: SPEC_URL,
      deepLinking: true,
      docExpansion: "list",
      presets: [
        SwaggerUI.presets.apis,
        window.SwaggerUIStandalonePreset || SwaggerUI.presets.apis,
      ],
      requestInterceptor: (req) => {
        Object.assign(req.headers, requestHeaders());
        req.credentials = "include";
        return req;
      },
      onComplete: () => {
        setStatus("");
        updateUserMeta(session);
        const key = session?.apiKey || state.auth?.getSession?.().apiKey || "";
        applySwaggerApiKey(key);
      },
    });
    state.swagger = ui;
    window.ui = ui;
    const key = session?.apiKey || state.auth?.getSession?.().apiKey || "";
    if (key) applySwaggerApiKey(key);
  };

  const initLogout = () => {
    const btn = document.getElementById("docsLogout");
    if (!btn) return;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      setStatus("Signing out...");
      Promise.resolve()
        .then(() =>
          state.auth?.clearSession?.("docs logout", {
            source: "docs-page",
          })
        )
        .then(() => fetch("/api/auth/logout", { method: "POST" }))
        .catch(() => {})
        .finally(() => {
          redirectToLogin("Signed out from WARest");
        });
    });
  };

  const startAuthSubscriber = () => {
    state.auth?.subscribe?.((event, payload = {}) => {
      if (event === "logout") {
        handleUnauthorized("Signed out");
        return;
      }
      if (event === "login") {
        updateUserMeta(payload);
        state.auth?.ensureDocsSession?.(payload.apiKey);
        fetchCodeTable();
        const key = payload.apiKey || (state.auth.getSession?.().apiKey ?? "");
        if (key) {
          setTimeout(() => applySwaggerApiKey(key), 200);
        } else {
          setSwaggerAuthState({
            status: "warn",
            message:
              "Warest is not yet authorized. Click Authorize and paste your API key.",
          });
        }
      }
    });
  };

  const bootstrap = async () => {
    state.statusEl = document.getElementById("docsStatus");
    state.usernameEl = document.getElementById("docsUsername");
    state.roleEl = document.getElementById("docsRole");
    state.codeTableBody = document.getElementById("codeTableBody");
    state.codeTableSection = document.getElementById("warest-code-table");
    state.authStateEl = document.getElementById("swaggerAuthState");

    state.auth = await waitFor(() => window.WAREST_AUTH);
    let session;
    try {
      session = requireSession();
    } catch {
      return;
    }
    await Promise.resolve(state.auth.ensureDocsSession?.(session.apiKey));
    startAuthSubscriber();
    initLogout();
    mountSwagger(session);
    fetchCodeTable();
  };

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    bootstrap();
  } else {
    document.addEventListener("DOMContentLoaded", bootstrap);
  }
})();
