/* WorkBuddy 签到面板 · 方案 A：公开静态页 + 私有数据仓 */
(function () {
  "use strict";

  var CFG_KEY = "wb_panel_cfg_v1";
  var API = "https://api.github.com";
  var cfg = null;
  var state = { accounts: [], archived: [], sha: null };
  var editing = { id: null, step: 1 };

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function toast(message, isError) {
    var el = $("#toast");
    el.textContent = message;
    el.className = "toast" + (isError ? " err" : "");
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.className = "toast hidden";
    }, 4200);
  }

  function fail(e) {
    console.error(e);
    var message = e && e.message ? e.message : String(e);
    toast(message.slice(0, 180), true);
  }

  /* ---------- 编解码 ---------- */

  function b64encode(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(value) {
    var clean = String(value || "").replace(/\s/g, "");
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function sha256hex(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.prototype.map
      .call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  function genId() {
    var a = new Uint8Array(4);
    crypto.getRandomValues(a);
    return (
      "acc_" +
      Array.prototype.map
        .call(a, function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  function secretName(id) {
    return "WORKBUDDY_COOKIE_" + id.slice(4).toUpperCase();
  }

  function parseExpiry(cookie) {
    var m = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (!m) return null;
    var raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch (e) {
      /* 保持原样 */
    }
    var parts = raw.split("|");
    var ts = Number(parts[1]);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }

  function fmtTime(value) {
    if (!value) return "-";
    var d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
    if (isNaN(d.getTime())) return "-";
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      " " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  /* ---------- GitHub API ---------- */

  async function gh(path, options) {
    options = options || {};
    var headers = Object.assign(
      {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + cfg.token,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      options.headers || {}
    );
    var res = await fetch(API + path, Object.assign({}, options, { headers: headers }));
    if (res.status === 204) return null;
    if (!res.ok) {
      var body = await res.text();
      var brief = path.split("?")[0];
      var hint = "";
      if (res.status === 401) hint = "令牌无效或已过期";
      else if (res.status === 403) hint = "权限不足或被限流";
      else if (res.status === 404) hint = "仓库不存在、令牌未授权该仓库，或缺少该接口所需权限";
      var err = new Error(
        (hint || "请求失败") + "（" + res.status + " " + brief + "）"
      );
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return res.json();
  }

  async function verifyConnection() {
    await gh("/repos/" + cfg.owner + "/" + cfg.repo);
    try {
      await gh(repoPath("/contents/accounts.json?ref=" + encodeURIComponent(cfg.branch)));
    } catch (e) {
      if (e.status !== 404) {
        throw new Error("Contents 权限异常：" + e.message);
      }
    }
    try {
      await gh(repoPath("/actions/secrets/public-key"));
    } catch (e) {
      throw new Error(
        "缺少 Secrets 权限（令牌 → Repository permissions → Secrets 设为 Read and write）：" +
          e.message
      );
    }
  }

  function repoPath(suffix) {
    return "/repos/" + cfg.owner + "/" + cfg.repo + suffix;
  }

  async function loadAccounts() {
    try {
      var data = await gh(repoPath("/contents/accounts.json?ref=" + cfg.branch));
      var parsed = JSON.parse(b64decode(data.content));
      state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      state.archived = Array.isArray(parsed.archived) ? parsed.archived : [];
      state.sha = data.sha;
    } catch (e) {
      if (e.status === 404) {
        state.accounts = [];
        state.archived = [];
        state.sha = null;
      } else {
        throw e;
      }
    }
  }

  async function saveAccounts(message) {
    var body = {
      schema_version: 1,
      accounts: state.accounts,
      archived: state.archived,
      updated_at: nowIso(),
    };
    var payload = {
      message: message,
      content: b64encode(JSON.stringify(body, null, 2) + "\n"),
      branch: cfg.branch,
    };
    if (state.sha) payload.sha = state.sha;
    var res = await gh(repoPath("/contents/accounts.json"), {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.sha = res.content.sha;
  }

  async function mutateAccounts(mutator, message) {
    var lastError = null;
    for (var attempt = 0; attempt < 3; attempt += 1) {
      await loadAccounts();
      if (!mutator(state)) return;
      try {
        await saveAccounts(message);
        return;
      } catch (e) {
        lastError = e;
        await sleep(600 + attempt * 700);
      }
    }
    throw lastError || new Error("保存失败");
  }

  async function putSecret(name, value) {
    var pk = await gh(repoPath("/actions/secrets/public-key"));
    await sodium.ready;
    var keyBytes = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
    var sealed = sodium.crypto_box_seal(sodium.from_string(value), keyBytes);
    var encrypted = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
    await gh(repoPath("/actions/secrets/" + name), {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: encrypted, key_id: pk.key_id }),
    });
  }

  async function deleteSecret(name) {
    await gh(repoPath("/actions/secrets/" + name), { method: "DELETE" });
  }

  async function dispatchRun(accountId) {
    await gh(repoPath("/actions/workflows/checkin.yml/dispatches"), {
      method: "POST",
      body: JSON.stringify({ ref: cfg.branch, inputs: { account: accountId } }),
    });
  }

  /* ---------- 渲染 ---------- */

  var STATUS_TEXT = {
    active: "生效中",
    expired: "已过期",
    error: "执行异常",
    validating: "校验中",
    disabled: "已停用",
  };

  function statusClass(status) {
    if (status === "active") return "badge badge-ok";
    if (status === "expired" || status === "error") return "badge badge-bad";
    if (status === "validating") return "badge badge-warn";
    return "badge badge-muted";
  }

  function expiringSoon(acc) {
    if (!acc.expires_at) return false;
    var now = Date.now() / 1000;
    return acc.expires_at > now && acc.expires_at - now < 3 * 86400;
  }

  function renderStats() {
    var total = state.accounts.length;
    var active = state.accounts.filter(function (a) {
      return a.status === "active";
    }).length;
    var bad = state.accounts.filter(function (a) {
      return a.status === "expired" || a.status === "error";
    }).length;
    var soon = state.accounts.filter(expiringSoon).length;
    $("#stat-total").textContent = total;
    $("#stat-active").textContent = active;
    $("#stat-bad").textContent = bad;
    $("#stat-expiring").textContent = soon;
    $("#account-summary").textContent = total
      ? "共 " + total + " 个账户，启用 " +
        state.accounts.filter(function (a) {
          return a.enabled !== false;
        }).length +
        " 个"
      : "尚无账户";
  }

  function renderAccounts() {
    var tbody = $("#account-tbody");
    if (!state.accounts.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">尚无账户，点击右上角“添加账户”开始</td></tr>';
      return;
    }
    tbody.innerHTML = state.accounts
      .map(function (acc) {
        var status = acc.enabled === false ? "disabled" : acc.status || "validating";
        var expireText = acc.expires_at ? fmtTime(acc.expires_at) : "-";
        if (expiringSoon(acc)) expireText += "（即将过期）";
        return (
          '<tr data-id="' +
          acc.id +
          '">' +
          '<td class="name-cell"><strong>' +
          escapeHtml(acc.name || "未命名") +
          "</strong><span>" +
          escapeHtml(acc.id) +
          "</span></td>" +
          "<td><code>" +
          escapeHtml(acc.hint || "已隐藏") +
          "</code></td>" +
          '<td><span class="' +
          statusClass(status) +
          '">' +
          (STATUS_TEXT[status] || status) +
          "</span></td>" +
          "<td>" +
          expireText +
          "</td>" +
          "<td>" +
          (acc.last_run_at ? fmtTime(acc.last_run_at) : "-") +
          "<br><span class=\"muted small\">" +
          escapeHtml(resultText(acc.last_result) || "-") +
          "</span></td>" +
          '<td class="ta-right">' +
          '<button class="btn-link" data-act="detail">详情</button>' +
          '<button class="btn-link" data-act="refresh">刷新凭证</button>' +
          '<button class="btn-link" data-act="toggle">' +
          (acc.enabled === false ? "启用" : "停用") +
          "</button>" +
          '<button class="btn-link danger" data-act="delete">删除</button>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderArchived() {
    var tbody = $("#archived-tbody");
    if (!state.archived.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无记录</td></tr>';
      return;
    }
    tbody.innerHTML = state.archived
      .slice()
      .reverse()
      .map(function (item) {
        return (
          "<tr><td>" +
          escapeHtml(item.name || "未命名") +
          "</td><td><code>" +
          escapeHtml(item.hint || "-") +
          "</code></td><td>" +
          fmtTime(item.deleted_at) +
          "</td><td>" +
          escapeHtml(resultText(item.last_result) || "-") +
          "</td></tr>"
        );
      })
      .join("");
  }

  function resultText(value) {
    return (
      {
        success: "签到成功",
        already: "今日已签到",
        valid: "凭证有效",
        failed: "失败",
      }[value] || value || ""
    );
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderAll() {
    renderStats();
    renderAccounts();
    renderArchived();
  }

  /* ---------- 连接配置 ---------- */

  function loadCfg() {
    try {
      cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
    } catch (e) {
      cfg = null;
    }
    if (cfg && cfg.owner && cfg.repo && cfg.token) {
      cfg.branch = cfg.branch || "main";
      $("#conn-badge").textContent = cfg.owner + "/" + cfg.repo;
      $("#conn-badge").className = "badge badge-ok";
      $("#setup-hint").classList.add("hidden");
      return true;
    }
    cfg = null;
    $("#conn-badge").textContent = "未连接";
    $("#conn-badge").className = "badge badge-muted";
    $("#setup-hint").classList.remove("hidden");
    return false;
  }

  function openModal(id) {
    $("#" + id).classList.remove("hidden");
  }

  function closeModal(id) {
    $("#" + id).classList.add("hidden");
  }

  $("#btn-settings").addEventListener("click", function () {
    if (cfg) {
      $("#form-settings").owner.value = cfg.owner;
      $("#form-settings").repo.value = cfg.repo;
      $("#form-settings").branch.value = cfg.branch || "main";
      $("#form-settings").token.value = cfg.token;
    }
    openModal("modal-settings");
  });

  $("#btn-setup-now").addEventListener("click", function () {
    openModal("modal-settings");
  });

  $("#form-settings").addEventListener("submit", async function (e) {
    e.preventDefault();
    var form = e.target;
    cfg = {
      owner: form.owner.value.trim(),
      repo: form.repo.value.trim(),
      branch: form.branch.value.trim() || "main",
      token: form.token.value.trim(),
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    try {
      await verifyConnection();
      await loadAccounts();
      renderAll();
      closeModal("modal-settings");
      toast("连接成功");
    } catch (err) {
      fail(err);
    }
  });

  $("#btn-disconnect").addEventListener("click", function () {
    localStorage.removeItem(CFG_KEY);
    cfg = null;
    state = { accounts: [], archived: [], sha: null };
    loadCfg();
    renderAll();
    closeModal("modal-settings");
    toast("已断开连接");
  });

  $("#btn-refresh").addEventListener("click", async function () {
    if (!cfg) return;
    try {
      await loadAccounts();
      renderAll();
      toast("已刷新");
    } catch (e) {
      fail(e);
    }
  });

  /* ---------- 添加账户向导 ---------- */

  function setStep(step) {
    editing.step = step;
    $$(".step").forEach(function (el) {
      el.classList.toggle("is-active", Number(el.dataset.step) === step);
    });
    $$(".step-pane").forEach(function (el) {
      el.classList.toggle("hidden", Number(el.dataset.pane) !== step);
    });
    $("#add-prev").classList.toggle("hidden", step === 1);
    $("#add-next").textContent = step === 3 ? "提交" : "下一步";
  }

  function openAdd(account) {
    editing.id = account ? account.id : null;
    editing.step = 1;
    $("#add-name").value = account ? account.name || "" : "";
    $("#add-cookie").value = "";
    $("#add-cookie").placeholder =
      "session=...; session_2=...（请从浏览器开发者工具复制完整 Cookie）";
    setStep(1);
    openModal("modal-add");
  }

  var MAX_ACCOUNTS = 10;

  $("#btn-add").addEventListener("click", function () {
    if (!cfg) {
      toast("请先完成连接设置", true);
      return;
    }
    if (state.accounts.length >= MAX_ACCOUNTS) {
      toast("账户数量已达上限（" + MAX_ACCOUNTS + " 个）", true);
      return;
    }
    openAdd(null);
  });

  $("#add-prev").addEventListener("click", function () {
    setStep(Math.max(1, editing.step - 1));
  });

  $("#add-next").addEventListener("click", async function () {
    if (editing.step === 1) {
      setStep(2);
      return;
    }
    if (editing.step === 2) {
      var cookie = $("#add-cookie").value.trim();
      if (!cookie) {
        toast("请先粘贴 Cookie", true);
        return;
      }
      if (!/(^|;\s*)session=/.test(cookie)) {
        toast("Cookie 中缺少 session= 字段", true);
        return;
      }
      var fingerprint = await sha256hex(cookie);
      var dup = state.accounts.find(function (a) {
        return a.fingerprint === fingerprint && a.id !== editing.id;
      });
      if (dup) {
        toast("该凭证已存在，账户：" + (dup.name || dup.id), true);
        return;
      }
      $("#confirm-name").textContent = $("#add-name").value.trim() || "未命名账户";
      $("#confirm-fingerprint").textContent = fingerprint.slice(0, 12) + "…";
      $("#confirm-expire").textContent = fmtTime(parseExpiry(cookie));
      setStep(3);
      return;
    }

    var btn = $("#add-next");
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await submitAccount();
      closeModal("modal-add");
      toast("已保存，正在后台校验，约 1 分钟后刷新查看状态");
      await loadAccounts();
      renderAll();
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false;
      setStep(editing.step);
    }
  });

  async function submitAccount() {
    var name = $("#add-name").value.trim() || "未命名账户";
    var cookie = $("#add-cookie").value.trim();
    var fingerprint = await sha256hex(cookie);
    var expires = parseExpiry(cookie);
    var id = editing.id || genId();
    var secret = secretName(id);
    var hint = "session…" + fingerprint.slice(-6);

    await putSecret(secret, cookie);

    await mutateAccounts(function (s) {
      var acc = s.accounts.find(function (a) {
        return a.id === id;
      });
      if (acc) {
        acc.name = name;
        acc.fingerprint = fingerprint;
        acc.hint = hint;
        acc.expires_at = expires;
        acc.status = "validating";
        acc.enabled = true;
        acc.updated_at = nowIso();
        acc.version = (acc.version || 1) + 1;
      } else {
        s.accounts.push({
          id: id,
          name: name,
          group: "",
          secret: secret,
          hint: hint,
          fingerprint: fingerprint,
          status: "validating",
          expires_at: expires,
          enabled: true,
          created_at: nowIso(),
          updated_at: nowIso(),
          last_run_at: "",
          last_result: "",
          last_message: "",
          history: [],
          version: 1,
        });
      }
      return true;
    }, editing.id ? "update credential: " + id : "add account: " + id);

    try {
      await dispatchRun(id);
    } catch (e) {
      console.warn("触发校验失败", e);
    }
  }

  /* ---------- 行操作 ---------- */

  $("#account-tbody").addEventListener("click", async function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var tr = btn.closest("tr");
    var id = tr.dataset.id;
    var account = state.accounts.find(function (a) {
      return a.id === id;
    });
    if (!account) return;
    var act = btn.dataset.act;

    if (act === "detail") return openDetail(account);
    if (act === "refresh") return openAdd(account);

    if (act === "toggle") {
      try {
        await mutateAccounts(function (s) {
          var acc = s.accounts.find(function (a) {
            return a.id === id;
          });
          if (!acc) return false;
          acc.enabled = acc.enabled === false;
          acc.status = acc.enabled ? "validating" : "disabled";
          acc.updated_at = nowIso();
          return true;
        }, "toggle account: " + id);
        await loadAccounts();
        renderAll();
      } catch (err) {
        fail(err);
      }
      return;
    }

    if (act === "delete") {
      if (
        !confirm(
          "删除后凭证会被清除，仅保留脱敏记录。确认删除账户「" +
            (account.name || id) +
            "」？"
        )
      )
        return;
      try {
        await mutateAccounts(function (s) {
          var idx = s.accounts.findIndex(function (a) {
            return a.id === id;
          });
          if (idx < 0) return false;
          var removed = s.accounts.splice(idx, 1)[0];
          s.archived.push({
            id: removed.id,
            name: removed.name,
            hint: removed.hint,
            deleted_at: nowIso(),
            last_result: removed.last_result,
            history: (removed.history || []).slice(-5),
          });
          return true;
        }, "archive account: " + id);
        try {
          await deleteSecret(secretName(id));
        } catch (err) {
          console.warn("删除密钥失败", err);
        }
        await loadAccounts();
        renderAll();
        toast("已删除账户并清除凭证");
      } catch (err) {
        fail(err);
      }
    }
  });

  /* ---------- 详情 ---------- */

  function openDetail(account) {
    $("#detail-title").textContent = account.name || "账户详情";
    var status = account.enabled === false ? "disabled" : account.status;
    $("#detail-kv").innerHTML = [
      ["账户 ID", "<code>" + escapeHtml(account.id) + "</code>"],
      ["密钥名称", "<code>" + escapeHtml(account.secret) + "</code>"],
      ["凭证指纹", "<code>" + escapeHtml((account.fingerprint || "").slice(0, 16)) + "…</code>"],
      ["状态", '<span class="' + statusClass(status) + '">' + (STATUS_TEXT[status] || status) + "</span>"],
      ["到期时间", fmtTime(account.expires_at)],
      ["最近执行", fmtTime(account.last_run_at)],
      ["执行结果", escapeHtml(resultText(account.last_result)) || "-"],
      ["最近信息", escapeHtml(account.last_message || "-")],
    ]
      .map(function (row) {
        return "<dt>" + row[0] + "</dt><dd>" + row[1] + "</dd>";
      })
      .join("");

    var list = (account.history || []).slice().reverse();
    $("#detail-history").innerHTML = list.length
      ? list
          .map(function (h) {
            return (
              "<li><span>" +
              fmtTime(h.at) +
              '</span><span class="h-result">' +
              escapeHtml(resultText(h.result)) +
              (h.credit != null ? " +" + h.credit : "") +
              "</span></li>"
            );
          })
          .join("")
      : '<li><span class="muted">暂无记录</span></li>';

    $("#detail-disable").textContent = account.enabled === false ? "启用" : "停用";
    $("#detail-disable").onclick = async function () {
      try {
        await mutateAccounts(function (s) {
          var acc = s.accounts.find(function (a) {
            return a.id === account.id;
          });
          if (!acc) return false;
          acc.enabled = acc.enabled === false;
          acc.status = acc.enabled ? "validating" : "disabled";
          acc.updated_at = nowIso();
          return true;
        }, "toggle account: " + account.id);
        await loadAccounts();
        renderAll();
        closeModal("modal-detail");
        toast("已更新状态");
      } catch (e) {
        fail(e);
      }
    };
    $("#detail-delete").onclick = function () {
      closeModal("modal-detail");
      var row = document.querySelector('tr[data-id="' + account.id + '"]');
      if (row) {
        var del = row.querySelector('[data-act="delete"]');
        if (del) del.click();
      }
    };
    openModal("modal-detail");
  }

  $("#detail-close").addEventListener("click", function () {
    closeModal("modal-detail");
  });

  /* ---------- 全局关闭 ---------- */

  $$("[data-close]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeModal(btn.dataset.close);
    });
  });

  $$(".modal").forEach(function (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal) modal.classList.add("hidden");
    });
  });

  /* ---------- 启动 ---------- */

  (async function init() {
    var connected = loadCfg();
    renderAll();
    if (!connected) return;
    try {
      await loadAccounts();
      renderAll();
    } catch (e) {
      fail(e);
    }
  })();
})();
