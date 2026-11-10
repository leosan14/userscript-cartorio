// ==UserScript==
// @name         NoCartório → Trello
// @namespace    cartoriosja.nocartorio.trello
// @version      1.3.0
// @description  Painel no protocolo do NoCartório: mostra se já existe cartão no Trello (e onde está), cria o cartão com quadro, coluna, etiqueta, responsável e prazo em dias úteis, e edita o cartão existente (mover, concluir, prazo, etiquetas, responsáveis, checklists).
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.trello.com
// @run-at       document-idle
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-trello.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-trello.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   * CORE — funções puras (sem DOM), testáveis fora do navegador
   * ===================================================================== */
  const Core = (() => {
    // palavras que não ajudam a comparar o nome do ato com o nome da etiqueta
    const STOP = new Set(('a o as os ao aos de da do das dos e em no na nos nas num numa para por pelo pela ' +
      'com sem ou um uma selo convencional eletronico eletronica digital publica publico livro n').split(' '));
    const NAME_STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

    function strip(s) {
      return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    function norm(s) {
      return strip(s).toLowerCase()
        .replace(/\([^)]*\bselo\b[^)]*\)/g, ' ') // "(selo convencional)", "(selo eletrônico)"
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }
    function stem(t) {
      if (t.length <= 4 || /^\d+$/.test(t)) return t;
      if (/(oes|aes)$/.test(t)) return t.slice(0, -3) + 'ao';
      if (/eis$/.test(t)) return t.slice(0, -3) + 'el';
      if (/s$/.test(t)) return t.slice(0, -1);
      return t;
    }
    function actTokens(s) {
      return norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
    }
    function nameTokens(s) {
      return norm(s).split(' ').filter((t) => t.length > 1 && !NAME_STOP.has(t));
    }
    function lev(a, b) {
      const m = a.length, n = b.length;
      if (!m) return n;
      if (!n) return m;
      let prev = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
      }
      return prev[n];
    }
    function tokEq(a, b) {
      if (a === b) return true;
      const m = Math.min(a.length, b.length);
      if (m >= 5 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1) return true; // Viera ~ Vieira
      if (m >= 5 && (a.startsWith(b) || b.startsWith(a))) return true; // hipotecaria ~ hipoteca
      return false;
    }
    function matchCount(A, B) {
      const used = new Array(B.length).fill(false);
      let n = 0;
      for (const a of A) {
        for (let i = 0; i < B.length; i++) {
          if (!used[i] && tokEq(a, B[i])) { used[i] = true; n++; break; }
        }
      }
      return n;
    }
    /** Semelhança (0–1) entre o nome do ato no NoCartório e o nome de uma etiqueta do Trello. */
    function actScore(actName, labelName) {
      const A = actTokens(actName), B = actTokens(labelName);
      if (!A.length || !B.length) return 0;
      const m = matchCount(A, B);
      let s = (2 * m) / (A.length + B.length);
      const na = norm(actName), nb = norm(labelName);
      if (m && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) s = Math.min(1, s + 0.1);
      return Math.round(s * 100) / 100;
    }
    /** Semelhança entre o nome do assinante (NoCartório) e o nome do membro (Trello). */
    function nameScore(signer, member) {
      const A = nameTokens(signer), B = nameTokens(member);
      if (!A.length || !B.length) return 0;
      const m = matchCount(B, A);
      if (B.length === 1) return m === 1 ? (A.length <= 2 ? 0.7 : 0.5) : 0;
      if (m < 2) return 0;
      return Math.round((m / B.length) * 100) / 100;
    }
    /** Melhor membro para o assinante, ou null se não houver um candidato claro. */
    function bestMember(signer, members) {
      const scored = (members || [])
        .map((mb) => ({ m: mb, s: nameScore(signer, mb.fullName || mb.username || '') }))
        .sort((a, b) => b.s - a.s);
      const top = scored[0], second = scored[1];
      if (!top || top.s < 0.6) return null;
      if (second && second.s >= top.s - 0.1) return null; // empate: deixa o seletor vazio
      return top.m;
    }
    function parseSignatory(label) {
      const s = String(label || '').trim();
      const m = s.match(/^(.*?)\s+como\s+(.+)$/i);
      return m ? { name: m[1].trim(), role: m[2].trim() } : { name: s, role: '' };
    }
    function cleanActName(name) {
      return String(name || '').replace(/\s*\([^)]*\bselo\b[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
    }

    /* ---------- números de protocolo ---------- */
    function digits(n) { return String(n == null ? '' : n).replace(/\D/g, ''); }
    function fmtNum(n, dot) {
      const s = digits(n);
      return dot ? s.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : s;
    }
    /** O título do cartão contém esse número? Aceita 32.144, 32144, "31.483 - 32.144", "Protocolo nº 32.144"… */
    function nameHasNumber(name, n) {
      const d = digits(n);
      if (!d) return false;
      const s = String(name || '').replace(/(\d)\.(?=\d{3}(?!\d))/g, '$1');
      return new RegExp('(^|[^\\d])' + d + '(?!\\d)').test(s);
    }
    /** Descobre o padrão de título usado no quadro (32.144 ou 32144; com ou sem " - NOME"). */
    function detectTitleFormat(names) {
      let dot = 0, nodot = 0, named = 0, total = 0;
      for (const nm of names || []) {
        const m = String(nm).match(/^\s*(\d{1,3}(?:\.\d{3})+|\d{4,})(?!\d)(.*)$/);
        if (!m) continue;
        total++;
        if (m[1].includes('.')) dot++; else nodot++;
        if (/^\s*[-–]\s*\p{L}/u.test(m[2])) named++;
      }
      return { total, dot: total ? dot >= nodot : true, named: total ? named / total > 0.5 : false };
    }

    /* ---------- descrição ---------- */
    const PLACEHOLDER = /^(?:x+|\?+|\.+|_+|-+|(?:\\?\*){1,4}|n\/?a)?$/i;
    const LINE_RE = /^(\s*(?:[-*+]\s+)?(?:\*\*)?)([^:\n]{2,60}?)((?:\*\*)?\s*:\s*)(.*)$/;
    function descKey(label) {
      const k = norm(label);
      if (/matricula/.test(k)) return 'matricula';
      if (/contato|telefone|whats/.test(k)) return 'contato';
      if (/apresentante|requerente/.test(k)) return 'apresentante';
      return null;
    }
    /** Preenche a descrição do modelo do quadro (ou a padrão) com os dados do protocolo. */
    function fillDescription(template, data, opts) {
      const tpl = String(template || '');
      const has = tpl.split('\n').some((l) => { const m = l.match(LINE_RE); return m && descKey(m[2]); });
      if (!has) {
        const out = ['- Nome do apresentante: ' + (data.apresentante || '')];
        if (opts && opts.matricula) out.push('- Número da Matrícula: ' + (data.matricula || ''));
        out.push('- Contato do apresentante: ' + (data.contato || ''));
        return out.join('\n');
      }
      return tpl.split('\n').map((l) => {
        const m = l.match(LINE_RE);
        if (!m) return l;
        const key = descKey(m[2]);
        if (!key) return l;
        const prefix = m[1] + m[2] + m[3].replace(/\s*$/, ' ');
        const cur = m[4].trim();
        if (data[key]) return prefix + data[key];
        return PLACEHOLDER.test(cur) ? prefix : l;
      }).join('\n');
    }
    /** Coloca um valor numa linha da descrição, só se a linha ainda estiver vazia. */
    function setDescField(desc, key, value) {
      let done = false;
      return String(desc || '').split('\n').map((l) => {
        if (done) return l;
        const m = l.match(LINE_RE);
        if (!m || descKey(m[2]) !== key) return l;
        done = true;
        const cur = m[4].trim();
        if (cur && !PLACEHOLDER.test(cur)) return l; // já preenchida pelo usuário
        return m[1] + m[2] + m[3].replace(/\s*$/, ' ') + value;
      }).join('\n');
    }
    function joinPt(list) {
      const a = (list || []).filter(Boolean);
      if (a.length <= 1) return a.join('');
      return a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1];
    }
    /** Extrai o nº da matrícula de uma "parte" do ato no NoCartório (ex.: "M-1496 (02.923-1) Casa"). */
    function matriculaFromPart(part) {
      const role = norm(part && part.role);
      const name = String((part && part.name) || '').trim();
      if (!/matricula/.test(role) || !name) return null;
      const m = name.match(/^\s*M\s*[-.]?\s*([\d.]+)/i);
      if (m && /registro geral/.test(role)) return m[1].replace(/\./g, '');
      return name.replace(/\s*\(.*$/, '').trim() || null;
    }

    /* ---------- dias úteis ---------- */
    function easter(y) { // algoritmo de Meeus/Jones/Butcher
      const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
      const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
      const m = Math.floor((a + 11 * h + 22 * l) / 451);
      const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
      return new Date(y, month - 1, day);
    }
    const pad = (n) => String(n).padStart(2, '0');
    function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
    function parseExtraHolidays(text) {
      const fixed = [], once = [];
      for (const raw of String(text || '').split(/[\n,;]+/)) {
        const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
        if (!m) continue;
        const d = +m[1], mo = +m[2];
        let y = m[3] ? +m[3] : null;
        if (y && y < 100) y += 2000;
        if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
        const nameMatch = raw.trim().match(/^\S+\s+[-–]?\s*(.+)$/);
        const name = nameMatch ? nameMatch[1].trim() : 'Feriado local';
        if (y) once.push([y + '-' + pad(mo) + '-' + pad(d), name]);
        else fixed.push([pad(mo) + '-' + pad(d), name]);
      }
      return { fixed, once };
    }
    const NATIONAL = [
      ['01-01', 'Confraternização Universal'], ['04-21', 'Tiradentes'], ['05-01', 'Dia do Trabalho'],
      ['09-07', 'Independência do Brasil'], ['10-12', 'Nossa Senhora Aparecida'], ['11-02', 'Finados'],
      ['11-15', 'Proclamação da República'], ['11-20', 'Consciência Negra'], ['12-25', 'Natal'],
    ];
    function holidaysOfYear(y, opts) {
      const o = opts || {};
      const map = new Map();
      for (const [md, name] of NATIONAL) map.set(y + '-' + md, name);
      const e = easter(y);
      map.set(ymd(addDays(e, -2)), 'Sexta-feira Santa');
      if (o.carnaval) { map.set(ymd(addDays(e, -48)), 'Carnaval'); map.set(ymd(addDays(e, -47)), 'Carnaval'); }
      if (o.corpus) map.set(ymd(addDays(e, 60)), 'Corpus Christi');
      const ex = parseExtraHolidays(o.extras);
      for (const [md, name] of ex.fixed) map.set(y + '-' + md, name);
      for (const [d, name] of ex.once) if (d.startsWith(y + '-')) map.set(d, name);
      return map;
    }
    function makeCalendar(opts) {
      const cache = new Map();
      const holidayName = (d) => {
        const y = d.getFullYear();
        if (!cache.has(y)) cache.set(y, holidaysOfYear(y, opts));
        return cache.get(y).get(ymd(d)) || null;
      };
      const isBusinessDay = (d) => d.getDay() !== 0 && d.getDay() !== 6 && !holidayName(d);
      /** Conta n dias úteis a partir do dia seguinte a `from`. */
      const addBusinessDays = (from, n) => {
        let d = addDays(from, 0), c = 0;
        while (c < n) { d = addDays(d, 1); if (isBusinessDay(d)) c++; }
        return d;
      };
      const upcoming = (from, count) => {
        const out = [];
        for (let i = 0; i < 400 && out.length < count; i++) {
          const d = addDays(from, i), n = holidayName(d);
          if (n) out.push({ date: d, name: n });
        }
        return out;
      };
      return { holidayName, isBusinessDay, addBusinessDays, upcoming };
    }

    return {
      norm, actTokens, nameTokens, lev, tokEq, actScore, nameScore, bestMember, parseSignatory, cleanActName,
      digits, fmtNum, nameHasNumber, detectTitleFormat,
      fillDescription, setDescField, joinPt, matriculaFromPart, descKey,
      easter, ymd, addDays, parseExtraHolidays, holidaysOfYear, makeCalendar,
    };
  })();

  // Execução fora do navegador (testes com Node): exporta o núcleo e para aqui.
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = Core;
    return;
  }

  /* =====================================================================
   * CONFIGURAÇÃO E MEMÓRIA (GM storage — fica só neste navegador)
   * ===================================================================== */
  const VERSION = '1.3.0';
  const DEF_CFG = { key: '', token: '', carnaval: true, corpus: true, extras: '', hiddenBoards: null, pos: 'bottom', attach: true };
  const DEF_MEM = { boardByPT: {}, boardByCT: {}, listByBoard: {}, templateByBoard: {}, labelMap: {}, memberBySig: {}, dueByBoard: {}, extraByBoard: {} };
  const NEW_LABEL_COLOR = 'sky_light'; // azul-celeste suave

  function gmGet(k, d) { try { const v = GM_getValue(k); return v === undefined || v === null ? d : v; } catch (e) { return d; } }
  function gmSet(k, v) { try { GM_setValue(k, v); } catch (e) { console.warn('[NoCartório→Trello] falha ao salvar', e); } }
  function getCfg() { return Object.assign({}, DEF_CFG, gmGet('cfg', {})); }
  function setCfg(c) { gmSet('cfg', c); }
  function getMem() {
    const m = gmGet('mem', {});
    const out = {};
    for (const k of Object.keys(DEF_MEM)) out[k] = Object.assign({}, m[k] || {});
    return out;
  }
  function setMem(m) { gmSet('mem', m); }
  function hasCreds() { const c = getCfg(); return !!(c.key && c.token); }
  function calendar() { const c = getCfg(); return Core.makeCalendar({ carnaval: c.carnaval, corpus: c.corpus, extras: c.extras }); }
  function isBoardVisible(b) {
    const c = getCfg();
    if (Array.isArray(c.hiddenBoards)) return !c.hiddenBoards.includes(b.id);
    return !/desuso/i.test(b.name || '');
  }

  /* =====================================================================
   * TRELLO API
   * ===================================================================== */
  class TrelloError extends Error {
    constructor(msg, status) { super(msg); this.status = status; }
  }
  function explainTrello(status, text) {
    if (status === 401) return 'O Trello recusou a chave/token (inválido, expirado ou sem permissão). Confira nas configurações.';
    if (status === 403) return 'Sem permissão no Trello para essa ação.';
    if (status === 404) return 'O Trello não encontrou o item (quadro, coluna ou cartão).';
    if (status === 413) return 'Arquivo grande demais para o Trello (limite de 10 MB no plano gratuito; 250 MB nos planos pagos).';
    if (status === 429) return 'Muitas requisições ao Trello. Aguarde alguns segundos e tente de novo.';
    const t = String(text || '').replace(/\s+/g, ' ').slice(0, 160);
    return 'Erro ' + status + ' do Trello' + (t ? ': ' + t : '');
  }
  function trelloOnce(method, path, query, body) {
    const c = getCfg();
    if (!c.key || !c.token) return Promise.reject(new TrelloError('Configure a chave e o token do Trello.', 0));
    let url = 'https://api.trello.com/1' + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
      const s = qs.toString();
      if (s) url += '?' + s;
    }
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData; // envio de arquivo
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: Object.assign(
          { Authorization: 'OAuth oauth_consumer_key="' + c.key + '", oauth_token="' + c.token + '"', Accept: 'application/json' },
          body && !isForm ? { 'Content-Type': 'application/json' } : {}
        ),
        data: isForm ? body : body ? JSON.stringify(body) : undefined,
        timeout: isForm ? 300000 : 30000,
        onload: (r) => {
          let j = null;
          try { j = r.responseText ? JSON.parse(r.responseText) : null; } catch (e) { /* resposta não-JSON */ }
          if (r.status >= 200 && r.status < 300) resolve(j);
          else reject(new TrelloError(explainTrello(r.status, r.responseText), r.status));
        },
        onerror: () => reject(new TrelloError('Falha de rede ao falar com o Trello.', 0)),
        ontimeout: () => reject(new TrelloError('O Trello demorou demais para responder.', 0)),
      });
    });
  }
  async function trello(method, path, opts) {
    const o = opts || {};
    try {
      return await trelloOnce(method, path, o.query, o.body);
    } catch (e) {
      if (e.status === 429) { await new Promise((r) => setTimeout(r, 2000)); return trelloOnce(method, path, o.query, o.body); }
      throw e;
    }
  }

  /* =====================================================================
   * NOCARTÓRIO — leitura dos dados do protocolo
   * ===================================================================== */
  function pageVersion() {
    try { const sp = document.querySelector('script[data-page]'); if (sp && sp.textContent.trim().startsWith('{')) return JSON.parse(sp.textContent).version || null; } catch (e) { /* */ }
    try { const el = document.querySelector('[data-page]'); const v = el && el.getAttribute('data-page'); if (v && v.startsWith('{')) return JSON.parse(v).version || null; } catch (e) { /* */ }
    return null;
  }
  async function fullPageProps(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('O NoCartório respondeu ' + r.status + '.');
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const sp = doc.querySelector('script[data-page]');
    if (sp && sp.textContent.trim().startsWith('{')) return JSON.parse(sp.textContent).props;
    const el = doc.querySelector('[data-page]');
    const v = el && el.getAttribute('data-page');
    if (v && v.startsWith('{')) return JSON.parse(v).props;
    throw new Error('Não encontrei os dados da página no NoCartório.');
  }
  /** Lê as "props" de uma página Inertia; tenta a requisição parcial (leve) e cai para o HTML completo. */
  async function inertiaProps(url, component, only) {
    const ver = pageVersion();
    if (ver && component) {
      try {
        const headers = { 'X-Inertia': 'true', 'X-Inertia-Version': ver, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, application/xhtml+xml' };
        if (only && only.length) { headers['X-Inertia-Partial-Component'] = component; headers['X-Inertia-Partial-Data'] = only.join(','); }
        const r = await fetch(url, { credentials: 'same-origin', headers });
        if (r.ok) {
          const j = await r.json();
          if (j && j.props) return j.props;
        }
      } catch (e) { /* cai para o HTML completo */ }
    }
    return fullPageProps(url);
  }

  async function loadProtocol(uuid) {
    const path = '/admin/manager/v2/protocol/' + uuid;
    const props = await inertiaProps(path, 'Protocol/Edit/Index', ['protocol', 'parts', 'processFilter']);
    const d = props && props.protocol && props.protocol.data;
    if (!d) throw new Error('Não consegui ler os dados deste protocolo.');
    const ref = d.references || {};
    let numero = ref.orderNumber != null ? Core.digits(ref.orderNumber) : '';
    const refLabel = String(ref.label || '').replace(/<[^>]+>/g, '');
    if (!numero) {
      const m = refLabel.match(/(?:protocolo|apontamento|prenota\w*)\s*(?:n[º°o.]*\s*)?(\d+)/i);
      if (m) numero = m[1];
    }
    const info = d.protocolInformation || {};
    const sigSel = d.signatory && d.signatory.initialSelection;
    const sig = sigSel && sigSel.label ? Object.assign({ id: sigSel.value || '', label: sigSel.label }, Core.parseSignatory(sigSel.label)) : null;
    const apresentantes = [];
    for (const p of props.parts || []) {
      if (!/apresentante/i.test(p.roleName || '')) continue;
      for (const it of p.items || []) {
        const n = it && it.data && it.data.profile && it.data.profile.name;
        if (n && !apresentantes.includes(n)) apresentantes.push(n);
      }
    }
    return {
      uuid,
      numero,
      refLabel,
      code: info.code || '',
      companyType: info.companyType || null,
      processType: (d.service && d.service.processType) || null,
      signatory: sig,
      apresentantes,
      processes: (props.processFilter && props.processFilter.data) || [],
      url: location.origin + path,
    };
  }

  const matriculaCache = new Map();
  async function loadMatriculas(proto) {
    if (matriculaCache.has(proto.uuid)) return matriculaCache.get(proto.uuid);
    const found = [];
    // As páginas dos atos não aceitam a requisição parcial do Inertia (respondem 409), por isso lemos o HTML.
    await Promise.all((proto.processes || []).map(async (p) => {
      try {
        const props = await fullPageProps('/admin/manager/process/' + p.id);
        for (const part of (props.layout && props.layout.parts) || []) {
          const m = Core.matriculaFromPart(part);
          if (m && !found.includes(m)) found.push(m);
        }
      } catch (e) { /* ignora o ato que falhar */ }
    }));
    found.sort((a, b) => (+a || 0) - (+b || 0));
    matriculaCache.set(proto.uuid, found);
    return found;
  }

  /* =====================================================================
   * ESTADO
   * ===================================================================== */
  const S = {
    uuid: null, open: false, view: 'main',
    proto: null, protoErr: null, matriculas: null, matriculaErr: false,
    me: null, boards: null, boardsErr: null, loading: false, cfgDraft: null,
    boardData: {}, boardErr: {}, boardLoading: {}, scanning: false, scanned: false, matches: null,
    archived: null, archivedLoading: false, archivedErr: null,
    templates: {}, tplDetail: {}, labelSug: [],
    creating: false, created: null, createErr: null, createWarn: [],
    configMsg: null, importOpen: false,
    showNew: false, edit: null, cardBusy: {}, cardErr: {},
  };
  let F = blankForm();
  let E = null; // formulário de edição do cartão existente
  function blankForm() {
    return {
      boardId: '', listId: '', templateId: '', title: '', titleTouched: false, desc: '', descTouched: false,
      labelMode: 'none', labelId: '', newLabelName: '', extraLabels: [], extraShown: [], memberId: '', memberWhy: '', dueDays: 5,
      attach: getCfg().attach, pos: getCfg().pos, confirmDup: false, files: [], comment: '',
    };
  }
  function resetState(uuid) {
    Object.assign(S, {
      uuid, proto: null, protoErr: null, matriculas: null, matriculaErr: false, matches: null, scanned: false,
      archived: null, archivedLoading: false, archivedErr: null, labelSug: [], loading: false,
      creating: false, created: null, createErr: null, createWarn: [],
      showNew: false, edit: null, cardBusy: {}, cardErr: {},
    });
    F = blankForm();
    E = null;
  }

  /* =====================================================================
   * CARGA DE DADOS
   * ===================================================================== */
  async function loadBoards() {
    const [me, boards] = await Promise.all([
      trello('GET', '/members/me', { query: { fields: 'fullName,username' } }),
      trello('GET', '/members/me/boards', { query: { filter: 'open', fields: 'name,shortUrl,closed' } }),
    ]);
    S.me = me;
    S.boards = (boards || []).filter((b) => !b.closed).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }
  function loadBoardData(id, force) {
    const cur = S.boardData[id];
    if (cur && !force && Date.now() - cur.t < 60000) return Promise.resolve(cur);
    if (S.boardLoading[id] && !force) return S.boardLoading[id];
    const p = fetchBoardData(id).finally(() => { delete S.boardLoading[id]; });
    S.boardLoading[id] = p;
    return p;
  }
  async function fetchBoardData(id) {
    const b = await trello('GET', '/boards/' + id, {
      query: {
        fields: 'name,shortUrl',
        cards: 'open', card_fields: 'name,idList,shortUrl,due,dueComplete,idMembers,idLabels,pos,isTemplate',
        lists: 'open', list_fields: 'name,pos',
        labels: 'all', label_fields: 'name,color', labels_limit: 1000,
        members: 'all', member_fields: 'fullName,username,initials',
      },
    });
    const data = {
      t: Date.now(), id, name: b.name, shortUrl: b.shortUrl,
      cards: b.cards || [], lists: (b.lists || []).slice().sort((x, y) => x.pos - y.pos),
      labels: b.labels || [], members: (b.members || []).slice().sort((x, y) => (x.fullName || '').localeCompare(y.fullName || '', 'pt-BR')),
    };
    S.boardData[id] = data;
    delete S.boardErr[id];
    return data;
  }
  async function loadTemplates(boardId) {
    const bd = S.boardData[boardId];
    const found = new Map();
    for (const c of (bd && bd.cards) || []) if (c.isTemplate) found.set(c.id, { id: c.id, name: c.name, isTemplate: true, closed: false, dateLastActivity: null, visible: true });
    for (const extra of ['', ' is:archived']) {
      try {
        const r = await trello('GET', '/search', {
          query: { query: 'name:protocolo' + extra, idBoards: boardId, modelTypes: 'cards', card_fields: 'name,isTemplate,closed,dateLastActivity', cards_limit: 50, partial: 'false' },
        });
        for (const c of (r && r.cards) || []) {
          if (!(c.isTemplate || /^\s*protocolo\s*$/i.test(c.name))) continue;
          const prev = found.get(c.id);
          found.set(c.id, Object.assign({}, c, prev && prev.visible ? { visible: true } : {}));
        }
      } catch (e) { /* busca opcional */ }
    }
    // ordem: modelos de verdade, depois os visíveis na coluna, depois o mais recente
    const list = [...found.values()].sort((a, b) => (Number(!!b.isTemplate) - Number(!!a.isTemplate)) ||
      (Number(!!b.visible) - Number(!!a.visible)) ||
      (new Date(b.dateLastActivity || 0) - new Date(a.dateLastActivity || 0)));
    S.templates[boardId] = list;
    return list;
  }
  async function loadTemplateDetail(cardId) {
    if (S.tplDetail[cardId]) return S.tplDetail[cardId];
    const c = await trello('GET', '/cards/' + cardId, { query: { fields: 'name,desc', checklists: 'all', checklist_fields: 'name' } });
    S.tplDetail[cardId] = { desc: c.desc || '', checklists: (c.checklists || []).map((x) => ({ id: x.id, name: x.name })) };
    return S.tplDetail[cardId];
  }

  function computeMatches() {
    const num = S.proto && S.proto.numero;
    if (!num || !S.boards) { S.matches = []; return; }
    const out = [];
    for (const b of S.boards) {
      const bd = S.boardData[b.id];
      if (!bd) continue;
      for (const c of bd.cards) {
        if (c.isTemplate || !Core.nameHasNumber(c.name, num)) continue;
        const list = bd.lists.find((l) => l.id === c.idList);
        const inList = bd.cards.filter((x) => x.idList === c.idList && !x.isTemplate).sort((x, y) => x.pos - y.pos);
        out.push({ card: c, board: bd, list, position: inList.findIndex((x) => x.id === c.id) + 1, total: inList.length });
      }
    }
    out.sort((a, b) => (Number(b.board.id === F.boardId) - Number(a.board.id === F.boardId)) || a.board.name.localeCompare(b.board.name, 'pt-BR'));
    S.matches = out;
  }
  async function scanBoards(force) {
    if (!S.boards) return;
    S.scanning = true; render();
    const vis = S.boards.filter(isBoardVisible);
    let i = 0;
    const worker = async () => {
      while (i < vis.length) {
        const b = vis[i++];
        try { await loadBoardData(b.id, force); } catch (e) { S.boardErr[b.id] = e.message; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    S.scanning = false;
    S.scanned = true;
    computeMatches();
    render();
  }
  async function searchArchived() {
    const num = S.proto && S.proto.numero;
    if (!num) return;
    S.archivedLoading = true; S.archivedErr = null; render();
    try {
      const variants = [...new Set([Core.fmtNum(num, true), Core.fmtNum(num, false)])];
      const found = new Map();
      for (const v of variants) {
        const r = await trello('GET', '/search', {
          query: {
            query: '"' + v + '" is:archived', modelTypes: 'cards', idBoards: 'mine', cards_limit: 50,
            card_fields: 'name,shortUrl,closed,idBoard,idList,dateLastActivity', card_board: 'true', board_fields: 'name', card_list: 'true', list_fields: 'name',
          },
        });
        for (const c of (r && r.cards) || []) if (Core.nameHasNumber(c.name, num) && !c.isTemplate) found.set(c.id, c);
      }
      S.archived = [...found.values()];
    } catch (e) {
      S.archivedErr = e.message;
    }
    S.archivedLoading = false;
    render();
  }

  /* =====================================================================
   * PADRÕES DO FORMULÁRIO
   * ===================================================================== */
  function isRI() { const ct = S.proto && S.proto.companyType; return !!ct && (ct.initials === 'ri' || /im[óo]veis/i.test(ct.name || '')); }
  function descData() {
    return {
      apresentante: (S.proto && S.proto.apresentantes.join(' / ')) || '',
      matricula: S.matriculas && S.matriculas.length ? Core.joinPt(S.matriculas) : '',
      contato: '',
    };
  }
  function rebuildDesc() {
    if (F.descTouched) return;
    const tpl = F.templateId && S.tplDetail[F.templateId] ? S.tplDetail[F.templateId].desc : '';
    F.desc = Core.fillDescription(tpl, descData(), { matricula: isRI() });
  }
  function buildTitle(bd) {
    if (!S.proto || !S.proto.numero) return '';
    const fmt = Core.detectTitleFormat(bd.cards.filter((c) => !c.isTemplate).map((c) => c.name));
    let t = Core.fmtNum(S.proto.numero, fmt.dot);
    if (fmt.named && S.proto.apresentantes[0]) t += ' - ' + S.proto.apresentantes[0];
    return t;
  }
  function labelSuggestionsFor(boardId) {
    const bd = S.boardData[boardId];
    const act = S.proto && S.proto.processType && S.proto.processType.name;
    if (!bd || !act) return [];
    const mem = getMem();
    const rememberedId = ((mem.labelMap[boardId] || {})[S.proto.processType.id]) || null;
    return bd.labels.filter((l) => l.name).map((l) => ({ label: l, score: Core.actScore(act, l.name), remembered: l.id === rememberedId }))
      .filter((x) => x.score >= 0.25 || x.remembered)
      .sort((a, b) => (Number(b.remembered) - Number(a.remembered)) || (b.score - a.score))
      .slice(0, 5);
  }
  function computeLabelSuggestions() { S.labelSug = labelSuggestionsFor(F.boardId); }
  /** Membro do quadro que corresponde ao assinante do serviço (lembrado ou pelo nome), ou ''. */
  function signerMemberId(bd) {
    const sig = S.proto && S.proto.signatory;
    if (!sig || !bd) return '';
    const rem = sig.id && getMem().memberBySig[sig.id];
    if (rem && bd.members.some((m) => m.id === rem)) return rem;
    const best = Core.bestMember(sig.name, bd.members);
    return best ? best.id : '';
  }
  function applyBoardDefaults() {
    const bd = S.boardData[F.boardId];
    if (!bd || !S.proto) return;
    const mem = getMem();
    const ml = mem.listByBoard[F.boardId];
    F.listId = bd.lists.some((l) => l.id === ml) ? ml : (bd.lists[0] ? bd.lists[0].id : '');
    if (!F.titleTouched) F.title = buildTitle(bd);
    computeLabelSuggestions();
    const top = S.labelSug[0];
    if (top && (top.remembered || top.score >= 0.5)) { F.labelMode = 'pick'; F.labelId = top.label.id; }
    else { F.labelMode = 'new'; F.labelId = ''; }
    F.newLabelName = Core.cleanActName(S.proto.processType ? S.proto.processType.name : '');
    F.memberId = ''; F.memberWhy = '';
    const sig = S.proto.signatory;
    if (sig) {
      const rem = sig.id && mem.memberBySig[sig.id];
      if (rem && bd.members.some((m) => m.id === rem)) { F.memberId = rem; F.memberWhy = 'lembrado'; }
      else {
        const best = Core.bestMember(sig.name, bd.members);
        if (best) { F.memberId = best.id; F.memberWhy = 'nome'; }
      }
    }
    const md = mem.dueByBoard[F.boardId];
    F.dueDays = md === 0 || md === 3 || md === 5 || md === 10 ? md : 5;
    F.extraLabels = []; F.extraShown = [];
    F.confirmDup = false;
  }
  function applyTemplateDefault() {
    const list = S.templates[F.boardId] || [];
    const rem = getMem().templateByBoard[F.boardId];
    if (rem === '') F.templateId = '';
    else if (rem && list.some((t) => t.id === rem)) F.templateId = rem;
    else F.templateId = list[0] ? list[0].id : '';
  }
  async function selectTemplate(id) {
    F.templateId = id;
    if (id) {
      try { await loadTemplateDetail(id); } catch (e) { S.createErr = 'Não consegui ler o modelo: ' + e.message; }
    }
    rebuildDesc();
    render();
  }
  async function setBoard(id) {
    F.boardId = id;
    S.created = null; S.createErr = null; S.createWarn = [];
    computeMatches();
    render();
    if (!id) return;
    try {
      await loadBoardData(id);
    } catch (e) {
      S.boardErr[id] = e.message; render(); return;
    }
    applyBoardDefaults();
    rebuildDesc();
    computeMatches();
    render();
    if (!S.templates[id]) await loadTemplates(id);
    if (F.boardId !== id) return;
    applyTemplateDefault();
    await selectTemplate(F.templateId);
  }
  function defaultBoardId() {
    const mem = getMem();
    const vis = (S.boards || []).filter(isBoardVisible);
    const pt = S.proto && S.proto.processType, ct = S.proto && S.proto.companyType;
    const cand = [pt && mem.boardByPT[pt.id], ct && mem.boardByCT[ct.id]];
    for (const c of cand) if (c && vis.some((b) => b.id === c)) return c;
    return '';
  }

  async function loadAll() {
    const uuid = S.uuid;
    if (!uuid || S.loading) return;
    S.loading = true;
    try { await loadAllInner(uuid); } finally { if (S.uuid === uuid) S.loading = false; }
  }
  async function loadAllInner(uuid) {
    render();
    const pProto = loadProtocol(uuid).then((p) => {
      if (S.uuid !== uuid) return;
      S.proto = p;
      rebuildDesc();
      render();
      if (isRI() && p.processes.length) {
        loadMatriculas(p).then((m) => {
          if (S.uuid !== uuid) return;
          S.matriculas = m;
          if (m.length) {
            if (F.descTouched) F.desc = Core.setDescField(F.desc, 'matricula', Core.joinPt(m));
            else rebuildDesc();
          }
          render();
        }).catch(() => { S.matriculaErr = true; render(); });
      }
    }).catch((e) => { if (S.uuid === uuid) { S.protoErr = e.message; render(); } });
    const pBoards = (S.boards ? Promise.resolve() : loadBoards()).catch((e) => { S.boardsErr = e.message; render(); });
    await Promise.all([pProto, pBoards]);
    if (S.uuid !== uuid || !S.proto || !S.boards) { render(); return; }
    const def = defaultBoardId();
    if (def) setBoard(def); else render();
    await scanBoards(false);
  }

  /* =====================================================================
   * CRIAÇÃO DO CARTÃO
   * ===================================================================== */
  function dueDateFor(days) {
    if (!days) return null;
    return calendar().addBusinessDays(new Date(), days);
  }
  async function createCard() {
    const bd = S.boardData[F.boardId];
    S.createErr = null; S.createWarn = []; S.created = null;
    if (!bd) { S.createErr = 'Escolha o quadro.'; render(); return; }
    if (!F.listId) { S.createErr = 'Escolha a coluna.'; render(); return; }
    if (!F.title.trim()) { S.createErr = 'Informe o título do cartão.'; render(); return; }
    if (F.labelMode === 'new' && !F.newLabelName.trim()) { S.createErr = 'Informe o nome da nova etiqueta.'; render(); return; }
    if (F.labelMode === 'pick' && !F.labelId) { S.createErr = 'Escolha a etiqueta (ou marque "sem etiqueta").'; render(); return; }
    const dupSame = (S.matches || []).some((m) => m.board.id === F.boardId);
    if (dupSame && !F.confirmDup) { S.createErr = 'Já existe cartão com esse número neste quadro. Marque a confirmação para criar mesmo assim.'; render(); return; }

    S.creating = true; render();
    const warn = [];
    try {
      // 1) etiqueta
      let labelId = F.labelMode === 'pick' ? F.labelId : '';
      if (F.labelMode === 'new') {
        const name = F.newLabelName.trim();
        const same = bd.labels.find((l) => Core.norm(l.name) === Core.norm(name));
        if (same) labelId = same.id;
        else {
          const nl = await trello('POST', '/boards/' + bd.id + '/labels', { query: { name, color: NEW_LABEL_COLOR } });
          labelId = nl.id;
          bd.labels.push({ id: nl.id, name: nl.name, color: nl.color });
        }
      }
      // 2) cartão
      const now = new Date();
      const dueDay = dueDateFor(F.dueDays);
      const body = { idList: F.listId, name: F.title.trim(), desc: F.desc, pos: F.pos === 'top' ? 'top' : 'bottom' };
      const extras = [...new Set(F.extraLabels)].filter((id) => id !== labelId && bd.labels.some((l) => l.id === id));
      const allLabels = [labelId, ...extras].filter(Boolean);
      if (allLabels.length) body.idLabels = allLabels.join(',');
      if (F.memberId) body.idMembers = F.memberId;
      if (dueDay) {
        body.due = new Date(dueDay.getFullYear(), dueDay.getMonth(), dueDay.getDate(), 23, 59, 0).toISOString();
        body.start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0).toISOString();
      }
      const card = await trello('POST', '/cards', { body });
      // garante etiqueta e responsável (algumas contas ignoram no POST)
      for (const lid of allLabels) {
        if ((card.idLabels || []).includes(lid)) continue;
        const ln = (bd.labels.find((l) => l.id === lid) || {}).name || '';
        try { await trello('POST', '/cards/' + card.id + '/idLabels', { query: { value: lid } }); } catch (e) { warn.push('Etiqueta "' + ln + '" não aplicada: ' + e.message); }
      }
      if (F.memberId && !(card.idMembers || []).includes(F.memberId)) {
        try { await trello('POST', '/cards/' + card.id + '/idMembers', { query: { value: F.memberId } }); } catch (e) { warn.push('Responsável não aplicado: ' + e.message); }
      }
      // 3) checklist(s) do modelo
      if (F.templateId) {
        try {
          const det = await loadTemplateDetail(F.templateId);
          for (const cl of det.checklists) {
            try { await trello('POST', '/cards/' + card.id + '/checklists', { query: { idChecklistSource: cl.id, name: cl.name } }); } catch (e) { warn.push('Checklist "' + cl.name + '" não copiado: ' + e.message); }
          }
        } catch (e) { warn.push('Não consegui ler o modelo para copiar o checklist: ' + e.message); }
      }
      // 4) link do NoCartório
      if (F.attach && S.proto) {
        try {
          await trello('POST', '/cards/' + card.id + '/attachments', { query: { url: S.proto.url, name: 'NoCartório — ' + (S.proto.refLabel || ('Protocolo ' + S.proto.numero)) } });
        } catch (e) { warn.push('Link do NoCartório não anexado: ' + e.message); }
      }
      // 4b) arquivos e comentário
      for (const f of F.files) {
        try { await uploadFile(card.id, f); } catch (e) { warn.push('Arquivo "' + f.name + '" não anexado: ' + e.message); }
      }
      if (F.comment.trim()) {
        try { await trello('POST', '/cards/' + card.id + '/actions/comments', { query: { text: F.comment.trim() } }); } catch (e) { warn.push('Comentário não publicado: ' + e.message); }
      }
      F.files = []; F.comment = '';
      // 5) memoriza as escolhas
      const mem = getMem();
      const pt = S.proto.processType, ct = S.proto.companyType;
      if (pt) mem.boardByPT[pt.id] = bd.id;
      if (ct) mem.boardByCT[ct.id] = bd.id;
      mem.listByBoard[bd.id] = F.listId;
      mem.templateByBoard[bd.id] = F.templateId || '';
      if (labelId && pt) { mem.labelMap[bd.id] = mem.labelMap[bd.id] || {}; mem.labelMap[bd.id][pt.id] = labelId; }
      if (S.proto.signatory && S.proto.signatory.id && F.memberId) mem.memberBySig[S.proto.signatory.id] = F.memberId;
      mem.dueByBoard[bd.id] = F.dueDays;
      if (extras.length) mem.extraByBoard[bd.id] = [...new Set([...extras, ...(mem.extraByBoard[bd.id] || [])])].slice(0, 8);
      setMem(mem);
      const cfg = getCfg(); cfg.pos = F.pos; cfg.attach = F.attach; setCfg(cfg);

      const list = bd.lists.find((l) => l.id === F.listId);
      S.created = { url: card.shortUrl || card.url, name: card.name, board: bd.name, list: list ? list.name : '' };
      S.createWarn = warn;
      try { await loadBoardData(bd.id, true); } catch (e) { /* */ }
      computeMatches();
    } catch (e) {
      S.createErr = 'Não foi possível criar o cartão: ' + e.message;
    }
    S.creating = false;
    render();
    const box = UI.shadow && UI.shadow.querySelector(S.created ? '[data-created]' : '.sec .box.err');
    if (box) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* =====================================================================
   * CARTÃO EXISTENTE — concluir, mover, prazo, etiquetas, responsáveis, checklists
   * ===================================================================== */
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  async function loadEditCard() {
    const ed = S.edit;
    if (!ed) return null;
    const [card, cls, acts] = await Promise.all([
      trello('GET', '/cards/' + ed.cardId, {
        query: { fields: 'name,desc,idBoard,idList,due,start,dueComplete,idMembers,idLabels,shortUrl,closed', attachments: 'true', attachment_fields: 'url,name,bytes,date,isUpload,mimeType' },
      }),
      trello('GET', '/cards/' + ed.cardId + '/checklists', { query: { fields: 'name,pos', checkItems: 'all', checkItem_fields: 'name,state,pos' } }),
      trello('GET', '/cards/' + ed.cardId + '/actions', { query: { filter: 'commentCard', limit: 50, memberCreator_fields: 'fullName,username' } }).catch(() => null),
    ]);
    if (S.edit !== ed) return null;
    card.attachments = (card.attachments || []).slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    card.comments = acts === null ? null : (acts || []).map((a) => ({
      id: a.id, date: a.date, text: (a.data && a.data.text) || '',
      author: (a.memberCreator && (a.memberCreator.fullName || a.memberCreator.username)) || '?',
    }));
    card.checklists = (cls || []).slice().sort((a, b) => a.pos - b.pos)
      .map((cl) => Object.assign(cl, { checkItems: (cl.checkItems || []).slice().sort((a, b) => a.pos - b.pos) }));
    ed.card = card;
    return card;
  }

  function initEdit(card) {
    E = {
      boardId: card.idBoard, listId: card.idList, pos: 'keep',
      title: card.name || '', desc: card.desc || '',
      labelIds: new Set(card.idLabels || []), shownLabels: (card.idLabels || []).slice(),
      newLabelOn: false, newLabelName: Core.cleanActName(S.proto && S.proto.processType ? S.proto.processType.name : ''),
      memberIds: new Set(card.idMembers || []),
      dueMode: 'keep', dueDate: card.due ? Core.ymd(new Date(card.due)) : Core.ymd(new Date()),
      lostLabels: [], lostMembers: [],
    };
  }

  async function openEdit(cardId) {
    if (S.edit && S.edit.cardId === cardId) { S.edit = null; E = null; render(); return; }
    const ed = { cardId, loading: true, err: null, card: null, saving: false, msg: null, warn: [], busy: {}, newItem: {}, tplId: '' };
    S.edit = ed; E = null;
    render();
    try {
      const card = await loadEditCard();
      if (card) {
        await loadBoardData(card.idBoard);
        if (S.edit === ed) initEdit(card);
      }
    } catch (e) { ed.err = e.message; }
    ed.loading = false;
    render();
    // modelos do quadro do cartão (para copiar checklist)
    const bId = ed.card && ed.card.idBoard;
    if (!bId || S.edit !== ed) return;
    if (!S.templates[bId]) { try { await loadTemplates(bId); } catch (e) { /* opcional */ } }
    const tl = S.templates[bId] || [];
    const rem = getMem().templateByBoard[bId];
    ed.tplId = rem && tl.some((t) => t.id === rem) ? rem : (tl[0] ? tl[0].id : '');
    if (S.edit === ed) render();
  }

  async function setEditBoard(id) {
    const ed = S.edit;
    if (!ed || !ed.card || !E) return;
    const card = ed.card;
    const prevBd = S.boardData[E.boardId];
    const prevLabels = [...E.labelIds].map((lid) => prevBd && prevBd.labels.find((l) => l.id === lid)).filter(Boolean);
    E.boardId = id;
    render();
    let bd;
    try { bd = await loadBoardData(id); } catch (e) { ed.err = e.message; render(); return; }
    if (S.edit !== ed || E.boardId !== id) return;
    if (id === card.idBoard) {
      Object.assign(E, { listId: card.idList, pos: 'keep', labelIds: new Set(card.idLabels || []), shownLabels: (card.idLabels || []).slice(),
        memberIds: new Set(card.idMembers || []), lostLabels: [], lostMembers: [] });
    } else {
      const ml = getMem().listByBoard[id];
      E.listId = bd.lists.some((l) => l.id === ml) ? ml : (bd.lists[0] ? bd.lists[0].id : '');
      if (E.pos === 'keep') E.pos = getCfg().pos === 'top' ? 'top' : 'bottom';
      // etiquetas: o quadro de destino tem as suas; mantém as de mesmo nome
      const mapped = [], lost = [];
      for (const l of prevLabels) {
        const t = l.name && bd.labels.find((x) => Core.norm(x.name) === Core.norm(l.name));
        if (t) mapped.push(t.id); else lost.push(l.name || '(sem nome)');
      }
      E.labelIds = new Set(mapped); E.shownLabels = mapped.slice(); E.lostLabels = lost;
      if (lost.length && lost[0] !== '(sem nome)') E.newLabelName = lost[0];
      // responsáveis: só quem é membro do quadro de destino
      const allMembers = Object.values(S.boardData).flatMap((b) => b.members);
      const keep = [], lostM = [];
      for (const mid of E.memberIds) {
        if (bd.members.some((m) => m.id === mid)) keep.push(mid);
        else { const mm = allMembers.find((m) => m.id === mid); lostM.push(mm ? mm.fullName : mid); }
      }
      E.memberIds = new Set(keep); E.lostMembers = lostM;
    }
    render();
  }

  /** Novo prazo escolhido: undefined = não mexe; null = remove; Date = novo prazo (23:59). */
  function editDueValue() {
    if (!E || E.dueMode === 'keep') return undefined;
    if (E.dueMode === 'none') return null;
    if (E.dueMode === 'date') {
      const m = String(E.dueDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) throw new Error('Escolha uma data válida para o prazo.');
      return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 0);
    }
    const d = dueDateFor(E.dueMode);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0);
  }

  /** Lista, em português, o que "Salvar alterações" vai fazer. */
  function pendingChanges() {
    const ed = S.edit;
    if (!ed || !ed.card || !E) return [];
    const card = ed.card, bd = S.boardData[E.boardId], oldBd = S.boardData[card.idBoard];
    const out = [];
    const boardChanged = E.boardId !== card.idBoard, listChanged = E.listId !== card.idList;
    const posTxt = E.pos === 'top' ? ' (no topo)' : E.pos === 'bottom' ? ' (no fim)' : '';
    if (boardChanged || listChanged) {
      const l = bd && bd.lists.find((x) => x.id === E.listId);
      out.push('mover para ' + (boardChanged && bd ? bd.name + ' › ' : '') + (l ? l.name : '?') + posTxt);
    } else if (E.pos !== 'keep') out.push(E.pos === 'top' ? 'levar ao topo da coluna' : 'levar ao fim da coluna');
    let due;
    try { due = editDueValue(); } catch (e) { due = undefined; }
    if (due !== undefined) {
      const cur = card.due ? new Date(card.due).getTime() : null;
      if (cur !== (due ? due.getTime() : null)) out.push(due ? 'prazo ' + fmtFullDate(due) : 'remover o prazo');
    }
    const lname = (b, id) => { const l = b && b.labels.find((x) => x.id === id); return l ? (l.name || '(sem nome)') : '?'; };
    const curL = boardChanged ? new Set() : new Set(card.idLabels || []);
    const addL = [...E.labelIds].filter((id) => !curL.has(id)), remL = [...curL].filter((id) => !E.labelIds.has(id));
    if (addL.length) out.push('+ etiqueta ' + addL.map((id) => '"' + lname(bd, id) + '"').join(', '));
    if (remL.length) out.push('− etiqueta ' + remL.map((id) => '"' + lname(oldBd, id) + '"').join(', '));
    if (boardChanged && E.lostLabels.length) out.push('− etiqueta ' + E.lostLabels.map((n) => '"' + n + '"').join(', ') + ' (não existe no destino)');
    if (E.newLabelOn && E.newLabelName.trim()) out.push('criar etiqueta "' + E.newLabelName.trim() + '"');
    const mname = (id) => { const m = Object.values(S.boardData).flatMap((b) => b.members).find((x) => x.id === id); return m ? m.fullName || m.username : '?'; };
    const curM = new Set(card.idMembers || []);
    const addM = [...E.memberIds].filter((id) => !curM.has(id)), remM = [...curM].filter((id) => !E.memberIds.has(id));
    if (addM.length) out.push('+ responsável ' + addM.map(mname).join(', '));
    if (remM.length) out.push('− responsável ' + remM.map(mname).join(', '));
    if (E.title.trim() !== (card.name || '')) out.push('título');
    if (E.desc !== (card.desc || '')) out.push('descrição');
    return out;
  }

  async function saveEdit() {
    const ed = S.edit;
    if (!ed || !ed.card || !E || ed.saving) return;
    const card = ed.card, bd = S.boardData[E.boardId];
    ed.err = null; ed.msg = null; ed.warn = [];
    if (!bd) { ed.err = 'O quadro de destino ainda não foi carregado.'; render(); return; }
    if (!E.listId) { ed.err = 'Escolha a coluna.'; render(); return; }
    if (!E.title.trim()) { ed.err = 'O título não pode ficar vazio.'; render(); return; }
    if (E.newLabelOn && !E.newLabelName.trim()) { ed.err = 'Informe o nome da nova etiqueta.'; render(); return; }
    let due;
    try { due = editDueValue(); } catch (e) { ed.err = e.message; render(); return; }
    const summary = pendingChanges();
    if (!summary.length) { ed.msg = 'Nada para salvar: nenhuma alteração foi feita.'; render(); return; }

    const boardChanged = E.boardId !== card.idBoard, listChanged = E.listId !== card.idList;
    const body = {};
    if (boardChanged) body.idBoard = E.boardId;
    if (boardChanged || listChanged) body.idList = E.listId;
    if (E.pos !== 'keep') body.pos = E.pos;
    if (E.title.trim() !== (card.name || '')) body.name = E.title.trim();
    if (E.desc !== (card.desc || '')) body.desc = E.desc;
    if (due !== undefined) {
      const cur = card.due ? new Date(card.due).getTime() : null;
      if (cur !== (due ? due.getTime() : null)) body.due = due ? due.toISOString() : null;
    }

    ed.saving = true; render();
    const warn = [];
    const reload = new Set([card.idBoard, E.boardId]);
    try {
      if (Object.keys(body).length) await trello('PUT', '/cards/' + card.id, { body });
      // etiqueta nova (no quadro de destino)
      const want = new Set(E.labelIds);
      let createdLabel = null;
      if (E.newLabelOn) {
        const name = E.newLabelName.trim();
        const same = bd.labels.find((l) => Core.norm(l.name) === Core.norm(name));
        if (same) createdLabel = same.id;
        else {
          const nl = await trello('POST', '/boards/' + bd.id + '/labels', { query: { name, color: NEW_LABEL_COLOR } });
          bd.labels.push({ id: nl.id, name: nl.name, color: nl.color });
          createdLabel = nl.id;
        }
        want.add(createdLabel);
      }
      // estado atual (ao trocar de quadro, o próprio Trello pode ter mexido em etiquetas e membros)
      let nowL = new Set(card.idLabels || []), nowM = new Set(card.idMembers || []);
      if (boardChanged) {
        const c2 = await trello('GET', '/cards/' + card.id, { query: { fields: 'idLabels,idMembers' } });
        nowL = new Set(c2.idLabels || []); nowM = new Set(c2.idMembers || []);
      }
      const addedL = [];
      for (const id of want) if (!nowL.has(id)) {
        try { await trello('POST', '/cards/' + card.id + '/idLabels', { query: { value: id } }); addedL.push(id); } catch (e) { warn.push('Etiqueta não aplicada: ' + e.message); }
      }
      for (const id of nowL) if (!want.has(id)) {
        try { await trello('DELETE', '/cards/' + card.id + '/idLabels/' + id); } catch (e) { warn.push('Etiqueta não removida: ' + e.message); }
      }
      for (const id of E.memberIds) if (!nowM.has(id)) {
        try { await trello('POST', '/cards/' + card.id + '/idMembers', { query: { value: id } }); } catch (e) { warn.push('Responsável não incluído: ' + e.message); }
      }
      for (const id of nowM) if (!E.memberIds.has(id)) {
        try { await trello('DELETE', '/cards/' + card.id + '/idMembers/' + id); } catch (e) { warn.push('Responsável não removido: ' + e.message); }
      }
      // aprende a etiqueta do ato, como na criação
      const pt = S.proto && S.proto.processType;
      if (pt && addedL.length) {
        const best = (createdLabel && addedL.includes(createdLabel)) ? createdLabel
          : addedL.map((id) => ({ id, s: Core.actScore(pt.name, (bd.labels.find((l) => l.id === id) || {}).name || '') }))
            .filter((x) => x.s >= 0.25).sort((a, b) => b.s - a.s).map((x) => x.id)[0];
        if (best) { const mem = getMem(); mem.labelMap[bd.id] = mem.labelMap[bd.id] || {}; mem.labelMap[bd.id][pt.id] = best; setMem(mem); }
      }
      ed.msg = 'Salvo: ' + summary.join(' · ') + '.';
      ed.warn = warn;
    } catch (e) {
      ed.err = 'Não foi possível salvar: ' + e.message;
    }
    // relê o cartão e os quadros envolvidos (mesmo se algo falhou no meio)
    try { if (await loadEditCard()) initEdit(ed.card); } catch (e) { /* */ }
    await Promise.all([...reload].map((id) => loadBoardData(id, true).catch(() => {})));
    computeMatches();
    ed.saving = false;
    render();
  }

  /** Marca/desmarca o cartão como concluído (o "concluído" do prazo no Trello). */
  async function toggleComplete(cardId) {
    const m = (S.matches || []).find((x) => x.card.id === cardId);
    const edCard = S.edit && S.edit.card && S.edit.card.id === cardId ? S.edit.card : null;
    const cur = edCard ? !!edCard.dueComplete : !!(m && m.card.dueComplete);
    S.cardBusy[cardId] = true; delete S.cardErr[cardId]; render();
    try {
      await trello('PUT', '/cards/' + cardId, { body: { dueComplete: !cur } });
      if (m) m.card.dueComplete = !cur; // objeto do cache do quadro
      if (edCard) edCard.dueComplete = !cur;
    } catch (e) { S.cardErr[cardId] = 'Não consegui alterar: ' + e.message; }
    delete S.cardBusy[cardId];
    render();
  }

  async function toggleCheckItem(it) {
    const ed = S.edit;
    if (!ed || !ed.card || ed.busy[it.id]) return;
    const prev = it.state;
    it.state = prev === 'complete' ? 'incomplete' : 'complete';
    ed.busy[it.id] = true; ed.err = null; render();
    try { await trello('PUT', '/cards/' + ed.card.id + '/checkItem/' + it.id, { query: { state: it.state } }); }
    catch (e) { it.state = prev; ed.err = 'Não consegui marcar o item: ' + e.message; }
    delete ed.busy[it.id];
    render();
  }

  async function addCheckItem(cl) {
    const ed = S.edit;
    const name = ((ed && ed.newItem[cl.id]) || '').trim();
    if (!ed || !name || ed.busy['add-' + cl.id]) return;
    ed.busy['add-' + cl.id] = true; ed.err = null; render();
    try {
      const it = await trello('POST', '/checklists/' + cl.id + '/checkItems', { query: { name, pos: 'bottom' } });
      cl.checkItems.push({ id: it.id, name: it.name || name, state: it.state || 'incomplete', pos: it.pos });
      ed.newItem[cl.id] = '';
    } catch (e) { ed.err = 'Não consegui adicionar o item: ' + e.message; }
    delete ed.busy['add-' + cl.id];
    render();
  }

  async function copyTemplateChecklists() {
    const ed = S.edit;
    if (!ed || !ed.card || !ed.tplId || ed.busy.tpl) return;
    ed.busy.tpl = true; ed.err = null; ed.msg = null; render();
    try {
      const det = await loadTemplateDetail(ed.tplId);
      if (!det.checklists.length) throw new Error('o modelo escolhido não tem checklist.');
      for (const cl of det.checklists) await trello('POST', '/cards/' + ed.card.id + '/checklists', { query: { idChecklistSource: cl.id, name: cl.name } });
      await loadEditCard();
      ed.msg = 'Checklist copiado do modelo: ' + det.checklists.map((x) => x.name).join(', ') + '.';
    } catch (e) { ed.err = 'Não consegui copiar o checklist: ' + e.message; }
    delete ed.busy.tpl;
    render();
  }

  const TRELLO_FREE_LIMIT = 10 * 1024 * 1024;
  function uploadFile(cardId, file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('name', file.name);
    fd.append('setCover', 'false');
    return trello('POST', '/cards/' + cardId + '/attachments', { body: fd });
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }
  function fmtDateTime(d) { return fmtFullDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  async function uploadEditFiles(files) {
    const ed = S.edit;
    if (!ed || !ed.card || !files.length || ed.busy.upload) return;
    const list = [...files];
    ed.err = null; ed.msg = null; ed.warn = [];
    const ok = [], fail = [];
    for (let i = 0; i < list.length; i++) {
      ed.busy.upload = 'Enviando ' + (i + 1) + ' de ' + list.length + ': ' + list[i].name + '…';
      render();
      try { await uploadFile(ed.card.id, list[i]); ok.push(list[i].name); }
      catch (e) { fail.push('"' + list[i].name + '": ' + e.message); }
    }
    delete ed.busy.upload;
    try { await loadEditCard(); } catch (e) { /* */ }
    if (ok.length) ed.msg = (ok.length > 1 ? ok.length + ' arquivos anexados' : 'Arquivo anexado') + ': ' + ok.join(', ') + '.';
    if (fail.length) ed.err = 'Não consegui anexar ' + fail.join('; ');
    render();
  }

  async function postComment() {
    const ed = S.edit;
    const text = ((ed && ed.newComment) || '').trim();
    if (!ed || !ed.card || !text || ed.busy.comment) return;
    ed.busy.comment = true; ed.err = null; render();
    try {
      await trello('POST', '/cards/' + ed.card.id + '/actions/comments', { query: { text } });
      ed.newComment = '';
      await loadEditCard();
    } catch (e) { ed.err = 'Não consegui publicar o comentário: ' + e.message; }
    delete ed.busy.comment;
    render();
  }

  async function attachProtoLink() {
    const ed = S.edit;
    if (!ed || !ed.card || !S.proto || ed.busy.att) return;
    ed.busy.att = true; ed.err = null; ed.msg = null; render();
    try {
      await trello('POST', '/cards/' + ed.card.id + '/attachments', { query: { url: S.proto.url, name: 'NoCartório — ' + (S.proto.refLabel || ('Protocolo ' + S.proto.numero)) } });
      await loadEditCard();
      ed.msg = 'Link do protocolo anexado ao cartão.';
    } catch (e) { ed.err = 'Não consegui anexar o link: ' + e.message; }
    delete ed.busy.att;
    render();
  }

  /* =====================================================================
   * INTERFACE (Shadow DOM, para não brigar com o CSS do NoCartório)
   * ===================================================================== */
  const UI = { host: null, shadow: null, btn: null, panel: null, body: null, titleEl: null };

  const LABEL_COLORS = {
    green_light: '#BAF3DB', green: '#4BCE97', green_dark: '#1F845A', yellow_light: '#F8E6A0', yellow: '#F5CD47', yellow_dark: '#946F00',
    orange_light: '#FEDEC8', orange: '#FEA362', orange_dark: '#C25100', red_light: '#FFD5D2', red: '#F87168', red_dark: '#C9372C',
    purple_light: '#DFD8FD', purple: '#9F8FEF', purple_dark: '#6E5DC6', blue_light: '#CCE0FF', blue: '#579DFF', blue_dark: '#0C66E4',
    sky_light: '#C6EDFB', sky: '#6CC3E0', sky_dark: '#227D9B', lime_light: '#D3F1A7', lime: '#94C748', lime_dark: '#5B7F24',
    pink_light: '#FDD0EC', pink: '#E774BB', pink_dark: '#AE4787', black_light: '#DCDFE4', black: '#8590A2', black_dark: '#626F86',
  };
  const DARK_TEXT = /_light$|^(green|yellow|orange|red|purple|blue|sky|lime|pink)$/;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Inter, Arial, sans-serif; color: #172B4D; }
    .fab { position: fixed; right: 18px; bottom: 186px; z-index: 99991; display: inline-flex; align-items: center; gap: 7px;
      background: #0C66E4; color: #fff; border: 0; border-radius: 999px; padding: 8px 14px 8px 11px; font-weight: 600; font-size: 13px;
      line-height: 1; font-family: inherit; cursor: pointer; box-shadow: 0 4px 12px rgba(9,30,66,.25); }
    .fab:hover { background: #0055CC; }
    .fab svg { width: 16px; height: 16px; }
    .fab[hidden] { display: none; }
    .panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); z-index: 99995; background: #fff;
      box-shadow: -8px 0 28px rgba(9,30,66,.22); display: flex; flex-direction: column; }
    .panel[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #DCDFE4; background: #F7F8F9; }
    .head .ttl { flex: 1; font-weight: 700; font-size: 15px; }
    .icon-btn { border: 0; background: transparent; cursor: pointer; padding: 6px; border-radius: 6px; color: #44546F; font-size: 16px; line-height: 1; }
    .icon-btn:hover { background: #E9EBEE; }
    .body { flex: 1; overflow: auto; padding: 12px 14px 24px; }
    .sec { margin-bottom: 16px; }
    .sec h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #626F86; }
    .muted { color: #626F86; }
    .small { font-size: 12px; }
    .proto .num { font-size: 18px; font-weight: 700; }
    .proto .act { font-weight: 600; margin: 2px 0; }
    .kv { display: grid; grid-template-columns: 96px 1fr; gap: 2px 8px; margin-top: 6px; }
    .kv dt { color: #626F86; }
    .kv dd { margin: 0; word-break: break-word; }
    .box { border-radius: 8px; padding: 9px 11px; margin: 6px 0; }
    .box.info { background: #E9F2FF; }
    .box.ok { background: #DCFFF1; }
    .box.warn { background: #FFF7D6; }
    .box.err { background: #FFECEB; color: #AE2E24; }
    .match { border: 1px solid #DCDFE4; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
    .match.same { border-color: #0C66E4; background: #F5F9FF; }
    .match .where { font-weight: 600; }
    .match a { color: #0C66E4; font-weight: 600; text-decoration: none; }
    .match a:hover { text-decoration: underline; }
    .fld { display: block; margin-bottom: 10px; }
    .lbl { display: block; font-weight: 600; margin-bottom: 3px; font-size: 12px; color: #44546F; }
    select, input[type=text], input[type=password], textarea { width: 100%; font: inherit; color: inherit; border: 1px solid #B7BDC7;
      border-radius: 6px; padding: 6px 8px; background: #fff; }
    textarea { resize: vertical; min-height: 92px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    select:focus, input:focus, textarea:focus { outline: 2px solid #388BFF; outline-offset: -1px; border-color: #388BFF; }
    .row { display: flex; gap: 8px; align-items: center; }
    .opt { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
    .opt:hover { background: #F1F2F4; }
    .opt input[type=radio], .opt input[type=checkbox] { margin: 0; }
    .opt .grow { flex: 1; min-width: 0; }
    .chip { display: inline-block; max-width: 100%; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
    .score { font-size: 11px; color: #626F86; white-space: nowrap; }
    .seg { display: flex; flex-wrap: wrap; gap: 6px; }
    .seg button { border: 1px solid #B7BDC7; background: #fff; border-radius: 6px; padding: 6px 10px; cursor: pointer; font: inherit; color: inherit; }
    .seg button small { display: block; color: #626F86; font-size: 11px; }
    .seg button.on { border-color: #0C66E4; background: #E9F2FF; color: #0055CC; font-weight: 600; }
    .seg button.on small { color: #0055CC; }
    .btn { border: 1px solid #B7BDC7; background: #fff; border-radius: 6px; padding: 7px 12px; cursor: pointer; font: inherit; color: inherit; }
    .btn:hover { background: #F1F2F4; }
    .btn.primary { background: #0C66E4; color: #fff; border-color: #0C66E4; font-weight: 600; }
    .btn.primary:hover { background: #0055CC; }
    .btn[disabled] { opacity: .55; cursor: default; }
    .btn.link { border: 0; background: none; color: #0C66E4; padding: 2px 0; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #B7BDC7; border-top-color: #0C66E4; border-radius: 50%;
      animation: sp .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .hint { font-size: 12px; color: #626F86; margin-top: 3px; }
    .tag { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 5px;
      border-radius: 3px; background: #E9F2FF; color: #0055CC; margin-left: 4px; vertical-align: 1px; }
    .foot { padding: 8px 14px; border-top: 1px solid #DCDFE4; font-size: 11px; color: #8590A2; display: flex; justify-content: space-between; }
    ol.steps { margin: 6px 0 0 18px; padding: 0; }
    ol.steps li { margin-bottom: 4px; }
    .boards { max-height: 180px; overflow: auto; border: 1px solid #DCDFE4; border-radius: 6px; padding: 4px; }
    input[type=date] { font: inherit; color: inherit; border: 1px solid #B7BDC7; border-radius: 6px; padding: 5px 8px; background: #fff; }
    .btn.sm { padding: 4px 9px; font-size: 12px; }
    .btn.on { border-color: #0C66E4; background: #E9F2FF; color: #0055CC; font-weight: 600; }
    .btn.done { border-color: #4BCE97; background: #DCFFF1; color: #216E4E; }
    .match a.btn { color: inherit; font-weight: 400; }
    .match a.btn:hover { text-decoration: none; }
    .mact { margin-top: 8px; }
    .match.editing { border-color: #0C66E4; box-shadow: inset 0 0 0 1px #0C66E4; }
    .edit { margin-top: 10px; padding-top: 4px; border-top: 1px dashed #B7BDC7; }
    .edit h4 { margin: 14px 0 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #626F86; }
    .edit h4 .muted { text-transform: none; letter-spacing: 0; font-weight: 400; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }
    @media (max-width: 440px) { .grid2 { grid-template-columns: 1fr; } }
    .tag.done { background: #DCFFF1; color: #216E4E; }
    .tag.late { background: #FFECEB; color: #AE2E24; }
    .cl { border: 1px solid #DCDFE4; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; }
    .cl-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .bar { height: 4px; background: #DCDFE4; border-radius: 2px; margin: 4px 0; overflow: hidden; }
    .bar i { display: block; height: 100%; background: #4BCE97; }
    .opt .ok-txt { text-decoration: line-through; color: #626F86; }
    .pending { font-size: 12px; color: #44546F; margin-top: 6px; }
    .savebar { position: sticky; bottom: -24px; background: inherit; padding: 8px 0 14px; border-top: 1px solid #DCDFE4; margin-top: 8px; z-index: 1;
      box-shadow: 0 -8px 8px -8px rgba(9,30,66,.18); }
    .match { background: #fff; }
    .drop { border: 1.5px dashed #B7BDC7; border-radius: 8px; padding: 12px; text-align: center; color: #44546F; font-size: 12px; cursor: pointer; background: #FAFBFC; }
    .drop:hover, .drop.over { border-color: #0C66E4; background: #E9F2FF; color: #0055CC; }
    .drop.busy { cursor: default; }
    .files { border: 1px solid #DCDFE4; border-radius: 6px; margin-bottom: 6px; }
    .file { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-top: 1px solid #EEF0F2; min-width: 0; }
    .file:first-child { border-top: 0; }
    .file .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .match .file a { font-weight: 400; }
    .ficon { font-size: 13px; }
    .cmt { border-left: 3px solid #DCDFE4; padding: 4px 0 4px 10px; margin-bottom: 8px; }
    .cmt-t { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
    .edit { background: inherit; }
  `;

  const TRELLO_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.5 2h-15A2.5 2.5 0 0 0 2 4.5v15A2.5 2.5 0 0 0 4.5 22h15a2.5 2.5 0 0 0 2.5-2.5v-15A2.5 2.5 0 0 0 19.5 2ZM10.6 17.2c0 .7-.6 1.3-1.3 1.3H5.9c-.7 0-1.3-.6-1.3-1.3V5.9c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v11.3Zm8.8-5c0 .7-.6 1.3-1.3 1.3h-3.4c-.7 0-1.3-.6-1.3-1.3V5.9c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v6.3Z"/></svg>';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') value = v;
        else if (k === 'checked') el.checked = true;
        else if (k === 'selected') el.selected = true;
        else if (k === 'disabled') el.disabled = true;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }
  function chip(label) {
    const bg = LABEL_COLORS[label.color] || '#F1F2F4';
    const fg = !label.color ? '#44546F' : DARK_TEXT.test(label.color) ? '#172B4D' : '#fff';
    return h('span', { class: 'chip', style: { background: bg, color: fg, border: label.color ? '0' : '1px solid #DCDFE4' }, title: label.name || '' }, label.name || '(sem nome)');
  }
  const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function fmtDate(d, withWeekday) {
    const s = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    return withWeekday ? WD[d.getDay()] + ' ' + s : s;
  }
  function fmtFullDate(d) { return fmtDate(d) + '/' + d.getFullYear(); }
  function spinner(text) { return h('div', { class: 'muted' }, h('span', { class: 'spin' }), text); }

  /* --- foco: preserva o cursor quando a interface é redesenhada --- */
  function captureFocus() {
    const el = UI.shadow && UI.shadow.activeElement;
    if (!el || !el.dataset || !el.dataset.k) return null;
    const st = { k: el.dataset.k };
    if ('selectionStart' in el && typeof el.value === 'string') {
      try { st.s = el.selectionStart; st.e = el.selectionEnd; st.value = el.value; st.scroll = el.scrollTop; } catch (e) { /* */ }
    }
    return st;
  }
  function firstDiff(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
  function restoreFocus(st) {
    if (!st) return;
    const el = UI.shadow.querySelector('[data-k="' + st.k + '"]');
    if (!el) return;
    el.focus({ preventScroll: true });
    if (st.s != null && typeof el.setSelectionRange === 'function') {
      let s = st.s, e = st.e;
      if (st.value != null && el.value !== st.value) {
        const idx = firstDiff(st.value, el.value), delta = el.value.length - st.value.length;
        if (s > idx) s += delta;
        if (e > idx) e += delta;
      }
      try { el.setSelectionRange(Math.max(0, s), Math.max(0, e)); el.scrollTop = st.scroll || 0; } catch (err) { /* */ }
    }
  }

  function ensureUI() {
    if (UI.host && document.documentElement.contains(UI.host)) return;
    if (!UI.host) {
      UI.host = document.createElement('div');
      UI.host.id = 'nct-trello-host';
      UI.shadow = UI.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      const wrap = h('div', { class: 'wrap' });
      UI.btn = h('button', { class: 'fab', type: 'button', title: 'Cartão do Trello deste protocolo', onclick: togglePanel });
      UI.btn.innerHTML = TRELLO_SVG + '<span>Trello</span>';
      UI.titleEl = h('div', { class: 'ttl' }, 'Trello');
      UI.body = h('div', { class: 'body' });
      UI.panel = h('div', { class: 'panel', hidden: true, role: 'dialog', 'aria-label': 'Trello' },
        h('div', { class: 'head' },
          UI.titleEl,
          h('button', { class: 'icon-btn', type: 'button', title: 'Recarregar', onclick: () => refresh() }, '⟳'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Configurações', onclick: () => { S.view = S.view === 'config' ? 'main' : 'config'; S.configMsg = null; render(); } }, '⚙'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Fechar (Esc)', onclick: closePanel }, '✕')),
        UI.body,
        h('div', { class: 'foot' }, h('span', null, 'NoCartório → Trello v' + VERSION), h('span', null, 'cartões criados ficam com o token configurado')));
      wrap.append(UI.btn, UI.panel);
      UI.shadow.append(style, wrap);
      // impede que atalhos de teclado do NoCartório disparem enquanto se digita no painel
      for (const ev of ['keydown', 'keyup', 'keypress']) {
        UI.host.addEventListener(ev, (e) => {
          if (ev === 'keydown' && e.key === 'Escape' && S.open) closePanel();
          e.stopPropagation();
        });
      }
    }
    document.body.appendChild(UI.host);
  }

  function togglePanel() { if (S.open) closePanel(); else openPanel(); }
  function openPanel(view) {
    ensureUI();
    S.open = true;
    UI.panel.hidden = false;
    if (view) S.view = view;
    if (!hasCreds()) S.view = 'config';
    render();
    if (hasCreds() && S.uuid && !S.proto && !S.protoErr) loadAll();
  }
  function closePanel() {
    S.open = false;
    if (UI.panel) UI.panel.hidden = true;
  }
  function refresh() {
    const uuid = S.uuid;
    resetState(uuid);
    S.boards = null; S.boardsErr = null; S.boardErr = {};
    S.boardData = {};
    S.templates = {};
    S.tplDetail = {};
    matriculaCache.delete(uuid);
    S.view = hasCreds() ? 'main' : 'config';
    render();
    if (hasCreds() && uuid) loadAll();
  }

  function render() {
    if (!UI.body || !S.open) return;
    const st = captureFocus();
    UI.titleEl.textContent = S.view === 'config' ? 'Trello · configurações'
      : S.proto && S.proto.numero ? 'Trello · protocolo ' + Core.fmtNum(S.proto.numero, true) : 'Trello';
    UI.body.replaceChildren(S.view === 'config' ? viewConfig() : viewMain());
    restoreFocus(st);
  }

  /* ---------------------- tela principal ---------------------- */
  function viewMain() {
    if (!S.uuid) return h('div', { class: 'box info' }, 'Abra um protocolo (Serviços › Visualizar) para usar o painel.');
    return h('div', null, secProto(), secSituacao(), secForm());
  }

  function secProto() {
    if (S.protoErr) return h('div', { class: 'sec' }, h('div', { class: 'box err' }, S.protoErr));
    if (!S.proto) return h('div', { class: 'sec' }, spinner('Lendo o protocolo no NoCartório…'));
    const p = S.proto;
    let mat = null;
    if (isRI()) {
      mat = S.matriculas === null && !S.matriculaErr ? h('span', { class: 'muted' }, h('span', { class: 'spin' }), 'procurando nos atos…')
        : S.matriculas && S.matriculas.length ? Core.joinPt(S.matriculas)
          : h('span', { class: 'muted' }, 'não encontrada nos atos');
    }
    const kind = (p.refLabel.match(/^\s*([A-Za-zÀ-ú]+)/) || [])[1] || 'Protocolo';
    return h('div', { class: 'sec proto' },
      h('div', { class: 'num' }, p.numero ? kind + ' ' + Core.fmtNum(p.numero, true) : 'Sem número de protocolo'),
      h('div', { class: 'act' }, p.processType ? p.processType.name : '—'),
      h('dl', { class: 'kv' },
        h('dt', null, 'Atribuição'), h('dd', null, p.companyType ? p.companyType.name : '—'),
        h('dt', null, 'Apresentante'), h('dd', null, p.apresentantes.length ? p.apresentantes.join(' / ') : '—'),
        h('dt', null, 'Assinante'), h('dd', null, p.signatory ? p.signatory.name + (p.signatory.role ? ' (' + p.signatory.role + ')' : '') : '—'),
        mat ? [h('dt', null, 'Matrícula'), h('dd', null, mat)] : null));
  }

  function secSituacao() {
    const kids = [h('h3', null, 'Já existe no Trello?')];
    if (S.boardsErr) kids.push(h('div', { class: 'box err' }, S.boardsErr));
    else if (!S.proto || !S.boards) kids.push(spinner('Carregando quadros…'));
    else if (!S.proto.numero) kids.push(h('div', { class: 'box warn' }, 'Este serviço não tem número de protocolo/prenotação; não há como procurar o cartão pelo número.'));
    else {
      const numTxt = Core.fmtNum(S.proto.numero, true);
      const ms = S.matches || [];
      for (const m of ms) kids.push(matchView(m));
      if (!S.scanned) kids.push(spinner('Procurando o nº ' + numTxt + ' nos quadros…'));
      else if (!ms.length) kids.push(h('div', { class: 'box ok' }, 'Nenhum cartão aberto com o nº ' + numTxt + ' nos quadros.'));
      if (S.scanned && S.scanning) kids.push(spinner('Atualizando…'));
      const errs = Object.keys(S.boardErr);
      if (errs.length) kids.push(h('div', { class: 'box warn small' }, 'Não consegui ler: ' + errs.map((id) => ((S.boards.find((b) => b.id === id) || {}).name || id)).join(', ')));
      // arquivados
      if (S.archivedLoading) kids.push(spinner('Procurando nos arquivados…'));
      else if (S.archivedErr) kids.push(h('div', { class: 'box err small' }, S.archivedErr));
      else if (S.archived) {
        if (!S.archived.length) kids.push(h('div', { class: 'muted small' }, 'Nenhum cartão arquivado com esse número.'));
        for (const c of S.archived) {
          kids.push(h('div', { class: 'match' },
            h('div', null, h('a', { href: c.shortUrl, target: '_blank', rel: 'noopener' }, c.name), h('span', { class: 'tag' }, 'arquivado')),
            h('div', { class: 'small muted' }, (c.board ? c.board.name : '') + (c.list ? ' › ' + c.list.name : ''))));
        }
      } else kids.push(h('button', { class: 'btn link small', type: 'button', onclick: searchArchived }, 'Procurar também nos arquivados'));
    }
    return h('div', { class: 'sec' }, kids);
  }

  function matchView(m) {
    const c = m.card, bd = m.board;
    const members = (c.idMembers || []).map((id) => bd.members.find((x) => x.id === id)).filter(Boolean);
    const labels = (c.idLabels || []).map((id) => bd.labels.find((x) => x.id === id)).filter(Boolean);
    const due = c.due ? new Date(c.due) : null;
    const late = due && !c.dueComplete && due < new Date();
    const editing = !!(S.edit && S.edit.cardId === c.id);
    const busy = !!S.cardBusy[c.id];
    return h('div', { class: 'match' + (bd.id === F.boardId ? ' same' : '') + (editing ? ' editing' : '') },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('a', { href: c.shortUrl, target: '_blank', rel: 'noopener' }, c.name),
        h('span', { class: 'small muted' }, m.position ? m.position + 'º de ' + m.total + ' na coluna' : '')),
      h('div', { class: 'where' }, bd.name, ' › ', m.list ? m.list.name : '(coluna arquivada)'),
      h('div', { class: 'small muted' },
        members.length ? 'Responsável: ' + members.map((x) => x.fullName).join(', ') : 'Sem responsável',
        due ? ' · prazo ' + fmtDate(due) : '',
        c.dueComplete ? h('span', { class: 'tag done' }, 'concluído') : late ? h('span', { class: 'tag late' }, 'atrasado') : null),
      labels.length ? h('div', { style: { marginTop: '4px', display: 'flex', gap: '4px', flexWrap: 'wrap' } }, labels.map(chip)) : null,
      h('div', { class: 'actions mact' },
        h('a', { class: 'btn sm', href: c.shortUrl, target: '_blank', rel: 'noopener' }, 'Abrir no Trello ↗'),
        h('button', { class: 'btn sm' + (c.dueComplete ? ' done' : ''), type: 'button', disabled: busy, 'data-k': 'done-' + c.id,
          title: c.dueComplete ? 'Clique para desmarcar' : 'Marca o cartão como concluído no Trello', onclick: () => toggleComplete(c.id) },
          busy ? 'Salvando…' : c.dueComplete ? '✓ Concluído (desmarcar)' : 'Marcar como concluído'),
        h('button', { class: 'btn sm' + (editing ? ' on' : ''), type: 'button', 'data-k': 'edit-' + c.id, onclick: () => openEdit(c.id) },
          editing ? 'Fechar edição' : 'Editar / mover…')),
      S.cardErr[c.id] ? h('div', { class: 'box err small' }, S.cardErr[c.id]) : null,
      editing ? viewEdit() : null);
  }

  /* ---------------------- edição do cartão existente ---------------------- */
  function viewEdit() {
    const ed = S.edit;
    if (ed.loading) return h('div', { class: 'edit' }, h('div', { style: { marginTop: '8px' } }, spinner('Lendo o cartão no Trello…')));
    if (!ed.card || !E) return h('div', { class: 'edit' }, h('div', { class: 'box err' }, ed.err || 'Não consegui ler o cartão.'));
    const card = ed.card;
    const bd = S.boardData[E.boardId];
    const kids = [];

    // --- mover ---
    const boardOpts = (S.boards || []).filter((b) => isBoardVisible(b) || b.id === card.idBoard || b.id === E.boardId);
    const sameList = E.boardId === card.idBoard && E.listId === card.idList;
    kids.push(h('h4', null, 'Mover'));
    kids.push(h('div', { class: 'grid2' },
      h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Quadro'),
        h('select', { 'data-k': 'e-board', value: E.boardId, onchange: (e) => setEditBoard(e.target.value) },
          boardOpts.map((b) => h('option', { value: b.id }, b.name + (b.id === card.idBoard ? ' (atual)' : ''))))),
      h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Coluna'),
        !bd ? spinner('Lendo…') : h('select', { 'data-k': 'e-list', value: E.listId, onchange: (e) => {
          E.listId = e.target.value;
          const same = E.boardId === card.idBoard && E.listId === card.idList;
          if (same && E.pos !== 'keep') E.pos = 'keep';
          else if (!same && E.pos === 'keep') E.pos = getCfg().pos === 'top' ? 'top' : 'bottom';
          render();
        } }, bd.lists.map((l) => h('option', { value: l.id }, l.name + (E.boardId === card.idBoard && l.id === card.idList ? ' (atual)' : '')))))));
    kids.push(h('div', { class: 'row', style: { marginTop: '-4px', marginBottom: '4px' } },
      h('span', { class: 'small muted' }, 'Posição na coluna:'),
      h('select', { 'data-k': 'e-pos', value: E.pos, style: { width: 'auto' }, onchange: (e) => { E.pos = e.target.value; render(); } },
        sameList ? h('option', { value: 'keep' }, 'manter onde está') : null,
        h('option', { value: 'top' }, 'no topo'), h('option', { value: 'bottom' }, 'no fim'))));
    if (E.boardId !== card.idBoard) {
      kids.push(h('div', { class: 'hint' }, 'Ao trocar de quadro, as etiquetas e os responsáveis passam a ser os do quadro de destino (veja abaixo).'));
    }

    // --- prazo ---
    const cal = calendar();
    const today = new Date();
    const curDue = card.due ? new Date(card.due) : null;
    const opts = [3, 5, 10].map((n) => ({ n, d: cal.addBusinessDays(today, n) }));
    const seg = (mode, title, sub) => h('button', { type: 'button', 'data-k': 'e-due-' + mode, class: E.dueMode === mode ? 'on' : '',
      onclick: () => { E.dueMode = mode; render(); } }, title, h('small', null, sub));
    kids.push(h('h4', null, 'Prazo ', h('span', { class: 'muted' }, '— dias úteis a partir de hoje, sem feriados')));
    kids.push(h('div', { class: 'seg' },
      seg('keep', 'Manter', curDue ? fmtDate(curDue, true) : 'sem prazo'),
      opts.map((o) => seg(o.n, o.n + ' dias úteis', fmtDate(o.d, true))),
      seg('date', 'Outra data', E.dueMode === 'date' && E.dueDate ? E.dueDate.split('-').reverse().slice(0, 2).join('/') : 'escolher'),
      curDue ? seg('none', 'Sem prazo', 'remover') : null));
    if (E.dueMode === 'date') {
      let warnTxt = null;
      const mm = String(E.dueDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (mm) {
        const d = new Date(+mm[1], +mm[2] - 1, +mm[3]);
        const hol = cal.holidayName(d);
        if (hol) warnTxt = 'Atenção: ' + fmtFullDate(d) + ' é feriado (' + hol + ').';
        else if (d.getDay() === 0 || d.getDay() === 6) warnTxt = 'Atenção: ' + fmtFullDate(d) + ' cai num ' + (d.getDay() === 0 ? 'domingo' : 'sábado') + '.';
        else if (d < Core.addDays(today, 0) && Core.ymd(d) !== Core.ymd(today)) warnTxt = 'Atenção: data no passado.';
      }
      kids.push(h('div', { class: 'row', style: { marginTop: '6px' } },
        h('input', { type: 'date', 'data-k': 'e-date', value: E.dueDate, onchange: (e) => { E.dueDate = e.target.value; render(); } }),
        h('span', { class: 'small muted' }, 'às 23:59')));
      if (warnTxt) kids.push(h('div', { class: 'box warn small' }, warnTxt));
    } else if (typeof E.dueMode === 'number') {
      const nd = opts.find((o) => o.n === E.dueMode).d;
      const same = curDue && Core.ymd(curDue) === Core.ymd(nd);
      kids.push(h('div', { class: 'hint' }, 'Novo prazo: ' + fmtFullDate(nd) + ' às 23:59' + (same ? ' — igual ao prazo atual, nada muda.' : '.')));
    }

    // --- etiquetas ---
    kids.push(h('h4', null, 'Etiquetas'));
    if (bd) kids.push(editLabels(bd, card));

    // --- responsáveis ---
    kids.push(h('h4', null, 'Responsáveis'));
    if (bd) kids.push(editMembers(bd, card));

    // --- título e descrição ---
    kids.push(h('h4', null, 'Título e descrição'));
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Título'),
      h('input', { type: 'text', 'data-k': 'e-title', value: E.title, oninput: (e) => { E.title = e.target.value; }, onchange: () => render() })));
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Descrição'),
      h('textarea', { 'data-k': 'e-desc', rows: 5, value: E.desc, oninput: (e) => { E.desc = e.target.value; }, onchange: () => render() }),
      h('button', { class: 'btn link small', type: 'button', onclick: () => {
        const d = descData();
        let nd = E.desc;
        for (const k of ['apresentante', 'matricula']) if (d[k]) nd = Core.setDescField(nd, k, d[k]);
        if (nd === E.desc) { ed.msg = 'Não há linha vazia de apresentante ou matrícula na descrição para completar.'; }
        else { E.desc = nd; ed.msg = null; }
        render();
      } }, 'Completar linhas vazias com os dados do NoCartório')));

    // --- salvar ---
    const pend = pendingChanges();
    kids.push(h('div', { class: 'savebar' },
      ed.err ? h('div', { class: 'box err' }, ed.err) : null,
      ed.msg && !(/^Salvo/.test(ed.msg) && pend.length) ? h('div', { class: 'box ' + (/^Salvo|anexado|copiado/.test(ed.msg) ? 'ok' : 'info') }, ed.msg,
        ed.warn.length ? h('ul', { class: 'small', style: { margin: '6px 0 0 16px', padding: 0 } }, ed.warn.map((w) => h('li', null, w))) : null) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', disabled: ed.saving || !pend.length, onclick: saveEdit }, ed.saving ? 'Salvando…' : 'Salvar alterações'),
        pend.length ? h('button', { class: 'btn', type: 'button', disabled: ed.saving, onclick: () => { initEdit(card); ed.msg = null; ed.err = null; render(); } }, 'Desfazer') : null),
      h('div', { class: 'pending' }, pend.length ? 'Vai salvar: ' + pend.join(' · ') : 'Nenhuma alteração pendente.')));

    // --- checklists (salvos na hora) ---
    kids.push(h('h4', null, 'Checklists ', h('span', { class: 'muted' }, '— cada clique já salva no Trello')));
    if (!card.checklists.length) kids.push(h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Este cartão não tem checklist.'));
    for (const cl of card.checklists) {
      const total = cl.checkItems.length, done = cl.checkItems.filter((x) => x.state === 'complete').length;
      kids.push(h('div', { class: 'cl' },
        h('div', { class: 'cl-h' }, h('b', null, cl.name), h('span', { class: 'small muted' }, done + '/' + total)),
        h('div', { class: 'bar' }, h('i', { style: { width: (total ? Math.round(done * 100 / total) : 0) + '%' } })),
        cl.checkItems.map((it) => h('label', { class: 'opt' },
          h('input', { type: 'checkbox', 'data-k': 'ci-' + it.id, checked: it.state === 'complete', disabled: !!ed.busy[it.id], onchange: () => toggleCheckItem(it) }),
          h('span', { class: 'grow' + (it.state === 'complete' ? ' ok-txt' : '') }, it.name))),
        h('div', { class: 'row', style: { marginTop: '4px' } },
          h('input', { type: 'text', 'data-k': 'cl-new-' + cl.id, placeholder: 'Novo item…', value: ed.newItem[cl.id] || '',
            oninput: (e) => { ed.newItem[cl.id] = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addCheckItem(cl); } } }),
          h('button', { class: 'btn sm', type: 'button', disabled: !!ed.busy['add-' + cl.id], onclick: () => addCheckItem(cl) }, ed.busy['add-' + cl.id] ? '…' : 'Adicionar'))));
    }
    const tpls = S.templates[card.idBoard];
    if (tpls && tpls.length) {
      kids.push(h('div', { class: 'row' },
        h('select', { 'data-k': 'e-tpl', value: ed.tplId, onchange: (e) => { ed.tplId = e.target.value; } },
          tpls.map((t) => h('option', { value: t.id }, t.name + (t.dateLastActivity ? ' — ' + fmtFullDate(new Date(t.dateLastActivity)) : '')))),
        h('button', { class: 'btn sm', type: 'button', disabled: !!ed.busy.tpl || !ed.tplId, style: { whiteSpace: 'nowrap' }, onclick: copyTemplateChecklists },
          ed.busy.tpl ? 'Copiando…' : card.checklists.length ? 'Copiar checklist do modelo' : 'Copiar checklist do modelo')));
      if (card.checklists.length) kids.push(h('div', { class: 'hint' }, 'O cartão já tem checklist; copiar do modelo adiciona outro.'));
    } else if (!tpls) kids.push(spinner('Procurando o cartão modelo…'));

    // --- anexos (salvos na hora) ---
    const atts = card.attachments || [];
    kids.push(h('h4', null, 'Anexos ', h('span', { class: 'muted' }, '— enviados na hora')));
    if (!atts.length) kids.push(h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Nenhum anexo.'));
    else kids.push(h('div', { class: 'files' }, atts.map((a) => h('div', { class: 'file' },
      h('span', { class: 'ficon' }, a.isUpload ? '📄' : '🔗'),
      h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'grow', title: a.name || a.url }, a.name || a.url),
      h('span', { class: 'score' }, [a.isUpload ? fmtBytes(a.bytes) : 'link', a.date ? fmtFullDate(new Date(a.date)) : ''].filter(Boolean).join(' · '))))));
    kids.push(fileDrop('e-files', (files) => uploadEditFiles(files), ed.busy.upload || null));
    const hasLink = atts.some((a) => S.proto && String(a.url || '').includes(S.proto.uuid));
    if (S.proto && !hasLink) {
      kids.push(h('div', { class: 'actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn sm', type: 'button', disabled: !!ed.busy.att, onclick: attachProtoLink }, ed.busy.att ? 'Anexando…' : 'Anexar o link deste protocolo no NoCartório')));
    }

    // --- comentários ---
    kids.push(h('h4', null, 'Comentários'));
    kids.push(h('div', { class: 'fld' },
      h('textarea', { 'data-k': 'e-comment', rows: 3, placeholder: 'Escreva um comentário… (Ctrl+Enter publica)', value: ed.newComment || '', style: { fontFamily: 'inherit', fontSize: '13px', minHeight: '64px' },
        oninput: (e) => { ed.newComment = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(); } } }),
      h('div', { class: 'actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn sm primary', type: 'button', disabled: !!ed.busy.comment, onclick: postComment }, ed.busy.comment ? 'Publicando…' : 'Comentar'),
        h('span', { class: 'small muted' }, 'Publicado como ' + (S.me ? S.me.fullName || S.me.username : 'a conta do token') + '.'))));
    if (card.comments === null) kids.push(h('div', { class: 'small muted' }, 'Não consegui ler os comentários.'));
    else if (!card.comments.length) kids.push(h('div', { class: 'small muted' }, 'Nenhum comentário.'));
    else for (const c of card.comments) {
      kids.push(h('div', { class: 'cmt' },
        h('div', { class: 'small' }, h('b', null, c.author), h('span', { class: 'muted' }, ' · ' + (c.date ? fmtDateTime(new Date(c.date)) : ''))),
        h('div', { class: 'cmt-t' }, c.text)));
    }
    return h('div', { class: 'edit' }, kids);
  }

  /** Área para escolher ou arrastar arquivos. onFiles recebe uma lista de File. */
  function fileDrop(key, onFiles, busyText) {
    const input = h('input', { type: 'file', multiple: true, 'data-k': key, style: { display: 'none' },
      onchange: (e) => { const fl = [...e.target.files]; e.target.value = ''; if (fl.length) onFiles(fl); } });
    const zone = h('div', { class: 'drop' + (busyText ? ' busy' : ''), role: 'button', tabindex: '0',
      onclick: () => { if (!busyText) input.click(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && !busyText) { e.preventDefault(); input.click(); } },
      ondragover: (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
        const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])];
        if (fl.length && !busyText) onFiles(fl);
      } },
      busyText ? [h('span', { class: 'spin' }), busyText] : ['Arraste arquivos aqui ou ', h('u', null, 'clique para escolher')]);
    return h('div', { class: 'fld' }, input, zone);
  }

  function editLabels(bd, card) {
    const kids = [];
    const sug = labelSuggestionsFor(E.boardId).slice(0, 3);
    const sugScore = new Map(sug.map((s) => [s.label.id, s]));
    const ids = [...new Set([...E.shownLabels, ...sug.map((s) => s.label.id)])];
    const onCard = new Set(E.boardId === card.idBoard ? card.idLabels || [] : []);
    for (const id of ids) {
      const l = bd.labels.find((x) => x.id === id);
      if (!l) continue;
      const s = sugScore.get(id);
      kids.push(h('label', { class: 'opt' },
        h('input', { type: 'checkbox', 'data-k': 'e-lab-' + id, checked: E.labelIds.has(id), onchange: (e) => { if (e.target.checked) E.labelIds.add(id); else E.labelIds.delete(id); render(); } }),
        h('span', { class: 'grow' }, chip(l)),
        onCard.has(id) ? h('span', { class: 'score' }, 'no cartão') : s ? (s.remembered ? h('span', { class: 'tag' }, 'usada antes') : h('span', { class: 'score' }, Math.round(s.score * 100) + '% parecida')) : null));
    }
    const rest = bd.labels.filter((l) => l.name && !ids.includes(l.id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (rest.length) {
      kids.push(h('div', { class: 'opt' },
        h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, 'Adicionar outra:'),
        h('select', { 'data-k': 'e-lab-add', value: '', onchange: (e) => { const id = e.target.value; if (id) { E.labelIds.add(id); E.shownLabels.push(id); render(); } } },
          h('option', { value: '' }, '— etiquetas do quadro —'),
          rest.map((l) => h('option', { value: l.id }, l.name + (l.color ? '' : ' (sem cor)'))))));
    }
    kids.push(h('label', { class: 'opt' },
      h('input', { type: 'checkbox', 'data-k': 'e-lab-new', checked: E.newLabelOn, onchange: (e) => { E.newLabelOn = e.target.checked; render(); } }),
      h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, 'Criar nova:'),
      h('input', { type: 'text', 'data-k': 'e-lab-new-name', value: E.newLabelName, oninput: (e) => { E.newLabelName = e.target.value; if (!E.newLabelOn) { E.newLabelOn = true; const cb = UI.shadow.querySelector('[data-k="e-lab-new"]'); if (cb) cb.checked = true; } }, onchange: () => render() }),
      h('span', { class: 'chip', title: 'azul-celeste suave', style: { background: LABEL_COLORS[NEW_LABEL_COLOR], width: '22px', height: '18px', padding: 0 } })));
    if (E.lostLabels.length) kids.push(h('div', { class: 'hint' }, 'Não existem no quadro de destino: ' + E.lostLabels.map((n) => '"' + n + '"').join(', ') + '. Marque "Criar nova" se quiser recriar.'));
    return h('div', { class: 'fld' }, kids);
  }

  function editMembers(bd, card) {
    const sigId = signerMemberId(bd);
    const sig = S.proto && S.proto.signatory;
    const first = new Set(E.boardId === card.idBoard ? card.idMembers || [] : []);
    const list = bd.members.slice().sort((a, b) => (Number(first.has(b.id)) - Number(first.has(a.id))) || (Number(b.id === sigId) - Number(a.id === sigId)));
    const kids = [h('div', { class: 'boards', style: { maxHeight: '150px' } }, list.map((m) => h('label', { class: 'opt' },
      h('input', { type: 'checkbox', 'data-k': 'e-mem-' + m.id, checked: E.memberIds.has(m.id), onchange: (e) => { if (e.target.checked) E.memberIds.add(m.id); else E.memberIds.delete(m.id); render(); } }),
      h('span', { class: 'grow' }, m.fullName || m.username),
      m.id === sigId ? h('span', { class: 'tag' }, 'assinante') : null)))];
    if (sig && !sigId) kids.push(h('div', { class: 'hint' }, 'Assinante no NoCartório: ' + sig.name + ' — não achei com segurança entre os membros do quadro.'));
    if (E.lostMembers.length) kids.push(h('div', { class: 'hint' }, 'Não são membros do quadro de destino e sairão do cartão: ' + E.lostMembers.join(', ') + '.'));
    return h('div', { class: 'fld' }, kids);
  }

  function secForm() {
    if (!S.proto || !S.boards) return null;
    // enquanto procura o número nos quadros, espera para não mostrar o formulário à toa
    if (S.proto.numero && !S.scanned && !S.created && !S.creating) return null;
    // já existe cartão: o formulário de criação fica recolhido
    if ((S.matches || []).length && !S.showNew && !S.created && !S.creating) {
      return h('div', { class: 'sec' }, h('button', { class: 'btn link', type: 'button', 'data-k': 'show-new', onclick: () => { S.showNew = true; render(); } }, '+ Criar outro cartão para este protocolo'));
    }
    const vis = S.boards.filter(isBoardVisible);
    const kids = [h('h3', null, 'Novo cartão')];
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Quadro'),
      h('select', { 'data-k': 'board', value: F.boardId, onchange: (e) => setBoard(e.target.value) },
        h('option', { value: '' }, '— escolha o quadro —'),
        vis.map((b) => h('option', { value: b.id }, b.name)))));
    if (!F.boardId) return h('div', { class: 'sec' }, kids);
    const bd = S.boardData[F.boardId];
    if (S.boardErr[F.boardId]) { kids.push(h('div', { class: 'box err' }, S.boardErr[F.boardId])); return h('div', { class: 'sec' }, kids); }
    if (!bd) { kids.push(spinner('Lendo o quadro…')); return h('div', { class: 'sec' }, kids); }

    // coluna
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Coluna'),
      h('select', { 'data-k': 'list', value: F.listId, onchange: (e) => { F.listId = e.target.value; } },
        bd.lists.map((l) => h('option', { value: l.id }, l.name)))));

    // modelo
    const tpls = S.templates[F.boardId];
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Modelo (checklist e descrição)'),
      !tpls ? spinner('Procurando o cartão modelo…')
        : h('select', { 'data-k': 'tpl', value: F.templateId, onchange: (e) => selectTemplate(e.target.value) },
          h('option', { value: '' }, '(sem modelo)'),
          tpls.map((t) => h('option', { value: t.id }, t.name + (t.dateLastActivity ? ' — ' + fmtFullDate(new Date(t.dateLastActivity)) : '') + (t.isTemplate ? '' : ' (não é modelo)')))),
      tpls && !tpls.length ? h('div', { class: 'hint' }, 'Nenhum cartão modelo "PROTOCOLO" encontrado neste quadro; o cartão sai sem checklist.') : null,
      F.templateId && S.tplDetail[F.templateId] ? h('div', { class: 'hint' }, S.tplDetail[F.templateId].checklists.length
        ? 'Copia: ' + S.tplDetail[F.templateId].checklists.map((x) => x.name).join(', ') : 'O modelo não tem checklist.') : null));

    // título
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Título'),
      h('input', { type: 'text', 'data-k': 'title', value: F.title, oninput: (e) => { F.title = e.target.value; F.titleTouched = true; } })));

    // descrição
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Descrição'),
      h('textarea', { 'data-k': 'desc', rows: 5, value: F.desc, oninput: (e) => { F.desc = e.target.value; F.descTouched = true; } }),
      h('div', { class: 'hint' }, 'O contato do apresentante não vem do NoCartório: complete aqui se quiser.')));

    kids.push(fieldLabel(bd));
    kids.push(fieldExtraLabels(bd));
    kids.push(fieldMember(bd));
    kids.push(fieldDue());

    // arquivos e comentário
    kids.push(h('span', { class: 'lbl' }, 'Anexos'));
    if (F.files.length) {
      kids.push(h('div', { class: 'files' }, F.files.map((f, i) => h('div', { class: 'file' },
        h('span', { class: 'ficon' }, '📄'), h('span', { class: 'grow', title: f.name }, f.name),
        h('span', { class: 'score' }, fmtBytes(f.size)),
        h('button', { class: 'icon-btn', type: 'button', title: 'Tirar da lista', style: { fontSize: '12px', padding: '2px 6px' }, onclick: () => { F.files.splice(i, 1); render(); } }, '✕')))));
    }
    kids.push(fileDrop('files', (fl) => { F.files.push(...fl); render(); }, null));
    if (F.files.some((f) => f.size > TRELLO_FREE_LIMIT)) kids.push(h('div', { class: 'box warn small' }, 'Arquivo acima de 10 MB: no plano gratuito do Trello o envio é recusado (nos planos pagos o limite é 250 MB).'));
    kids.push(h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Comentário inicial (opcional)'),
      h('textarea', { 'data-k': 'comment', rows: 2, value: F.comment, style: { fontFamily: 'inherit', fontSize: '13px', minHeight: '52px' }, oninput: (e) => { F.comment = e.target.value; } })));

    // opções
    kids.push(h('div', { class: 'fld' },
      h('label', { class: 'opt' }, h('input', { type: 'checkbox', 'data-k': 'attach', checked: F.attach, onchange: (e) => { F.attach = e.target.checked; } }),
        h('span', { class: 'grow' }, 'Anexar o link do protocolo no NoCartório')),
      h('div', { class: 'row', style: { padding: '2px 6px' } }, h('span', { class: 'small muted' }, 'Posição na coluna:'),
        h('select', { 'data-k': 'pos', value: F.pos, style: { width: 'auto' }, onchange: (e) => { F.pos = e.target.value; } },
          h('option', { value: 'top' }, 'no topo'), h('option', { value: 'bottom' }, 'no fim')))));

    // duplicidade
    const dupSame = (S.matches || []).filter((m) => m.board.id === F.boardId);
    if (dupSame.length && (!S.created || S.createErr)) {
      kids.push(h('div', { class: 'box warn' },
        h('div', null, 'Já existe ', dupSame.length > 1 ? dupSame.length + ' cartões' : 'cartão', ' com o nº ', Core.fmtNum(S.proto.numero, true), ' neste quadro (veja acima).'),
        h('label', { class: 'opt', style: { padding: '4px 0 0' } }, h('input', { type: 'checkbox', 'data-k': 'dup', checked: F.confirmDup, onchange: (e) => { F.confirmDup = e.target.checked; } }),
          h('span', null, 'Criar outro cartão mesmo assim'))));
    }

    if (S.createErr) kids.push(h('div', { class: 'box err' }, S.createErr));
    if (S.created) {
      kids.push(h('div', { class: 'box ok', 'data-created': '1' },
        h('div', null, h('b', null, 'Cartão criado: '), h('a', { href: S.created.url, target: '_blank', rel: 'noopener', style: { color: '#0C66E4', fontWeight: '600' } }, S.created.name)),
        h('div', { class: 'small' }, S.created.board + ' › ' + S.created.list),
        S.createWarn.length ? h('ul', { class: 'small', style: { margin: '6px 0 0 16px', padding: 0 } }, S.createWarn.map((w) => h('li', null, w))) : null));
    }
    kids.push(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', disabled: S.creating, onclick: createCard }, S.creating ? 'Criando…' : 'Criar cartão'),
      S.created ? h('a', { class: 'btn', href: S.created.url, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, 'Abrir no Trello') : null));
    return h('div', { class: 'sec' }, kids);
  }

  function fieldLabel(bd) {
    const kids = [h('span', { class: 'lbl' }, 'Etiqueta do ato')];
    const radio = (mode, id) => h('input', {
      type: 'radio', name: 'nct-label', 'data-k': 'lab-' + mode + (id ? '-' + id : ''),
      checked: F.labelMode === mode && (mode !== 'pick' || F.labelId === id),
      onchange: () => { F.labelMode = mode; if (mode === 'pick') F.labelId = id; render(); },
    });
    const sugIds = new Set(S.labelSug.map((x) => x.label.id));
    for (const s of S.labelSug) {
      kids.push(h('label', { class: 'opt' }, radio('pick', s.label.id), h('span', { class: 'grow' }, chip(s.label)),
        s.remembered ? h('span', { class: 'tag' }, 'usada antes') : h('span', { class: 'score' }, Math.round(s.score * 100) + '% parecida')));
    }
    if (!S.labelSug.length) kids.push(h('div', { class: 'hint', style: { margin: '0 6px 4px' } }, 'Nenhuma etiqueta parecida com "' + Core.cleanActName(S.proto.processType ? S.proto.processType.name : '') + '".'));
    // outra etiqueta do quadro
    const otherSelected = F.labelMode === 'pick' && F.labelId && !sugIds.has(F.labelId);
    const others = bd.labels.filter((l) => l.name).slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    kids.push(h('div', { class: 'opt' },
      h('input', { type: 'radio', name: 'nct-label', 'data-k': 'lab-other', checked: otherSelected,
        onchange: () => { const sel = UI.shadow.querySelector('[data-k="lab-other-sel"]'); F.labelMode = 'pick'; F.labelId = sel && sel.value ? sel.value : ''; render(); } }),
      h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, 'Outra:'),
      h('select', { 'data-k': 'lab-other-sel', value: otherSelected ? F.labelId : '', onchange: (e) => { F.labelMode = 'pick'; F.labelId = e.target.value; render(); } },
        h('option', { value: '' }, '— todas as etiquetas do quadro —'),
        others.map((l) => h('option', { value: l.id }, l.name + (l.color ? '' : ' (sem cor)'))))));
    // nova etiqueta
    kids.push(h('div', { class: 'opt' }, radio('new'),
      h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, 'Criar nova:'),
      h('input', { type: 'text', 'data-k': 'lab-new-name', value: F.newLabelName, onfocus: () => { if (F.labelMode !== 'new') { F.labelMode = 'new'; const r = UI.shadow.querySelector('[data-k="lab-new"]'); if (r) r.checked = true; } }, oninput: (e) => { F.newLabelName = e.target.value; F.labelMode = 'new'; } }),
      h('span', { class: 'chip', title: 'azul-celeste suave', style: { background: LABEL_COLORS[NEW_LABEL_COLOR], width: '22px', height: '18px', padding: 0 } })));
    kids.push(h('label', { class: 'opt' }, radio('none'), h('span', { class: 'grow small' }, 'Sem etiqueta')));
    return h('div', { class: 'fld' }, kids);
  }

  /** Etiquetas secundárias (SAEC, Malote…), além da etiqueta do ato. */
  function fieldExtraLabels(bd) {
    const mainId = F.labelMode === 'pick' ? F.labelId : '';
    const recent = (getMem().extraByBoard[bd.id] || []).filter((id) => bd.labels.some((l) => l.id === id));
    const shown = [...new Set([...recent, ...F.extraShown, ...F.extraLabels])].filter((id) => id !== mainId);
    const kids = [h('span', { class: 'lbl' }, 'Outras etiquetas')];
    for (const id of shown) {
      const l = bd.labels.find((x) => x.id === id);
      if (!l) continue;
      kids.push(h('label', { class: 'opt' },
        h('input', { type: 'checkbox', 'data-k': 'xlab-' + id, checked: F.extraLabels.includes(id), onchange: (e) => {
          F.extraLabels = F.extraLabels.filter((x) => x !== id);
          if (e.target.checked) F.extraLabels.push(id);
          render();
        } }),
        h('span', { class: 'grow' }, chip(l)),
        recent.includes(id) ? h('span', { class: 'score' }, 'usada antes') : null));
    }
    const rest = bd.labels.filter((l) => l.name && l.id !== mainId && !shown.includes(l.id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (rest.length) {
      kids.push(h('div', { class: 'opt' },
        h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, 'Adicionar:'),
        h('select', { 'data-k': 'xlab-add', value: '', onchange: (e) => { const id = e.target.value; if (id && !F.extraLabels.includes(id)) { F.extraLabels.push(id); F.extraShown.push(id); render(); } } },
          h('option', { value: '' }, '— etiquetas do quadro —'),
          rest.map((l) => h('option', { value: l.id }, l.name + (l.color ? '' : ' (sem cor)'))))));
    }
    kids.push(h('div', { class: 'hint' }, 'Etiquetas secundárias, como SAEC ou Malote. As que você usar ficam como atalho neste quadro.'));
    return h('div', { class: 'fld' }, kids);
  }

  function fieldMember(bd) {
    const sig = S.proto.signatory;
    let hint;
    if (!sig) hint = 'O NoCartório não informa assinante neste serviço.';
    else if (F.memberWhy === 'lembrado') hint = 'Assinante: ' + sig.name + ' — escolha lembrada da última vez.';
    else if (F.memberWhy === 'nome') hint = 'Assinante: ' + sig.name + ' — sugerido pelo nome.';
    else if (F.memberWhy === 'manual') hint = 'Assinante no NoCartório: ' + sig.name + '.';
    else hint = 'Assinante: ' + sig.name + ' — não achei com segurança no quadro; escolha acima.';
    return h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Responsável'),
      h('select', { 'data-k': 'member', value: F.memberId, onchange: (e) => { F.memberId = e.target.value; F.memberWhy = 'manual'; render(); } },
        h('option', { value: '' }, '— sem responsável —'),
        bd.members.map((m) => h('option', { value: m.id }, m.fullName || m.username))),
      h('div', { class: 'hint' }, hint));
  }

  function fieldDue() {
    const cal = calendar();
    const today = new Date();
    const opts = [3, 5, 10].map((n) => ({ n, d: cal.addBusinessDays(today, n) }));
    return h('div', { class: 'fld' }, h('span', { class: 'lbl' }, 'Prazo (dias úteis, sem feriados)'),
      h('div', { class: 'seg' },
        opts.map((o) => h('button', { type: 'button', 'data-k': 'due-' + o.n, class: F.dueDays === o.n ? 'on' : '', onclick: () => { F.dueDays = o.n; render(); } },
          o.n + ' dias úteis', h('small', null, fmtDate(o.d, true)))),
        h('button', { type: 'button', 'data-k': 'due-0', class: F.dueDays === 0 ? 'on' : '', onclick: () => { F.dueDays = 0; render(); } }, 'Sem prazo', h('small', null, '—'))),
      F.dueDays ? h('div', { class: 'hint' }, 'Início hoje (' + fmtDate(today) + '); entrega ' + fmtFullDate(opts.find((o) => o.n === F.dueDays).d) + ' às 23:59.') : null);
  }

  /* ---------------------- configurações ---------------------- */
  function viewConfig() {
    const c = getCfg();
    // rascunho guardado no estado: não se perde quando a tela é redesenhada
    const draft = S.cfgDraft || (S.cfgDraft = { key: c.key, token: c.token, carnaval: c.carnaval, corpus: c.corpus, extras: c.extras });
    const keyIn = h('input', { type: 'text', 'data-k': 'cfg-key', value: draft.key, placeholder: '32 caracteres', autocomplete: 'off', oninput: (e) => { draft.key = e.target.value.trim(); } });
    const tokIn = h('input', { type: 'password', 'data-k': 'cfg-token', value: draft.token, placeholder: 'ATTA…', autocomplete: 'off', oninput: (e) => { draft.token = e.target.value.trim(); } });
    const save = (msg) => {
      const cur = getCfg();
      Object.assign(cur, { key: draft.key, token: draft.token, carnaval: draft.carnaval, corpus: draft.corpus, extras: draft.extras });
      setCfg(cur);
      S.configMsg = msg || { ok: true, text: 'Configurações salvas.' };
    };
    const kids = [];
    if (S.configMsg) kids.push(h('div', { class: 'box ' + (S.configMsg.ok ? 'ok' : 'err') }, S.configMsg.text));

    // conexão
    kids.push(h('div', { class: 'sec' }, h('h3', null, 'Conexão com o Trello'),
      h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Chave da API (API key)'), keyIn),
      h('label', { class: 'fld' }, h('span', { class: 'lbl' }, 'Token'),
        h('div', { class: 'row' }, tokIn, h('button', { class: 'btn', type: 'button', onclick: () => { tokIn.type = tokIn.type === 'password' ? 'text' : 'password'; } }, 'mostrar'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          if (!draft.key) { S.configMsg = { ok: false, text: 'Cole a chave da API primeiro.' }; render(); return; }
          const url = 'https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=' + encodeURIComponent('NoCartório → Trello') + '&key=' + encodeURIComponent(draft.key);
          window.open(url, '_blank', 'noopener');
        } }, 'Gerar token no Trello'),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          save();
          S.boards = null; S.boardData = {}; S.templates = {}; S.tplDetail = {};
          try {
            await loadBoards();
            S.configMsg = { ok: true, text: 'Conectado como ' + (S.me.fullName || S.me.username) + ' — ' + S.boards.length + ' quadros.' };
          } catch (e) { S.configMsg = { ok: false, text: e.message }; }
          render();
        } }, 'Salvar e testar')),
      h('ol', { class: 'steps small muted' },
        h('li', null, 'Em trello.com/apps/admin, crie um Power-Up (nome à escolha, ex.: "NoCartório") na área de trabalho do cartório, abra-o e, na aba da chave de API, clique em "Generate a new API key".'),
        h('li', null, 'Cole a chave acima e clique em "Gerar token no Trello". Autorize e copie o token exibido (o token precisa ser gerado com essa mesma chave).'),
        h('li', null, 'Cole o token, clique em "Salvar e testar". Use a conta que deve aparecer como criadora dos cartões (ex.: CartórioSJA).')),
      h('div', { class: 'hint' }, 'A chave e o token ficam guardados só neste navegador (armazenamento do Violentmonkey/Tampermonkey). O token pode ser revogado no Trello em Configurações › Aplicativos.')));

    // quadros
    if (S.boards && S.boards.length) {
      const hidden = Array.isArray(c.hiddenBoards) ? c.hiddenBoards : S.boards.filter((b) => /desuso/i.test(b.name)).map((b) => b.id);
      kids.push(h('div', { class: 'sec' }, h('h3', null, 'Quadros usados'),
        h('div', { class: 'boards' }, S.boards.map((b) => h('label', { class: 'opt' },
          h('input', { type: 'checkbox', checked: !hidden.includes(b.id), onchange: (e) => {
            const cur = getCfg();
            let hb = Array.isArray(cur.hiddenBoards) ? cur.hiddenBoards.slice() : hidden.slice();
            hb = hb.filter((id) => id !== b.id);
            if (!e.target.checked) hb.push(b.id);
            cur.hiddenBoards = hb; setCfg(cur);
          } }),
          h('span', { class: 'grow' }, b.name)))),
        h('div', { class: 'hint' }, 'Só os quadros marcados aparecem no seletor e entram na busca por cartão existente.')));
    }

    // feriados
    const cal = Core.makeCalendar({ carnaval: draft.carnaval, corpus: draft.corpus, extras: draft.extras });
    const up = cal.upcoming(new Date(), 6);
    kids.push(h('div', { class: 'sec' }, h('h3', null, 'Prazos — feriados'),
      h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Sempre contam como não úteis: sábados, domingos, feriados nacionais (inclusive 20/11) e Sexta-feira Santa.'),
      h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: draft.carnaval, onchange: (e) => { draft.carnaval = e.target.checked; } }), h('span', null, 'Carnaval (segunda e terça)')),
      h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: draft.corpus, onchange: (e) => { draft.corpus = e.target.checked; } }), h('span', null, 'Corpus Christi')),
      h('label', { class: 'fld', style: { marginTop: '6px' } }, h('span', { class: 'lbl' }, 'Outros feriados (municipais, estaduais, pontos facultativos)'),
        h('textarea', { 'data-k': 'cfg-extras', rows: 4, value: draft.extras, placeholder: 'Um por linha:\ndd/mm Nome  → todo ano\ndd/mm/aaaa Nome  → só naquele ano', oninput: (e) => { draft.extras = e.target.value; } })),
      h('div', { class: 'hint' }, 'Próximos considerados: ' + up.map((x) => fmtFullDate(x.date) + ' ' + x.name).join(' · ')),
      h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => { save(); render(); } }, 'Salvar'))));

    // backup
    kids.push(h('div', { class: 'sec' }, h('h3', null, 'Levar para outra máquina'),
      h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Copia a configuração (inclui o token!) e as escolhas aprendidas, para colar no script de outra máquina.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const txt = JSON.stringify({ app: 'nocartorio-trello', v: VERSION, cfg: getCfg(), mem: getMem() });
          try { await navigator.clipboard.writeText(txt); S.configMsg = { ok: true, text: 'Configuração copiada. Não compartilhe fora do cartório: contém o token.' }; }
          catch (e) { S.importOpen = true; S.configMsg = { ok: true, text: 'Copie o texto da caixa abaixo.' }; S.importText = txt; }
          render();
        } }, 'Copiar configuração'),
        h('button', { class: 'btn', type: 'button', onclick: () => { S.importOpen = !S.importOpen; S.importText = ''; render(); } }, 'Colar configuração…'),
        h('button', { class: 'btn', type: 'button', onclick: () => {
          if (!confirm('Esquecer quadros, colunas, etiquetas e responsáveis aprendidos?')) return;
          setMem(JSON.parse(JSON.stringify(DEF_MEM))); S.configMsg = { ok: true, text: 'Escolhas aprendidas apagadas.' }; render();
        } }, 'Esquecer escolhas')),
      S.importOpen ? h('div', { style: { marginTop: '8px' } },
        h('textarea', { 'data-k': 'cfg-import', rows: 4, value: S.importText || '', oninput: (e) => { S.importText = e.target.value; } }),
        h('div', { class: 'actions', style: { marginTop: '6px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => {
          try {
            const j = JSON.parse(S.importText || '');
            if (!j || j.app !== 'nocartorio-trello') throw new Error('texto não reconhecido');
            setCfg(Object.assign({}, DEF_CFG, j.cfg || {}));
            const m = getMem(); for (const k of Object.keys(DEF_MEM)) m[k] = Object.assign({}, (j.mem || {})[k] || {}); setMem(m);
            S.importOpen = false; S.boards = null; S.cfgDraft = null;
            S.configMsg = { ok: true, text: 'Configuração importada. Clique em "Salvar e testar" para conferir.' };
          } catch (e) { S.configMsg = { ok: false, text: 'Não consegui importar: ' + e.message }; }
          render();
        } }, 'Importar'))) : null));

    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => {
      S.view = 'main'; S.configMsg = null; S.cfgDraft = null; render();
      // se a conexão foi refeita/testada, os dados do Trello foram descartados: recarrega tudo
      if (hasCreds() && S.uuid && (!S.proto || !S.boards || !S.scanned || (F.boardId && !S.boardData[F.boardId]))) refresh();
    } }, '← Voltar ao protocolo')));
    return h('div', null, kids);
  }

  /* =====================================================================
   * NAVEGAÇÃO (o NoCartório é SPA: a URL muda sem recarregar a página)
   * ===================================================================== */
  const PROTO_RE = /^\/admin\/manager\/v2\/protocol\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
  function currentUuid() { const m = location.pathname.match(PROTO_RE); return m ? m[1].toLowerCase() : null; }
  function tick() {
    const uuid = currentUuid();
    if (uuid) ensureUI();
    if (!UI.host) return;
    if (!document.documentElement.contains(UI.host)) document.body.appendChild(UI.host);
    UI.btn.hidden = !uuid;
    if (uuid !== S.uuid) {
      const keepBoards = S.boards;
      resetState(uuid);
      S.boards = keepBoards;
      if (!uuid) closePanel();
      else if (S.open) { render(); if (hasCreds()) loadAll(); }
    }
  }
  setInterval(tick, 700);
  tick();

  try {
    GM_registerMenuCommand('Trello: abrir painel', () => { ensureUI(); openPanel('main'); });
    GM_registerMenuCommand('Trello: configurações', () => { ensureUI(); openPanel('config'); });
  } catch (e) { /* gerenciador sem menu */ }
})();