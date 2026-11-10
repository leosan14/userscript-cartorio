// ==UserScript==
// @name         NoCartório — Busca Avançada Livro 3 (Registro Auxiliar)
// @namespace    https://github.com/leonardo/nocartorio-livro3
// @version      1.0.0
// @description  Busca no Livro 3 (Registro Auxiliar) por nome, CPF/CNPJ, produto, safra, número do registro e título, com extração automática dos dados dos registros.
// @author       Leonardo
// @match        https://app.nocartorio.com/admin/manager/v2/ri-auxiliary-registry-book*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-livro3-busca-avancada.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-livro3-busca-avancada.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Configuração
   * ------------------------------------------------------------------ */

  const BOOK_PATH = '/admin/manager/v2/ri-auxiliary-registry-book';
  const BASE_URL = location.origin + BOOK_PATH;
  const LS_KEY = 'nc3-busca-avancada:v1';
  const SCRIPT_VERSION = '1.0.0';

  const PRODUCT_SUGGESTIONS = [
    'SOJA', 'MILHO', 'SORGO', 'FEIJÃO', 'ALGODÃO', 'CAFÉ', 'ARROZ', 'TRIGO',
    'GIRASSOL', 'CANOLA', 'AMENDOIM', 'MAMONA', 'CANA-DE-AÇÚCAR',
    'BOVINOS', 'SUÍNOS', 'AVES', 'OVINOS', 'CAPRINOS', 'EQUINOS',
    'COLHEITADEIRA', 'TRATOR', 'PULVERIZADOR', 'PLANTADEIRA', 'CAMINHÃO',
    'MÁQUINAS AGRÍCOLAS', 'IMPLEMENTOS AGRÍCOLAS'
  ];

  const PRODUCT_TERMS = [
    ['SOJA', 'SOJA'],
    ['MILHO', 'MILHO'],
    ['SORGO', 'SORGO'],
    ['FEIJÃO', 'FEIJÃO'],
    ['FEIJAO', 'FEIJÃO'],
    ['ALGODÃO', 'ALGODÃO'],
    ['ALGODAO', 'ALGODÃO'],
    ['CAFÉ', 'CAFÉ'],
    ['CAFE', 'CAFÉ'],
    ['ARROZ', 'ARROZ'],
    ['TRIGO', 'TRIGO'],
    ['GIRASSOL', 'GIRASSOL'],
    ['CANOLA', 'CANOLA'],
    ['AMENDOIM', 'AMENDOIM'],
    ['MAMONA', 'MAMONA'],
    ['CANA-DE-AÇÚCAR', 'CANA-DE-AÇÚCAR'],
    ['CANA DE AÇÚCAR', 'CANA-DE-AÇÚCAR'],
    ['BOVINOS', 'BOVINOS'],
    ['BOVINO', 'BOVINOS'],
    ['SUÍNOS', 'SUÍNOS'],
    ['SUINOS', 'SUÍNOS'],
    ['AVES', 'AVES'],
    ['OVINOS', 'OVINOS'],
    ['CAPRINOS', 'CAPRINOS'],
    ['EQUINOS', 'EQUINOS'],
    ['COLHEITADEIRA', 'COLHEITADEIRA'],
    ['TRATOR', 'TRATOR'],
    ['PULVERIZADOR', 'PULVERIZADOR'],
    ['PLANTADEIRA', 'PLANTADEIRA'],
    ['CAMINHÃO', 'CAMINHÃO'],
    ['CAMINHAO', 'CAMINHÃO'],
    ['MÁQUINAS AGRÍCOLAS', 'MÁQUINAS AGRÍCOLAS'],
    ['MAQUINAS AGRICOLAS', 'MÁQUINAS AGRÍCOLAS']
  ];

  const ROLE_DEFS = [
    { key: 'emitente', label: 'Emitente/Devedor' },
    { key: 'credor', label: 'Credor(a)' },
    { key: 'nubentes', label: 'Nubentes' }
  ];

  const LABEL_DEFS = [
    { key: 'titulo', labels: ['TÍTULO', 'TITULO'] },
    { key: 'prenotacao', labels: ['PRENOTAÇÃO', 'PRENOTACAO'] },
    { key: 'emitente', labels: ['EMITENTES/DEVEDORES', 'EMITENTES / DEVEDORES', 'EMITENTE/DEVEDOR', 'EMITENTE / DEVEDOR', 'EMITENTES', 'DEVEDORES', 'EMITENTE', 'DEVEDOR'] },
    { key: 'credor', labels: ['CREDORES', 'CREDORAS', 'CREDORA', 'CREDOR'] },
    { key: 'nubentes', labels: ['NUBENTES'] },
    { key: 'garantia', labels: ['GARANTIA'] },
    { key: 'imovel', labels: ['IMÓVEL DE LOCALIZAÇÃO DOS BENS DADOS EM GARANTIA', 'IMOVEL DE LOCALIZACAO DOS BENS DADOS EM GARANTIA'] },
    { key: 'vencimento', labels: ['VENCIMENTO DA DÍVIDA', 'VENCIMENTO DA DIVIDA'] },
    { key: 'valor_divida', labels: ['VALOR DA DÍVIDA', 'VALOR DA DIVIDA'] },
    { key: 'produto', labels: ['PRODUTO A SER ENTREGUE'] },
    { key: 'caracteristicas', labels: ['CARACTERÍSTICAS DO PRODUTO', 'CARACTERISTICAS DO PRODUTO'] },
    { key: 'destinacao', labels: ['DESTINAÇÃO', 'DESTINACAO'] },
    { key: 'juros', labels: ['TAXA DE JUROS'] },
    { key: 'outras_registraveis', labels: ['OUTRAS GARANTIAS REGISTRÁVEIS', 'OUTRAS GARANTIAS REGISTRAVEIS'] },
    { key: 'outras_nao', labels: ['OUTRAS GARANTIAS NÃO REGISTRÁVEIS', 'OUTRAS GARANTIAS NAO REGISTRAVEIS'] },
    { key: 'indisponibilidade', labels: ['INDISPONIBILIDADE'] },
    { key: 'emolumentos', labels: ['EMOLUMENTOS, TAXAS E DEMAIS TRIBUTOS', 'EMOLUMENTOS'] },
    { key: 'selo', labels: ['SELO'] },
    { key: 'forma_pagamento', labels: ['FORMA E DATA DE PAGAMENTO'] },
    { key: 'praca', labels: ['PRAÇA DE PAGAMENTO', 'PRACA DE PAGAMENTO'] },
    { key: 'regime', labels: ['REGIME DE BENS'] },
    { key: 'domicilio', labels: ['PRIMEIRO DOMICÍLIO DOS NUBENTES APÓS O CASAMENTO'] }
  ];

  const state = {
    open: false,
    loading: false,
    error: null,
    query: null,
    fields: null,
    page: 1,
    result: null,
    parsed: null,
    cache: new Map(),
    controller: null,
    strict: false,
    lastPath: location.pathname
  };

  let host = null;
  let shadow = null;
  let form = null;
  let resultsEl = null;

  /* ------------------------------------------------------------------ *
   *  Utilidades
   * ------------------------------------------------------------------ */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function onlyDigits(value) {
    return String(value == null ? '' : value).replace(/\D+/g, '');
  }

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function normKey(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function includesAll(haystack, term) {
    const hay = normKey(haystack);
    const words = normKey(term).split(' ').filter(Boolean);
    return words.length > 0 && words.every((word) => hay.includes(word));
  }

  function includesAllWords(haystack, term) {
    const hay = normalizeText(haystack);
    const words = normalizeText(term).split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    return words.every((word) => {
      try {
        const regex = new RegExp('(^|[^a-z0-9])' + escapeRegExp(word) + '($|[^a-z0-9])');
        return regex.test(hay);
      } catch (error) {
        return false;
      }
    });
  }

  function formatCpf(digits) {
    const d = onlyDigits(digits);
    return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
  }

  function formatCnpj(digits) {
    const d = onlyDigits(digits);
    return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d;
  }

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s:;,.–—-]+/, '')
      .trim();
  }

  function firstSentence(value, maxLength) {
    let text = clean(value);
    const dot = text.indexOf('. ');
    if (dot > 0) text = text.slice(0, dot);
    text = text.replace(/\s*\.\s*$/, '').trim();
    if (maxLength && text.length > maxLength) text = text.slice(0, maxLength - 1).trim() + '…';
    return text;
  }

  function firstMoney(value) {
    const match = String(value == null ? '' : value).match(/R\$\s*([\d.]+,\d{2})/);
    return match ? 'R$ ' + match[1] : '';
  }

  function normalizeSafra(value) {
    const text = clean(value);
    const match = text.match(/^(\d{2,4})\s*[\/\-.]\s*(\d{2,4})$/);
    if (!match) return text;
    const start = match[1].length === 2 ? '20' + match[1] : match[1];
    const end = match[2].length === 2 ? '20' + match[2] : match[2];
    return start + '/' + end;
  }

  function safeUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function isListPage() {
    const path = location.pathname.replace(/\/+$/, '');
    return path === BOOK_PATH;
  }

  function timelineStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function requestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
    else setTimeout(callback, 16);
  }

  /* ------------------------------------------------------------------ *
   *  Leitura e extração do texto dos registros
   * ------------------------------------------------------------------ */

  function decodeEntities(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  function htmlToText(html) {
    if (!html) return '';
    let text = String(html)
      .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ');
    text = decodeEntities(text);
    text = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return text;
  }

  const LABEL_PATTERNS = [];
  LABEL_DEFS.forEach((def) => {
    def.labels.forEach((label) => {
      // Todos os campos extraídos são labels de formulário seguidos de dois-pontos.
      const source = escapeRegExp(label) + '\\s*:';
      LABEL_PATTERNS.push({
        key: def.key,
        label,
        regex: new RegExp(source, 'giu')
      });
    });
  });

  function extractSections(text) {
    const matches = [];
    LABEL_PATTERNS.forEach((pattern) => {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        matches.push({
          key: pattern.key,
          label: pattern.label,
          start: match.index,
          end: match.index + match[0].length
        });
        if (match[0].length === 0) pattern.regex.lastIndex += 1;
      }
    });

    matches.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    const picked = [];
    matches.forEach((match) => {
      const previous = picked[picked.length - 1];
      if (previous && match.start < previous.end) return;
      picked.push(match);
    });

    const sections = {};
    picked.forEach((match, index) => {
      const next = picked[index + 1];
      const value = clean(text.slice(match.end, next ? next.start : text.length));
      if (!sections[match.key] || value.length > sections[match.key].length) {
        sections[match.key] = value;
      }
    });

    return sections;
  }

  function extractDocs(value) {
    const source = String(value == null ? '' : value);
    const found = [];
    const seen = new Set();

    const cnpjRegex = /\b\d{2}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*\/?\s*\d{4}\s*[-.]?\s*\d{2}\b/g;
    let match;
    while ((match = cnpjRegex.exec(source)) !== null) {
      const digits = onlyDigits(match[0]);
      if (digits.length === 14 && !seen.has(digits)) {
        seen.add(digits);
        found.push({ type: 'CNPJ', value: formatCnpj(digits), digits });
      }
    }

    const rest = source.replace(cnpjRegex, ' ');
    const cpfRegex = /\b\d{3}\s*\.?\s*\d{3}\s*\.?\s*\d{3}\s*[-.]?\s*\d{2}\b/g;
    while ((match = cpfRegex.exec(rest)) !== null) {
      const digits = onlyDigits(match[0]);
      if (digits.length === 11 && !seen.has(digits)) {
        seen.add(digits);
        found.push({ type: 'CPF', value: formatCpf(digits), digits });
      }
    }

    return found;
  }

  function extractParties(sections) {
    const parties = [];
    const seen = new Set();

    ROLE_DEFS.forEach((role) => {
      const section = sections[role.key];
      if (!section) return;

      const chunks = section.split(/;\s*(?:e\s+)?/i);
      chunks.forEach((chunkRaw) => {
        let chunk = chunkRaw.replace(/^\s*(?:e|E)\s+/, '').trim();
        if (!chunk) return;
        if (/^(n[ãa]o consta|nenhum|nenhuma)\b/i.test(chunk)) return;

        let name = chunk.split(',')[0].trim();
        name = clean(name);
        if (!name || name.length < 2) return;
        if (name.length > 160) name = name.slice(0, 157).trim() + '…';

        const docs = extractDocs(chunk);
        const key = role.label + '|' + normKey(name) + '|' + docs.map((d) => d.digits).join(',');
        if (seen.has(key)) return;
        seen.add(key);
        parties.push({ role: role.label, name, docs });
      });
    });

    return parties;
  }

  function extractAvalistas(sections) {
    const section = sections.outras_nao;
    if (!section || /n[ãa]o consta/i.test(section)) return [];

    let source = section.replace(/^.*?\baval\s+de\s+/i, '');
    if (source === section && !/\baval\b/i.test(section)) return [];

    const parties = [];
    const seen = new Set();
    const regex = /([A-Za-zÀ-Úà-ú][A-Za-zÀ-Úà-ú0-9\s.'&\/-]{1,90}?)\s*,\s*inscrit[oa]\s+(?:no|sob)\s+(?:CPF|CNPJ|CNPJ\/MF)?\s*(?:sob\s+)?(?:o\s+)?(?:n[º°.]*)?\s*(\d[\d.\/-]{7,20})/gi;
    let match;
    while ((match = regex.exec(source)) !== null) {
      let name = clean(match[1]).replace(/^(?:e|E)\s+/, '').trim();
      if (!name || name.length < 2) continue;
      if (/\b(pessoa|empresa|inscrit|portador|brasileir|residente|domiciliad|representante|s[óo]cio)\b/i.test(name)) continue;

      const docs = extractDocs(match[0]);
      const key = normKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      parties.push({ role: 'Avalista', name, docs });
    }

    return parties;
  }

  function extractProduct(sections) {
    const candidates = [];

    if (sections.produto) {
      let product = clean(sections.produto);
      product = product.split(/,\s*(?:na quantidade|em quantidade|no valor|equivalente|safra)\b/i)[0];
      product = product.split(',')[0].trim();
      if (product) candidates.push(product);
    }

    // Não usa o texto inteiro aqui: palavras como "milhões" e cláusulas de
    // regime de bens geram falsos positivos (ex.: "milho" em "milhões").
    const haystack = normalizeText([
      sections.produto,
      sections.garantia,
      sections.destinacao
    ].filter(Boolean).join(' | '));

    PRODUCT_TERMS.forEach(([term, canonical]) => {
      const normalized = normalizeText(term);
      const regex = new RegExp('(^|[^a-z0-9])' + escapeRegExp(normalized) + '($|[^a-z0-9])');
      if (regex.test(haystack)) candidates.push(canonical);
    });

    const unique = [];
    const seen = new Set();
    candidates.forEach((candidate) => {
      const key = normKey(candidate);
      if (!key || seen.has(key)) return;
      seen.add(key);
      unique.push(candidate);
    });

    return unique.filter((candidate, index) => {
      const candidateKey = normKey(candidate);
      return !unique.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherKey = normKey(other);
        return otherKey.length > candidateKey.length && otherKey.includes(candidateKey);
      });
    });
  }

  function extractSafras(text) {
    const found = new Set();
    // Exige a palavra "safra" para não confundir com anos de fabricação
    // de máquinas (ex.: "ANO 2005/2006").
    const regex = /safra\s*:?\s*(\d{4})\s*[\/\-]\s*(\d{4})/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      found.add(match[1] + '/' + match[2]);
    }
    return Array.from(found).sort();
  }

  function extractGarantiaType(sections) {
    let value = clean(sections.garantia);
    if (!value) return '';
    value = value.split(/\s+e\s+sem\s+concorr/i)[0];
    value = value.split(',')[0].trim();
    if (value.length > 110) value = value.slice(0, 107).trim() + '…';
    return value;
  }

  function extractImovel(sections) {
    const full = clean(sections.imovel);
    const result = { full, nome: '', matricula: '' };
    if (!full) return result;

    const matricula = full.match(/matr[íi]cula\s*n?[°º]?\s*([\d.]+)/i);
    if (matricula) result.matricula = matricula[1];

    const nome = full.match(/\b(Fazenda|S[íi]tio|Ch[áa]cara|Lote|Gleba|Área|Area)\s+([^,;.]+)/i);
    if (nome) result.nome = clean(nome[1] + ' ' + nome[2]);

    return result;
  }

  function extractTitulo(sections, entry) {
    let value = clean(sections.titulo);
    if (value) {
      value = value.split(/,\s*(?:emitida|emitido|lavrada|lavrado|datada|datado|celebrada|celebrado)/i)[0];
      value = value.split(/\s+(?:emitida|emitido|lavrada|lavrado|datada|datado|celebrada|celebrado)\s+em\b/i)[0];
      value = value.split(/\.\s/)[0];
      value = clean(value);
      if (value.length > 170) value = value.slice(0, 167).trim() + '…';
    }

    if (!value) {
      value = (entry.profile && entry.profile.name) || '';
      value = value.replace(/^R-\d+\s*\([^)]*\)\s*/, '').trim();
      if (!value || value === extractAto(entry)) value = 'Registro ' + entry.number;
    }

    return value;
  }

  function extractAto(entry) {
    const name = (entry.profile && entry.profile.name) || '';
    const match = name.match(/\)\s*(.+)$/);
    return match ? match[1].trim() : (name || entry.number_label || 'Registro');
  }

  function parseEntry(entry) {
    const text = htmlToText(entry.draft_html || '');
    const sections = extractSections(text);
    const parties = extractParties(sections).concat(extractAvalistas(sections));

    const allDocs = [];
    const docSeen = new Set();
    parties.forEach((party) => {
      party.docs.forEach((doc) => {
        if (!docSeen.has(doc.digits)) {
          docSeen.add(doc.digits);
          allDocs.push(doc);
        }
      });
    });

    const averbacao = /^\s*AV\.?\s*\d+/i.test(text) || /\bAVERBAÇÃO\b/i.test(text.slice(0, 400));
    const cancelado = /\bCANCELAD[OA]\b/i.test(text);
    const titulo = extractTitulo(sections, entry);

    return {
      entry,
      text,
      sections,
      parties,
      docs: allDocs,
      produto: extractProduct(sections),
      safras: extractSafras(text),
      garantia: extractGarantiaType(sections),
      valorDivida: firstMoney(sections.valor_divida),
      valorGarantia: firstMoney(sections.garantia),
      vencimento: firstSentence(sections.vencimento, 90),
      imovel: extractImovel(sections),
      titulo: cancelado && !sections.titulo
        ? 'Registro cancelado'
        : averbacao && !sections.titulo
          ? 'Averbação do Registro Auxiliar nº ' + entry.number
          : titulo,
      ato: cancelado ? 'Cancelamento' : averbacao ? 'Averbação' : extractAto(entry),
      averbacao,
      cancelado
    };
  }

  /* ------------------------------------------------------------------ *
   *  Consulta ao sistema (Inertia)
   * ------------------------------------------------------------------ */

  function getInertiaVersion() {
    try {
      if (history.state && history.state.page && history.state.page.version) {
        return String(history.state.page.version);
      }
    } catch (error) { /* ignore */ }

    try {
      const script = document.querySelector('script[data-page="app"]');
      if (script) {
        const page = JSON.parse(script.textContent || '{}');
        if (page.version) return String(page.version);
      }
    } catch (error) { /* ignore */ }

    return '';
  }

  function normalizePayload(payload) {
    const props = (payload && payload.props) || {};
    const entries = props.entries || {};
    const data = Array.isArray(entries.data) ? entries.data : [];
    return {
      data,
      meta: entries.meta || {},
      filters: props.filters || {},
      payload
    };
  }

  function buildUrl(query, page) {
    const url = new URL(BASE_URL);
    if (query && query.registry) url.searchParams.set('registry', query.registry);
    if (query && query.q) url.searchParams.set('q', query.q);
    if (page && page > 1) url.searchParams.set('page', String(page));
    return url.toString();
  }

  function cacheKey(query, page) {
    return [query && query.registry || '', query && query.q || '', page || 1].join('|');
  }

  async function fetchPage(query, page, signal) {
    const key = cacheKey(query, page);
    if (state.cache.has(key)) return state.cache.get(key);

    const url = buildUrl(query, page);
    const version = getInertiaVersion();
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html, application/xhtml+xml'
    };

    if (version) {
      headers['X-Inertia'] = 'true';
      headers['X-Inertia-Version'] = version;
      headers['X-Inertia-Except-Once-Props'] = 'auth,search,analytics_context,chat,menu,drafts_max_terms';
    }

    let response;
    try {
      response = await fetch(url, {
        headers,
        credentials: 'same-origin',
        signal
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new Error('Falha de rede ao consultar o NoCartório. Verifique sua conexão e tente novamente.');
    }

    if (response.status === 409) {
      // Versão do bundle mudou: tenta novamente como navegação normal.
      response = await fetch(url, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, application/xhtml+xml'
        },
        credentials: 'same-origin',
        signal
      });
    }

    if (response.redirected && /\/login\b/i.test(response.url)) {
      throw new Error('Sua sessão parece ter expirado. Recarregue a página, faça login e tente novamente.');
    }

    if (!response.ok) {
      throw new Error('O sistema respondeu com o status ' + response.status + '. Tente novamente em alguns instantes.');
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const normalized = normalizePayload(payload);
      state.cache.set(key, normalized);
      return normalized;
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const script = doc.querySelector('script[data-page="app"]');
    if (!script) {
      if (doc.querySelector('input[type="password"]') || /login/i.test(doc.title || '')) {
        throw new Error('Sua sessão parece ter expirado. Recarregue a página, faça login e tente novamente.');
      }
      throw new Error('Não foi possível interpretar a resposta do sistema. Recarregue a página e tente novamente.');
    }

    let payload;
    try {
      payload = JSON.parse(script.textContent || '{}');
    } catch (error) {
      throw new Error('A resposta do sistema veio em um formato inesperado. Recarregue a página e tente novamente.');
    }

    const normalized = normalizePayload(payload);
    state.cache.set(key, normalized);
    return normalized;
  }

  /* ------------------------------------------------------------------ *
   *  Montagem da consulta
   * ------------------------------------------------------------------ */

  function readFormValues() {
    if (!form) return { nome: '', doc: '', produto: '', safra: '', registro: '', titulo: '' };
    const elements = form.elements;
    return {
      nome: (elements.nome.value || '').trim(),
      doc: (elements.doc.value || '').trim(),
      produto: (elements.produto.value || '').trim(),
      safra: (elements.safra.value || '').trim(),
      registro: onlyDigits(elements.registro.value),
      titulo: (elements.titulo.value || '').trim()
    };
  }

  function composeQuery(values) {
    const terms = [];
    if (values.nome) terms.push(values.nome);
    if (values.doc) terms.push(onlyDigits(values.doc) || values.doc);
    if (values.produto) terms.push(values.produto);
    if (values.safra) terms.push(normalizeSafra(values.safra));
    if (values.titulo) terms.push(values.titulo);

    return {
      q: terms.join(' ').replace(/\s+/g, ' ').trim(),
      registry: values.registro || ''
    };
  }

  function nativeUrlFor(query) {
    const url = new URL(BASE_URL);
    if (query.registry) url.searchParams.set('registry', query.registry);
    if (query.q) url.searchParams.set('q', query.q);
    return url.toString();
  }

  /* ------------------------------------------------------------------ *
   *  Conferência dos campos extraídos
   * ------------------------------------------------------------------ */

  function checkField(label, fieldHaystack, term, fullText, useWordBoundary) {
    if (!term) return null;
    const matcher = useWordBoundary ? includesAllWords : includesAll;
    const fieldMatch = matcher(fieldHaystack, term);
    const textMatch = matcher(fullText, term);
    return {
      label,
      state: fieldMatch ? 'ok' : textMatch ? 'warn' : 'miss'
    };
  }

  function computeChecks(fields, parsed) {
    if (!fields) return [];
    const checks = [];
    const partyNames = parsed.parties.map((party) => party.name).join(' | ');
    const partyDocs = parsed.parties
      .flatMap((party) => party.docs.map((doc) => doc.value + ' ' + doc.digits))
      .join(' | ');

    const nome = checkField('Nome', partyNames, fields.nome, parsed.text, false);
    if (nome) checks.push(nome);

    const doc = checkField('CPF/CNPJ', partyDocs, fields.doc, parsed.text, false);
    if (doc) checks.push(doc);

    const produto = checkField('Produto', parsed.produto.join(' | '), fields.produto, parsed.text, true);
    if (produto) checks.push(produto);

    const safra = checkField('Safra', parsed.safras.join(' | '), normalizeSafra(fields.safra), parsed.text, true);
    if (safra) checks.push(safra);

    if (fields.registro) {
      checks.push({
        label: 'Nº',
        state: String(parsed.entry.number) === String(fields.registro) ? 'ok' : 'miss'
      });
    }

    const titulo = checkField('Título', (parsed.titulo || '') + ' | ' + (parsed.ato || ''), fields.titulo, parsed.text, true);
    if (titulo) checks.push(titulo);

    return checks;
  }

  function checkTitle(check) {
    if (check.state === 'ok') return 'Encontrado no campo extraído';
    if (check.state === 'warn') return 'Encontrado no texto do registro, mas não no campo extraído';
    return 'Não localizado na extração automática';
  }

  /* ------------------------------------------------------------------ *
   *  Destaques e trechos
   * ------------------------------------------------------------------ */

  function buildHighlightTokens(fields) {
    if (!fields) return [];
    const raw = [];
    if (fields.nome) raw.push(fields.nome);
    if (fields.produto) raw.push(fields.produto);
    if (fields.titulo) raw.push(fields.titulo);
    if (fields.safra) raw.push(normalizeSafra(fields.safra));
    if (fields.registro) raw.push(fields.registro);

    if (fields.doc) {
      const digits = onlyDigits(fields.doc);
      raw.push(digits);
      if (digits.length === 11) raw.push(formatCpf(digits));
      if (digits.length === 14) raw.push(formatCnpj(digits));
    }

    const stopWords = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'a', 'o']);
    const tokens = [];
    const seen = new Set();
    raw.forEach((value) => {
      String(value || '').split(/\s+/).forEach((token) => {
        const cleaned = token.trim();
        if (cleaned.length < 3) return;
        if (stopWords.has(cleaned.toLowerCase())) return;
        if (!/^[\p{L}\p{N}.\/-]+$/u.test(cleaned)) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        tokens.push(cleaned);
      });
    });

    return tokens.sort((a, b) => b.length - a.length);
  }

  function highlight(value, tokens) {
    const safe = esc(value);
    if (!tokens || tokens.length === 0) return safe;
    try {
      const regex = new RegExp('(' + tokens.map(escapeRegExp).join('|') + ')', 'gi');
      return safe.replace(regex, '<mark>$1</mark>');
    } catch (error) {
      return safe;
    }
  }

  function buildSnippet(text, tokens) {
    if (!text) return '';
    let index = -1;
    for (const token of tokens) {
      const lower = text.toLowerCase();
      const tokenLower = token.toLowerCase();
      const at = lower.indexOf(tokenLower);
      if (at >= 0 && (index < 0 || at < index)) index = at;
    }

    if (index < 0) return text.slice(0, 260) + (text.length > 260 ? '…' : '');
    const start = Math.max(0, index - 110);
    const end = Math.min(text.length, index + 210);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }

  /* ------------------------------------------------------------------ *
   *  Interface
   * ------------------------------------------------------------------ */

  const STYLES = `
    :host { font-family: inherit; }
    .nc3-root, .nc3-root * { box-sizing: border-box; }
    .nc3-root {
      position: fixed; inset: 0; z-index: 2147483000;
      font-family: inherit; font-size: 14px; line-height: 1.45;
      color: var(--foreground, #111827);
      -webkit-font-smoothing: antialiased;
    }
    .nc3-backdrop {
      position: absolute; inset: 0;
      background: rgba(15, 23, 42, .55);
      backdrop-filter: blur(2px);
    }
    .nc3-dialog {
      position: absolute; inset: 2.5vh 2.5vw;
      max-width: 1180px; margin: 0 auto;
      display: flex; flex-direction: column;
      background: var(--background, #ffffff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 14px;
      box-shadow: 0 25px 90px rgba(0, 0, 0, .38);
      overflow: hidden;
    }
    .nc3-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 16px 20px;
      border-bottom: 1px solid var(--border, #e5e7eb);
      background: var(--card, #ffffff);
    }
    .nc3-kicker {
      font-size: 11px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: var(--primary, #2563eb);
      margin-bottom: 2px;
    }
    .nc3-head h2 {
      margin: 0; font-size: 21px; line-height: 1.2;
      font-weight: 700; letter-spacing: -.02em;
    }
    .nc3-sub {
      margin: 4px 0 0; font-size: 12.5px;
      color: var(--muted-foreground, #64748b);
      max-width: 760px;
    }
    .nc3-icon {
      flex: 0 0 auto; width: 34px; height: 34px;
      border-radius: 8px; border: 1px solid transparent;
      background: transparent; color: inherit; cursor: pointer;
      font-size: 16px; line-height: 1;
    }
    .nc3-icon:hover { background: var(--accent, #f1f5f9); }
    .nc3-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .nc3-form {
      padding: 14px 20px 12px;
      border-bottom: 1px solid var(--border, #e5e7eb);
      background: var(--muted, #f8fafc);
    }
    .nc3-grid {
      display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
    }
    .nc3-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .nc3-field > span {
      font-size: 10.5px; font-weight: 700; letter-spacing: .05em;
      text-transform: uppercase; color: var(--muted-foreground, #64748b);
    }
    .nc3-field input {
      width: 100%; height: 36px; padding: 0 10px;
      border: 1px solid var(--border, #d1d5db);
      border-radius: 8px;
      background: var(--background, #ffffff);
      color: var(--foreground, #111827);
      font: inherit; font-size: 13.5px;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .nc3-field input:focus {
      border-color: var(--ring, #3b82f6);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring, #3b82f6) 18%, transparent);
    }
    .nc3-field input::placeholder { color: var(--muted-foreground, #94a3b8); }
    .nc3-nome { grid-column: span 3; }
    .nc3-doc { grid-column: span 2; }
    .nc3-num { grid-column: span 1; }
    .nc3-prod { grid-column: span 2; }
    .nc3-safra { grid-column: span 1; }
    .nc3-titulo { grid-column: span 3; }
    .nc3-actions {
      display: flex; flex-wrap: wrap; align-items: center;
      gap: 8px; margin-top: 11px;
    }
    .nc3-btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; height: 34px; padding: 0 12px;
      border-radius: 8px; border: 1px solid var(--border, #d1d5db);
      background: var(--background, #ffffff);
      color: var(--foreground, #111827);
      font: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer; text-decoration: none; white-space: nowrap;
      transition: background .15s ease, border-color .15s ease, opacity .15s ease;
    }
    .nc3-btn:hover { background: var(--accent, #f1f5f9); }
    .nc3-btn:disabled { opacity: .45; cursor: not-allowed; }
    .nc3-primary {
      background: var(--primary, #2563eb);
      border-color: var(--primary, #2563eb);
      color: var(--primary-foreground, #ffffff);
    }
    .nc3-primary:hover { filter: brightness(.96); background: var(--primary, #2563eb); }
    .nc3-ghost { background: transparent; }
    .nc3-ghost:hover { background: var(--accent, #f1f5f9); }
    .nc3-hint { margin-left: auto; font-size: 11.5px; color: var(--muted-foreground, #64748b); }
    .nc3-toggle {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--muted-foreground, #64748b);
      cursor: pointer; user-select: none;
    }
    .nc3-toggle input {
      width: 14px; height: 14px; margin: 0;
      accent-color: var(--primary, #2563eb);
    }
    .nc3-query {
      margin-top: 10px; padding: 7px 10px;
      border: 1px dashed var(--border, #cbd5e1);
      border-radius: 8px; background: var(--background, #ffffff);
      font-size: 11.5px; color: var(--muted-foreground, #64748b);
      word-break: break-word;
    }
    .nc3-query code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--foreground, #111827); font-size: 11.5px;
    }
    .nc3-results {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 14px 20px 26px;
      background: var(--background, #ffffff);
      scrollbar-gutter: stable;
    }
    .nc3-summary {
      display: flex; flex-wrap: wrap; align-items: center;
      gap: 8px 16px; margin-bottom: 12px;
      font-size: 13.5px;
    }
    .nc3-summary strong { font-size: 16px; }
    .nc3-summary-sub { color: var(--muted-foreground, #64748b); font-size: 12.5px; }
    .nc3-summary-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
    .nc3-cards { display: flex; flex-direction: column; gap: 10px; }
    .nc3-group-note {
      margin: 4px 0 2px; padding-top: 9px;
      border-top: 1px dashed var(--border, #cbd5e1);
      font-size: 12px; color: var(--muted-foreground, #64748b);
    }
    .nc3-card {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px;
      background: var(--card, #ffffff);
      padding: 13px 15px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
    }
    .nc3-card-head {
      display: flex; flex-wrap: wrap; align-items: center;
      gap: 6px 10px; margin-bottom: 6px;
    }
    .nc3-badge {
      display: inline-flex; align-items: center; height: 22px;
      padding: 0 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--primary, #2563eb) 12%, transparent);
      color: var(--primary, #2563eb);
      font-size: 11.5px; font-weight: 800; letter-spacing: .02em;
    }
    .nc3-status {
      display: inline-flex; align-items: center; height: 22px;
      padding: 0 8px; border-radius: 999px;
      background: #fee2e2; color: #991b1b;
      font-size: 11px; font-weight: 800;
    }
    .nc3-status-info { background: #dbeafe; color: #1e40af; }
    .nc3-date, .nc3-ato {
      font-size: 12px; color: var(--muted-foreground, #64748b);
    }
    .nc3-links { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
    .nc3-links a {
      font-size: 12px; font-weight: 600; color: var(--primary, #2563eb);
      text-decoration: none; padding: 3px 7px; border-radius: 6px;
    }
    .nc3-links a:hover { background: var(--accent, #f1f5f9); text-decoration: underline; }
    .nc3-card-title {
      margin: 2px 0 7px; font-size: 15px; font-weight: 700;
      letter-spacing: -.01em; line-height: 1.3;
    }
    .nc3-card-title a { color: inherit; text-decoration: none; }
    .nc3-card-title a:hover { text-decoration: underline; }
    .nc3-parties { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
    .nc3-party { font-size: 12.5px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; }
    .nc3-role {
      font-size: 10.5px; font-weight: 800; letter-spacing: .04em;
      text-transform: uppercase; color: var(--muted-foreground, #64748b);
      min-width: 88px;
    }
    .nc3-pname { font-weight: 650; }
    .nc3-doc {
      font-size: 11.5px; color: var(--muted-foreground, #64748b);
      background: var(--muted, #f1f5f9); padding: 1px 6px; border-radius: 5px;
    }
    .nc3-avalistas {
      margin-top: 4px; padding-top: 5px;
      border-top: 1px dashed var(--border, #e5e7eb);
    }
    .nc3-avalistas summary {
      cursor: pointer; font-size: 10.5px; font-weight: 800;
      letter-spacing: .04em; text-transform: uppercase;
      color: var(--muted-foreground, #64748b);
    }
    .nc3-avalistas[open] summary { margin-bottom: 4px; }
    .nc3-avalistas .nc3-party { margin-top: 2px; }
    .nc3-facts {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px 12px; margin-top: 6px;
    }
    .nc3-fact { font-size: 12.5px; min-width: 0; }
    .nc3-fact > span {
      display: block; font-size: 10px; font-weight: 800; letter-spacing: .05em;
      text-transform: uppercase; color: var(--muted-foreground, #64748b);
      margin-bottom: 1px;
    }
    .nc3-fact > div { overflow-wrap: anywhere; }
    .nc3-checks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .nc3-check {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10.5px; font-weight: 700; padding: 2px 7px;
      border-radius: 999px; border: 1px solid transparent;
    }
    .nc3-check.ok { background: #dcfce7; color: #166534; }
    .nc3-check.warn { background: #fef3c7; color: #92400e; }
    .nc3-check.miss { background: #fee2e2; color: #991b1b; }
    .nc3-snippet {
      margin: 8px 0 0; padding: 7px 9px;
      border-radius: 7px; background: var(--muted, #f8fafc);
      border: 1px solid var(--border, #e5e7eb);
      font-size: 11.5px; line-height: 1.45;
      color: var(--muted-foreground, #475569);
      overflow-wrap: anywhere;
    }
    .nc3-snippet mark, .nc3-card mark {
      background: #fde047; color: #111827;
      padding: 0 1px; border-radius: 2px;
    }
    .nc3-card-foot {
      margin-top: 7px; font-size: 10.5px;
      color: var(--muted-foreground, #94a3b8);
    }
    .nc3-pager {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
      gap: 6px; margin: 12px 0;
    }
    .nc3-pager .nc3-btn { height: 30px; font-size: 12px; padding: 0 9px; }
    .nc3-pager span { font-size: 12px; color: var(--muted-foreground, #64748b); }
    .nc3-page-input {
      width: 56px; height: 28px; text-align: center;
      border: 1px solid var(--border, #d1d5db); border-radius: 6px;
      background: var(--background, #ffffff); color: inherit;
      font: inherit; font-size: 12px;
    }
    .nc3-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; text-align: center;
      padding: 44px 18px; color: var(--muted-foreground, #64748b);
    }
    .nc3-empty-icon {
      width: 44px; height: 44px; display: grid; place-items: center;
      border-radius: 50%; background: var(--muted, #f1f5f9);
      font-size: 22px; margin-bottom: 9px;
    }
    .nc3-empty h3 { margin: 0 0 4px; font-size: 15px; color: var(--foreground, #111827); }
    .nc3-empty p { margin: 0; max-width: 520px; font-size: 12.5px; }
    .nc3-empty .nc3-btn { margin-top: 12px; }
    .nc3-loading {
      display: flex; align-items: center; justify-content: center;
      gap: 10px; padding: 52px 20px;
      color: var(--muted-foreground, #64748b); font-size: 13px;
    }
    .nc3-spinner {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid var(--border, #cbd5e1);
      border-top-color: var(--primary, #2563eb);
      animation: nc3-spin .75s linear infinite;
    }
    @keyframes nc3-spin { to { transform: rotate(360deg); } }
    .nc3-error .nc3-empty-icon { background: #fee2e2; color: #991b1b; font-weight: 800; }
    @media (max-width: 900px) {
      .nc3-dialog { inset: 0; border-radius: 0; max-width: none; }
      .nc3-grid { grid-template-columns: 1fr 1fr; }
      .nc3-nome, .nc3-doc, .nc3-num, .nc3-prod, .nc3-safra, .nc3-titulo { grid-column: span 2; }
      .nc3-facts { grid-template-columns: 1fr 1fr; }
      .nc3-hint { width: 100%; margin-left: 0; }
    }
    @media (prefers-color-scheme: dark) {
      .nc3-check.ok { background: #14532d; color: #bbf7d0; }
      .nc3-check.warn { background: #78350f; color: #fde68a; }
      .nc3-check.miss, .nc3-status { background: #7f1d1d; color: #fecaca; }
      .nc3-status-info { background: #1e3a8a; color: #dbeafe; }
      .nc3-snippet mark, .nc3-card mark { background: #a16207; color: #ffffff; }
    }
  `;

  const MODAL_HTML = `
    <div class="nc3-root" part="root">
      <div class="nc3-backdrop" data-nc3-close></div>
      <div class="nc3-dialog" role="dialog" aria-modal="true" aria-labelledby="nc3-title">
        <header class="nc3-head">
          <div>
            <div class="nc3-kicker">Livro 3 · Registro Auxiliar</div>
            <h2 id="nc3-title">Busca avançada</h2>
            <p class="nc3-sub">
              Combine nome, CPF/CNPJ, produto, safra e número do registro. Os termos são combinados com <strong>E</strong> (todos precisam aparecer) e a busca consulta o texto integral dos registros. A busca avançada é independente dos filtros da barra do sistema.
            </p>
          </div>
          <button type="button" class="nc3-icon" data-nc3-close aria-label="Fechar (Esc)">✕</button>
        </header>
        <div class="nc3-body">
          <form class="nc3-form" id="nc3-form" autocomplete="off">
            <div class="nc3-grid">
              <label class="nc3-field nc3-nome">
                <span>Nome / razão social</span>
                <input name="nome" type="text" placeholder="Ex.: RAFAEL AMORIM DA SILVA" spellcheck="false">
              </label>
              <label class="nc3-field nc3-doc">
                <span>CPF / CNPJ</span>
                <input name="doc" type="text" inputmode="numeric" placeholder="000.000.000-00" spellcheck="false">
              </label>
              <label class="nc3-field nc3-num">
                <span>Nº do registro</span>
                <input name="registro" type="text" inputmode="numeric" placeholder="Ex.: 6950" spellcheck="false">
              </label>
              <label class="nc3-field nc3-prod">
                <span>Produto</span>
                <input name="produto" type="text" list="nc3-produtos" placeholder="Ex.: SOJA, MILHO" spellcheck="false" title="O sistema busca o termo no texto integral; variantes como 'milhões' podem aparecer. Use o filtro de correspondência nos campos para conferir.">
              </label>
              <label class="nc3-field nc3-safra">
                <span>Safra</span>
                <input name="safra" type="text" list="nc3-safras" placeholder="Ex.: 2026/2027" spellcheck="false">
              </label>
              <label class="nc3-field nc3-titulo">
                <span>Título / tipo de ato</span>
                <input name="titulo" type="text" placeholder="Ex.: Cédula de Produto Rural" spellcheck="false">
              </label>
            </div>
            <datalist id="nc3-produtos">${PRODUCT_SUGGESTIONS.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
            <datalist id="nc3-safras">${buildSafraSuggestions().map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
            <div class="nc3-actions">
              <button type="submit" class="nc3-btn nc3-primary">Buscar</button>
              <button type="button" class="nc3-btn nc3-ghost" data-nc3-clear>Limpar</button>
              <button type="button" class="nc3-btn nc3-ghost" data-nc3-native>Abrir na lista do sistema</button>
              <label class="nc3-toggle" title="O sistema busca no texto integral; este filtro confere os campos extraídos apenas na página atual.">
                <input type="checkbox" name="strict">
                <span>Só correspondências nos campos (nesta página)</span>
              </label>
              <span class="nc3-hint">Enter busca · Alt+B abre/fecha</span>
            </div>
            <div class="nc3-query" hidden></div>
          </form>
          <div class="nc3-results" id="nc3-results" aria-live="polite">
            <div class="nc3-empty">
              <div class="nc3-empty-icon">⌕</div>
              <h3>Comece a busca</h3>
              <p>Preencha um ou mais campos. Deixe tudo em branco para ver os registros mais recentes.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  function buildSafraSuggestions() {
    const current = new Date().getFullYear();
    const values = [];
    for (let year = current - 4; year <= current + 10; year += 1) {
      values.push(year + '/' + (year + 1));
    }
    return values;
  }

  function ensureLauncherStyle() {
    if (document.getElementById('nc3-launcher-style')) return;
    const style = document.createElement('style');
    style.id = 'nc3-launcher-style';
    style.textContent = `
      #nc3-launcher {
        display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; height: 36px; padding: 0 12px;
        border-radius: 8px; border: 1px solid var(--border, #d1d5db);
        background: var(--background, #ffffff);
        color: var(--foreground, #111827);
        font: inherit; font-size: 13px; font-weight: 650;
        cursor: pointer; white-space: nowrap;
        transition: background .15s ease, border-color .15s ease;
      }
      #nc3-launcher:hover { background: var(--accent, #f1f5f9); }
      #nc3-launcher svg { width: 14px; height: 14px; flex: 0 0 auto; }
      @media (max-width: 640px) { #nc3-launcher span { display: none; } }
    `;
    document.head.appendChild(style);
  }

  function injectLauncher() {
    if (!isListPage()) return;
    if (document.getElementById('nc3-launcher')) return;

    const section = document.querySelector('section[aria-label^="Filtros"]');
    if (!section) return;

    ensureLauncherStyle();

    const button = document.createElement('button');
    button.id = 'nc3-launcher';
    button.type = 'button';
    button.title = 'Busca avançada no Livro 3 (Alt+B)';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle>
        <path d="m21 21-4.35-4.35"></path>
        <path d="M11 8v6"></path>
        <path d="M8 11h6"></path>
      </svg>
      <span>Busca avançada</span>
    `;
    button.addEventListener('click', () => openDialog());

    const buttons = Array.from(section.querySelectorAll('button'));
    const buscar = buttons.find((item) => /^buscar$/i.test((item.textContent || '').trim()));
    if (buscar && buscar.parentElement) buscar.parentElement.appendChild(button);
    else section.appendChild(button);
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    if (host && !host.isConnected) {
      host = null;
      shadow = null;
      form = null;
      resultsEl = null;
    }

    host = document.createElement('div');
    host.id = 'nc3-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;';
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + STYLES + '</style>' + MODAL_HTML;

    form = shadow.querySelector('#nc3-form');
    resultsEl = shadow.querySelector('#nc3-results');

    bindUiEvents();
    restoreForm();
  }

  function bindUiEvents() {
    shadow.addEventListener('click', (event) => {
      const close = event.target.closest('[data-nc3-close]');
      if (close) {
        event.preventDefault();
        closeDialog();
        return;
      }

      const clear = event.target.closest('[data-nc3-clear]');
      if (clear) {
        event.preventDefault();
        clearForm();
        return;
      }

      const nativeButton = event.target.closest('[data-nc3-native]');
      if (nativeButton) {
        event.preventDefault();
        openNativeList();
        return;
      }

      const pageButton = event.target.closest('[data-nc3-page]');
      if (pageButton) {
        event.preventDefault();
        goToPage(Number(pageButton.dataset.nc3Page));
        return;
      }

      const exportButton = event.target.closest('[data-nc3-export]');
      if (exportButton) {
        event.preventDefault();
        exportCsv();
        return;
      }

      const retryButton = event.target.closest('[data-nc3-retry]');
      if (retryButton) {
        event.preventDefault();
        if (state.query) executeSearch(state.query, state.fields, state.page);
        else runSearch(1);
        return;
      }

      const strictOff = event.target.closest('[data-nc3-strict-off]');
      if (strictOff) {
        event.preventDefault();
        state.strict = false;
        const input = form.elements.strict;
        if (input) input.checked = false;
        renderResults();
      }
    });

    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('.nc3-page-input')) {
        event.preventDefault();
        goToPage(Number(event.target.value));
      }
    });

    shadow.addEventListener('change', (event) => {
      if (event.target.matches('.nc3-page-input')) {
        goToPage(Number(event.target.value));
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      runSearch(1);
    });

    form.addEventListener('input', () => {
      scheduleFormSave();
    });

    form.addEventListener('change', (event) => {
      if (event.target.matches('input[name="strict"]')) {
        state.strict = event.target.checked;
        if (state.result) renderResults();
      }
    });
  }

  function bindGlobalEvents() {
    document.addEventListener('keydown', (event) => {
      if (event.altKey && (event.key === 'b' || event.key === 'B')) {
        if (!isListPage()) return;
        event.preventDefault();
        if (state.open) closeDialog();
        else openDialog();
        return;
      }
      if (event.key === 'Escape' && state.open) {
        event.preventDefault();
        closeDialog();
      }
    });

    document.addEventListener('popstate', () => {
      if (location.pathname !== state.lastPath) {
        state.lastPath = location.pathname;
        if (!isListPage() && state.open) closeDialog();
        scheduleLauncherCheck();
      }
    });
  }

  function openDialog() {
    if (!isListPage()) return;
    ensureHost();
    host.style.display = 'block';
    state.open = true;
    requestFrame(() => {
      const first = shadow.querySelector('input[name="nome"]');
      if (first) first.focus();
    });
  }

  function closeDialog() {
    if (!host) return;
    host.style.display = 'none';
    state.open = false;
  }

  /* ------------------------------------------------------------------ *
   *  Formulário
   * ------------------------------------------------------------------ */

  let formSaveTimer = null;

  function scheduleFormSave() {
    if (formSaveTimer) clearTimeout(formSaveTimer);
    formSaveTimer = setTimeout(() => {
      formSaveTimer = null;
      saveForm(readFormValues());
    }, 350);
  }

  function saveForm(values) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ ...values, savedAt: Date.now() }));
    } catch (error) { /* ignore */ }
  }

  function restoreForm() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch (error) { /* ignore */ }

    if (!saved) return;

    ['nome', 'doc', 'produto', 'safra', 'registro', 'titulo'].forEach((key) => {
      const input = form.elements[key];
      if (input && typeof saved[key] === 'string') input.value = saved[key];
    });
  }

  function clearForm() {
    if (formSaveTimer) {
      clearTimeout(formSaveTimer);
      formSaveTimer = null;
    }
    try { localStorage.removeItem(LS_KEY); } catch (error) { /* ignore */ }
    form.reset();
    state.strict = false;
    state.query = null;
    state.fields = null;
    state.result = null;
    state.parsed = null;
    state.page = 1;
    state.error = null;
    updateQueryDisplay(null);
    renderStart();
    const first = shadow.querySelector('input[name="nome"]');
    if (first) first.focus();
  }

  function openNativeList() {
    const values = readFormValues();
    const query = composeQuery(values);
    window.location.assign(nativeUrlFor(query));
  }

  /* ------------------------------------------------------------------ *
   *  Execução da busca
   * ------------------------------------------------------------------ */

  function runSearch(page) {
    const values = readFormValues();
    const query = composeQuery(values);
    state.fields = values;
    executeSearch(query, values, page || 1);
  }

  async function executeSearch(query, fields, page) {
    if (!query) return;

    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;

    state.query = query;
    state.fields = fields;
    state.loading = true;
    state.error = null;
    state.page = page || 1;

    updateQueryDisplay(query);
    renderLoading();

    try {
      const result = await fetchPage(query, page || 1, controller.signal);
      if (controller.signal.aborted) return;

      state.result = result;
      state.parsed = result.data.map(parseEntry);
      state.page = Number(result.meta && result.meta.current_page) || page || 1;
      state.loading = false;
      state.error = null;
      saveForm(fields);
      renderResults();
      updateDatalistsFromResults(state.parsed);
      if (resultsEl) resultsEl.scrollTop = 0;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      state.loading = false;
      state.error = error instanceof Error ? error : new Error(String(error));
      renderError();
    }
  }

  function goToPage(page) {
    if (!state.query || !Number.isFinite(page)) return;
    const last = Number(state.result && state.result.meta && state.result.meta.last_page) || 1;
    const target = Math.min(Math.max(1, Math.trunc(page)), last);
    if (target === state.page) return;
    executeSearch(state.query, state.fields, target);
  }

  function updateQueryDisplay(query) {
    if (!shadow) return;
    const box = shadow.querySelector('.nc3-query');
    if (!box) return;
    if (!query || (!query.q && !query.registry)) {
      box.hidden = true;
      box.textContent = '';
      return;
    }

    const parts = [];
    if (query.registry) parts.push('registro = ' + query.registry);
    if (query.q) parts.push('texto = "' + query.q + '"');
    box.hidden = false;
    box.innerHTML = '<span>Consulta enviada ao sistema:</span> <code>' + esc(parts.join(' · ')) + '</code>';
  }

  function updateDatalistsFromResults(parsed) {
    if (!shadow || !parsed || parsed.length === 0) return;
    const productList = shadow.querySelector('#nc3-produtos');
    const safraList = shadow.querySelector('#nc3-safras');

    if (productList) {
      const existing = new Set(Array.from(productList.options).map((option) => normKey(option.value)));
      parsed.forEach((item) => item.produto.forEach((product) => {
        const key = normKey(product);
        if (key && !existing.has(key)) {
          existing.add(key);
          const option = document.createElement('option');
          option.value = product;
          productList.appendChild(option);
        }
      }));
    }

    if (safraList) {
      const existing = new Set(Array.from(safraList.options).map((option) => option.value));
      parsed.forEach((item) => item.safras.forEach((safra) => {
        if (!existing.has(safra)) {
          existing.add(safra);
          const option = document.createElement('option');
          option.value = safra;
          safraList.appendChild(option);
        }
      }));
    }
  }

  /* ------------------------------------------------------------------ *
   *  Renderização
   * ------------------------------------------------------------------ */

  function renderStart() {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="nc3-empty">
        <div class="nc3-empty-icon">⌕</div>
        <h3>Comece a busca</h3>
        <p>Preencha um ou mais campos. Deixe tudo em branco para ver os registros mais recentes.</p>
      </div>
    `;
  }

  function renderLoading() {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="nc3-loading">
        <span class="nc3-spinner"></span>
        Consultando o Livro 3…
      </div>
    `;
  }

  function renderError() {
    if (!resultsEl) return;
    const message = (state.error && state.error.message) || 'Erro inesperado.';
    resultsEl.innerHTML = `
      <div class="nc3-empty nc3-error">
        <div class="nc3-empty-icon">!</div>
        <h3>Não foi possível consultar</h3>
        <p>${esc(message)}</p>
        <button type="button" class="nc3-btn nc3-primary" data-nc3-retry>Tentar novamente</button>
      </div>
    `;
  }

  function renderResults() {
    if (!resultsEl) return;

    if (!state.result) {
      renderStart();
      return;
    }

    const meta = state.result.meta || {};
    const parsed = state.parsed || [];
    const total = Number(meta.total) || 0;

    if (parsed.length === 0 || total === 0) {
      resultsEl.innerHTML = `
        <div class="nc3-empty">
          <div class="nc3-empty-icon">∅</div>
          <h3>Nenhum registro encontrado</h3>
          <p>Tente remover um dos filtros ou usar um termo mais curto. A busca do sistema é feita no texto integral do registro.</p>
          <button type="button" class="nc3-btn nc3-ghost" data-nc3-clear>Limpar filtros</button>
        </div>
      `;
      return;
    }

    const current = Number(meta.current_page) || state.page || 1;
    const last = Number(meta.last_page) || 1;
    const perPage = Number(meta.per_page) || parsed.length;
    const tokens = buildHighlightTokens(state.fields);

    const items = parsed.map((item) => ({
      item,
      checks: computeChecks(state.fields, item)
    }));
    const isExact = (checks) => checks.length === 0 || checks.every((check) => check.state === 'ok');
    const exact = items.filter((entry) => isExact(entry.checks));
    const others = items.filter((entry) => !isExact(entry.checks));

    if (state.strict && exact.length === 0) {
      resultsEl.innerHTML = `
        <div class="nc3-summary">
          <div><strong>${total.toLocaleString('pt-BR')}</strong> ${total === 1 ? 'registro encontrado' : 'registros encontrados'}</div>
          <div class="nc3-summary-sub">Página ${current} de ${last} · ${perPage} por página</div>
          <div class="nc3-summary-actions">
            <button type="button" class="nc3-btn nc3-ghost" data-nc3-export>Exportar CSV desta página</button>
            <button type="button" class="nc3-btn nc3-ghost" data-nc3-native>Abrir na lista do sistema</button>
          </div>
        </div>
        ${renderPager(meta)}
        <div class="nc3-empty">
          <div class="nc3-empty-icon">∅</div>
          <h3>Nenhuma correspondência nos campos desta página</h3>
          <p>O sistema encontrou ${total.toLocaleString('pt-BR')} registro(s), mas nenhum desta página tem o termo no campo extraído. Desative o filtro ou avance a página.</p>
          <button type="button" class="nc3-btn nc3-ghost" data-nc3-strict-off>Desativar filtro</button>
        </div>
        ${renderPager(meta)}
      `;
      return;
    }

    const exactCards = exact.map((entry) => renderCard(entry.item, tokens, entry.checks)).join('');
    const otherCards = state.strict ? '' : others.map((entry) => renderCard(entry.item, tokens, entry.checks)).join('');
    const groupNote = (!state.strict && others.length > 0)
      ? '<div class="nc3-group-note">' + (exact.length > 0 ? 'Outros resultados — ' : 'Resultados — ') + 'o termo não foi confirmado nos campos extraídos (pode ser ocorrência parcial no texto, anexo ou processo):</div>'
      : '';
    const shownInfo = state.strict
      ? `Mostrando ${exact.length} de ${parsed.length} nesta página`
      : others.length > 0
        ? `${exact.length} com correspondência nos campos · ${others.length} outro(s) nesta página`
        : '';

    const pager = renderPager(meta);

    resultsEl.innerHTML = `
      <div class="nc3-summary">
        <div><strong>${total.toLocaleString('pt-BR')}</strong> ${total === 1 ? 'registro encontrado' : 'registros encontrados'}</div>
        <div class="nc3-summary-sub">Página ${current} de ${last} · ${perPage} por página${shownInfo ? ' · ' + shownInfo : ''}</div>
        <div class="nc3-summary-actions">
          <button type="button" class="nc3-btn nc3-ghost" data-nc3-export>Exportar CSV desta página</button>
          <button type="button" class="nc3-btn nc3-ghost" data-nc3-native>Abrir na lista do sistema</button>
        </div>
      </div>
      ${pager}
      <div class="nc3-cards">${exactCards}${groupNote}${otherCards}</div>
      ${pager}
    `;
  }

  function renderPager(meta) {
    const current = Number(meta.current_page) || 1;
    const last = Number(meta.last_page) || 1;
    if (last <= 1) return '';

    return `
      <div class="nc3-pager">
        <button type="button" class="nc3-btn nc3-ghost" data-nc3-page="1" ${current <= 1 ? 'disabled' : ''}>« Primeira</button>
        <button type="button" class="nc3-btn nc3-ghost" data-nc3-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>‹ Anterior</button>
        <span>Página <input class="nc3-page-input" type="number" min="1" max="${last}" value="${current}" aria-label="Página"> de ${last}</span>
        <button type="button" class="nc3-btn nc3-ghost" data-nc3-page="${current + 1}" ${current >= last ? 'disabled' : ''}>Próxima ›</button>
        <button type="button" class="nc3-btn nc3-ghost" data-nc3-page="${last}" ${current >= last ? 'disabled' : ''}>Última »</button>
      </div>
    `;
  }

  function renderCard(item, tokens, computedChecks) {
    const entry = item.entry;
    const registryUrl = safeUrl(entry.registry_url) || (BASE_URL + '/registry/' + encodeURIComponent(entry.number));
    const documentUrl = safeUrl(entry.profile && entry.profile.url);

    const renderParty = (party) => {
      const docs = party.docs.map((doc) =>
        `<span class="nc3-doc">${esc(doc.type)} ${highlight(doc.value, tokens)}</span>`
      ).join(' ');
      return `
        <div class="nc3-party">
          <span class="nc3-role">${esc(party.role)}</span>
          <span class="nc3-pname">${highlight(party.name, tokens)}</span>
          ${docs}
        </div>
      `;
    };

    const mainParties = item.parties.filter((party) => party.role !== 'Avalista');
    const avalistas = item.parties.filter((party) => party.role === 'Avalista');
    const nameFilter = state.fields && state.fields.nome;
    const docFilter = state.fields && state.fields.doc;
    const avalistaMatches = avalistas.some((party) => {
      if (nameFilter && includesAllWords(party.name, nameFilter)) return true;
      if (docFilter && party.docs.some((doc) => doc.digits === onlyDigits(docFilter))) return true;
      return false;
    });

    const partiesHtml = (mainParties.length
      ? mainParties.map(renderParty).join('')
      : '<div class="nc3-party"><span class="nc3-role">Partes</span><span class="nc3-doc">não identificadas automaticamente</span></div>')
      + (avalistas.length
        ? `<details class="nc3-avalistas"${avalistaMatches ? ' open' : ''}>
             <summary>Avalistas (${avalistas.length})</summary>
             ${avalistas.map(renderParty).join('')}
           </details>`
        : '');

    const facts = [];
    if (item.produto.length) facts.push(renderFact('Produto', item.produto.join(' · '), tokens));
    if (item.safras.length) facts.push(renderFact('Safra', item.safras.join(' · '), tokens));
    if (item.garantia) facts.push(renderFact('Garantia', item.garantia, tokens));
    if (item.valorDivida || item.valorGarantia) {
      const values = [];
      if (item.valorDivida) values.push('Dívida: ' + item.valorDivida);
      if (item.valorGarantia) values.push('Garantia: ' + item.valorGarantia);
      facts.push(renderFact('Valor', values.join(' · '), tokens));
    }
    if (item.vencimento) facts.push(renderFact('Vencimento', item.vencimento, tokens));
    if (item.imovel && (item.imovel.nome || item.imovel.matricula)) {
      const property = [
        item.imovel.nome,
        item.imovel.matricula ? 'matrícula ' + item.imovel.matricula : ''
      ].filter(Boolean).join(' · ');
      facts.push(renderFact('Imóvel', property, tokens));
    }

    const checks = (computedChecks || computeChecks(state.fields, item))
      .map((check) => `<span class="nc3-check ${check.state}" title="${esc(checkTitle(check))}">${esc(check.label)} ${check.state === 'ok' ? '✓' : check.state === 'warn' ? '~' : '?'}</span>`)
      .join('');

    const registered = entry.registered_at || '';
    const registration = entry.registration_number || '';

    const titleText = item.titulo || item.ato || ('Registro ' + entry.number);

    return `
      <article class="nc3-card">
        <div class="nc3-card-head">
          <span class="nc3-badge">R-${esc(entry.number)}</span>
          ${item.cancelado ? '<span class="nc3-status">CANCELADO</span>' : ''}
          ${item.averbacao ? '<span class="nc3-status nc3-status-info">AVERBAÇÃO</span>' : ''}
          ${registered ? `<span class="nc3-date">${esc(registered)}</span>` : ''}
          <span class="nc3-ato">${esc(item.ato)}</span>
          <span class="nc3-links">
            <a href="${esc(registryUrl)}" target="_blank" rel="noopener noreferrer">Ver registro ↗</a>
            ${documentUrl ? `<a href="${esc(documentUrl)}" target="_blank" rel="noopener noreferrer">Documento ↗</a>` : ''}
          </span>
        </div>
        <h3 class="nc3-card-title">
          <a href="${esc(registryUrl)}" target="_blank" rel="noopener noreferrer">${highlight(titleText, tokens)}</a>
        </h3>
        <div class="nc3-parties">${partiesHtml}</div>
        ${facts.length ? `<div class="nc3-facts">${facts.join('')}</div>` : ''}
        ${checks ? `<div class="nc3-checks">${checks}</div>` : ''}
        ${item.text ? `<p class="nc3-snippet">${highlight(buildSnippet(item.text, tokens), tokens)}</p>` : ''}
        ${registration ? `<div class="nc3-card-foot">Código Nacional de Matrícula: ${esc(registration)}</div>` : ''}
      </article>
    `;
  }

  function renderFact(label, value, tokens) {
    return `
      <div class="nc3-fact">
        <span>${esc(label)}</span>
        <div>${highlight(value, tokens)}</div>
      </div>
    `;
  }

  /* ------------------------------------------------------------------ *
   *  Exportação CSV
   * ------------------------------------------------------------------ */

  function csvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    if (!state.parsed || state.parsed.length === 0) return;

    const source = state.strict
      ? state.parsed.filter((item) => {
          const checks = computeChecks(state.fields, item);
          return checks.length === 0 || checks.every((check) => check.state === 'ok');
        })
      : state.parsed;

    if (source.length === 0) return;

    const rows = [[
      'Registro', 'Data', 'Ato', 'Título', 'Partes', 'CPF/CNPJ', 'Produto', 'Safra',
      'Garantia', 'Valor', 'Vencimento', 'Imóvel', 'Código Nacional de Matrícula', 'URL'
    ]];

    source.forEach((item) => {
      const entry = item.entry;
      const parties = item.parties.map((party) => party.role + ': ' + party.name).join(' | ');
      const docs = item.parties
        .flatMap((party) => party.docs.map((doc) => doc.type + ' ' + doc.value))
        .join(' | ');
      const values = [];
      if (item.valorDivida) values.push('Dívida: ' + item.valorDivida);
      if (item.valorGarantia) values.push('Garantia: ' + item.valorGarantia);
      const property = item.imovel
        ? [item.imovel.nome, item.imovel.matricula ? 'matrícula ' + item.imovel.matricula : ''].filter(Boolean).join(' | ')
        : '';

      rows.push([
        entry.number,
        entry.registered_at || '',
        item.ato,
        item.titulo,
        parties,
        docs,
        item.produto.join(' | '),
        item.safras.join(' | '),
        item.garantia,
        values.join(' | '),
        item.vencimento,
        property,
        entry.registration_number || '',
        safeUrl(entry.registry_url) || ''
      ]);
    });

    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'livro3-busca-' + timelineStamp() + '.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ------------------------------------------------------------------ *
   *  Inicialização
   * ------------------------------------------------------------------ */

  let launcherScheduled = false;

  function scheduleLauncherCheck() {
    if (launcherScheduled) return;
    launcherScheduled = true;
    requestFrame(() => {
      launcherScheduled = false;
      if (!isListPage()) {
        const existing = document.getElementById('nc3-launcher');
        if (existing) existing.remove();
        return;
      }
      injectLauncher();
    });
  }

  function init() {
    bindGlobalEvents();

    if (isListPage()) injectLauncher();

    const observer = new MutationObserver(() => scheduleLauncherCheck());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    scheduleLauncherCheck();

    // Exponibiliza um pequeno atalho para depuração manual.
    try {
      window.__nc3BuscaAvancada = {
        version: SCRIPT_VERSION,
        open: openDialog,
        close: closeDialog,
        parseEntry,
        fetchPage,
        state
      };
    } catch (error) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
