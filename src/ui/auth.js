(() => {
  const STORAGE_KEYS = Object.freeze({
    apiKey: "wa.apiKey",
    baseUrl: "wa.baseUrl",
    username: "wa.username",
    isAdmin: "wa.isAdmin",
  });
  const SIGNAL_STORAGE_KEY = "wa.auth.signal";
  const CHANNEL_NAME = "WAREST_AUTH_CHANNEL";
  const CLIENT_ID = Math.random().toString(36).slice(2);
  const watchers = new Set();
  let broadcastChannel = null;
  let lastSignalTs = 0;
  try {
    if (typeof BroadcastChannel === "function") {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      broadcastChannel.addEventListener("message", (event) => {
        if (!event) return;
        handleRemoteSignal(event.data);
      });
    }
  } catch {
    broadcastChannel = null;
  }

  window.addEventListener("storage", (event) => {
    if (event.key === SIGNAL_STORAGE_KEY && event.newValue) {
      try {
        handleRemoteSignal(JSON.parse(event.newValue));
      } catch {}
    }
  });

  const readStorage = (key) => {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  };
  const writeStorage = (key, value) => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  };

  const dispatchLocal = (event, payload, meta) => {
    watchers.forEach((fn) => {
      try {
        fn(event, payload || {}, meta || {});
      } catch (err) {
        console.error("[WAREST_AUTH] subscriber failed", err);
      }
    });
  };

  const broadcastMessage = (msg) => {
    lastSignalTs = msg.ts;
    if (broadcastChannel) {
      try {
        broadcastChannel.postMessage(msg);
      } catch {}
    }
    try {
      localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify(msg));
    } catch {}
  };

  const notify = (event, payload, options = {}) => {
    const { broadcast = true, source = null } = options;
    const msg = {
      event,
      payload: payload || {},
      ts: Date.now(),
      clientId: CLIENT_ID,
      origin: source || null,
    };
    dispatchLocal(event, msg.payload, {
      clientId: CLIENT_ID,
      ts: msg.ts,
      local: true,
      self: true,
      origin: source || null,
    });
    if (broadcast) {
      broadcastMessage(msg);
    }
    return msg;
  };

  const handleRemoteSignal = (msg) => {
    if (!msg || !msg.event) return;
    if (msg.ts && msg.ts <= lastSignalTs) return;
    lastSignalTs = msg.ts;
    const meta = {
      clientId: msg.clientId,
      ts: msg.ts,
      local: false,
      self: msg.clientId === CLIENT_ID,
      origin: msg.origin || null,
    };
    if (meta.self) return;
    dispatchLocal(msg.event, msg.payload || {}, meta);
  };

  const getSession = () => {
    const baseUrlFallback =
      (window.location && window.location.origin) || "http://localhost";
    const adminRaw = readStorage(STORAGE_KEYS.isAdmin) || "";
    const isAdmin = adminRaw === "1" || adminRaw === "true";
    return {
      apiKey: readStorage(STORAGE_KEYS.apiKey),
      username: readStorage(STORAGE_KEYS.username),
      baseUrl: readStorage(STORAGE_KEYS.baseUrl) || baseUrlFallback,
      isAdmin,
    };
  };

  const setSession = (session = {}, options = {}) => {
    const prev = getSession();
    const normalizedIsAdmin =
      typeof session.isAdmin === "boolean"
        ? session.isAdmin
        : typeof session.isAdmin !== "undefined"
        ? (() => {
            const lowered = String(session.isAdmin).trim().toLowerCase();
            return lowered === "1" || lowered === "true" || lowered === "admin";
          })()
        : !!prev.isAdmin;
    const clean = {
      apiKey: String(session.apiKey || "").trim(),
      username: String(session.username || "").trim(),
      baseUrl: String(
        session.baseUrl ||
          readStorage(STORAGE_KEYS.baseUrl) ||
          (window.location && window.location.origin) ||
          ""
      ).trim(),
      isAdmin: normalizedIsAdmin,
    };
    writeStorage(STORAGE_KEYS.apiKey, clean.apiKey);
    writeStorage(STORAGE_KEYS.username, clean.username);
    writeStorage(STORAGE_KEYS.baseUrl, clean.baseUrl);
    writeStorage(STORAGE_KEYS.isAdmin, clean.isAdmin ? "1" : "");
    notify("login", clean, {
      broadcast: options.broadcast !== false,
      source: options.source,
    });
    return clean;
  };

  const clearSession = (reason = "", options = {}) => {
    writeStorage(STORAGE_KEYS.apiKey, "");
    writeStorage(STORAGE_KEYS.username, "");
    writeStorage(STORAGE_KEYS.baseUrl, "");
    writeStorage(STORAGE_KEYS.isAdmin, "");
    notify(
      "logout",
      { reason: reason || "", source: options.source || null },
      { broadcast: options.broadcast !== false, source: options.source }
    );
  };

  const ensureDocsSession = (apiKey) => {
    const key = String(apiKey || "").trim();
    if (!key) return Promise.resolve(null);
    return fetch("/api/auth/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WAREST-API-KEY": key,
      },
      body: JSON.stringify({ apiKey: key }),
      credentials: "same-origin",
    })
      .then((resp) => {
        if (!resp.ok) throw new Error("DOCS_SESSION_SYNC_FAILED");
        return resp.json().catch(() => ({}));
      })
      .then((body) => {
        if (body?.username) {
          setSession(
            {
              apiKey: key,
              username: body.username,
              baseUrl:
                (window.location && window.location.origin) ||
                getSession().baseUrl,
              isAdmin: !!body?.isAdmin,
            },
            { broadcast: false, source: "docs" }
          );
        }
        return body;
      })
      .catch((err) => {
        console.warn("[WAREST_AUTH] ensureDocsSession failed", err?.message);
        return null;
      });
  };

  const subscribe = (fn) => {
    if (typeof fn !== "function") return () => {};
    watchers.add(fn);
    return () => watchers.delete(fn);
  };

  const bootstrapDocs = (ctx = {}) => {
    if (bootstrapDocs.__ready) return;
    bootstrapDocs.__ready = true;
    const inferredRole = String(ctx.role || "").toLowerCase();
    const initialIsAdmin =
      typeof ctx.isAdmin === "boolean"
        ? ctx.isAdmin
        : inferredRole === "admin";
    const state = {
      username: String(ctx.username || ""),
      apiKey: String(ctx.apiKey || ""),
      isAdmin: initialIsAdmin,
    };
    state.role = state.isAdmin ? "admin" : "user";
    const codeTable = Array.isArray(ctx.codeTable) ? ctx.codeTable : [];
    window.__WAREST_DOCS__ = state;
    window.__WAREST_CODE_TABLE__ = codeTable;
    if (state.apiKey) {
      setSession(
        {
          apiKey: state.apiKey,
          username: state.username,
          baseUrl: (window.location && window.location.origin) || "",
          isAdmin: state.isAdmin,
        },
        { broadcast: true, source: "docs" }
      );
      ensureDocsSession(state.apiKey);
    }
    const STORAGE_STATE = {
      usernameEl: null,
      roleEl: null,
      logoutInProgress: false,
    };
    const updateBannerUser = () => {
      if (STORAGE_STATE.usernameEl)
        STORAGE_STATE.usernameEl.textContent = state.username || "user";
      if (STORAGE_STATE.roleEl)
        STORAGE_STATE.roleEl.textContent = state.isAdmin ? "admin" : "user";
    };
    const applyApiKey = (keyOverride) => {
      const selected = keyOverride || state.apiKey;
      if (!selected) return;
      let attempts = 0;
      const attempt = () => {
        attempts += 1;
        const ui = window.ui;
        if (!ui) {
          if (attempts < 400) requestAnimationFrame(attempt);
          return;
        }
        let success = false;
        try {
          if (typeof ui.preauthorizeApiKey === "function") {
            ui.preauthorizeApiKey("ApiKeyAuth", selected);
            success = true;
          }
          const sys = typeof ui.getSystem === "function" ? ui.getSystem() : null;
          const authActions = sys?.authActions || ui.authActions;
          if (authActions?.authorize) {
            authActions.authorize({
              ApiKeyAuth: { value: selected },
            });
            success = true;
          }
        } catch {}
        if (!success && attempts < 400) {
          requestAnimationFrame(attempt);
        }
      };
      attempt();
    };
    window.__WAREST_APPLY_API_KEY = applyApiKey;

    const ensureHeader = (root) => {
      if (document.getElementById("warest-docs-header")) return;
      const header = document.createElement("header");
      header.id = "warest-docs-header";
      const baseUrl = window.location ? window.location.origin : "";
      header.innerHTML = `
      <div class="warest-logo">
        <img class="warest-logo-img" src="${baseUrl}/media/warest.png" alt="WARest Logo" />
        <div class="warest-logo-text">
          <strong style="color:black;">WARest - WhatsApp Rest API Multi Sessions</strong>
          <small>WhatsApp Unofficial REST Api. NodeJS based</small>
        </div>
      </div>
    `;
      const parent = root.parentElement || document.body;
      if (parent) {
        parent.insertBefore(header, root);
      } else {
        root.insertBefore(header, root.firstChild);
      }
    };

    const ensureFooter = (root) => {
      if (document.getElementById("warest-docs-footer")) return;
      const footer = document.createElement("footer");
      footer.id = "warest-docs-footer";
      const year = new Date().getFullYear();
      footer.innerHTML = `&copy; ${year} WARest. All rights reserved.`;
      root.appendChild(footer);
    };

    const injectBanner = () => {
      const root = document.querySelector(".swagger-ui");
      if (!root) {
        requestAnimationFrame(injectBanner);
        return;
      }
      ensureHeader(root);
      ensureFooter(root);
      if (document.getElementById("warest-docs-banner")) return;
      const banner = document.createElement("section");
      banner.id = "warest-docs-banner";
      banner.innerHTML = `
      <div class="warest-docs-info">
        Logged in as <strong id="warest-docs-username"></strong>
        (<span id="warest-docs-role"></span>).
      </div>
      <div class="warest-docs-actions">
        <button type="button" id="warest-docs-logout" class="logout">
          Logout
        </button>
      </div>
    `;
      STORAGE_STATE.usernameEl = banner.querySelector("#warest-docs-username");
      STORAGE_STATE.roleEl = banner.querySelector("#warest-docs-role");
      updateBannerUser();
      const logoutBtn = banner.querySelector("#warest-docs-logout");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", () => triggerDocsLogout("button"));
      }
      const header = document.getElementById("warest-docs-header");
      const parent = (header && header.parentElement) || root.parentElement || root;
      if (header && parent) {
        parent.insertBefore(banner, header.nextSibling || root);
      } else {
        root.insertBefore(banner, root.firstChild);
      }
    };

    const injectCodeTable = () => {
      const data = Array.isArray(window.__WAREST_CODE_TABLE__)
        ? window.__WAREST_CODE_TABLE__
        : [];
      if (!data.length) return;
      const root = document.querySelector(".swagger-ui");
      if (!root) {
        requestAnimationFrame(injectCodeTable);
        return;
      }
      if (document.getElementById("warest-code-table")) return;
      const section = document.createElement("section");
      section.id = "warest-code-table";
      section.innerHTML = `
      <h2>WARest API Code Reference</h2>
      <div class="warest-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Message</th>
              <th>HTTP</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    `;
      const tbody = section.querySelector("tbody");
      data.forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${row.app_code}</td>
        <td>${row.app_name}</td>
        <td>${row.message}</td>
        <td>${row.http_status}</td>
        <td>${row.category}</td>`;
        tbody.appendChild(tr);
      });
      const footer = document.getElementById("warest-docs-footer");
      if (footer && footer.parentElement === root) {
        root.insertBefore(section, footer);
      } else {
        root.appendChild(section);
      }
    };

    const hookSwaggerAuthorize = () => {
      const ui = window.ui;
      if (!ui?.authActions?.authorize) {
        requestAnimationFrame(hookSwaggerAuthorize);
        return;
      }
      if (ui.authActions.authorize.__warestPatched) return;
      const original = ui.authActions.authorize.bind(ui.authActions);
      const wrapped = (payload) => {
        const result = original(payload);
        const key = extractApiKeyFromPayload(payload);
        if (key) {
          state.apiKey = key;
          setSession(
            {
              apiKey: key,
              username: state.username,
              baseUrl: (window.location && window.location.origin) || "",
            },
            { broadcast: true, source: "docs" }
          );
          ensureDocsSession(key);
          applyApiKey(key);
        }
        return result;
      };
      wrapped.__warestPatched = true;
      ui.authActions.authorize = wrapped;
    };

    const extractApiKeyFromPayload = (payload) => {
      if (!payload) return "";
      if (typeof payload === "string") return payload.trim();
      const target = payload.ApiKeyAuth || payload.apiKey || payload.api_key;
      if (target) {
        if (typeof target === "string") return target.trim();
        if (typeof target.value === "string") return target.value.trim();
      }
      const firstEntry = Array.isArray(payload)
        ? payload[0]
        : typeof payload === "object"
        ? Object.values(payload)[0]
        : null;
      if (!firstEntry) return "";
      if (typeof firstEntry === "string") return firstEntry.trim();
      if (typeof firstEntry.value === "string") return firstEntry.value.trim();
      return "";
    };

    const hookSwaggerLogout = () => {
      const ui = window.ui;
      if (!ui?.authActions?.logout) {
        requestAnimationFrame(hookSwaggerLogout);
        return;
      }
      if (ui.authActions.logout.__warestPatched) return;
      const original = ui.authActions.logout.bind(ui.authActions);
      const wrapped = (names) => {
        triggerDocsLogout("swagger");
        return original(names);
      };
      wrapped.__warestPatched = true;
      ui.authActions.logout = wrapped;
    };

    const triggerDocsLogout = (source = "docs") => {
      if (STORAGE_STATE.logoutInProgress) return;
      STORAGE_STATE.logoutInProgress = true;
      clearSession("docs logout", { source });
      fetch("/api/auth/logout", { method: "POST" })
        .catch(() => {})
        .finally(() => {
          setTimeout(() => window.location.reload(), 400);
        });
    };

    injectBanner();
    injectCodeTable();
    hookSwaggerAuthorize();
    hookSwaggerLogout();
    applyApiKey(state.apiKey);

    subscribe((event, payload, meta = {}) => {
      if (meta.self) return;
      if (event === "logout") {
        if (STORAGE_STATE.logoutInProgress) return;
        STORAGE_STATE.logoutInProgress = true;
        setTimeout(() => window.location.reload(), 400);
        return;
      }
      if (event === "login" && payload?.apiKey) {
        if (typeof payload.isAdmin === "boolean") {
          state.isAdmin = payload.isAdmin;
          state.role = state.isAdmin ? "admin" : "user";
        }
        if (payload.username) state.username = payload.username;
        updateBannerUser();
        if (payload.apiKey !== state.apiKey) {
          state.apiKey = payload.apiKey;
          ensureDocsSession(payload.apiKey);
          applyApiKey(payload.apiKey);
        }
      }
    });
  };

  window.WAREST_AUTH = {
    STORAGE_KEYS,
    getSession,
    setSession,
    clearSession,
    ensureDocsSession,
    subscribe,
    bootstrapDocs,
  };

  if (window.__WAREST_DOCS_CONTEXT__) {
    window.WAREST_AUTH.bootstrapDocs(window.__WAREST_DOCS_CONTEXT__);
  }
})();
