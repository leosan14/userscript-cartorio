// ==UserScript==
// @name         Busca Protesto — Buscador Completo (Nocartorio)
// @name:pt-BR   Busca Protesto — Buscador Completo (Nocartorio)
// @namespace    https://github.com/leonardo/busca-protesto
// @version      1.3.0
// @description  Buscador completo de protesto de títulos: busca por nome do devedor, CPF/CNPJ, número do título/nosso número e número de ordem, com exportação CSV. Para o Livro de Protocolos do Nocartorio.
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/admin/manager/v2/tp-protocol-book*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      app.nocartorio.com
// @compatible   violentmonkey 2.12+
// @inject-into  content
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   *  CONFIGURAÇÃO
   * ================================================================ */
  const ORIGIN = location.origin;
  const URL_LIST = '/admin/manager/v2/tp-protocol-book';
  const URL_PROFILES = '/api/profiles/search-for-autocomplete';
  const urlProfileDoc = (uuid) => `/admin/manager/v2/profile/${uuid}/document`;

  const ROLES = [
    { v: '', l: 'Qualquer função' },
    { v: '1', l: 'Apresentante' },
    { v: '2', l: 'Cedente' },
    { v: '3', l: 'Devedor' },
    { v: '4', l: 'Sacador' },
  ];

  const PARALLEL_LIST = 4;           // páginas de lista consultadas em paralelo
  const MAX_PAGES_NAME_SEARCH = 50;  // teto de segurança para busca por nome (450 apontamentos)
  const DOC_CONCURRENCY = 5;
  const LIST_DELAY_MS = 40;
  const AUTO_DETAIL_LIMIT = 100;     // até quantos resultados buscar detalhes automaticamente
  const MAX_VERIFY = 300;            // teto de apontamentos conferidos por CPF/CNPJ

  const SHORTCUT = { ctrl: true, shift: true, key: 'f' };

  /* ================================================================
   *  ARMAZENAMENTO (GM ou localStorage)
   * ================================================================ */
  const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const store = {
    get(key, def) {
      try {
        if (hasGM) {
          const value = GM_getValue(key, def);
          // GM_* legado é síncrono. Se um manager retornar Promise, use o
          // fallback local em vez de tratar a Promise como se fosse o cache.
          if (value && typeof value.then === 'function') return def;
          return value;
        }
        const raw = localStorage.getItem('bp:' + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (_) { return def; }
    },
    set(key, val) {
      try {
        if (hasGM) {
          const result = GM_setValue(key, val);
          // Algumas versões/implementações retornam Promise apesar do GM_* legado.
          if (result && typeof result.catch === 'function') {
            result.catch(() => {
              try { localStorage.setItem('bp:' + key, JSON.stringify(val)); } catch (_) {}
            });
          }
        } else localStorage.setItem('bp:' + key, JSON.stringify(val));
      } catch (_) { /* quota */ }
    },
    del(key) {
      try {
        if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else localStorage.removeItem('bp:' + key);
      } catch (_) {}
    },
  };

  /* Caches locais genéricos: entryId -> { t: timestamp, f: payload } */
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

  function makeCache(key, label, ttlMs = TTL_MS) {
    let data = store.get(key, {}) || {};
    let writes = 0;
    const save = () => {
      const now = Date.now();
      for (const k of Object.keys(data)) { if (now - data[k].t > ttlMs) delete data[k]; }
      store.set(key, data);
    };
    return {
      label,
      /** Retorna o payload cacheado (pode ser null = "não tem dado") ou undefined = ausente/expirado. */
      get(id) {
        const hit = data[id];
        if (!hit) return undefined;
        if (Date.now() - hit.t > ttlMs) { delete data[id]; return undefined; }
        return hit.f;
      },
      has(id) {
        const hit = data[id];
        if (!hit) return false;
        if (Date.now() - hit.t > ttlMs) { delete data[id]; return false; }
        return true;
      },
      put(id, payload) {
        data[id] = { t: Date.now(), f: payload };
        // Evita serializar milhares de entradas repetidamente (especialmente
        // importante no Violentmonkey, cujo storage passa pela extensão).
        if (++writes % 1000 === 0) save();
      },
      save,
      clear() { data = {}; store.del(key); },
      size() { return Object.keys(data).length; },
    };
  }

  const tituloCache = makeCache('titulo_cache_v1', 'titulo');
  const processoCache = makeCache('processo_cache_v1', 'processo');
  const listaFullCache = makeCache('lista_full_v1', 'lista', 30 * 60 * 1000); // 30 min
  const caches = [tituloCache, processoCache, listaFullCache];

  /* ================================================================
   *  UTILITÁRIOS
   * ================================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function formatDocument(value) {
    const d = digits(value);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return value;
  }
  const looksLikeDocument = (v) => { const d = digits(v); return d.length === 11 || d.length === 14; };

  /* ================================================================
   *  CAMADA DE API (Inertia)
   * ================================================================ */
  let inertiaVersion = null;

  function versionFromDom() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const t = s.textContent || '';
      if (t.trim().startsWith('{"component"')) {
        try { return JSON.parse(t).version || null; } catch (_) {}
      }
    }
    return null;
  }

  async function refreshVersion() {
    try {
      const resp = await fetch(ORIGIN + URL_LIST, { credentials: 'include' });
      const html = await resp.text();
      const start = html.indexOf('{"component"');
      if (start !== -1) {
        const end = html.indexOf('</script>', start);
        const raw = html.slice(start, end === -1 ? undefined : end);
        const v = JSON.parse(raw).version;
        if (v) { inertiaVersion = v; return inertiaVersion; }
      }
    } catch (_) {}
    return versionFromDom();
  }

  async function inertiaGet(path) {
    if (!inertiaVersion) inertiaVersion = versionFromDom() || await refreshVersion();
    const doFetch = () => fetch(ORIGIN + path, {
      credentials: 'include',
      headers: { 'X-Inertia': 'true', 'X-Inertia-Version': inertiaVersion || '' },
    });
    let resp = await doFetch();
    if (resp.status === 409) {           // versão do bundle desatualizada
      await refreshVersion();
      resp = await doFetch();
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' em ' + path);
    const json = await resp.json();
    if (!json || !json.props) throw new Error('Resposta inesperada da API');
    return json;
  }

  function newAbortCtl() {
    const ctl = { aborted: false };
    ctl.abort = () => { ctl.aborted = true; };
    ctl.check = () => { if (ctl.aborted) throw new DOMException('Abortado', 'AbortError'); };
    return ctl;
  }
  const isAbort = (e) => e && e.name === 'AbortError';

  /* ---- lista de apontamentos ---- */
  async function fetchEntriesPage(params, page) {
    const qs = new URLSearchParams();
    if (params.search_term) qs.set('search_term', params.search_term);
    if (params.search_name) qs.set('search_name', params.search_name);
    if (params.search_name && params.searchType) qs.set('searchType', params.searchType);
    if (page && page > 1) qs.set('page', String(page));
    const json = await inertiaGet(URL_LIST + (qs.toString() ? '?' + qs.toString() : ''));
    return json.props.entries; // { data, meta }
  }

  /** Busca todos os apontamentos de um filtro, paginando (páginas em paralelo). */
  async function collectEntries(params, { maxPages = Infinity } = {}, onProgress, ctl) {
    let first;
    try { first = await fetchEntriesPage(params, 1); } catch (e) { throw e; }
    ctl && ctl.check();
    const total = first.meta ? first.meta.total : first.data.length;
    const lastPage = first.meta ? first.meta.last_page : 1;
    const pagesToFetch = Math.min(lastPage, maxPages);
    const all = first.data.slice();
    let pagesDone = 1;
    let nextPage = 2;
    async function worker() {
      while (true) {
        ctl && ctl.check();
        const p = nextPage++;
        if (p > pagesToFetch) return;
        const pageData = await fetchEntriesPage(params, p);
        all.push(...pageData.data);
        pagesDone++;
        onProgress && onProgress({ phase: 'list', done: all.length, total, page: pagesDone, pages: pagesToFetch, truncated: lastPage > pagesToFetch });
        await sleep(LIST_DELAY_MS);
      }
    }
    const workers = Math.min(PARALLEL_LIST, Math.max(pagesToFetch - 1, 1));
    await Promise.all(Array.from({ length: workers }, worker));
    // deduplica (a paginação pode deslocar com inserções simultâneas) e reordena
    const seen = new Set();
    const dedup = [];
    for (const e of all) { if (!seen.has(e.id)) { seen.add(e.id); dedup.push(e); } }
    dedup.sort((a, b) => (b.order_number || 0) - (a.order_number || 0));
    return { entries: dedup, total, truncated: lastPage > pagesToFetch, lastPage };
  }

  /* ---- perfis (CPF/CNPJ -> pessoa) ---- */
  async function searchProfiles(q) {
    const resp = await fetch(ORIGIN + URL_PROFILES + '?q=' + encodeURIComponent(q), { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' na busca de pessoas');
    const j = await resp.json();
    return (j.data || []).map((it) => {
      const parts = String(it.name || '').split('|').map((s) => s.trim());
      return { id: it.id, full: it.name, name: parts[0], docLabel: parts.find((p) => /CPF|CNPJ/i.test(p)) || '' };
    });
  }

  /* ---- documentos do apontamento (dados do título) ---- */
  const TITLE_DOC_TYPE = 'Título Apresentado para Protesto';

  function extractTitleFields(docJson) {
    const docs = (((docJson || {}).props || {}).documents || {}).data || [];
    const titulo = docs.find((d) => d.document_type && d.document_type.name === TITLE_DOC_TYPE);
    if (!titulo) return null;
    const out = {};
    for (const group of titulo.document_fields || []) {
      for (const f of group.fields || []) {
        out[f.document_field_type_name] = f.display ?? f.value ?? '';
      }
    }
    return Object.keys(out).length ? out : null;
  }

  async function fetchTitleFields(entry, ctl) {
    const cached = tituloCache.get(entry.id);
    if (cached !== undefined) return cached;
    ctl && ctl.check();
    const profileUuid = extractProfileUuid(entry.documents_url);
    if (!profileUuid) return null;
    try {
      const json = await inertiaGet(urlProfileDoc(profileUuid));
      const fields = extractTitleFields(json);
      tituloCache.put(entry.id, fields);
      return fields;
    } catch (e) {
      if (isAbort(e)) throw e;
      return null; // tolera falhas individuais
    }
  }

  function extractProfileUuid(documentsUrl) {
    if (!documentsUrl) return null;
    const m = String(documentsUrl).match(/\/profile\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  /** Versão compacta de um apontamento para o cache da varredura completa. */
  function slimEntry(e) {
    const processUrl = (e.references || []).map((r) => r.url).find((url) => url && /\/process\//.test(url)) || '';
    // Array posicional reduz bastante o uso de storage: a lista tem ~6.200 itens.
    return [e.id, e.order_number, e.nature, e.presenter, e.registered_at, e.url,
      e.documents_url, e.instrument_url, e.protocol?.code || '', e.protocol?.url || '', processUrl];
  }

  function inflateEntry(row) {
    // Também aceita o formato objeto da v1.2, para não invalidar o cache já salvo.
    if (!Array.isArray(row)) return row;
    const [id, order_number, nature, presenter, registered_at, url, documents_url,
      instrument_url, protocolCode, protocolUrl, processUrl] = row;
    return {
      id, order_number, nature, presenter, registered_at, url, documents_url, instrument_url,
      protocol: protocolCode ? { code: protocolCode, url: protocolUrl || '' } : null,
      references: processUrl ? [{ url: processUrl }] : [],
    };
  }

  /* ---- processos do apontamento (papéis com CPF/CNPJ das partes) ---- */
  function processPathFor(entry) {
    const ref = (entry.references || []).find((x) => x.url && /\/process\//.test(x.url));
    if (!ref) return null;
    try {
      const p = new URL(ref.url, ORIGIN).pathname;
      return p.replace('/admin/manager/process/', '/admin/manager/v2/process/') + '/edit';
    } catch (_) { return null; }
  }

  /**
   * Retorna { roles: { 'Devedor': [label-completo], ... }, url } do processo
   * vinculado ao apontamento, com cache por entrada.
   */
  async function fetchProcessRoles(entry, ctl) {
    const cached = processoCache.get(entry.id);
    if (cached !== undefined) return cached;
    const path = processPathFor(entry);
    if (!path) return null;
    ctl && ctl.check();
    try {
      const json = await inertiaGet(path);
      const inputs = (((json.props || {}).content || {}).inputs) || {};
      const roles = {};
      for (const item of Object.values(inputs)) {
        if (item && item.type === 'select' && item.label) {
          roles[item.label] = (item.initialSelection || []).map((s) => s.label).filter(Boolean);
        }
      }
      const payload = { roles, url: path.replace(/\/edit$/, '') };
      processoCache.put(entry.id, payload);
      return payload;
    } catch (e) {
      if (isAbort(e)) throw e;
      return null;
    }
  }

  /** Versão em massa com concorrência, para verificação de CPF/CNPJ. */
  async function fetchProcessRolesMany(entries, onProgress, ctl) {
    const results = new Map();
    let idx = 0, done = 0, uncached = 0;
    for (const e of entries) {
      const c = processoCache.get(e.id);
      if (c !== undefined) results.set(e.id, c);
      else uncached++;
    }
    onProgress && onProgress({ phase: 'verify', done: entries.length - uncached, total: entries.length, uncached });
    async function worker() {
      while (true) {
        ctl && ctl.check();
        const i = idx++;
        if (i >= entries.length) return;
        const e = entries[i];
        if (results.has(e.id)) continue;
        const payload = await fetchProcessRoles(e, ctl);
        results.set(e.id, payload);
        done++;
        onProgress && onProgress({ phase: 'verify', done: entries.length - uncached + done, total: entries.length, uncached });
        if (uncached > 2) await sleep(30);
      }
    }
    await Promise.all(Array.from({ length: Math.min(DOC_CONCURRENCY, entries.length) }, worker));
    if (uncached > 0) processoCache.save();
    return results;
  }

  /** Busca campos de título para muitos apontamentos, com cache e concorrência. */
  async function fetchTitleFieldsMany(entries, onProgress, ctl) {
    const results = new Map();
    let idx = 0, done = 0, uncached = 0;
    for (const e of entries) {
      const c = tituloCache.get(e.id);
      if (c !== undefined) results.set(e.id, c);
      else uncached++;
    }
    onProgress && onProgress({ phase: 'details', done: entries.length - uncached, total: entries.length, uncached });
    async function worker() {
      while (true) {
        ctl && ctl.check();
        const i = idx++;
        if (i >= entries.length) return;
        const e = entries[i];
        if (results.has(e.id)) continue;
        const fields = await fetchTitleFields(e, ctl);
        results.set(e.id, fields);
        done++;
        onProgress && onProgress({ phase: 'details', done: entries.length - uncached + done, total: entries.length, uncached });
        if (uncached > 2) await sleep(30);
      }
    }
    await Promise.all(Array.from({ length: Math.min(DOC_CONCURRENCY, entries.length) }, worker));
    if (uncached > 0) tituloCache.save();
    return results;
  }

  /* ================================================================
   *  ORQUESTRAÇÃO DA BUSCA
   * ================================================================ */
  async function resolveDocumentNames(query, ctl) {
    // query: CPF/CNPJ digitado. Retorna lista de pessoas correspondentes.
    const formatted = formatDocument(query);
    const matches = await searchProfiles(formatted);
    ctl && ctl.check();
    // mantém apenas correspondências com o mesmo número de dígitos
    const d = digits(query);
    return matches.filter((m) => digits(m.docLabel).length === d.length);
  }

  /**
   * Critérios: { term, name, role, doc, title }
   *  - doc: CPF/CNPJ -> vira busca por nome das pessoas resolvidas
   *  - title: número do título / nosso número -> cruzamento local com cache
   */
  async function runSearch(crit, onProgress, ctl) {
    const report = (o) => onProgress && onProgress(o);
    const out = { warnings: [], resolved: [], people: [] };

    // 1) CPF/CNPJ -> nomes (recall: nome completo + primeiro nome p/ variantes de grafia)
    let nameQueries = [];
    if (crit.doc) {
      report({ phase: 'resolve', text: 'Localizando pessoa pelo CPF/CNPJ ' + formatDocument(crit.doc) + '…' });
      const people = await resolveDocumentNames(crit.doc, ctl);
      out.people = people;
      if (!people.length) {
        out.entries = []; out.total = 0; out.truncated = false;
        out.warnings.push('Nenhuma pessoa encontrada com o documento ' + formatDocument(crit.doc) + '.');
        return out;
      }
      const queries = [];
      const push = (q) => { const t = String(q || '').trim(); if (t && !queries.some((x) => norm(x) === norm(t))) queries.push(t); };
      for (const p of people.slice(0, 3)) {
        push(p.name);
        const first = String(p.name || '').trim().split(/\s+/)[0];
        if (first && first.length >= 4) push(first);
      }
      nameQueries = queries.slice(0, 6);
      out.resolved = people.map((p) => p.full);
      if (people.length > 1) out.warnings.push(people.length + ' pessoas distintas com este documento; resultados unificados.');
    } else if (crit.name) {
      nameQueries = [crit.name];
    }

    // 2) conjunto candidato vindo da API
    let candidates = [];
    let totalServer = 0;
    const hasServerFilter = crit.term || nameQueries.length;
    const titleOnly = !!crit.title && !hasServerFilter;

    if (!titleOnly) {
      const searchSets = [];
      if (nameQueries.length) {
        for (const nq of nameQueries) {
          report({ phase: 'list', text: 'Consultando apontamentos de “' + nq + '”…' });
          const r = await collectEntries({ search_term: crit.term, search_name: nq, searchType: crit.role },
            { maxPages: MAX_PAGES_NAME_SEARCH },
            (p) => report({ phase: 'list', text: 'Listando apontamentos… ' + p.done + '/' + p.total + (p.truncated ? ' (limitado)' : '') }), ctl);
          if (r.truncated) out.warnings.push('Busca por “' + nq + '” limitada a ' + MAX_PAGES_NAME_SEARCH + ' páginas (' + r.entries.length + ' apontamentos). Refine o nome.');
          searchSets.push(r.entries);
          totalServer += r.total;
        }
      } else {
        report({ phase: 'list', text: 'Consultando apontamentos…' });
        const r = await collectEntries({ search_term: crit.term }, { maxPages: MAX_PAGES_NAME_SEARCH },
          (p) => report({ phase: 'list', text: 'Listando apontamentos… ' + p.done + '/' + p.total }), ctl);
        if (r.truncated) out.warnings.push('Resultado truncado em ' + r.entries.length + ' apontamentos. Use um número de ordem mais específico.');
        searchSets.push(r.entries);
        totalServer += r.total;
      }
      // união deduplicada preservando ordem (mais recente primeiro)
      const seen = new Set();
      for (const set of searchSets) {
        for (const e of set) { if (!seen.has(e.id)) { seen.add(e.id); candidates.push(e); } }
      }
    }

    // 2b) verificação precisa do CPF/CNPJ nas partes do processo de cada apontamento
    if (crit.doc && candidates.length) {
      const wanted = digits(crit.doc);
      const roleLabel = crit.role ? (ROLES.find((r) => r.v === crit.role) || {}).l : null;
      let toVerify = candidates;
      if (candidates.length > MAX_VERIFY) {
        out.warnings.push('Muitos candidatos (' + candidates.length + '); conferindo os ' + MAX_VERIFY + ' mais recentes. Refine com nome ou nº de ordem.');
        toVerify = candidates.slice(0, MAX_VERIFY);
      }
      report({ phase: 'verify', text: 'Conferindo o documento em cada apontamento…' });
      const procMap = await fetchProcessRolesMany(toVerify,
        (p) => report({ phase: 'verify', text: 'Conferindo documento… ' + p.done + '/' + p.total }), ctl);
      const verified = [];
      let semProcesso = 0;
      for (const e of toVerify) {
        const proc = procMap.get(e.id);
        if (!proc || !proc.roles) { semProcesso++; continue; }
        const labels = roleLabel ? (proc.roles[roleLabel] || []) : Object.values(proc.roles).flat();
        const match = labels.some((label) => (label.match(/\d[\d./-]*/g) || []).some((run) => digits(run) === wanted));
        if (match) verified.push({ ...e, _pessoas: proc.roles, _processo: proc.url });
      }
      if (semProcesso) out.warnings.push(semProcesso + ' apontamento(s) sem processo vinculado não puderam ser conferidos.');
      if (roleLabel && !verified.length && toVerify.length) {
        // sem correspondência com a função escolhida: informa se existe sem o recorte de função
        out.warnings.push('Nada encontrado com a função “' + roleLabel + '” para este documento.');
      }
      candidates = verified;
      totalServer = verified.length;
    }

    // 3) filtro por número do título (cruzamento local com cache)
    if (crit.title) {
      const needle = norm(crit.title);
      if (titleOnly) {
        const cachedList = listaFullCache.get('_all');
        if (cachedList) {
          report({ phase: 'scan', text: 'Lista completa obtida do cache local (' + cachedList.length + ' apontamentos)…' });
          candidates = cachedList.map(inflateEntry);
          totalServer = candidates.length;
        } else {
          report({ phase: 'scan', text: 'Varredura completa para localizar o título (1ª vez é mais lenta)…' });
          const all = await collectEntries({}, {},
            (p) => report({ phase: 'scan', text: 'Indexando lista… ' + p.done + '/' + p.total + ' (página ' + p.page + '/' + p.pages + ')' }), ctl);
          candidates = all.entries;
          totalServer = all.total;
          listaFullCache.put('_all', candidates.map(slimEntry));
          listaFullCache.save();
        }
      }
      report({ phase: 'details', text: 'Consultando dados dos títulos…' });
      const fieldsMap = await fetchTitleFieldsMany(candidates,
        (p) => report({ phase: 'details', text: 'Dados do título… ' + p.done + '/' + p.total }), ctl);
      candidates = candidates.filter((e) => {
        const f = fieldsMap.get(e.id) || {};
        return norm(f['Número do Título']).includes(needle) || norm(f['Nosso Número']).includes(needle);
      });
      totalServer = candidates.length;
    }

    out.entries = candidates;
    out.total = totalServer || candidates.length;
    return out;
  }

  /* ================================================================
   *  UI
   * ================================================================ */
  const Z_TOP = 2147483646;
  let panelEl = null, btnEl = null, activeCtl = null;

  const css = `
.bp-root { position: fixed; top: 78px; right: 16px; width: 640px; max-width: calc(100vw - 32px); max-height: calc(100vh - 96px);
  background: var(--bp-bg); color: var(--bp-fg); border: 1px solid var(--bp-border); border-radius: 14px;
  box-shadow: 0 12px 36px rgba(24,24,27,.18); z-index: ${Z_TOP}; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  display: none; flex-direction: column; overflow: hidden; }
.bp-root.bp-open { display: flex; }
.bp-root { --bp-bg:#ffffff; --bp-fg:#27272a; --bp-border:#e4e4e7; --bp-muted:#71717a; --bp-soft:#f4f4f5; --bp-input:#ffffff;
  --bp-accent:#ea580c; --bp-accent-soft:#fff7ed; --bp-ok:#16a34a; --bp-err:#dc2626; }
.bp-header { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--bp-border);
  background:var(--bp-bg); border-top:3px solid var(--bp-accent); cursor: move; user-select:none; }
.bp-header b { font-size:14px; }
.bp-header .bp-sub { color: var(--bp-muted); font-size:11px; }
.bp-x { margin-left:auto; border:0; background:transparent; color:var(--bp-muted); font-size:18px; cursor:pointer; line-height:1; padding:4px 6px; border-radius:6px; }
.bp-x:hover { background: var(--bp-soft); color: var(--bp-fg); }
.bp-body { padding: 14px 16px; overflow:auto; }
.bp-grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px 12px; }
.bp-field { display:flex; flex-direction:column; gap:4px; }
.bp-field label { font-weight:600; font-size:12px; }
.bp-field .bp-hint { color: var(--bp-muted); font-size:11px; font-weight:400; }
.bp-input, .bp-select { border:1px solid var(--bp-border); background:var(--bp-input); color:var(--bp-fg);
  border-radius:7px; padding:8px 10px; font:inherit; outline:none; width:100%; box-sizing:border-box; }
.bp-input:focus, .bp-select:focus { border-color: var(--bp-accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--bp-accent) 18%, transparent); }
.bp-actions { display:flex; align-items:center; gap:8px; margin-top:14px; flex-wrap:wrap; }
.bp-btn { border:1px solid var(--bp-border); background:var(--bp-bg); color:var(--bp-fg); border-radius:7px; padding:8px 14px; font:inherit; font-weight:600; cursor:pointer; }
.bp-btn:hover { background: var(--bp-soft); }
.bp-btn.bp-primary { background:var(--bp-accent); border-color:var(--bp-accent); color:#fff; }
.bp-btn.bp-primary:hover { filter: brightness(1.05); }
.bp-btn:disabled { opacity:.55; cursor:not-allowed; }
.bp-status { margin-top:12px; font-size:12px; color:var(--bp-muted); display:none; align-items:center; gap:8px; }
.bp-status.bp-on { display:flex; }
.bp-bar { flex:1; height:6px; border-radius:99px; background:var(--bp-soft); overflow:hidden; }
.bp-bar i { display:block; height:100%; width:40%; background:var(--bp-accent); border-radius:99px; animation: bp-slide 1.1s ease-in-out infinite; }
@keyframes bp-slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(300%)} }
.bp-summary { margin-top:12px; font-size:12.5px; display:none; }
.bp-summary.bp-on { display:block; }
.bp-summary .bp-chip { display:inline-block; background:var(--bp-accent-soft); color:var(--bp-accent); border:1px solid color-mix(in srgb, var(--bp-accent) 30%, transparent);
  border-radius:99px; padding:2px 10px; margin:2px 4px 2px 0; font-size:11.5px; font-weight:600; }
.bp-warn { color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 10px; margin-top:10px; font-size:12px; display:none; }
.bp-dark .bp-warn { background:#422006; border-color:#78350f; color:#fbbf24; }
.bp-warn.bp-on { display:block; }
.bp-results { margin-top:12px; display:flex; flex-direction:column; gap:10px; max-height: 34vh; overflow:auto; padding-right:4px; }
.bp-card { border:1px solid var(--bp-border); border-radius:10px; padding:10px 12px; background:var(--bp-bg); }
.bp-card .bp-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bp-card .bp-order { font-weight:800; font-size:14px; color:var(--bp-accent); }
.bp-card .bp-nat { background:var(--bp-soft); border-radius:99px; padding:2px 8px; font-size:11px; color:var(--bp-muted); }
.bp-card .bp-pres { margin-top:4px; }
.bp-card .bp-kv { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr)); gap:2px 12px; margin-top:8px; font-size:12px; }
.bp-card .bp-kv div span { color:var(--bp-muted); }
.bp-card .bp-links { margin-top:8px; display:flex; gap:12px; font-size:12px; flex-wrap:wrap; }
.bp-card .bp-links a { color:var(--bp-accent); text-decoration:none; font-weight:600; }
.bp-card .bp-links a:hover { text-decoration:underline; }
.bp-empty { text-align:center; color:var(--bp-muted); padding:26px 0 18px; }
.bp-fab { position:fixed; right:20px; bottom:104px; z-index:${Z_TOP}; width:48px; height:48px; border-radius:50%;
  border:0; cursor:pointer; background:#ea580c; color:#fff; font-size:20px; box-shadow:0 10px 26px rgba(0,0,0,.35); }
.bp-fab:hover { filter:brightness(1.07); }
.bp-fab .bp-dot { position:absolute; top:-2px; right:-2px; width:14px; height:14px; border-radius:50%; background:#22c55e; border:2px solid #fff; display:none; }
.bp-toasts { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:${Z_TOP}; display:flex; flex-direction:column; gap:8px; align-items:center; }
.bp-toast { background:#111827; color:#fff; padding:9px 16px; border-radius:99px; font-size:12.5px; box-shadow:0 8px 24px rgba(0,0,0,.3); }
.bp-toast.bp-err { background:#b91c1c; }
.bp-legend { margin-top:10px; font-size:11px; color:var(--bp-muted); }
`;

  function toast(msg, isErr) {
    let host = document.querySelector('.bp-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'bp-toasts'; document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = 'bp-toast' + (isErr ? ' bp-err' : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function isDark() {
    return document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.body?.classList.contains('dark') ||
      document.body?.getAttribute('data-theme') === 'dark';
  }

  function buildUI() {
    if (!document.getElementById('bp-style')) {
      const style = document.createElement('style');
      style.id = 'bp-style';
      style.textContent = css;
      document.head.appendChild(style);
    }

    // botão flutuante
    btnEl = document.createElement('button');
    btnEl.className = 'bp-fab';
    btnEl.title = 'Busca Protesto (Ctrl+Shift+F)';
    btnEl.innerHTML = '<span class="bp-dot"></span>&#128269;';
    btnEl.addEventListener('click', togglePanel);
    document.body.appendChild(btnEl);

    // painel
    panelEl = document.createElement('div');
    panelEl.className = 'bp-root';
    panelEl.innerHTML = `
      <div class="bp-header" id="bp-drag">
        <div>
          <b>&#128269; Busca Protesto</b>
          <div class="bp-sub">Buscador completo do Livro de Protocolos</div>
        </div>
        <button class="bp-x" id="bp-close" title="Fechar">&#10005;</button>
      </div>
      <div class="bp-body">
        <div class="bp-grid">
          <div class="bp-field">
            <label>Nº de ordem <span class="bp-hint">(exato)</span></label>
            <input class="bp-input" id="bp-term" inputmode="numeric" placeholder="Ex.: 7081">
          </div>
          <div class="bp-field">
            <label>Função <span class="bp-hint">(com o nome)</span></label>
            <select class="bp-select" id="bp-role">
              ${ROLES.map((r) => `<option value="${r.v}">${r.l}</option>`).join('')}
            </select>
          </div>
          <div class="bp-field">
            <label>Nome da pessoa <span class="bp-hint">(devedor, cedente…)</span></label>
            <input class="bp-input" id="bp-name" placeholder="Ex.: CLEONICE">
          </div>
          <div class="bp-field">
            <label>CPF / CNPJ</label>
            <input class="bp-input" id="bp-doc" inputmode="numeric" placeholder="000.000.000-00 ou 00.000.000/0000-00">
          </div>
          <div class="bp-field" style="grid-column: 1 / -1;">
            <label>Nº do título / nosso número <span class="bp-hint">(faz cruzamento local, com cache)</span></label>
            <input class="bp-input" id="bp-title" placeholder="Ex.: 266155/7 ou 320600000068708">
          </div>
        </div>
        <div class="bp-actions">
          <button class="bp-btn bp-primary" id="bp-search">&#128269; Buscar</button>
          <button class="bp-btn" id="bp-clear">Limpar</button>
          <button class="bp-btn" id="bp-cancel" disabled>Parar</button>
          <span style="flex:1"></span>
          <button class="bp-btn" id="bp-csv" disabled>&#11015; CSV</button>
          <button class="bp-btn" id="bp-cache" title="Remove os dados de títulos guardados neste navegador">Limpar cache</button>
        </div>
        <div class="bp-status" id="bp-status"><span id="bp-status-text"></span><span class="bp-bar"><i></i></span><span id="bp-status-count"></span></div>
        <div class="bp-warn" id="bp-warn"></div>
        <div class="bp-summary" id="bp-summary"></div>
        <div class="bp-results" id="bp-results"></div>
        <div class="bp-legend">Busca por título/nosso número consulta os documentos de cada apontamento; a 1ª varredura é lenta e os resultados ficam em cache (7 dias) para as próximas buscas.</div>
      </div>`;
    document.body.appendChild(panelEl);

    panelEl.querySelector('#bp-close').addEventListener('click', () => togglePanel(false));
    panelEl.querySelector('#bp-search').addEventListener('click', () => doSearch());
    panelEl.querySelector('#bp-clear').addEventListener('click', resetForm);
    panelEl.querySelector('#bp-cancel').addEventListener('click', () => { if (activeCtl) activeCtl.abort(); });
    panelEl.querySelector('#bp-csv').addEventListener('click', exportCsv);
    panelEl.querySelector('#bp-cache').addEventListener('click', () => { caches.forEach((c) => c.clear()); toast('Caches (títulos e processos) removidos.'); });
    panelEl.querySelector('#bp-doc').addEventListener('blur', (e) => {
      if (looksLikeDocument(e.target.value)) e.target.value = formatDocument(e.target.value);
    });
    for (const id of ['#bp-term', '#bp-name', '#bp-doc', '#bp-title']) {
      panelEl.querySelector(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    }
    makeDraggable(panelEl, panelEl.querySelector('#bp-drag'));
    applyTheme();
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.bp-x')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(4, Math.min(window.innerWidth - 120, ox + e.clientX - sx)) + 'px';
      panel.style.top = Math.max(4, Math.min(window.innerHeight - 60, oy + e.clientY - sy)) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function applyTheme() { if (panelEl) panelEl.classList.toggle('bp-dark', isDark()); }

  function togglePanel(force) {
    if (!panelEl) buildUI();
    const open = force !== undefined ? force : !panelEl.classList.contains('bp-open');
    panelEl.classList.toggle('bp-open', open);
    if (open) { applyTheme(); panelEl.querySelector('#bp-term').focus(); }
  }

  /* ---------------- busca ---------------- */
  let lastResults = [];

  function setStatus(text, count) {
    const el = panelEl.querySelector('#bp-status');
    if (text === null) { el.classList.remove('bp-on'); return; }
    el.classList.add('bp-on');
    panelEl.querySelector('#bp-status-text').textContent = text;
    panelEl.querySelector('#bp-status-count').textContent = count || '';
  }
  function setWarn(list) {
    const el = panelEl.querySelector('#bp-warn');
    if (!list || !list.length) { el.classList.remove('bp-on'); el.textContent = ''; return; }
    el.classList.add('bp-on');
    el.textContent = list.join(' ');
  }
  function setBusy(busy) {
    panelEl.querySelector('#bp-search').disabled = busy;
    panelEl.querySelector('#bp-cancel').disabled = !busy;
  }

  function readCriteria() {
    return {
      term: panelEl.querySelector('#bp-term').value.trim(),
      name: panelEl.querySelector('#bp-name').value.trim(),
      role: panelEl.querySelector('#bp-role').value,
      doc: panelEl.querySelector('#bp-doc').value.trim(),
      title: panelEl.querySelector('#bp-title').value.trim(),
    };
  }

  async function doSearch() {
    if (activeCtl) activeCtl.abort();
    const crit = readCriteria();
    if (!crit.term && !crit.name && !crit.doc && !crit.title) {
      toast('Informe ao menos um critério de busca.', true);
      return;
    }
    if (crit.role && !crit.name && !crit.doc) {
      toast('A “Função” só se aplica junto com nome ou CPF/CNPJ.', true);
      return;
    }
    activeCtl = newAbortCtl();
    const ctl = activeCtl;
    setBusy(true);
    setWarn([]);
    panelEl.querySelector('#bp-results').innerHTML = '';
    panelEl.querySelector('#bp-summary').classList.remove('bp-on');
    panelEl.querySelector('#bp-csv').disabled = true;
    setStatus('Iniciando…');
    try {
      const res = await runSearch(crit, (p) => {
        if (p.text) setStatus(p.text);
        else if (p.phase === 'list') setStatus('Listando apontamentos…', p.done + '/' + p.total);
        else if (p.phase === 'verify') setStatus('Conferindo documento…', p.done + '/' + p.total);
        else if (p.phase === 'details') setStatus('Dados dos títulos…', p.done + '/' + p.total);
        else if (p.phase === 'scan') setStatus(p.text);
      }, ctl);

      // detalhes (dados do título) para resultados sem critério de título
      if (!crit.title && res.entries.length) {
        if (res.entries.length <= AUTO_DETAIL_LIMIT) {
          setStatus('Carregando dados dos títulos…');
          const map = await fetchTitleFieldsMany(res.entries,
            (p) => setStatus('Dados dos títulos…', p.done + '/' + p.total), ctl);
          res.entries = res.entries.map((e) => ({ ...e, _titulo: map.get(e.id) || null }));
        } else {
          res.warnings.push('Detalhes do título não carregados para ' + res.entries.length + ' resultados (use um filtro mais específico).');
        }
      } else {
        res.entries = res.entries.map((e) => ({ ...e, _titulo: tituloCache.get(e.id) || null }));
      }

      // hidrata devedor/papéis do cache de processos, quando já conhecidos
      res.entries = res.entries.map((e) => {
        if (e._pessoas) return e;
        const p = processoCache.get(e.id);
        return p ? { ...e, _pessoas: p.roles, _processo: p.url } : e;
      });
      lastResults = res.entries;
      renderSummary(res, crit);
      renderResults(res.entries);
      panelEl.querySelector('#bp-csv').disabled = !res.entries.length;
      setStatus(null);
      setWarn(res.warnings);
      if (!res.entries.length && !(res.warnings || []).length) {
        panelEl.querySelector('#bp-results').innerHTML = '<div class="bp-empty">Nenhum apontamento encontrado para os critérios informados.</div>';
      }
    } catch (e) {
      setStatus(null);
      if (!isAbort(e)) { toast('Erro na busca: ' + (e.message || e), true); console.error('[Busca Protesto]', e); }
    } finally {
      if (activeCtl === ctl) activeCtl = null;
      setBusy(false);
    }
  }

  function renderSummary(res, crit) {
    const el = panelEl.querySelector('#bp-summary');
    const chips = [];
    if (crit.term) chips.push('Ordem: <b>' + esc(crit.term) + '</b>');
    if (crit.name) chips.push('Nome: <b>' + esc(crit.name) + '</b>' + (crit.role ? ' (' + esc((ROLES.find((r) => r.v === crit.role) || {}).l || '') + ')' : ''));
    if (crit.doc) chips.push('CPF/CNPJ: <b>' + esc(formatDocument(crit.doc)) + '</b>');
    if (crit.title) chips.push('Título: <b>' + esc(crit.title) + '</b>');
    const total = res.truncated ? res.entries.length + '+' : res.entries.length;
    el.innerHTML = '<span class="bp-chip">' + total + ' resultado' + (res.entries.length === 1 ? '' : 's') + '</span> ' + chips.join(' · ');
    if (res.resolved && res.resolved.length) {
      el.innerHTML += '<div style="margin-top:4px;color:var(--bp-muted)">Pessoa(s) resolvida(s): ' + res.resolved.map(esc).join(' · ') + '</div>';
    }
    el.classList.add('bp-on');
  }

  const TITULO_KEYS = [
    ['Número do Título', 'Nº do título'],
    ['Nosso Número', 'Nosso número'],
    ['Espécie do Título Apresentado', 'Espécie'],
    ['Valor', 'Valor'],
    ['Saldo', 'Saldo'],
    ['Data de Vencimento', 'Vencimento'],
    ['Data de emissão', 'Emissão'],
    ['Data da Apresentação', 'Apresentação'],
    ['Praça de Pagamento do Protesto', 'Praça'],
  ];

  function renderResults(entries) {
    const host = panelEl.querySelector('#bp-results');
    host.innerHTML = '';
    for (const e of entries) {
      const card = document.createElement('div');
      card.className = 'bp-card';
      const kv = [];
      const f = e._titulo || {};
      for (const [key, label] of TITULO_KEYS) {
        if (f[key]) kv.push('<div><span>' + label + ':</span> ' + esc(f[key]) + '</div>');
      }
      const parts = e._pessoas || {};
      const deb = parts['Devedor'] || [];
      const outros = Object.keys(parts)
        .filter((k) => k !== 'Devedor' && k !== 'Apresentante' && !/^Apontamento/.test(k))
        .map((k) => '<div><span>' + esc(k) + ':</span> ' + parts[k].map(esc).join(' · ') + '</div>');
      card.innerHTML = `
        <div class="bp-top">
          <span class="bp-order">Nº ${esc(e.order_number)}</span>
          <span class="bp-nat">${esc(e.nature || '')}</span>
          ${e.protocol && e.protocol.code ? '<span class="bp-nat">' + esc(e.protocol.code) + '</span>' : ''}
        </div>
        ${deb.length ? '<div class="bp-pres"><span style="color:var(--bp-muted)">Devedor:</span> ' + deb.map(esc).join(' · ') + '</div>' : ''}
        <div class="bp-pres"><span style="color:var(--bp-muted)">Apresentante:</span> ${esc(e.presenter || '—')}</div>
        <div class="bp-pres"><span style="color:var(--bp-muted)">Registrado em:</span> ${esc(e.registered_at || '—')}</div>
        ${kv.length ? '<div class="bp-kv">' + kv.join('') + '</div>' : ''}
        ${outros.length ? '<div class="bp-kv">' + outros.join('') + '</div>' : ''}
        <div class="bp-links">
          <a href="${esc(e.url || '#')}" target="_blank" rel="noopener">Abrir apontamento &#8599;</a>
          ${e.protocol && e.protocol.url ? '<a href="' + esc(e.protocol.url) + '" target="_blank" rel="noopener">Protocolo &#8599;</a>' : ''}
          ${e._processo ? '<a href="' + esc(ORIGIN + e._processo) + '" target="_blank" rel="noopener">Processo &#8599;</a>' : ''}
          ${e.instrument_url ? '<a href="' + esc(e.instrument_url) + '" target="_blank" rel="noopener">Instrumento &#8599;</a>' : ''}
        </div>`;
      host.appendChild(card);
    }
  }

  function resetForm() {
    for (const id of ['#bp-term', '#bp-name', '#bp-doc', '#bp-title']) panelEl.querySelector(id).value = '';
    panelEl.querySelector('#bp-role').value = '';
    lastResults = [];
    panelEl.querySelector('#bp-results').innerHTML = '';
    panelEl.querySelector('#bp-summary').classList.remove('bp-on');
    panelEl.querySelector('#bp-csv').disabled = true;
    setWarn([]);
  }

  /* ---------------- CSV ---------------- */
  function exportCsv() {
    if (!lastResults.length) return;
    const cols = ['ordem', 'natureza', 'apresentante', 'registrado_em', 'protocolo', 'devedor',
      'numero_titulo', 'nosso_numero', 'especie', 'valor', 'saldo', 'vencimento', 'emissao', 'apresentacao', 'praca', 'url'];
    const rows = [cols.join(';')];
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    for (const e of lastResults) {
      const f = e._titulo || {};
      const deb = ((e._pessoas || {}).Devedor || []).join(' · ');
      rows.push([
        e.order_number, e.nature, e.presenter, e.registered_at, e.protocol && e.protocol.code, deb,
        f['Número do Título'], f['Nosso Número'], f['Espécie do Título Apresentado'], f['Valor'], f['Saldo'],
        f['Data de Vencimento'], f['Data de emissão'], f['Data da Apresentação'], f['Praça de Pagamento do Protesto'],
        e.url,
      ].map(q).join(';'));
    }
    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'busca-protesto-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('CSV exportado (' + lastResults.length + ' linhas).');
  }

  /* ---------------- inicialização ---------------- */
  function onKeydown(e) {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === SHORTCUT.key) {
      e.preventDefault();
      togglePanel();
    }
  }

  function init() {
    buildUI();
    window.addEventListener('keydown', onKeydown, true);
    // acompanha navegação SPA para esconder/mostrar o botão
    setInterval(() => {
      const ok = location.pathname.startsWith(URL_LIST);
      if (btnEl) btnEl.style.display = ok ? 'block' : 'none';
      if (!ok && panelEl) panelEl.classList.remove('bp-open');
      applyTheme();
    }, 1500);
  }

  function safeInit() {
    try {
      if (document.querySelector('.bp-root')) return;
      init();
    } catch (error) {
      // Um erro de inicialização deve ser diagnosticável sem deixar uma falha
      // silenciosa que pareça que o Violentmonkey desligou o script.
      console.error('[Busca Protesto] falha ao inicializar:', error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit, { once: true });
  else safeInit();
})();
