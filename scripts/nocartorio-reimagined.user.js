// ==UserScript==
// @name         NoCartório Reimagined
// @namespace    https://app.nocartorio.com/
// @version      0.3.0
// @description  Ribbon de navegação por atribuição cartorária (RI, TN, RCPN, TP, RTD, RCPJ) com temas Electric Blue e Hot Wheels. Desligue com ?ncr=off.
// @author       NoCartório Reimagined
// @match        https://app.nocartorio.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-reimagined.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-reimagined.user.js
// ==/UserScript==

(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/catalog/attributions.js
  var ATTRIBUTIONS = Object.freeze([
    { id: "ri", short: "RI", label: "Registro de Imóveis", companyType: 4 },
    { id: "tn", short: "TN", label: "Tabelionato de Notas", companyType: 1 },
    { id: "rcpn", short: "RCPN", label: "Registro Civil das Pessoas Naturais", companyType: 7 },
    { id: "tp", short: "TP", label: "Tabelionato de Protesto", companyType: 3 },
    { id: "rtd", short: "RTD", label: "Registro de Títulos e Documentos", companyType: 5 },
    { id: "rcpj", short: "RCPJ", label: "Registro Civil das Pessoas Jurídicas", companyType: 6 }
  ]);
  var ATTRIBUTION_IDS = ATTRIBUTIONS.map((a) => a.id);
  var attributionById = (id3) => ATTRIBUTIONS.find((a) => a.id === id3) || null;
  function norm(value) {
    return String(value == null ? "" : value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  var STRICT = [
    ["rcpj", /registro civil.*juridicas|\brcpj\b/],
    ["rcpn", /registro civil.*naturais|\brcpn\b/],
    ["ri", /registro de imoveis|\bri\b/],
    ["tn", /tabelionato de notas|\btn\b/],
    ["tp", /tabelionato de protesto|\btp\b/],
    ["rtd", /titulos e documentos|\brtd\b/]
  ];
  var LOOSE = [
    ["rcpj", /\bjuridicas?\b/],
    ["rcpn", /\bnaturais\b/],
    ["ri", /\bimoveis\b/],
    ["tn", /\bnotas\b/],
    ["tp", /\bprotestos?\b/],
    ["rtd", /\btitulos\b/]
  ];
  function attributionFromLabel(label3, { loose = false } = {}) {
    const text = norm(label3);
    if (!text) return null;
    for (const [id3, re] of STRICT) if (re.test(text)) return id3;
    if (loose) {
      for (const [id3, re] of LOOSE) if (re.test(text)) return id3;
    }
    return null;
  }
  function attributionFromAncestors(ancestors, opts) {
    for (const label3 of ancestors) {
      const id3 = attributionFromLabel(label3, opts);
      if (id3) return id3;
    }
    return null;
  }
  var BOOK = /^\/v2\/(?:tmp-)?(ri|tn|rcpn|rcpj|rtd|tp)-[^/?]*book/;
  var CT_NUM = /\/company-type\/(\d+)(?:\/|$)/;
  var CT_SLUG = /\/company-type\/(ri|tn|rcpn|rcpj|rtd|tp)(?:\/|$)/;
  var SPECIAL = [
    [/^\/cnib-requests/, "ri"],
    [/^\/v2\/onr-/, "ri"],
    [/^\/onr\/4(\/|$)/, "ri"],
    [/^\/v2\/extrajudicial-reports\/cra(\/|$)/, "tp"],
    [/central-rtdpj/, "rtd"]
  ];
  function attributionFromPath(path) {
    let m = BOOK.exec(path);
    if (m) return m[1];
    m = CT_SLUG.exec(path);
    if (m) return m[1];
    m = CT_NUM.exec(path);
    if (m) {
      const found = ATTRIBUTIONS.find((a) => a.companyType === Number(m[1]));
      if (found) return found.id;
    }
    for (const [re, id3] of SPECIAL) if (re.test(path)) return id3;
    return null;
  }

  // src/catalog/denylist.js
  var DENY_PATH = [
    /^\/auth(\/|$)/i,
    /(^|\/)(logout|signout|sign-out|sair)(\/|$|\?)/i,
    /(^|\/)(delete|destroy|remove|excluir|apagar|purge)(\/|$|\?)/i
  ];
  var DENY_LABEL = [/^sair$/, /^logout$/, /^encerrar sessao/];
  function isDenied(path, label3) {
    if (DENY_PATH.some((re) => re.test(path))) return true;
    const text = norm(label3);
    return DENY_LABEL.some((re) => re.test(text));
  }

  // src/catalog/paths.js
  var MANAGER_PREFIX = "/admin/manager";
  var SENSITIVE_PARAMS = /^(owner_?id|user_?id|token|_token|access_token|api_?key|session(_?id)?|csrf)$/i;
  function normalizeHref(href, base) {
    if (typeof href !== "string") return { ok: false, reason: "invalid" };
    const raw = href.trim();
    if (!raw || raw.startsWith("#") || /^(javascript|data|mailto|tel|blob):/i.test(raw)) {
      return { ok: false, reason: "invalid" };
    }
    let url;
    let baseUrl;
    try {
      baseUrl = new URL(base);
      url = new URL(raw, baseUrl);
    } catch (e) {
      return { ok: false, reason: "invalid" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid" };
    if (url.origin !== baseUrl.origin) return { ok: false, reason: "external" };
    let path = url.pathname;
    if (path === MANAGER_PREFIX || path.startsWith(MANAGER_PREFIX + "/")) {
      path = path.slice(MANAGER_PREFIX.length) || "/";
    }
    if (path.length > 1) path = path.replace(/\/+$/, "");
    const params = new URLSearchParams(url.search);
    for (const name of [...params.keys()]) if (SENSITIVE_PARAMS.test(name)) params.delete(name);
    const query = params.toString();
    const search = query ? `?${query}` : "";
    return { ok: true, path, search, key: path + search, url: url.href };
  }
  var isV2Path = (path) => path.startsWith("/v2/");
  function currentLocationKey(loc) {
    const n = normalizeHref(loc.href, loc.href);
    return n.ok ? { key: n.key, path: n.path } : { key: "", path: "" };
  }

  // src/catalog/rules.js
  var KIND_RANK = Object.freeze({
    nav: 0,
    book: 0,
    service: 1,
    central: 2,
    report: 3,
    general: 4,
    import: 8,
    backup: 9,
    other: 10
  });
  var TOPS = [
    ["dashboard", /^dashboard$/],
    ["kb", /base de conhecimento/],
    ["tasks", /^agendamentos?$/],
    ["fraud", /fraude/],
    ["servicos", /^servicos?$/],
    ["partes", /^partes$/],
    ["livros", /^livros$/],
    ["importacao", /^importacao de livros/],
    ["backup", /^backup de livros/],
    ["relatorios", /^relatorios?$/],
    ["financeiro", /^financeiro$/],
    ["tribunal", /tribunal de justica/],
    ["doi", /^doi$/],
    ["config", /^configuracoes?$/]
  ];
  var INICIO_PATHS = /* @__PURE__ */ new Set(["/v2/dashboard", "/v2/tasks", "/v2/fraud", "/knowledge-base/home"]);
  var SERVICE_CREATE = /^\/v2\/company\/protocol\/create\/normal\/company-type\/\d+$/;
  var BOOK_PATH = /^\/v2\/(ri|tn|rcpn|rcpj|rtd|tp)-[^/?]*book/;
  var IMPORT_PATH = /^\/v2\/tmp-[^/?]*book/;
  var BACKUP_PATH = /^\/v2\/manager\/backup\/notary-book\//;
  var FINANCE_HINT = /payment|financ|fatur|pagament|credit|invoice/;
  function findTop(ancestors, label3) {
    const chain = [...ancestors, label3];
    for (let index = 0; index < chain.length; index++) {
      const text = norm(chain[index]);
      for (const [key, re] of TOPS) if (re.test(text)) return { key, index };
      const attr = attributionFromLabel(chain[index]);
      if (attr && index < ancestors.length) return { key: "attr", index, attr };
      if (attr && index === ancestors.length && ancestors.length === 0) return { key: "attr", index, attr };
    }
    return null;
  }
  var ICON_BY_LABEL = [
    [/dashboard|painel/, "home"],
    [/agend|tarefa/, "calendar"],
    [/fraude/, "alert"],
    [/conhecimento|ajuda/, "help"],
    [/pessoa|fisica/, "user"],
    [/empresa|juridica/, "building"],
    [/orgao/, "landmark"],
    [/imovel/, "pin"],
    [/assinatura|cartao/, "idcard"],
    [/confer|checklist/, "checkList"],
    [/importa/, "upload"],
    [/backup/, "archive"],
    [/livro/, "book"],
    [/relat|digitaliza/, "chart"],
    [/selo|lote/, "bolt"],
    [/fatura|recibo|nota fiscal/, "receipt"],
    [/financ|pagament|credito|conta|saldo|caixa/, "wallet"],
    [/tribunal|judic/, "scale"],
    [/acesso|senha|seguran|2fa|autentic|ip\b|dispositivo/, "lock"],
    [/colaborador|usuario|equipe/, "users"],
    [/minuta|modelo|certidao/, "cert"],
    [/qualifica/, "clipboard"],
    [/central|integra|onr|cnib|censec|cenprot|crc|sirc|cra|doi|notariado/, "link"],
    [/servico|protocolo|abrir|novo/, "filePlus"],
    [/configur|ajuste|preferenc/, "settings"]
  ];
  function iconFor(label3, path, fallback = "dot") {
    const text = norm(label3) + " " + path;
    for (const [re, icon] of ICON_BY_LABEL) if (re.test(text)) return icon;
    return fallback;
  }
  function place(tab, kind, group, prominence, icon, depth, extra = {}) {
    return { tab, kind, group, prominence, icon, depth, ...extra };
  }
  function classify({ label: label3, ancestors, path }) {
    if (INICIO_PATHS.has(path)) {
      return place("inicio", "nav", "Navegação", "primary", iconFor(label3, path), ancestors.length);
    }
    const top = findTop(ancestors, label3);
    const sub = top && top.index + 1 < ancestors.length ? ancestors[top.index + 1] : null;
    const depth = top ? top.index + (sub ? 2 : 1) : 0;
    const key = top ? top.key : null;
    const looseAttr = () => attributionFromPath(path) || attributionFromAncestors(ancestors, { loose: true });
    const strictAttr = () => attributionFromPath(path) || attributionFromAncestors(ancestors);
    if (key === "dashboard" || key === "kb" || key === "tasks" || key === "fraud") {
      return place("inicio", "nav", "Navegação", "primary", iconFor(label3, path), depth);
    }
    if (key === "partes" || path.startsWith("/v2/profile/category/")) {
      return place("servicos", "general", "Partes", "primary", iconFor(label3, path), depth);
    }
    if (SERVICE_CREATE.test(path)) {
      const attr = attributionFromPath(path);
      if (attr) {
        return place(attr, "service", "Serviços", "primary", "filePlus", depth, {
          label: `Novo serviço de ${attributionById(attr).short}`
        });
      }
    }
    if (key === "servicos") {
      return place("servicos", "general", sub || "Serviços", "normal", iconFor(label3, path), depth);
    }
    if (key === "livros" || BOOK_PATH.test(path)) {
      const attr = looseAttr();
      if (attr) return place(attr, "book", "Livros", "featured", "book", depth);
    }
    if (key === "importacao" || IMPORT_PATH.test(path)) {
      const attr = looseAttr();
      if (attr) return place(attr, "import", "Importação", "secondary", "upload", depth);
    }
    if (key === "backup" || BACKUP_PATH.test(path)) {
      const attr = looseAttr();
      if (attr) return place(attr, "backup", "Backup", "secondary", "archive", depth);
    }
    if (key === "relatorios") {
      const attr = strictAttr();
      if (attr) return place(attr, "report", "Relatórios", "normal", iconFor(label3, path, "chart"), depth);
      if (FINANCE_HINT.test(path)) {
        return place("financeiro", "general", "Relatórios financeiros", "normal", iconFor(label3, path, "chart"), depth);
      }
      return place("administracao", "general", "Relatórios gerais", "normal", iconFor(label3, path, "chart"), depth);
    }
    if (key === "financeiro") {
      return place("financeiro", "general", sub || "Financeiro", "normal", iconFor(label3, path, "wallet"), depth);
    }
    if (key === "tribunal") {
      return place("financeiro", "general", "Tribunal de Justiça", "normal", iconFor(label3, path, "scale"), depth);
    }
    if (key === "doi") {
      const attr = strictAttr();
      if (attr) return place(attr, "central", "DOI", "normal", "link", depth);
    }
    if (key === "attr") {
      const isReport = /relat/.test(norm(label3)) || ancestors.some((a) => /relat/.test(norm(a)));
      if (isReport) {
        return place(top.attr, "report", "Relatórios", "normal", iconFor(label3, path, "chart"), depth);
      }
      return place(top.attr, "central", sub || "Centrais e integrações", "normal", iconFor(label3, path, "link"), depth);
    }
    if (key === "config") {
      return place("administracao", "general", sub || "Configurações", "normal", iconFor(label3, path, "settings"), depth);
    }
    return place("administracao", "other", "Mais", "normal", iconFor(label3, path), 0);
  }

  // src/catalog/verified.js
  var VERIFIED_ROUTES = Object.freeze([
    { id: "dashboard", exact: "/v2/dashboard", source: "M1 §1.3" },
    { id: "knowledge-base", exact: "/knowledge-base/home", source: "M1 §1.3" },
    { id: "tasks", exact: "/v2/tasks", source: "M1 §1.3" },
    { id: "fraud", exact: "/v2/fraud", source: "M1 §1.3" },
    { id: "protocol-list", exact: "/v2/protocol", source: "M1 §1.3 (/v2/protocol?status=…)" },
    { id: "protocol-select-type", exact: "/v2/protocol/select-type", source: "M1 §1.5" },
    { id: "protocol-create", pattern: /^\/v2\/company\/protocol\/create\/normal\/company-type\/[134567]$/, source: "M1 §1.3" },
    { id: "service-conference", exact: "/service-conference", source: "M1 §1.3" },
    { id: "draft-conference", exact: "/draft-conference", source: "M1 §1.3" },
    { id: "profile-category", pattern: /^\/v2\/profile\/category\/(1|2|3|4|17)$/, source: "M1 §1.3" },
    { id: "book", pattern: /^\/v2\/(rcpn|rcpj|ri|rtd|tn|tp)-[^/?]*-book/, source: "M1 §1.3" },
    { id: "import-book", pattern: /^\/v2\/tmp-[^/?]*-book/, source: "M1 §1.3" },
    { id: "backup-book", pattern: /^\/v2\/manager\/backup\/notary-book\/[^/]+$/, source: "M1 §1.3" },
    { id: "report-legacy", prefix: "/report/", source: "M1 §1.3" },
    { id: "report-v2", pattern: /^\/v2\/report\/company-type\/\d+\//, source: "M1 §1.3" },
    { id: "finance-legacy", prefix: "/finance/", source: "M1 §1.3, §1.4" },
    { id: "finance-v2", prefix: "/v2/finance/", source: "M1 §1.3" },
    { id: "tj-v2", prefix: "/v2/tj-request/", source: "M1 §1.3" },
    { id: "tj-legacy", prefix: "/tj-request/", source: "M1 §1.3" },
    { id: "doi", pattern: /^\/v2\/doi\/company-type\/\d+$/, source: "M1 §1.3" },
    { id: "central-doi", prefix: "/v2/central-doi/", source: "M1 §1.3" },
    { id: "cnib", prefix: "/cnib-requests", source: "M1 §1.3" },
    { id: "onr-v2", prefix: "/v2/onr-", source: "M1 §1.3" },
    { id: "onr", prefix: "/onr/4/", source: "M1 §1.3" },
    { id: "tn-extrajudicial", prefix: "/company-type/tn/extrajudicial-reports/", source: "M1 §1.3" },
    { id: "rcpn-extrajudicial", prefix: "/company-type/rcpn/extrajudicial-reports/", source: "M1 §1.3" },
    { id: "tp-company-type", prefix: "/company-type/tp/", source: "M1 §1.3" },
    { id: "rtd-central", pattern: /^\/company-type\/rtd\/.*central-rtdpj/, source: "M1 §1.3" },
    { id: "cra", prefix: "/v2/extrajudicial-reports/cra/", source: "M1 §1.3" },
    { id: "qualification", prefix: "/qualification/", source: "M1 §1.3" },
    { id: "company-settings", prefix: "/company/", source: "M1 §1.3" }
  ]);
  function matchVerified(path) {
    return VERIFIED_ROUTES.find((r) => {
      if (r.exact) return r.exact === path;
      if (r.prefix) return path.startsWith(r.prefix);
      return r.pattern.test(path);
    }) || null;
  }
  var isVerified = (path) => matchVerified(path) !== null;

  // src/catalog/build.js
  var TABS = Object.freeze([
    { id: "inicio", label: "Início", short: "Início" },
    { id: "servicos", label: "Serviços", short: "Serviços" },
    ...ATTRIBUTIONS.map((a) => ({ id: a.id, label: a.label, short: a.short, attribution: true })),
    { id: "financeiro", label: "Financeiro", short: "Financeiro" },
    { id: "administracao", label: "Administração", short: "Administração" }
  ]);
  var slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  function buildModel(items, baseUrl) {
    const stats = { total: items.length, shown: 0, denied: 0, external: 0, invalid: 0, duplicate: 0, other: 0, verified: 0 };
    const tabs = new Map(TABS.map((t) => [t.id, { ...t, groups: /* @__PURE__ */ new Map() }]));
    const seen = /* @__PURE__ */ new Set();
    let sequence = 0;
    for (const item of items) {
      const n = normalizeHref(item.href, baseUrl);
      if (!n.ok) {
        stats[n.reason === "external" ? "external" : "invalid"]++;
        continue;
      }
      if (isDenied(n.path, item.label)) {
        stats.denied++;
        continue;
      }
      if (seen.has(n.key)) {
        stats.duplicate++;
        continue;
      }
      seen.add(n.key);
      const c = classify({ label: item.label, ancestors: item.ancestors, path: n.path });
      const tab = tabs.get(c.tab);
      if (!tab) continue;
      const gkey = `${c.kind}|${c.group}`;
      let group = tab.groups.get(gkey);
      if (!group) {
        const attr = attributionById(c.tab);
        const full = { Importação: "Importação de livros", Backup: "Backup de livros", Livros: "Livros" }[c.group];
        group = {
          id: `${c.tab}:${c.kind}:${slug(c.group)}`,
          kind: c.kind,
          label: c.group === "Livros" && attr ? `Livros de ${attr.short}` : c.group,
          title: full && attr ? `${full} de ${attr.short}` : c.group,
          prominence: c.prominence,
          region: c.kind === "import" || c.kind === "backup" ? "tools" : "main",
          rank: KIND_RANK[c.kind] ?? 5,
          first: sequence,
          commands: []
        };
        tab.groups.set(gkey, group);
      }
      const hint = item.ancestors.slice(c.depth).join(" › ");
      group.commands.push({
        id: n.key,
        key: n.key,
        path: n.path,
        hasQuery: n.search !== "",
        label: c.label || item.label,
        title: item.label,
        hint,
        href: n.url,
        icon: c.icon,
        legacy: !isV2Path(n.path),
        verified: isVerified(n.path),
        prominence: c.prominence
      });
      sequence++;
      stats.shown++;
      if (c.kind === "other") stats.other++;
      if (isVerified(n.path)) stats.verified++;
    }
    const out = [];
    for (const tab of tabs.values()) {
      const groups = [...tab.groups.values()].sort((a, b) => a.rank - b.rank || a.first - b.first);
      if (!groups.length) continue;
      for (const g of groups) disambiguate(g);
      out.push({ id: tab.id, label: tab.label, short: tab.short, groups });
    }
    const commandCount = out.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.commands.length, 0), 0);
    const signature = out.map((t) => t.groups.map((g) => g.commands.map((c) => c.key + "|" + c.label).join("\n")).join("\n")).join("\n");
    return { tabs: out, stats, commandCount, signature };
  }
  function disambiguate(group) {
    const count = /* @__PURE__ */ new Map();
    for (const c of group.commands) count.set(c.label, (count.get(c.label) || 0) + 1);
    for (const c of group.commands) if (count.get(c.label) > 1 && c.hint) c.label = `${c.hint} › ${c.label}`;
  }
  function isCurrent(command, current) {
    if (!current || !current.key) return false;
    return command.key === current.key || !command.hasQuery && command.path === current.path;
  }
  function findCurrent(model, current) {
    for (const tab of model.tabs) {
      for (const group of tab.groups) {
        const command = group.commands.find((c) => isCurrent(c, current));
        if (command) return { tab: tab.id, group, command };
      }
    }
    return null;
  }

  // src/catalog/live.js
  var LABEL_KEYS = ["label", "title", "name", "text"];
  var HREF_KEYS = ["href", "url", "link", "route", "path", "to"];
  var CHILD_KEYS = ["children", "items", "submenu", "subMenu", "sub_menu", "submenus", "menu", "links", "childs"];
  var SKIP_KEYS = /auth|user|token|session|csrf|password|permission/i;
  var MAX_DEPTH = 8;
  var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  var SIDEBAR_TRANSIENT = Object.freeze(["no-app", "no-vnode", "no-candidate", "no-resolver", "empty-tree", "route-failed"]);
  var compName = (c) => c && c.type && (c.type.__name || c.type.name);
  function inMainNav(c) {
    let p = c.parent;
    for (let i = 0; p && i < 60; i += 1, p = p.parent) {
      const n = compName(p);
      if (n === "NavMain" || n === "SidebarNavigationGroup") return true;
    }
    return false;
  }
  function findCandidates(root) {
    const seen = /* @__PURE__ */ new Set();
    const found = [];
    function visit(v, depth) {
      if (!v || typeof v !== "object" || seen.has(v) || depth > 80) return;
      seen.add(v);
      const c = v.component;
      if (c) {
        if (compName(c) === "RecursiveSidebarMenu" && !c.props?.isRecursiveChild && Array.isArray(c.props?.navItems) && !c.isUnmounted && !c.isDeactivated) found.push(c);
        visit(c.subTree, depth + 1);
      }
      if (Array.isArray(v.children)) for (const child of v.children) visit(child, depth + 1);
      if (v.ssContent) visit(v.ssContent, depth + 1);
    }
    visit(root, 0);
    return found;
  }
  function flattenNavItems(component) {
    const out = [];
    let failure = null;
    function flatten(nodes, ancestors, depth) {
      if (!Array.isArray(nodes) || depth > MAX_DEPTH) {
        failure = failure || "tree-malformed";
        return;
      }
      for (const node of nodes) {
        if (!isObject(node) || typeof node.title !== "string") {
          failure = failure || "tree-malformed";
          return;
        }
        if (Array.isArray(node.children) && node.children.length) {
          flatten(node.children, [...ancestors, node.title], depth + 1);
        } else if (node.urlItem?.url) {
          try {
            const u = node.urlItem;
            const href = String(component.proxy.route(u.url, { ...u.params, ...u.query }));
            out.push({ label: node.title, href, ancestors: ancestors.slice(), order: out.length });
          } catch (e) {
            failure = failure || "route-failed";
          }
        }
      }
    }
    flatten(component.props.navItems, [], 0);
    return { items: out, failure };
  }
  var sameItems = (a, b) => a.length === b.length && a.every((x, i) => x.label === b[i].label && x.href === b[i].href);
  function readSidebarDetailed(win) {
    let root = null;
    try {
      root = win.document.getElementById("app");
    } catch (e) {
    }
    if (!root) return { status: "no-app", items: null, candidates: 0 };
    const vnode = root._vnode;
    if (!vnode) return { status: "no-vnode", items: null, candidates: 0 };
    const found = findCandidates(vnode);
    if (!found.length) return { status: "no-candidate", items: null, candidates: 0 };
    const usable = found.filter((c) => typeof c.proxy?.route === "function");
    if (!usable.length) return { status: "no-resolver", items: null, candidates: found.length };
    const scoped = usable.filter(inMainNav);
    const chosen = scoped.length ? scoped : usable;
    const parsed = [];
    for (const c of chosen) {
      const { items, failure } = flattenNavItems(c);
      if (failure) return { status: failure, items: null, candidates: found.length };
      if (items.length) parsed.push(items);
    }
    if (!parsed.length) return { status: "empty-tree", items: null, candidates: found.length };
    let merged;
    if (scoped.length) {
      merged = parsed.flat().map((x, i) => ({ ...x, order: i }));
    } else {
      if (parsed.some((p) => !sameItems(p, parsed[0]))) return { status: "ambiguous", items: null, candidates: found.length };
      merged = parsed[0];
    }
    return { status: "ok", items: merged, candidates: found.length };
  }
  var pickString = (node, keys) => {
    for (const k of keys) if (typeof node[k] === "string" && node[k].trim()) return node[k].trim();
    return "";
  };
  function flattenMenu(menu) {
    const out = [];
    const walk = (node, ancestors, depth) => {
      if (depth > MAX_DEPTH) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, ancestors, depth + 1);
        return;
      }
      if (!isObject(node)) return;
      const label3 = pickString(node, LABEL_KEYS);
      const href = pickString(node, HREF_KEYS);
      const kids = CHILD_KEYS.map((k) => node[k]).filter((v) => Array.isArray(v) || isObject(v));
      if (label3 && href && href !== "#") out.push({ label: label3, href, ancestors: ancestors.slice(), order: out.length });
      const next = label3 ? [...ancestors, label3] : ancestors;
      if (kids.length) {
        for (const kid of kids) walk(kid, next, depth + 1);
      } else if (!label3 && !href) {
        for (const [k, v] of Object.entries(node)) {
          if (SKIP_KEYS.test(k)) continue;
          if (Array.isArray(v) || isObject(v)) walk(v, ancestors, depth + 1);
        }
      }
    };
    walk(menu, [], 0);
    return out;
  }
  function readMenu(win, page) {
    const fromPage = page && page.props && page.props.menu;
    if (fromPage) return { menu: fromPage, source: "event" };
    try {
      const state = win.history && win.history.state;
      const menu = state && state.page && state.page.props && state.page.props.menu;
      if (menu) return { menu, source: "history" };
    } catch (e) {
    }
    try {
      const script = win.document.querySelector('script[data-page="app"]');
      if (script && script.textContent) {
        const menu = JSON.parse(script.textContent).props.menu;
        if (menu) return { menu, source: "script" };
      }
    } catch (e) {
    }
    return null;
  }
  function menuShape(menu, depth = 0) {
    if (Array.isArray(menu)) {
      return { type: `array(${menu.length})`, item: depth < 4 && menu.length ? menuShape(menu[0], depth + 1) : void 0 };
    }
    if (isObject(menu)) {
      const keys = {};
      for (const [k, v] of Object.entries(menu)) {
        if (SKIP_KEYS.test(k)) {
          keys[k] = "omitido";
          continue;
        }
        keys[k] = depth < 4 && (Array.isArray(v) || isObject(v)) ? menuShape(v, depth + 1) : typeof v;
      }
      return { type: "object", keys };
    }
    return { type: typeof menu };
  }

  // src/compat/selftest.js
  var CHECKS = [
    ["sidebar", 'Sidebar nativa [data-slot="sidebar"]', (d) => d.querySelector('[data-slot="sidebar"]')],
    ["inset", 'Área de conteúdo [data-slot="sidebar-inset"]', (d) => d.querySelector('[data-slot="sidebar-inset"]')],
    ["header", "Cabeçalho nativo main > header", (d) => d.querySelector("main > header")],
    ["breadcrumb", "Breadcrumb .app-breadcrumb-bar", (d) => d.querySelector(".app-breadcrumb-bar")],
    ["search", 'Busca nativa (Ctrl+K) [aria-label="Buscar"]', (d) => d.querySelector('[aria-label="Buscar"]')],
    ["inertia", 'Página Inertia script[data-page="app"]', (d) => d.querySelector('script[data-page="app"]')]
  ];
  function runSelfTest(doc) {
    const checks = CHECKS.map(([id3, label3, probe]) => {
      let ok = false;
      try {
        ok = !!probe(doc);
      } catch (e) {
        ok = false;
      }
      return { id: id3, label: label3, ok };
    });
    return { checks, failed: checks.filter((c) => !c.ok).map((c) => c.id) };
  }
  function checkEnvironment(win) {
    const problems = [];
    if (!win.document || typeof win.document.documentElement.attachShadow !== "function") problems.push("shadow-dom");
    if (typeof win.URL !== "function") problems.push("url");
    return problems;
  }

  // src/detect/layout.js
  function detectLayout(doc) {
    if (doc.querySelector("#mainnav-menu")) return "legacy";
    const app3 = doc.getElementById("app");
    if (doc.querySelector('[data-slot="sidebar"]') || doc.querySelector('script[data-page="app"]') || app3 && app3.__vue_app__) {
      return "v2";
    }
    return "unknown";
  }

  // src/detect/module.js
  var INICIO = /^\/(v2\/(dashboard|tasks|fraud)|knowledge-base)(\/|$)/;
  var SERVICOS = /^\/(v2\/(protocol|profile|company\/protocol)|service-conference|draft-conference)(\/|$)/;
  var FINANCEIRO = /^\/(v2\/)?(finance|tj-request)(\/|$)/;
  function detectModule(pathname, base = "https://app.nocartorio.com/") {
    const n = normalizeHref(pathname, base);
    if (!n.ok) return null;
    const attr = attributionFromPath(n.path);
    if (attr) return attr;
    if (INICIO.test(n.path)) return "inicio";
    if (SERVICOS.test(n.path)) return "servicos";
    if (FINANCEIRO.test(n.path)) return "financeiro";
    return null;
  }

  // src/ribbon/navigate.js
  function createNavigator(win) {
    return {
      go(href) {
        const n = normalizeHref(href, win.location.href);
        if (!n.ok) return "blocked";
        const target = new URL(n.url);
        if (isV2Path(n.path)) {
          try {
            const app3 = win.document.getElementById("app");
            const inertia = app3 && app3.__vue_app__ && app3.__vue_app__.config.globalProperties.$inertia;
            if (inertia && typeof inertia.visit === "function") {
              inertia.visit(target.pathname + target.search + target.hash);
              return "inertia";
            }
          } catch (e) {
          }
        }
        win.location.assign(target.href);
        return "assign";
      }
    };
  }

  // src/theme/electric-blue.js
  var electric_blue_exports = {};
  __export(electric_blue_exports, {
    globalCss: () => globalCss,
    id: () => id,
    label: () => label,
    ribbonCss: () => ribbonCss,
    swatch: () => swatch
  });

  // src/theme/tokens.js
  var WITH_HEX = /* @__PURE__ */ new Set([
    "primary",
    "primary-foreground",
    "background",
    "foreground",
    "card",
    "card-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "info",
    "info-foreground",
    "success",
    "success-foreground",
    "warning",
    "warning-foreground",
    "border",
    "input",
    "ring"
  ]);
  function appTokensCss(selector, tokens) {
    const lines = ["color-scheme: light;"];
    for (const [name, value] of Object.entries(tokens)) {
      lines.push(`--${name}: ${value} !important;`);
      if (WITH_HEX.has(name)) lines.push(`--${name}-hex: ${value} !important;`);
    }
    return `${selector} {
  ${lines.join("\n  ")}
}`;
  }
  function surfaceRamp(ramp) {
    const out = {};
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].forEach((step, i) => {
      out[`color-surface-${step}`] = ramp[i];
    });
    return out;
  }
  function ribbonVarsCss(themeId, vars) {
    const body = Object.entries(vars).map(([k, v]) => `--ncr-${k}: ${v};`).join("\n  ");
    return `:host([data-theme="${themeId}"]) {
  ${body}
}`;
  }
  var rootSelector = (themeId) => `html[data-ncr="on"][data-ncr-theme="${themeId}"]`;

  // src/theme/electric-blue.js
  var id = "electric-blue";
  var label = "Electric Blue";
  var swatch = ["#0a1a3a", "#1f6bff"];
  var app = {
    primary: "#1f6bff",
    "primary-foreground": "#ffffff",
    background: "#f4f7fc",
    foreground: "#0f1b33",
    card: "#ffffff",
    "card-foreground": "#0f1b33",
    popover: "#ffffff",
    "popover-foreground": "#0f1b33",
    secondary: "#14213d",
    "secondary-foreground": "#eaf1ff",
    muted: "#eaf0fb",
    "muted-foreground": "#55627d",
    accent: "#e3ecfd",
    "accent-foreground": "#0e2a66",
    destructive: "#d92d20",
    "destructive-foreground": "#ffffff",
    info: "#00a3d9",
    "info-foreground": "#ffffff",
    success: "#12a56f",
    "success-foreground": "#ffffff",
    warning: "#f5a300",
    "warning-foreground": "#0f1b33",
    border: "#dbe4f3",
    input: "#dbe4f3",
    ring: "#4d8dff",
    ...surfaceRamp([
      "#f3f6fc",
      "#e5ebf6",
      "#cfd9ec",
      "#aebcd8",
      "#8294b8",
      "#5f7195",
      "#475879",
      "#33425f",
      "#1f2b45",
      "#101a30",
      "#0a1224"
    ]),
    // o laranja original do sistema (item ativo do menu etc.) vira azul elétrico
    "color-orange-400": "#4d8dff",
    "color-orange-500": "#1f6bff",
    "color-orange-600": "#1553d6",
    "chart-1": "#1f6bff",
    "chart-2": "#00c2ff",
    "chart-3": "#7c5cff",
    "chart-4": "#12b886",
    "chart-5": "#f5a300",
    sidebar: "#101a30",
    "sidebar-foreground": "#eaf1ff",
    "sidebar-primary": "#1f6bff",
    "sidebar-primary-foreground": "#ffffff",
    "sidebar-accent": "#1f2b45",
    "sidebar-accent-foreground": "#ffffff",
    "sidebar-border": "rgba(77, 141, 255, .28)",
    "sidebar-ring": "#4d8dff",
    "vis-color0": "#1f6bff",
    "vis-color1": "#00c2ff",
    "vis-color2": "#7c5cff",
    "vis-color3": "#12b886",
    "vis-color4": "#f5a300",
    "vis-color5": "#e5484d",
    "vis-plotline-color": "#1f6bff",
    "vis-axis-grid-color": "#e1e8f5"
  };
  var ribbon = {
    bar: "linear-gradient(180deg, #0c204a 0%, #081632 100%)",
    "bar-fg": "#eef3fc",
    "bar-muted": "#9db2d6",
    accent: "#1f6bff",
    "accent-fg": "#ffffff",
    "accent-2": "#31a8ff",
    panel: "#f4f6f9",
    "panel-fg": "#162030",
    "panel-muted": "#5c6b87",
    "group-line": "#e0e6f0",
    hover: "#e9effa",
    active: "#dce8fa",
    "featured-bg": "#eaf1fd",
    "featured-line": "#b2c8f2",
    "tools-fg": "#697894",
    focus: "#1f6bff",
    shadow: "0 6px 18px -10px rgba(8, 22, 50, .5)"
  };
  var globalCss = [
    appTokensCss(rootSelector(id), app),
    `${rootSelector(id)} { --ncr-accent-line: linear-gradient(90deg, #1f6bff, #00c2ff 60%, #1f6bff); --ncr-primary-gradient: linear-gradient(135deg, #3d84ff 0%, #1f6bff 55%, #1553d6 100%); }`
  ].join("\n");
  var ribbonCss = ribbonVarsCss(id, ribbon);

  // src/theme/hot-wheels.js
  var hot_wheels_exports = {};
  __export(hot_wheels_exports, {
    globalCss: () => globalCss2,
    id: () => id2,
    label: () => label2,
    ribbonCss: () => ribbonCss2,
    swatch: () => swatch2
  });
  var id2 = "hot-wheels";
  var label2 = "Hot Wheels";
  var swatch2 = ["#14171c", "#e4002b"];
  var app2 = {
    primary: "#e4002b",
    "primary-foreground": "#ffffff",
    background: "#f4f5f7",
    foreground: "#14161a",
    card: "#ffffff",
    "card-foreground": "#14161a",
    popover: "#ffffff",
    "popover-foreground": "#14161a",
    secondary: "#1b1e24",
    "secondary-foreground": "#f5f6f8",
    muted: "#eef0f4",
    "muted-foreground": "#5f6673",
    accent: "#fdeceb",
    "accent-foreground": "#7d1523",
    destructive: "#d71920",
    "destructive-foreground": "#ffffff",
    info: "#0e9fff",
    "info-foreground": "#ffffff",
    success: "#0f9f6e",
    "success-foreground": "#ffffff",
    warning: "#f5a300",
    "warning-foreground": "#14161a",
    border: "#e3e6ed",
    input: "#e3e6ed",
    ring: "#ff6a00",
    ...surfaceRamp([
      "#f4f5f7",
      "#e7e9ee",
      "#d3d7e0",
      "#b3b9c6",
      "#8b93a3",
      "#69707f",
      "#4f5664",
      "#3a404b",
      "#262b34",
      "#14171c",
      "#0b0d10"
    ]),
    "color-orange-400": "#ff7a2b",
    "color-orange-500": "#ff5a00",
    "color-orange-600": "#d94a00",
    "chart-1": "#e4002b",
    "chart-2": "#ff6a00",
    "chart-3": "#ffc300",
    "chart-4": "#0e9fff",
    "chart-5": "#7c3aed",
    sidebar: "#14171c",
    "sidebar-foreground": "#f4f5f7",
    "sidebar-primary": "#e4002b",
    "sidebar-primary-foreground": "#ffffff",
    "sidebar-accent": "#262b34",
    "sidebar-accent-foreground": "#ffffff",
    "sidebar-border": "rgba(228, 0, 43, .30)",
    "sidebar-ring": "#ff6a00",
    "vis-color0": "#e4002b",
    "vis-color1": "#ff6a00",
    "vis-color2": "#ffc300",
    "vis-color3": "#0e9fff",
    "vis-color4": "#7c3aed",
    "vis-color5": "#12b886",
    "vis-plotline-color": "#e4002b",
    "vis-axis-grid-color": "#e6e9ef"
  };
  var ribbon2 = {
    bar: "linear-gradient(180deg, #181c22 0%, #0e1116 100%)",
    "bar-fg": "#f5f6f8",
    "bar-muted": "#9ba3b1",
    accent: "#ff6a00",
    "accent-fg": "#1a0f00",
    "accent-2": "#ff3b30",
    panel: "#1c2027",
    "panel-fg": "#f1f3f6",
    "panel-muted": "#9aa2b0",
    "group-line": "#303642",
    hover: "#292f3a",
    active: "#332a22",
    "featured-bg": "#251f1a",
    "featured-line": "#8a541f",
    "tools-fg": "#8590a0",
    focus: "#ff6a00",
    shadow: "0 6px 18px -10px rgba(0, 0, 0, .8)"
  };
  var globalCss2 = [
    appTokensCss(rootSelector(id2), app2),
    `${rootSelector(id2)} { --ncr-accent-line: linear-gradient(90deg, #ff6a00, #ff3b30 55%, #ffc300 85%, #ff6a00); --ncr-primary-gradient: linear-gradient(135deg, #ff7a1f 0%, #ff5a00 55%, #e04a00 100%); }`
  ].join("\n");
  var ribbonCss2 = ribbonVarsCss(id2, ribbon2);

  // src/theme/ids.js
  var THEME_IDS = Object.freeze(["electric-blue", "hot-wheels"]);
  var DEFAULT_THEME = "electric-blue";
  var isThemeId = (v) => THEME_IDS.includes(v);

  // src/theme/manager.js
  var THEMES = Object.freeze({ [id]: electric_blue_exports, [id2]: hot_wheels_exports });
  var THEME_LIST = Object.freeze([electric_blue_exports, hot_wheels_exports]);
  var ribbonThemeCss = THEME_LIST.map((t) => t.ribbonCss).join("\n");
  var BASE_CSS = `
/* Neutraliza a skin Barbie/Hot Wheels antiga enquanto a Reimagined está ativa */
html[data-ncr="on"] #nc-skin-switcher,
html[data-ncr="on"] #nc-skin-hint { display: none !important; }

/* Sidebar nativa oculta só por CSS (nenhum nó do Vue é movido nem removido) */
html[data-ncr="on"][data-ncr-sidebar="hidden"] [data-slot="sidebar"] { display: none !important; }
html[data-ncr="on"] [data-slot="sidebar-wrapper"] {
  min-height: calc(100svh - var(--ncr-ribbon-h, 0px)) !important;
}

/* Acabamentos do cabeçalho nativo e dos botões primários */
html[data-ncr="on"] main > header { position: relative; }
html[data-ncr="on"] main > header::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
  background: var(--ncr-accent-line); pointer-events: none;
}
html[data-ncr="on"] [data-slot="button"].bg-primary { background-image: var(--ncr-primary-gradient) !important; }
html[data-ncr="on"] :focus-visible { outline-color: var(--ring); }
`;
  var globalThemeCss = BASE_CSS + THEME_LIST.map((t) => t.globalCss).join("\n");
  function createThemeManager(doc) {
    const root = doc.documentElement;
    const STYLE_ID = "ncr-style";
    const ensureStyle = () => {
      let style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement("style");
        style.id = STYLE_ID;
        (doc.head || root).appendChild(style);
      }
      if (style.textContent !== globalThemeCss) style.textContent = globalThemeCss;
    };
    return {
      install(theme) {
        ensureStyle();
        root.setAttribute("data-ncr", "on");
        this.apply(theme);
      },
      apply(theme) {
        root.setAttribute("data-ncr-theme", isThemeId(theme) ? theme : DEFAULT_THEME);
      },
      setSidebarHidden(hidden) {
        if (hidden) root.setAttribute("data-ncr-sidebar", "hidden");
        else root.removeAttribute("data-ncr-sidebar");
      },
      setRibbonHeight(px) {
        root.style.setProperty("--ncr-ribbon-h", `${Math.max(0, Math.round(px))}px`);
      },
      // Reaplica o que o Inertia/Vue poderia ter descartado (idempotente).
      ensure(theme, sidebarHidden) {
        if (root.getAttribute("data-ncr") !== "on" || !doc.getElementById(STYLE_ID)) this.install(theme);
        if (root.getAttribute("data-ncr-theme") !== theme) this.apply(theme);
        this.setSidebarHidden(sidebarHidden);
      },
      uninstall() {
        ["data-ncr", "data-ncr-theme", "data-ncr-sidebar"].forEach((a) => root.removeAttribute(a));
        root.style.removeProperty("--ncr-ribbon-h");
        if (root.getAttribute("style") === "") root.removeAttribute("style");
        const style = doc.getElementById(STYLE_ID);
        if (style) style.remove();
      }
    };
  }

  // src/ribbon/icons.js
  var P = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    alert: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="M12 8v5M12 16.5v.5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.5"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    checkList: '<path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h10M11 12h10M11 18h10"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.6-4 3.8-6 8-6s7.4 2 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
    building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
    landmark: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
    pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-1.5 1.7-2 3-2s2.5.5 3 2M15 10h3M15 14h3"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5V5.5M8 7h8"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
    chart: '<path d="M4 20V4M4 20h16M8 16v-5M13 16V8M18 16v-3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    scale: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z"/>',
    bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
    cert: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    dot: '<circle cx="12" cy="12" r="3"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    power: '<path d="M12 3v9M6.5 6.5a8 8 0 1 0 11 0"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    ribbonMode: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="m9 13.5 3 3 3-3"/>',
    pinRibbon: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>'
  };
  var hasIcon = (name) => Object.prototype.hasOwnProperty.call(P, name);
  function iconSvg(name, size = 18) {
    const body = hasIcon(name) ? P[name] : P.dot;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // src/ribbon/layout.js
  function collapsePriority(group) {
    return (group.region === "tools" ? 1e3 : 0) + (group.rank ?? 0);
  }
  var DEFAULT_SAFETY = 2;
  function computeVisibleGroups(groups, widths, availableWidth, opts = {}) {
    const moreWidth = opts.moreWidth ?? 48;
    const safety = opts.safety ?? DEFAULT_SAFETY;
    const budget = Math.max(0, availableWidth - moreWidth);
    const order = [...groups].sort((a, b) => {
      const d = collapsePriority(b) - collapsePriority(a);
      if (d !== 0) return d;
      return groups.indexOf(b) - groups.indexOf(a);
    });
    let used = 0;
    for (const g of groups) used += widths[g.id] || 0;
    const hidden = [];
    const hiddenSet = /* @__PURE__ */ new Set();
    for (const g of order) {
      if (used <= budget + safety) break;
      if (hiddenSet.size >= groups.length - 1) break;
      hiddenSet.add(g.id);
      hidden.push(g.id);
      used -= widths[g.id] || 0;
    }
    const shown = groups.filter((g) => !hiddenSet.has(g.id)).map((g) => g.id);
    return { hidden, shown, moreVisible: hidden.length > 0 };
  }

  // src/ribbon/styles.js
  var RIBBON_CSS = `
:host {
  all: initial;
  display: block;
  position: sticky;
  top: 0;
  z-index: 45;
  font: 13px/1.25 "Open Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  color: var(--ncr-panel-fg);
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.ribbon { box-shadow: var(--ncr-shadow); }
svg { display: block; flex: none; }

button, a { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--ncr-focus); outline-offset: 1px; border-radius: 4px; }

/* ---- barra de abas ---- */
.titlebar {
  display: flex; align-items: flex-end; gap: 8px; padding: 4px 8px 0;
  background: var(--ncr-bar); color: var(--ncr-bar-fg);
}
.brand {
  display: flex; flex-direction: column; justify-content: center; padding: 0 4px 4px 2px;
  font-weight: 700; letter-spacing: .01em; white-space: nowrap; line-height: 1.05;
}
.brand small { font-size: 9px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--ncr-accent-2); }
.tabs { display: flex; gap: 2px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.tab {
  position: relative; padding: 7px 12px 6px; border-radius: 6px 6px 0 0; white-space: nowrap;
  color: var(--ncr-bar-muted); font-weight: 600; border-top: 3px solid transparent;
  transition: background-color .15s ease, color .15s ease;
}
.tab:hover { color: var(--ncr-bar-fg); background: rgba(255,255,255,.08); }
.tab[aria-selected="true"] {
  background: var(--ncr-panel); color: var(--ncr-panel-fg); border-top-color: var(--ncr-accent);
}
.tab .full { display: none; }
.actions { display: flex; align-items: center; gap: 3px; padding-bottom: 4px; flex: none; }
.iconbtn {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: 6px;
  color: var(--ncr-bar-muted); font-size: 12px; white-space: nowrap;
}
.iconbtn:hover { color: var(--ncr-bar-fg); background: rgba(255,255,255,.1); }
.iconbtn[aria-pressed="true"] { color: var(--ncr-bar-fg); background: rgba(255,255,255,.14); }
.themes { display: inline-flex; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 1px; gap: 1px; margin-right: 2px; }
.theme {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  color: var(--ncr-bar-muted); font-size: 12px; font-weight: 600; white-space: nowrap;
}
.theme i { width: 9px; height: 9px; border-radius: 50%; background: var(--sw); box-shadow: 0 0 0 1px rgba(255,255,255,.4); }
.theme[aria-checked="true"] { background: var(--ncr-accent); color: var(--ncr-accent-fg); }

/* ---- painel da aba ---- */
.panel {
  position: relative;
  display: flex; align-items: stretch; gap: 0; padding: 5px 6px 4px;
  background: var(--ncr-panel); color: var(--ncr-panel-fg);
  border-bottom: 1px solid var(--ncr-group-line);
}
.group { display: flex; flex-direction: column; padding: 0 7px; border-right: 1px solid var(--ncr-group-line); flex: 0 0 auto; }
.group:last-of-type { border-right: 0; }
.group-body { display: flex; align-items: stretch; gap: 2px; flex: 1 1 auto; }
.group-title {
  margin-top: 3px; text-align: center; font-size: 10px; color: var(--ncr-panel-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
.tools { margin-left: auto; display: flex; flex: 0 0 auto; padding-left: 6px; }
.tools .group { border-right: 0; border-left: 1px dashed var(--ncr-group-line); }

.cmd {
  position: relative; display: flex; align-items: center; gap: 6px; text-decoration: none; border-radius: 5px;
  color: var(--ncr-panel-fg); border-bottom: 2px solid transparent;
  transition: background-color .12s ease;
}
.cmd:hover { background: var(--ncr-hover); }
.cmd[aria-current="page"] { background: var(--ncr-active); border-bottom-color: var(--ncr-accent); font-weight: 700; }
.cmd .lg { font-size: 10px; color: var(--ncr-panel-muted); margin-left: 2px; }
.cmd svg { color: var(--ncr-accent); }

/* botões grandes: funções frequentes */
.prom-primary .cmd, .prom-featured .cmd {
  flex-direction: column; justify-content: flex-start; text-align: center; gap: 3px;
  min-width: 62px; max-width: 92px; padding: 5px 5px 3px; font-size: 12px;
}
.prom-primary .cmd svg, .prom-featured .cmd svg { width: 24px; height: 24px; }
.prom-primary .cmd span, .prom-featured .cmd span {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: break-word;
}
.prom-primary .cmd .lg, .prom-featured .cmd .lg { position: absolute; top: 2px; right: 4px; margin: 0; }
/* livros: grupo destacado */
.group.prom-featured {
  background: var(--ncr-featured-bg); border-color: var(--ncr-featured-line); border-radius: 7px; margin-right: 6px;
}
.group.prom-featured .group-title { color: var(--ncr-accent); font-weight: 700; }
.group.prom-featured .group-body { flex-wrap: wrap; max-width: 460px; }

/* botões pequenos: até 3 linhas por coluna, estilo Office */
.prom-normal .group-body, .prom-secondary .group-body {
  display: grid; grid-auto-flow: column; grid-template-rows: repeat(3, 24px); column-gap: 6px; align-content: start;
}
.prom-normal .cmd, .prom-secondary .cmd { padding: 0 7px 0 4px; height: 24px; max-width: 196px; }
.prom-normal .cmd svg, .prom-secondary .cmd svg { width: 15px; height: 15px; }
.prom-normal .cmd span, .prom-secondary .cmd span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ferramentas secundárias (importação/backup): discretas */
.prom-secondary { opacity: .92; }
.prom-secondary .cmd { font-size: 12px; color: var(--ncr-tools-fg); }
.prom-secondary .cmd svg { color: var(--ncr-tools-fg); }
.prom-secondary .group-title { font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }

/* ---- botão "Mais" (comandos recolhidos) ---- */
.more {
  flex: 0 0 auto; align-self: center; margin-left: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 6px; color: var(--ncr-panel-fg);
  border: 1px solid var(--ncr-group-line); background: var(--ncr-panel);
}
.more:hover { background: var(--ncr-hover); }
.more[aria-expanded="true"] { background: var(--ncr-active); border-color: var(--ncr-accent); }
.more.off { display: none !important; }
.more-menu {
  position: absolute; top: calc(100% + 1px); right: 6px; z-index: 60;
  min-width: 200px; max-width: 320px; max-height: 60vh; overflow: auto;
  padding: 4px; border-radius: 8px; border: 1px solid var(--ncr-group-line);
  background: var(--ncr-panel); color: var(--ncr-panel-fg); box-shadow: var(--ncr-shadow);
}
.more-menu .cmd { padding: 6px 8px; border-radius: 5px; }
.more-menu .cmd:hover { background: var(--ncr-hover); }

.empty { padding: 14px; color: var(--ncr-panel-muted); }
.hint { align-self: center; padding: 0 12px; color: var(--ncr-panel-muted); font-size: 12px; white-space: nowrap; }
kbd { font: 600 11px ui-monospace, Consolas, monospace; padding: 1px 5px; border: 1px solid var(--ncr-group-line); border-radius: 4px; }

/* ---- modos de exibição da faixa (como no Word) ---- */
.ribbon { position: relative; }
/* "Mostrar só as guias": o painel abre sobreposto ao conteúdo e some depois do uso */
.ribbon[data-mode="tabs"][data-peek] .panel {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 50;
  box-shadow: var(--ncr-shadow);
}
.ribbon[data-mode="tabs"]:not([data-peek]) .tab[aria-selected="true"] {
  background: transparent; color: var(--ncr-bar-fg); border-top-color: transparent;
  box-shadow: inset 0 -2px 0 var(--ncr-accent);
}
/* "Ocultar automaticamente": só uma faixa fina no topo; um clique mostra tudo por cima */
.ribbon[data-mode="auto"] { position: absolute; top: 0; left: 0; right: 0; z-index: 55; }
.ribbon[data-mode="auto"]:not([data-peek]) { display: none; }
.reveal {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 12px;
  background: var(--ncr-bar); color: var(--ncr-bar-muted); border-bottom: 2px solid var(--ncr-accent);
}
.reveal:hover { color: var(--ncr-bar-fg); background: var(--ncr-accent); }
.pin {
  flex: 0 0 auto; align-self: flex-end; margin-left: auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 5px; color: var(--ncr-panel-muted);
}
.tools ~ .pin, .more ~ .pin { margin-left: 4px; }
.pin:hover { background: var(--ncr-hover); color: var(--ncr-panel-fg); }
.display-menu {
  position: absolute; top: 36px; right: 8px; z-index: 70; width: 290px;
  padding: 4px; border-radius: 8px; border: 1px solid var(--ncr-group-line);
  background: var(--ncr-panel); color: var(--ncr-panel-fg); box-shadow: var(--ncr-shadow);
}
.display-menu .opt {
  display: grid; grid-template-columns: 18px 1fr; column-gap: 8px; align-items: start;
  width: 100%; padding: 7px 8px; border-radius: 5px; text-align: left;
}
.display-menu .opt:hover, .display-menu .opt:focus-visible { background: var(--ncr-hover); }
.display-menu .opt svg { visibility: hidden; color: var(--ncr-accent); margin-top: 1px; }
.display-menu .opt[aria-checked="true"] svg { visibility: visible; }
.display-menu .opt b { display: block; font-weight: 600; }
.display-menu .opt small { grid-column: 2; display: block; font-size: 11px; color: var(--ncr-panel-muted); margin-top: 1px; }
.display-menu .foot { padding: 5px 8px 3px; font-size: 11px; color: var(--ncr-panel-muted); border-top: 1px solid var(--ncr-group-line); margin-top: 3px; }

/* As abas usam sempre o rótulo curto (sigla/nome), com o nome completo em tooltip (title).
   Evita recorte da lista de abas em qualquer largura. */
.tab .full { display: none; }
/* Compactação progressiva da barra de título para caber em desktop menor sem recortar abas. */
@media (max-width: 1360px) {
  .theme .txt { display: none; }
  .iconbtn .txt { display: none; }
  .themes { gap: 0; }
}
@media (max-width: 1120px) {
  .brand { display: none; }
  .brand small { display: none; }
}
@media (max-width: 900px) {
  .group-title { display: none; }
  .prom-primary .cmd, .prom-featured .cmd { min-width: 54px; }
}
@media (max-width: 640px) {
  .tab { padding: 7px 8px 6px; }
  .titlebar { gap: 4px; padding-left: 4px; padding-right: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .tab, .cmd { transition: none; }
}
`;
  var RIBBON_STYLES = ribbonThemeCss + "\n" + RIBBON_CSS;

  // src/ribbon/host.js
  var HOST_ID = "ncr-host";
  function createRibbon({ doc, win, handlers }) {
    const state = {
      model: { tabs: [], signature: "" },
      theme: "electric-blue",
      activeTab: null,
      current: null,
      mode: "always",
      // "peek": faixa aberta temporariamente nos modos "tabs" e "auto"
      peek: false,
      sidebarHidden: true
    };
    const panelVisible = () => state.mode === "always" || state.peek;
    const host = doc.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-ncr-host", "");
    const root = host.attachShadow({ mode: "open" });
    const h = (tag, props = {}, ...kids) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (v === false || v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "text") el.textContent = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
      for (const kid of kids) if (kid) el.append(kid);
      return el;
    };
    const style = h("style", { text: RIBBON_STYLES });
    const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Atribuições" });
    const brand = h("div", { class: "brand" }, h("span", { text: "NoCartório" }), h("small", { text: "Reimagined" }));
    const themeGroup = h("div", { class: "themes", role: "radiogroup", "aria-label": "Tema" });
    const themeButtons = /* @__PURE__ */ new Map();
    for (const t of THEME_LIST) {
      const btn = h("button", {
        class: "theme",
        type: "button",
        role: "radio",
        "data-theme-id": t.id,
        title: `Tema ${t.label}`,
        style: `--sw:${t.swatch[1]}`
      }, h("i"), h("span", { class: "txt", text: t.label }));
      btn.addEventListener("click", () => handlers.onTheme(t.id));
      themeButtons.set(t.id, btn);
      themeGroup.append(btn);
    }
    const sidebarBtn = h("button", {
      class: "iconbtn",
      type: "button",
      "data-action": "sidebar",
      title: "Mostrar ou ocultar a sidebar original do NoCartório"
    });
    const displayBtn = h("button", {
      class: "iconbtn",
      type: "button",
      "data-action": "display",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "ncr-display-menu",
      title: "Opções de exibição da faixa (Ctrl+F1 alterna)",
      "aria-label": "Opções de exibição da faixa",
      html: iconSvg("ribbonMode", 16)
    });
    const disableBtn = h("button", {
      class: "iconbtn",
      type: "button",
      "data-action": "disable",
      title: "Desativar a Reimagined e voltar à interface original",
      html: iconSvg("power", 16) + '<span class="txt">Original</span>'
    });
    sidebarBtn.addEventListener("click", () => handlers.onToggleSidebar());
    displayBtn.addEventListener("click", () => toggleDisplay(!isDisplayOpen()));
    disableBtn.addEventListener("click", () => handlers.onDisable());
    const actions = h("div", { class: "actions" }, themeGroup, sidebarBtn, displayBtn, disableBtn);
    const titlebar = h("div", { class: "titlebar" }, brand, tablist, actions);
    const panel = h("div", { class: "panel", role: "tabpanel", id: "ncr-panel", tabindex: "-1" });
    const ribbon3 = h("div", { class: "ribbon", role: "navigation", "aria-label": "Ribbon NoCartório Reimagined" }, titlebar, panel);
    const reveal = h("button", {
      class: "reveal",
      type: "button",
      "data-action": "reveal",
      hidden: true,
      title: "Mostrar a faixa do NoCartório Reimagined",
      "aria-label": "Mostrar a faixa do NoCartório Reimagined",
      html: iconSvg("more", 14)
    });
    reveal.addEventListener("click", () => setPeek(!state.peek));
    const pinBtn = h("button", {
      class: "pin",
      type: "button",
      "data-action": "pin",
      title: "Fixar a faixa (sempre mostrar)",
      "aria-label": "Fixar a faixa (sempre mostrar)",
      html: iconSvg("pinRibbon", 15)
    });
    pinBtn.addEventListener("click", () => handlers.onRibbonMode("always"));
    const DISPLAY_MODES = [
      { id: "auto", label: "Ocultar automaticamente", hint: "Esconde a faixa inteira; clique na barrinha do topo para mostrá-la." },
      { id: "tabs", label: "Mostrar só as guias", hint: "Os comandos aparecem ao clicar numa guia e somem depois do uso." },
      { id: "always", label: "Sempre mostrar guias e comandos", hint: "A faixa fica fixa no topo, como sempre foi." }
    ];
    const displayMenu = h("div", { class: "display-menu", id: "ncr-display-menu", role: "menu", "aria-label": "Opções de exibição da faixa", hidden: true });
    const displayOpts = /* @__PURE__ */ new Map();
    for (const m of DISPLAY_MODES) {
      const opt = h("button", { class: "opt", type: "button", role: "menuitemradio", "data-mode": m.id, tabindex: "-1" });
      opt.innerHTML = iconSvg("check", 16);
      opt.append(h("span", {}, h("b", { text: m.label })), h("small", { text: m.hint }));
      opt.addEventListener("click", () => {
        closeDisplay(true);
        handlers.onRibbonMode(m.id);
      });
      displayOpts.set(m.id, opt);
      displayMenu.append(opt);
    }
    displayMenu.append(h("div", { class: "foot", html: "Atalho: <kbd>Ctrl</kbd>+<kbd>F1</kbd> ou duplo clique numa guia" }));
    ribbon3.append(displayMenu);
    root.append(style, reveal, ribbon3);
    function isDisplayOpen() {
      return displayBtn.getAttribute("aria-expanded") === "true";
    }
    function closeDisplay(restoreFocus) {
      if (!isDisplayOpen()) return;
      displayBtn.setAttribute("aria-expanded", "false");
      displayMenu.hidden = true;
      if (restoreFocus) {
        try {
          displayBtn.focus();
        } catch (e) {
        }
      }
    }
    function toggleDisplay(force) {
      if (!force) {
        closeDisplay(true);
        return;
      }
      closeMore(false);
      displayBtn.setAttribute("aria-expanded", "true");
      displayMenu.hidden = false;
      const opt = displayOpts.get(state.mode) || displayMenu.querySelector(".opt");
      if (opt) opt.focus();
    }
    displayMenu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeDisplay(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const items = [...displayOpts.values()];
        const at = items.indexOf(root.activeElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === "Tab") {
        closeDisplay(false);
      }
    });
    function setPeek(on) {
      on = !!on && state.mode !== "always";
      if (state.peek === on) return;
      api.update({ peek: on });
    }
    function closePeek(restoreFocus) {
      if (!state.peek) return;
      const hadFocus = root.activeElement != null;
      setPeek(false);
      if (restoreFocus && hadFocus) {
        const target = state.mode === "auto" ? reveal : tabButtons.get(state.activeTab);
        try {
          if (target) target.focus();
        } catch (e) {
        }
      }
    }
    ribbon3.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !state.peek || isMoreOpen() || isDisplayOpen()) return;
      e.preventDefault();
      closePeek(true);
    });
    const moreBtn = h("button", {
      class: "more",
      type: "button",
      "data-action": "more",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "ncr-more-menu",
      title: "Mais comandos",
      html: iconSvg("more", 16)
    });
    const moreMenu = h("div", { class: "more-menu", id: "ncr-more-menu", role: "menu", hidden: true, tabindex: "-1" });
    moreBtn.addEventListener("click", () => toggleMore(!isMoreOpen()));
    function isMoreOpen() {
      return moreBtn.getAttribute("aria-expanded") === "true";
    }
    function closeMore(restoreFocus) {
      if (!isMoreOpen()) return;
      moreBtn.setAttribute("aria-expanded", "false");
      if (restoreFocus !== false) {
        try {
          moreBtn.focus();
        } catch (e) {
        }
      }
      moreMenu.hidden = true;
    }
    function openMore() {
      moreBtn.setAttribute("aria-expanded", "true");
      moreMenu.hidden = false;
      const first = moreMenu.querySelector("a.cmd, button");
      if (first) first.focus();
    }
    const toggleMore = (force) => {
      if (force == null) force = !isMoreOpen();
      if (force) openMore();
      else closeMore(true);
    };
    moreMenu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMore(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const items = [...moreMenu.querySelectorAll("a.cmd")];
        if (!items.length) return;
        const at = items.indexOf(root.activeElement);
        const d = e.key === "ArrowDown" ? 1 : -1;
        items[(at + d + items.length) % items.length].focus();
      } else if (e.key === "Tab") {
        e.stopPropagation();
        closeMore(false);
      }
    });
    const withinMore = (e) => {
      const path = typeof e.composedPath === "function" && e.composedPath() || [];
      return path.includes(moreBtn) || path.includes(moreMenu);
    };
    const pathOf = (e) => typeof e.composedPath === "function" && e.composedPath() || [];
    const withinDisplay = (e) => {
      const path = pathOf(e);
      return path.includes(displayBtn) || path.includes(displayMenu);
    };
    const outsideHost = (e) => !pathOf(e).includes(host);
    const onDocPointerDown = (e) => {
      if (isMoreOpen() && !withinMore(e)) closeMore(false);
      if (isDisplayOpen() && !withinDisplay(e)) closeDisplay(false);
      if (state.peek && outsideHost(e)) closePeek(false);
    };
    const onDocFocusIn = (e) => {
      if (isMoreOpen() && !withinMore(e)) closeMore(false);
      if (isDisplayOpen() && !withinDisplay(e)) closeDisplay(false);
      if (state.peek && outsideHost(e)) closePeek(false);
    };
    doc.addEventListener("pointerdown", onDocPointerDown);
    doc.addEventListener("focusin", onDocFocusIn);
    let tabsSignature = "";
    const tabButtons = /* @__PURE__ */ new Map();
    const renderTabs = () => {
      const sig = state.model.tabs.map((t) => t.id).join(",");
      if (sig !== tabsSignature) {
        tabsSignature = sig;
        tabButtons.clear();
        tablist.replaceChildren();
        for (const tab of state.model.tabs) {
          const btn = h("button", {
            class: "tab",
            type: "button",
            role: "tab",
            id: `ncr-tab-${tab.id}`,
            "data-tab": tab.id,
            "aria-controls": "ncr-panel",
            title: tab.label
          }, h("span", { class: "short", text: tab.short }), h("span", { class: "full", text: tab.label }));
          btn.addEventListener("click", () => {
            if (state.mode !== "always") state.peek = !(state.peek && tab.id === state.activeTab);
            handlers.onSelectTab(tab.id);
          });
          btn.addEventListener("dblclick", (e) => {
            e.preventDefault();
            handlers.onRibbonMode(state.mode === "always" ? "tabs" : "always");
          });
          btn.addEventListener("keydown", onTabKey);
          tabButtons.set(tab.id, btn);
          tablist.append(btn);
        }
      }
      for (const [id3, btn] of tabButtons) {
        const on = id3 === state.activeTab;
        btn.setAttribute("aria-selected", on ? "true" : "false");
        btn.tabIndex = on ? 0 : -1;
      }
      panel.setAttribute("aria-labelledby", `ncr-tab-${state.activeTab}`);
    };
    function onTabKey(e) {
      const ids = [...tabButtons.keys()];
      const at = ids.indexOf(e.currentTarget.dataset.tab);
      let next = null;
      if (e.key === "ArrowRight") next = ids[(at + 1) % ids.length];
      else if (e.key === "ArrowLeft") next = ids[(at - 1 + ids.length) % ids.length];
      else if (e.key === "Home") next = ids[0];
      else if (e.key === "End") next = ids[ids.length - 1];
      else if (e.key === "ArrowDown") {
        if (!panelVisible()) setPeek(true);
        const first = panel.querySelector("a.cmd");
        if (first) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (!next) return;
      e.preventDefault();
      tabButtons.get(next).focus();
      handlers.onSelectTab(next);
    }
    const buildCommand = (cmd) => {
      const a = h("a", {
        class: "cmd",
        href: cmd.href,
        "data-key": cmd.key,
        "data-icon": cmd.icon,
        title: cmd.hint ? `${cmd.hint} › ${cmd.title}` : cmd.title,
        "aria-current": isCurrent(cmd, state.current) ? "page" : false
      });
      a.innerHTML = iconSvg(cmd.icon, 18);
      a.append(h("span", { text: cmd.label }));
      a.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        closePeek(false);
        handlers.onNavigate(cmd.href, cmd);
      });
      return a;
    };
    const buildGroup = (group) => {
      const el = h("div", {
        class: `group prom-${group.prominence}`,
        role: "group",
        "aria-label": group.title,
        "data-group": group.id,
        "data-kind": group.kind
      });
      const body = h("div", { class: "group-body" });
      for (const cmd of group.commands) body.append(buildCommand(cmd));
      el.append(body, h("div", { class: "group-title", title: group.title, text: group.label }));
      return el;
    };
    const groupEls = /* @__PURE__ */ new Map();
    const renderPanel = () => {
      panel.replaceChildren();
      groupEls.clear();
      ribbon3.setAttribute("data-mode", state.mode);
      ribbon3.toggleAttribute("data-peek", state.peek);
      reveal.hidden = state.mode !== "auto";
      reveal.setAttribute("aria-expanded", state.peek ? "true" : "false");
      panel.hidden = !panelVisible();
      const tab = state.model.tabs.find((t) => t.id === state.activeTab);
      if (!tab) {
        panel.append(h("div", { class: "empty", text: "Nenhum comando disponível nesta aba." }));
        return;
      }
      panel.setAttribute("data-tab", tab.id);
      const tools = h("div", { class: "tools", "data-region": "tools" });
      for (const group of tab.groups) {
        const el = buildGroup(group);
        groupEls.set(group.id, { el, region: group.region, rank: group.rank, group });
        (group.region === "tools" ? tools : panel).append(el);
      }
      if (tab.id === "inicio") panel.append(h("div", { class: "hint", html: "Busca nativa: <kbd>Ctrl</kbd>+<kbd>K</kbd>" }));
      if (tools.childElementCount) panel.append(tools);
      if (state.mode !== "always") panel.append(pinBtn);
    };
    const layout = () => {
      const groups = [...groupEls.values()];
      if (!groups.length) {
        ensureMoreHidden();
        return;
      }
      // Mede sempre com todos os grupos visíveis: um grupo escondido mede 0px e, antes, isso
      // fazia o layout alternar sem parar entre "mostrar tudo" e "recolher no Mais" (a faixa piscava).
      // Tudo acontece no mesmo tick, então o navegador não chega a pintar o estado intermediário.
      for (const { el } of groupEls.values()) el.hidden = false;
      if (moreBtn.parentNode === panel) moreBtn.remove();
      const availableWidth = panel.getBoundingClientRect().width;
      const widths = {};
      let measurable = availableWidth > 0;
      for (const [id3, { el }] of groupEls) {
        const w = el.getBoundingClientRect().width;
        widths[id3] = w;
        if (w <= 0) measurable = false;
      }
      if (!measurable) {
        applyLayout(/* @__PURE__ */ new Set());
        ensureMoreHidden();
        return;
      }
      const desc = groups.map(({ group }) => ({ id: group.id, region: group.region, rank: group.rank }));
      const { hidden } = computeVisibleGroups(desc, widths, availableWidth, { moreWidth: state.mode !== "always" ? 80 : 52 });
      applyLayout(new Set(hidden));
    };
    function ensureMoreHidden() {
      moreBtn.classList.toggle("off", true);
      closeMore(false);
      if (moreBtn.parentNode === panel) moreBtn.remove();
    }
    function applyLayout(hiddenIds) {
      const moreCommands = [];
      for (const [id3, { el, group }] of groupEls) {
        if (hiddenIds.has(id3)) {
          el.hidden = true;
          for (const cmd of group.commands) moreCommands.push(cmd);
        } else {
          el.hidden = false;
        }
      }
      moreMenu.replaceChildren();
      for (const cmd of moreCommands) {
        const item = buildCommand(cmd);
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        moreMenu.append(item);
      }
      const needsMore = moreCommands.length > 0;
      moreBtn.classList.toggle("off", !needsMore);
      if (needsMore) {
        if (moreBtn.parentNode !== panel) panel.append(moreBtn, moreMenu);
        if (pinBtn.parentNode === panel) panel.append(pinBtn);
        moreBtn.hidden = false;
      } else {
        if (moreBtn.parentNode === panel) moreBtn.remove();
        if (moreMenu.parentNode) moreMenu.remove();
        closeMore(false);
      }
    }
    panel.addEventListener("keydown", (e) => {
      if (isMoreOpen()) return;
      if (e.key === "Escape") {
        const btn = tabButtons.get(state.activeTab);
        if (btn) {
          e.preventDefault();
          btn.focus();
        }
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const links = [...panel.querySelectorAll("a.cmd")].filter((a) => !a.hidden);
      const at = links.indexOf(root.activeElement);
      if (at < 0) return;
      e.preventDefault();
      links[(at + (e.key === "ArrowRight" ? 1 : -1) + links.length) % links.length].focus();
    });
    const renderActions = () => {
      host.setAttribute("data-theme", state.theme);
      for (const [id3, btn] of themeButtons) btn.setAttribute("aria-checked", id3 === state.theme ? "true" : "false");
      sidebarBtn.setAttribute("aria-pressed", state.sidebarHidden ? "false" : "true");
      sidebarBtn.innerHTML = iconSvg("panel", 16) + '<span class="txt">Sidebar original</span>';
      for (const [id3, opt] of displayOpts) opt.setAttribute("aria-checked", id3 === state.mode ? "true" : "false");
    };
    let resizeObserver = null;
    let lastLayoutWidth = -1;
    const onHostResize = () => {
      const rect = host.getBoundingClientRect();
      if (handlers.onResize) handlers.onResize(rect.height);
      // Só a largura muda o que cabe na faixa; mudanças de altura não refazem o layout
      // (evita um ciclo layout → nova altura → layout).
      if (panelVisible() && Math.round(rect.width) !== lastLayoutWidth) {
        lastLayoutWidth = Math.round(rect.width);
        layout();
      }
    };
    const api = {
      host,
      root,
      get state() {
        return { ...state };
      },
      mount() {
        doc.querySelectorAll(`[data-ncr-host]`).forEach((n) => {
          if (n !== host) n.remove();
        });
        if (!host.isConnected) doc.body.insertBefore(host, doc.body.firstChild);
        if (!resizeObserver && typeof win.ResizeObserver === "function") {
          resizeObserver = new win.ResizeObserver(onHostResize);
          resizeObserver.observe(host);
        }
        onHostResize();
      },
      update(patch = {}) {
        const modelChanged = patch.model && patch.model !== state.model;
        const modeChanged = patch.mode !== void 0 && patch.mode !== state.mode;
        Object.assign(state, patch);
        if (modeChanged || state.mode === "always") state.peek = false;
        renderActions();
        renderTabs();
        renderPanel();
        layout();
        if (modelChanged || patch.mode !== void 0 || patch.peek !== void 0) onHostResize();
      },
      focusTab() {
        const btn = tabButtons.get(state.activeTab);
        if (btn) btn.focus();
      },
      // exposto para testes/inspeção: quantos comandos estão recolhidos no "Mais" nesta aba.
      overflowInfo() {
        const cmds = moreMenu.querySelectorAll("a.cmd").length;
        return { hiddenCommands: cmds, moreVisible: moreBtn.classList.contains("off") === false };
      },
      destroy() {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        doc.removeEventListener("pointerdown", onDocPointerDown);
        doc.removeEventListener("focusin", onDocFocusIn);
        host.remove();
      }
    };
    return api;
  }

  // src/theme/skin-guard.js
  function createSkinGuard(win) {
    let previous = null;
    return {
      present: () => !!(win.__ncSkin && typeof win.__ncSkin.apply === "function"),
      neutralize() {
        const skin = win.__ncSkin;
        if (!skin || typeof skin.apply !== "function") return false;
        const current = skin.theme;
        if (current && current !== "off") {
          if (previous === null) previous = current;
          try {
            skin.apply("off", false);
          } catch (e) {
            return false;
          }
        }
        return true;
      },
      restore() {
        const skin = win.__ncSkin;
        if (previous !== null && skin && typeof skin.apply === "function") {
          try {
            skin.apply(previous, false);
          } catch (e) {
          }
        }
        previous = null;
      },
      get previous() {
        return previous;
      }
    };
  }

  // src/core/killswitch.js
  function readKillParam(search) {
    try {
      const value = new URLSearchParams(search).get("ncr");
      if (value === "off") return "off";
      if (value === "on") return "on";
    } catch (e) {
    }
    return null;
  }
  var ALLOWED_HOST = "app.nocartorio.com";
  function hostAllowed(loc) {
    return loc.protocol === "https:" && loc.hostname === ALLOWED_HOST;
  }

  // src/core/log.js
  function createLogger(sink) {
    const once = /* @__PURE__ */ new Set();
    const call = (level, args) => {
      try {
        if (sink && sink[level]) sink[level]("[NCR]", ...args);
      } catch (e) {
      }
    };
    return {
      info: (...a) => call("info", a),
      warn: (...a) => call("warn", a),
      warnOnce(key, ...a) {
        if (once.has(key)) return;
        once.add(key);
        call("warn", a);
      }
    };
  }

  // src/core/app.js
  var VERSION = true ? "0.3.0" : "dev";
  var MIN_DESKTOP_WIDTH = 1024;
  var RETRY_DELAYS_MS = Object.freeze([60, 150, 350, 800, 1800, 4e3]);
  var MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
  var MAX_RECOVERIES = 5;
  var WATCH_DEBOUNCE_MS = 400;
  var MAX_WATCH_PROBES = 60;
  function createApp({ win, prefs, navigator, log }) {
    const doc = win.document;
    const logger = log || createLogger(win.console);
    const nav = navigator || createNavigator(win);
    const themes = createThemeManager(doc);
    const skin = createSkinGuard(win);
    let status = "idle";
    let reason = null;
    let phase = "inactive";
    let active = false;
    let model = null;
    let ribbon3 = null;
    let selftest = null;
    let menuKeys = null;
    let sidebarSource = false;
    let generation = 0;
    let timer = null;
    let busy = false;
    let settled = false;
    let attempts = 0;
    let totalAttempts = 0;
    let lastSuspension = null;
    let lastReconcile = null;
    let lastTrigger = null;
    let lastSource = null;
    let recoverable = false;
    let recoveries = 0;
    let watchProbes = 0;
    let observer = null;
    let watchTimer = null;
    let lifecycleOn = false;
    const unlisten = [];
    const setStatus = (s, r = null) => {
      status = s;
      reason = r;
      return s;
    };
    const listen = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      unlisten.push(() => target.removeEventListener(type, fn, opts));
    };
    const clearTimer = () => {
      if (timer !== null) {
        win.clearTimeout(timer);
        timer = null;
      }
    };
    const invalidate = () => {
      generation += 1;
      clearTimer();
      disarmWatch();
    };
    const resetCycle = () => {
      attempts = 0;
      recoverable = false;
      recoveries = 0;
      watchProbes = 0;
    };
    function disarmWatch() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (watchTimer !== null) {
        win.clearTimeout(watchTimer);
        watchTimer = null;
      }
    }
    function armWatch() {
      if (observer || recoveries >= MAX_RECOVERIES || watchProbes >= MAX_WATCH_PROBES) return;
      const target = doc.getElementById("app") || doc.body;
      if (!target || typeof win.MutationObserver !== "function") return;
      observer = new win.MutationObserver(() => {
        if (watchTimer !== null) return;
        const gen = generation;
        watchTimer = win.setTimeout(() => {
          watchTimer = null;
          if (gen !== generation || !recoverable || active || busy) return;
          if (recoveries >= MAX_RECOVERIES) {
            disarmWatch();
            return;
          }
          watchProbes += 1;
          if (readSidebarDetailed(win).status === "ok") {
            recoveries += 1;
            attempt("recover");
          } else if (watchProbes >= MAX_WATCH_PROBES) {
            disarmWatch();
          }
        }, WATCH_DEBOUNCE_MS);
      });
      observer.observe(target, { childList: true, subtree: true });
    }
    const buildFrom = (page) => {
      const read = readMenu(win, page);
      if (!read) return { model: null, why: "props.menu-indisponivel", menuKeys: null, transient: false, source: null };
      const contextual = !!(read.menu && read.menu.inertiaRoutes && read.menu.translations);
      let items;
      let source = null;
      let transient = false;
      if (contextual) {
        const sidebar = readSidebarDetailed(win);
        source = { read: sidebar.status, candidates: sidebar.candidates };
        items = sidebar.items;
        transient = SIDEBAR_TRANSIENT.includes(sidebar.status);
      } else {
        items = flattenMenu(read.menu);
      }
      const built = buildModel(items || [], win.location.href);
      const keys = read.menu && typeof read.menu === "object" ? Object.keys(read.menu).slice(0, 30) : null;
      return {
        model: built,
        why: built.commandCount ? null : "menu-sem-itens-reconhecidos",
        menuKeys: keys,
        sidebarSource: contextual,
        source,
        transient
      };
    };
    const chooseTab = () => {
      const current = currentLocationKey(win.location);
      const hit = findCurrent(model, current);
      const tabIds = model.tabs.map((t) => t.id);
      const byRoute = detectModule(win.location.pathname, win.location.href);
      const saved = prefs.get().lastTab;
      const tab = hit && hit.tab || tabIds.includes(byRoute) && byRoute || tabIds.includes(saved) && saved || tabIds[0];
      return { tab, current };
    };
    const render = (patch = {}) => {
      const p = prefs.get();
      ribbon3.update({ model, theme: p.theme, mode: p.ribbonMode, sidebarHidden: p.sidebarHidden, ...patch });
    };
    const handlers = {
      onNavigate: (href) => nav.go(href),
      onSelectTab(id3) {
        prefs.set({ lastTab: id3 });
        render({ activeTab: id3 });
      },
      onTheme: (id3) => api.setTheme(id3),
      onRibbonMode: (mode) => api.setRibbonMode(mode),
      onToggleSidebar() {
        const sidebarHidden = !prefs.get().sidebarHidden;
        prefs.set({ sidebarHidden });
        themes.setSidebarHidden(sidebarHidden);
        render({ sidebarHidden });
      },
      onDisable: () => api.disable(),
      onResize: (px) => themes.setRibbonHeight(px)
    };
    const runCompat = () => {
      selftest = runSelfTest(doc);
      if (selftest.failed.length) {
        logger.warnOnce("selftest:" + selftest.failed.join(","), "seletores ausentes (possível mudança de versão do app):", selftest.failed.join(", "));
      }
    };
    function activate() {
      skin.neutralize();
      const p = prefs.get();
      themes.install(p.theme);
      ribbon3 = createRibbon({ doc, win, handlers });
      ribbon3.mount();
      const { tab, current } = chooseTab();
      render({ activeTab: tab, current });
      if (ribbon3.host.isConnected && model.commandCount > 0) themes.setSidebarHidden(p.sidebarHidden);
      active = true;
      runCompat();
    }
    function restoreNative() {
      if (ribbon3) {
        ribbon3.destroy();
        ribbon3 = null;
      }
      themes.uninstall();
      skin.restore();
      active = false;
      model = null;
    }
    function teardown() {
      invalidate();
      resetCycle();
      unlisten.splice(0).forEach((off) => off());
      lifecycleOn = false;
      restoreNative();
    }
    function evaluate(event) {
      if (!prefs.get().enabled) return { kind: "disabled" };
      if (win.innerWidth < MIN_DESKTOP_WIDTH) return { kind: "incompatible", status: "unsupported-viewport", reason: "desktop-min-1024" };
      const layout = detectLayout(doc);
      if (layout === "legacy") return { kind: "incompatible", status: "unsupported-layout", reason: "legacy" };
      if (layout === "unknown") return { kind: "transient", status: "unsupported-layout", reason: "unknown" };
      const page = event && event.detail && event.detail.page;
      const built = buildFrom(page);
      if (built.menuKeys) menuKeys = built.menuKeys;
      lastSource = built.source;
      const confirmed = !!(built.model && built.model.commandCount);
      if (!confirmed) {
        const partialVisit = active && model && !sidebarSource && !(page && page.props && page.props.menu);
        if (!partialVisit) {
          return { kind: built.transient ? "transient" : "permanent", status: "unreconciled", reason: built.why, detail: built.source ? built.source.read : null };
        }
      }
      if (!active) {
        model = built.model;
        sidebarSource = built.sidebarSource;
        activate();
        return { kind: "ok" };
      }
      if (confirmed) {
        if (built.model.signature !== model.signature) model = built.model;
        sidebarSource = built.sidebarSource;
      }
      const p = prefs.get();
      themes.ensure(p.theme, p.sidebarHidden);
      skin.neutralize();
      if (!ribbon3.host.isConnected) ribbon3.mount();
      const { tab, current } = chooseTab();
      render({ activeTab: tab, current });
      runCompat();
      return { kind: "ok" };
    }
    function attempt(trigger, event) {
      if (busy) return;
      busy = true;
      const wasActive = active;
      const hadRibbonBefore = wasActive || phase === "suspended" || phase === "navigating";
      const isRecovery = trigger === "recover" || trigger === "inertia:finish" && recoverable;
      lastTrigger = trigger;
      if (!isRecovery) attempts += 1;
      totalAttempts += 1;
      phase = "reconciling";
      let outcome;
      try {
        outcome = evaluate(event);
      } catch (e) {
        logger.warn("falha ao reconciliar; a interface original foi restaurada", e);
        outcome = { kind: "transient", status: "unreconciled", reason: wasActive ? "falha-reconciliacao" : "falha-ativacao" };
      } finally {
        busy = false;
      }
      if (outcome.kind === "disabled") {
        invalidate();
        restoreNative();
        phase = "disabled";
        setStatus("disabled", "preferencia");
        return;
      }
      if (outcome.kind === "ok") {
        clearTimer();
        disarmWatch();
        recoverable = false;
        phase = "active";
        setStatus("active");
        settled = true;
        lastReconcile = { ok: true, reason: null, attempt: attempts, trigger };
        return;
      }
      restoreNative();
      settled = false;
      lastReconcile = { ok: false, reason: outcome.reason, attempt: attempts, trigger };
      lastSuspension = { reason: outcome.reason, kind: outcome.kind, attempt: attempts, detail: outcome.detail || null };
      if (outcome.kind === "transient" && !isRecovery && attempts < MAX_ATTEMPTS) {
        const gen = generation;
        phase = hadRibbonBefore ? "suspended" : "initializing";
        setStatus(phase, outcome.reason);
        clearTimer();
        timer = win.setTimeout(() => {
          timer = null;
          if (gen !== generation) return;
          attempt("retry");
        }, RETRY_DELAYS_MS[attempts - 1]);
        return;
      }
      clearTimer();
      phase = "incompatible";
      setStatus(outcome.status, outcome.reason);
      recoverable = outcome.kind === "transient" && outcome.status === "unreconciled";
      if (recoverable) armWatch();
      else disarmWatch();
      if (outcome.status === "unreconciled") {
        logger.warnOnce(
          "unreconciled:" + outcome.reason,
          `não foi possível reconciliar com o menu real (${outcome.reason}); a sidebar original permanece. Fonte da sidebar: ${lastSource && lastSource.read || "n/d"} (instâncias: ${lastSource ? lastSource.candidates : "n/d"}); chaves do topo: ${(menuKeys || []).join(", ") || "n/d"}. Tentativas: ${attempts}. Use __ncr.status() e __ncr.menuShape() para diagnosticar (sem valores).`
        );
      }
    }
    const onInertiaStart = () => {
      lastTrigger = "inertia:start";
      invalidate();
      attempts = 0;
      settled = false;
      if (active) phase = "navigating";
    };
    const onInertiaNavigate = (event) => {
      invalidate();
      resetCycle();
      settled = false;
      attempt("inertia:navigate", event);
    };
    const onInertiaFinish = (event) => {
      lastTrigger = "inertia:finish";
      if (settled && phase === "active") return;
      if (phase === "disabled") return;
      if (phase === "incompatible") {
        if (recoverable && recoveries < MAX_RECOVERIES) {
          invalidate();
          recoveries += 1;
          attempt("inertia:finish", event);
        }
        return;
      }
      if (attempts >= MAX_ATTEMPTS) return;
      invalidate();
      attempt("inertia:finish", event);
    };
    const onWindowLoad = () => {
      if (active) {
        skin.neutralize();
        runCompat();
        return;
      }
      if (timer !== null && attempts < MAX_ATTEMPTS) {
        invalidate();
        attempt("load");
      }
    };
    const installLifecycle = () => {
      if (lifecycleOn) return;
      lifecycleOn = true;
      listen(doc, "inertia:start", onInertiaStart);
      listen(doc, "inertia:navigate", onInertiaNavigate);
      listen(doc, "inertia:finish", onInertiaFinish);
      if (doc.readyState !== "complete") listen(win, "load", onWindowLoad, { once: true });
    };
    const api = {
      version: VERSION,
      // valor legado do estado (string); status() devolve o diagnóstico completo
      get state() {
        return status;
      },
      get reason() {
        return reason;
      },
      get active() {
        return active;
      },
      get theme() {
        return prefs.get().theme;
      },
      themes: THEME_IDS,
      start() {
        if (active || timer !== null || busy) return status;
        const env = checkEnvironment(win);
        if (env.length) {
          phase = "incompatible";
          return setStatus("unsupported-browser", env.join(","));
        }
        if (!hostAllowed(win.location)) {
          phase = "incompatible";
          return setStatus("blocked-host", win.location.hostname);
        }
        const kill = readKillParam(win.location.search);
        if (kill === "off") prefs.set({ enabled: false });
        else if (kill === "on") prefs.set({ enabled: true });
        if (!prefs.get().enabled) {
          phase = "disabled";
          return setStatus("disabled", kill === "off" ? "?ncr=off" : "preferencia");
        }
        const layout = detectLayout(doc);
        if (layout === "legacy") {
          phase = "incompatible";
          return setStatus("unsupported-layout", layout);
        }
        if (win.innerWidth < MIN_DESKTOP_WIDTH) {
          phase = "incompatible";
          return setStatus("unsupported-viewport", "desktop-min-1024");
        }
        installLifecycle();
        invalidate();
        resetCycle();
        phase = "initializing";
        setStatus("initializing");
        attempt("start");
        return status;
      },
      stop() {
        teardown();
        phase = "inactive";
        return setStatus("stopped");
      },
      disable() {
        prefs.set({ enabled: false });
        teardown();
        phase = "disabled";
        return setStatus("disabled", "preferencia");
      },
      enable() {
        prefs.set({ enabled: true });
        return api.start();
      },
      refresh() {
        if (active) {
          invalidate();
          resetCycle();
          attempt("refresh");
        } else if (status !== "disabled") {
          invalidate();
          api.start();
        }
        return status;
      },
      setTheme(id3) {
        if (!isThemeId(id3)) return false;
        prefs.set({ theme: id3 });
        if (active) {
          themes.apply(id3);
          ribbon3.update({ theme: id3 });
        }
        return true;
      },
      // "always" (sempre mostrar), "tabs" (só as guias) ou "auto" (ocultar automaticamente)
      get ribbonMode() {
        return prefs.get().ribbonMode;
      },
      setRibbonMode(mode) {
        if (!isRibbonMode(mode)) return false;
        prefs.set({ ribbonMode: mode });
        if (active && ribbon3) render({ mode, peek: false });
        return true;
      },
      cycleTheme() {
        const at = THEME_IDS.indexOf(prefs.get().theme);
        return api.setTheme(THEME_IDS[(at + 1) % THEME_IDS.length]);
      },
      menuShape() {
        const read = readMenu(win, null);
        return read ? menuShape(read.menu) : null;
      },
      // Diagnóstico acessível (window.__ncr.status()). Só códigos, contagens e booleanos: nenhuma
      // URL, rótulo, rota, token, dado de sessão ou conteúdo de registro.
      status() {
        let layout = "unknown";
        try {
          layout = detectLayout(doc);
        } catch (e) {
        }
        let vueReadable = false;
        try {
          vueReadable = !!doc.getElementById("app")?._vnode;
        } catch (e) {
        }
        return {
          version: VERSION,
          ribbon: phase,
          state: status,
          reason,
          layout,
          enabled: prefs.get().enabled,
          mounted: !!(ribbon3 && ribbon3.host.isConnected),
          sidebarSource,
          vueReadable,
          skinPresent: skin.present(),
          lastSuspension: lastSuspension ? { ...lastSuspension } : null,
          lastReconcile: lastReconcile ? { ...lastReconcile } : null,
          lastTrigger,
          attempts,
          totalAttempts,
          maxAttempts: MAX_ATTEMPTS,
          retryPending: timer !== null,
          // origem da sidebar na última leitura: só código e contagem (nunca rótulos ou rotas)
          source: lastSource ? { ...lastSource } : null,
          recoverable,
          recoveries,
          maxRecoveries: MAX_RECOVERIES,
          watching: observer !== null
        };
      },
      // Só contagens e ids: nenhum rótulo, rota ou dado pessoal.
      diagnostics() {
        return {
          version: VERSION,
          status,
          reason,
          skin: { present: skin.present(), previous: skin.previous },
          stats: model ? model.stats : null,
          tabs: model ? model.tabs.map((t) => ({ id: t.id, groups: t.groups.length, commands: t.groups.reduce((n, g) => n + g.commands.length, 0) })) : [],
          selftest: selftest ? selftest.failed : null,
          menuKeys
        };
      },
      destroy() {
        teardown();
        keyOff();
        win.removeEventListener("resize", onViewport);
        phase = "inactive";
        setStatus("destroyed");
      }
    };
    const onKey = (e) => {
      if (e.key === "F1" && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && active) {
        e.preventDefault();
        api.setRibbonMode(prefs.get().ribbonMode === "always" ? "tabs" : "always");
        return;
      }
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.code === "KeyR") {
        e.preventDefault();
        if (active || timer !== null) api.disable();
        else api.enable();
      } else if (e.code === "KeyT" && active) {
        e.preventDefault();
        api.cycleTheme();
      }
    };
    win.addEventListener("keydown", onKey);
    const keyOff = () => win.removeEventListener("keydown", onKey);
    const onViewport = () => {
      if (win.innerWidth < MIN_DESKTOP_WIDTH) {
        if (active || timer !== null) {
          invalidate();
          restoreNative();
          phase = "incompatible";
          setStatus("unsupported-viewport", "desktop-min-1024");
        }
      } else if (!active && status === "unsupported-viewport") {
        api.start();
      }
    };
    win.addEventListener("resize", onViewport);
    return api;
  }

  // src/prefs/store.js
  var PREFS_KEY = "ncr:prefs";
  var VERSION2 = 1;
  var DEFAULTS = Object.freeze({
    v: VERSION2,
    enabled: true,
    theme: DEFAULT_THEME,
    sidebarHidden: true,
    ribbonMode: "always",
    lastTab: null
  });
  var RIBBON_MODES = Object.freeze(["always", "tabs", "auto"]);
  var isRibbonMode = (v) => RIBBON_MODES.includes(v);
  function sanitize(raw) {
    const out = { ...DEFAULTS };
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    if (isThemeId(raw.theme)) out.theme = raw.theme;
    if (typeof raw.sidebarHidden === "boolean") out.sidebarHidden = raw.sidebarHidden;
    if (isRibbonMode(raw.ribbonMode)) out.ribbonMode = raw.ribbonMode;
    else if (raw.collapsed === true) out.ribbonMode = "tabs";
    if (typeof raw.lastTab === "string" && /^[a-z]{2,16}$/.test(raw.lastTab)) out.lastTab = raw.lastTab;
    return out;
  }
  function createPrefs(storage) {
    let memory = null;
    const read = () => {
      try {
        const text = storage && storage.getItem(PREFS_KEY);
        return sanitize(text ? JSON.parse(text) : null);
      } catch (e) {
        return sanitize(null);
      }
    };
    const write = (value) => {
      memory = value;
      try {
        if (storage) storage.setItem(PREFS_KEY, JSON.stringify(value));
      } catch (e) {
      }
    };
    return {
      get() {
        return memory ? { ...memory } : read();
      },
      set(patch) {
        const next = sanitize({ ...this.get(), ...patch });
        write(next);
        return { ...next };
      },
      reset() {
        memory = null;
        try {
          if (storage) storage.removeItem(PREFS_KEY);
        } catch (e) {
        }
        return { ...DEFAULTS };
      }
    };
  }

  // src/main.js
  (function() {
    "use strict";
    const existing = window.__ncr;
    if (existing && existing.version) {
      if (existing.version === VERSION) {
        try {
          existing.refresh();
        } catch (e) {
        }
        return;
      }
      try {
        existing.destroy();
      } catch (e) {
      }
    }
    let storage = null;
    try {
      storage = window.localStorage;
    } catch (e) {
    }
    const app3 = createApp({ win: window, prefs: createPrefs(storage) });
    Object.defineProperty(window, "__ncr", { value: app3, configurable: true });
    app3.start();
  })();
})();
