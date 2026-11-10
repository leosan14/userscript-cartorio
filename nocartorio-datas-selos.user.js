// ==UserScript==
// @name         NoCartório — Datas dos Selos
// @namespace    https://app.nocartorio.com/
// @version      1.0.0
// @description  Exibe, abaixo de cada selo, a data/hora de protocolo e a data/hora de registro do ato.
// @author       Missão 2
// @match        https://app.nocartorio.com/admin/manager/v2/protocol/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * NoCartório — Datas dos Selos
 * ---------------------------------------------------------------------------
 * Fontes confirmadas na Missão 1 (RELATORIO_MISSAO_1_DATAS_SELOS.md):
 *
 * 1) Data de protocolo do serviço:
 *    props.protocol.data.references.registered_at
 *    (JSON Inertia da própria página; prenotação no livro de protocolo)
 *
 * 2) Data de prática/registro do ato:
 *    data[].registeredAt
 *    (GET /api/v2/protocols/{protocolId}/processes)
 *    Fallback somente quando o campo ISO estiver ausente:
 *    data[].stamp.registeredAt (mesmo evento, já formatado pelo frontend)
 *
 * Não usamos createdAt (entrada em estoque), sentAt (envio ao Tribunal),
 * initialized_at (abertura) nem qualquer data de emissão não confirmada.
 *
 * O script apenas faz GET e mantém os dados em memória. Não lê nem guarda
 * cookies, tokens, senhas ou dados pessoais.
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // =========================================================================
  // Configuração
  // =========================================================================

  const CONFIG = Object.freeze({
    // O frontend examinado apresentou as datas em UTC-3. Mantemos o mesmo
    // horário de parede do sistema ao formatar timestamps ISO com fuso.
    timeZone: 'America/Sao_Paulo',

    // Cache em memória por serviço. Não há persistência.
    cacheLimit: 24,

    // Tempos de espera e limites de proteção.
    errorCooldownMs: 60_000,
    fallbackDelayMs: 700,
    routeFallbackDelayMs: 1_200,
    maxFallbackPages: 30,
    fetchTimeoutMs: 12_000,
    fetchRetryDelayMs: 800,
    routeDebounceMs: 60,
    scanDebounceMs: 120,

    // Logs de diagnóstico. Mantido desligado para não poluir o console.
    debug: false,
  });

  const ACT_LINK_SELECTOR =
    'a[aria-label="Ver detalhes do ato do processo"], ' +
    'a[href*="/admin/manager/process/"]';

  const BOX_ATTR = 'data-ncs-dates';
  const BOX_KEY_ATTR = 'data-ncs-key';
  const BOX_PROTOCOL_ATTR = 'data-ncs-protocol';
  const BOX_SIGNATURE_ATTR = 'data-ncs-signature';

  // Marca requisições internas do fallback para o observer não as processar
  // duas vezes. O browser ignora propriedades simbólicas em RequestInit.
  const INTERNAL_FETCH = Symbol('ncsDatasSelosInternalFetch');

  // =========================================================================
  // Utilidades gerais
  // =========================================================================

  function debugLog() {
    if (!CONFIG.debug) return;
    try {
      console.log.apply(console, ['[NoCartório Datas dos Selos]'].concat(Array.from(arguments)));
    } catch (_) {
      // Ignora falhas de console.
    }
  }

  function normalizeId(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeStampNumber(value) {
    return String(value == null ? '' : value)
      .replace(/[^0-9a-z]/gi, '')
      .toLowerCase();
  }

  function toPositiveInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      return element.getClientRects().length > 0;
    } catch (_) {
      return false;
    }
  }

  function createAbortError() {
    try {
      return new DOMException('Aborted', 'AbortError');
    } catch (_) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      return error;
    }
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 20));
  }

  function delay(milliseconds, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(createAbortError());
        return;
      }

      let timer = null;

      function onAbort() {
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(createAbortError());
      }

      timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // =========================================================================
  // Datas
  // =========================================================================

  let intlDateFormatter = null;
  let intlDateFormatterFailed = false;

  function getIntlDateFormatter() {
    if (intlDateFormatter || intlDateFormatterFailed) return intlDateFormatter;
    try {
      intlDateFormatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone: CONFIG.timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch (_) {
      intlDateFormatterFailed = true;
      intlDateFormatter = null;
    }
    return intlDateFormatter;
  }

  /**
   * Converte uma data confirmada da API para "DD/MM/AAAA às HH:mm".
   *
   * - DD/MM/AAAA HH:mm:ss (stamp.registeredAt): preserva a hora já local.
   * - ISO sem fuso: preserva a hora de parede, sem inventar conversão.
   * - ISO com Z/offset: converte para o fuso configurado (UTC-3 observado).
   */
  function formatDate(value) {
    if (value == null) return null;

    const raw = String(value).trim();
    if (!raw) return null;

    // Formato já entregue pelo frontend: 10/01/2026 15:05[:00]
    const localMatch = raw.match(
      /^(\d{2})\/(\d{2})\/(\d{4})(?:[,\s]+(?:às\s+)?(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/
    );
    if (localMatch) {
      const dd = localMatch[1];
      const mm = localMatch[2];
      const yyyy = localMatch[3];
      const hh = localMatch[4];
      const min = localMatch[5];
      if (hh != null && min != null) return dd + '/' + mm + '/' + yyyy + ' às ' + hh + ':' + min;
      return dd + '/' + mm + '/' + yyyy;
    }

    // ISO sem fuso: 2026-01-10T18:05:00[.000000]
    const naiveMatch = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/
    );
    if (naiveMatch) {
      const yyyy = naiveMatch[1];
      const mm = naiveMatch[2];
      const dd = naiveMatch[3];
      const hh = naiveMatch[4];
      const min = naiveMatch[5];
      if (hh != null && min != null) return dd + '/' + mm + '/' + yyyy + ' às ' + hh + ':' + min;
      return dd + '/' + mm + '/' + yyyy;
    }

    // ISO com fuso: 2026-01-10T18:05:00.000000Z
    // Trunca frações de segundo com mais de 3 dígitos para compatibilidade.
    const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return null;

    const formatter = getIntlDateFormatter();
    if (formatter) {
      try {
        const parts = formatter.formatToParts(date);
        const pick = function (type) {
          for (let i = 0; i < parts.length; i++) {
            if (parts[i].type === type) return parts[i].value;
          }
          return '';
        };

        const dd = pick('day');
        const mm = pick('month');
        const yyyy = pick('year');
        const hh = pick('hour');
        const min = pick('minute');

        if (dd && mm && yyyy && hh && min) {
          return dd + '/' + mm + '/' + yyyy + ' às ' + hh + ':' + min;
        }
      } catch (_) {
        // Usa o fallback local abaixo.
      }
    }

    const pad = function (number) {
      return String(number).padStart(2, '0');
    };
    return (
      pad(date.getDate()) +
      '/' +
      pad(date.getMonth() + 1) +
      '/' +
      date.getFullYear() +
      ' às ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  }

  // =========================================================================
  // Localização da página e do JSON Inertia
  // =========================================================================

  function getProtocolId() {
    const match = location.pathname.match(
      /\/admin\/manager\/v2\/protocol\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
    );
    return match ? normalizeId(match[1]) : null;
  }

  function isTargetPage() {
    return location.hostname === 'app.nocartorio.com' && Boolean(getProtocolId());
  }

  function getHistoryPage() {
    try {
      const state = window.history.state;
      if (!state) return null;

      let pageState = state.page;

      // Algumas versões/ferramentas guardam o page como JSON serializado.
      if (typeof pageState === 'string') {
        try {
          pageState = JSON.parse(pageState);
        } catch (_) {
          pageState = null;
        }
      }

      if (pageState && pageState.props) return pageState;
      if (state.props) return state;
    } catch (_) {
      // history.state pode lançar em contextos restritos.
    }
    return null;
  }

  function hasHistoryState() {
    try {
      return window.history.state != null;
    } catch (_) {
      return false;
    }
  }

  /**
   * Extrai somente os dois campos que interessam do JSON Inertia.
   * O objeto completo da página não é retido.
   */
  function extractProtocolInfo(props) {
    const protocol = props && props.protocol;
    const data =
      protocol && typeof protocol === 'object'
        ? protocol.data && typeof protocol.data === 'object'
          ? protocol.data
          : protocol
        : null;

    if (!data || typeof data !== 'object') return null;

    const id = typeof data.id === 'string' ? normalizeId(data.id) : null;
    let registeredAt = null;

    const references = data.references;
    if (Array.isArray(references)) {
      // Só usa a data quando todas as referências apontam para o mesmo instante.
      // Caso contrário, evita escolher uma referência arbitrariamente.
      const dates = [];
      for (let i = 0; i < references.length; i++) {
        const reference = references[i];
        if (
          reference &&
          typeof reference.registered_at === 'string' &&
          reference.registered_at.trim()
        ) {
          dates.push(reference.registered_at);
        }
      }
      const unique = Array.from(new Set(dates));
      if (unique.length === 1) registeredAt = unique[0];
    } else if (
      references &&
      typeof references === 'object' &&
      typeof references.registered_at === 'string' &&
      references.registered_at.trim()
    ) {
      registeredAt = references.registered_at;
    }

    if (!id && !registeredAt) return null;
    return { id: id, registeredAt: registeredAt };
  }

  // Cache da leitura do <script data-page="app"> para não reprocessar o JSON
  // a cada mutação do DOM.
  let scriptInfoCache = { text: null, info: null };

  function getScriptProtocolInfo() {
    const script =
      document.querySelector('script[data-page="app"][type="application/json"]') ||
      document.querySelector('script[data-page="app"]');
    const app = !script ? document.querySelector('#app[data-page]') : null;

    const text = script
      ? script.textContent || ''
      : app
        ? app.getAttribute('data-page') || ''
        : null;

    if (text == null) return null;

    if (text !== scriptInfoCache.text) {
      scriptInfoCache.text = text;
      try {
        const page = JSON.parse(text);
        scriptInfoCache.info = extractProtocolInfo(page && page.props);
      } catch (_) {
        scriptInfoCache.info = null;
      }
    }
    return scriptInfoCache.info;
  }

  /**
   * Retorna a data de protocolo somente quando ela pertence ao serviço atual.
   * Em navegações SPA, o estado do Inertia é a fonte atual; o script inicial
   * é usado apenas na carga direta, antes de o Inertia hidratar o histórico.
   */
  function getProtocolInfo(protocolId) {
    const page = getHistoryPage();

    if (page) {
      const info = extractProtocolInfo(page.props);
      if (!info) return null;
      if (info.id && info.id !== protocolId) return null;
      if (info.id === protocolId) return info;
      // Sem id só confia na carga direta (script ou state inicial), nunca em
      // navegação SPA, para não vazar a data do serviço anterior.
      return hasHistoryState() ? null : info;
    }

    const scriptInfo = getScriptProtocolInfo();
    if (!scriptInfo) return null;
    if (scriptInfo.id) return scriptInfo.id === protocolId ? scriptInfo : null;

    // Sem id no script: confia nele apenas na carga inicial, antes de existir
    // estado do Inertia. Em navegações SPA o script pode estar desatualizado.
    return hasHistoryState() ? null : scriptInfo;
  }

  // =========================================================================
  // Cache por serviço
  // =========================================================================

  const protocolCache = new Map();

  function getOrCreateState(protocolId) {
    const existing = protocolCache.get(protocolId);
    if (existing) return existing;

    const state = {
      protocolId: protocolId,
      protocolRegisteredAt: null,
      processes: new Map(),
      loadedPages: new Set(),
      pendingPages: new Set(), // páginas cuja requisição já foi iniciada pela interface
      lastPage: null,
      nextPageUrl: null,
      status: 'idle', // idle | loading | ready | error
      promise: null,
      abortController: null,
      fallbackTimer: null,
      lastFallbackAt: 0,
      lastErrorAt: 0,
      lastUpdatedAt: 0,
      warned: false,
    };

    protocolCache.set(protocolId, state);
    evictOldStates(protocolId);
    return state;
  }

  function evictOldStates(keepId) {
    if (protocolCache.size <= CONFIG.cacheLimit) return;

    const keys = Array.from(protocolCache.keys());
    for (let i = 0; i < keys.length; i++) {
      if (protocolCache.size <= CONFIG.cacheLimit) break;
      const key = keys[i];
      if (key === keepId) continue;

      const oldState = protocolCache.get(key);
      if (oldState) {
        if (oldState.abortController) oldState.abortController.abort();
        if (oldState.fallbackTimer) {
          clearTimeout(oldState.fallbackTimer);
          oldState.fallbackTimer = null;
        }
      }
      protocolCache.delete(key);
    }
  }

  function refreshProtocolInfo(state) {
    const info = getProtocolInfo(state.protocolId);
    if (!info) return;
    if (info.id && info.id !== state.protocolId) return;
    if (info.id === state.protocolId || !info.id) {
      state.protocolRegisteredAt = info.registeredAt || null;
    }
  }

  // =========================================================================
  // Normalização da resposta de atos
  // =========================================================================

  /**
   * Mantém apenas o necessário: id do ato, registeredAt e número/data dos selos.
   * Campos como createdAt, sentAt, canceledAt, nomes e códigos são descartados.
   */
  function extractProcessRecord(item) {
    if (!item || typeof item !== 'object') return null;

    const id = typeof item.id === 'string' ? normalizeId(item.id) : null;
    if (!id) return null;

    const registeredAt =
      typeof item.registeredAt === 'string' && item.registeredAt.trim()
        ? item.registeredAt
        : null;

    const stamps = [];
    const seen = new Set();

    function addStamp(candidate) {
      if (!candidate || typeof candidate !== 'object') return;

      const number =
        candidate.number != null ? String(candidate.number).trim() : '';
      if (!number) return; // Sem número não há como associar ao DOM com segurança.

      const stampRegisteredAt =
        typeof candidate.registeredAt === 'string' && candidate.registeredAt.trim()
          ? candidate.registeredAt
          : null;

      const key = number + '\u0000' + (stampRegisteredAt || '');
      if (seen.has(key)) return;
      seen.add(key);

      stamps.push({
        number: number,
        registeredAt: stampRegisteredAt,
      });
    }

    if (Array.isArray(item.stamp)) {
      item.stamp.forEach(addStamp);
    } else {
      addStamp(item.stamp);
    }

    if (Array.isArray(item.stamps)) {
      item.stamps.forEach(addStamp);
    } else {
      addStamp(item.stamps);
    }

    return {
      id: id,
      registeredAt: registeredAt,
      stamps: stamps,
    };
  }

  function ingestProcessesResponse(protocolId, json) {
    if (!json || typeof json !== 'object') return null;

    const list = Array.isArray(json.data)
      ? json.data
      : json.data && Array.isArray(json.data.data)
        ? json.data.data
        : null;

    if (!list) return null;

    const state = getOrCreateState(protocolId);
    debugLog('processos recebidos', protocolId, list.length);

    // Substitui o registro do ato a cada resposta. Assim, se um selo for
    // removido/trocado, o cache não mantém dados antigos daquele ato.
    for (let i = 0; i < list.length; i++) {
      const record = extractProcessRecord(list[i]);
      if (record) state.processes.set(record.id, record);
    }

    const meta = json.meta && typeof json.meta === 'object' ? json.meta : {};
    const currentPage = toPositiveInt(
      json.current_page != null ? json.current_page : meta.current_page
    );
    const lastPage = toPositiveInt(
      json.last_page != null ? json.last_page : meta.last_page
    );
    const nextRaw =
      json.next_page_url != null
        ? json.next_page_url
        : json.links && json.links.next != null
          ? json.links.next
          : meta.next_page_url;

    if (currentPage != null) state.loadedPages.add(currentPage);
    if (lastPage != null) state.lastPage = lastPage;

    state.nextPageUrl = resolveNextPageUrl(
      protocolId,
      nextRaw,
      currentPage,
      lastPage
    );
    state.status = 'ready';
    state.lastUpdatedAt = Date.now();
    state.lastErrorAt = 0;

    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }

    scheduleScan();

    return {
      currentPage: currentPage,
      lastPage: lastPage,
      hasNext: Boolean(state.nextPageUrl),
    };
  }

  function processesPath(protocolId) {
    return '/api/v2/protocols/' + encodeURIComponent(protocolId) + '/processes';
  }

  function processesUrl(protocolId, page) {
    return processesPath(protocolId) + '?page=' + encodeURIComponent(String(page));
  }

  function resolveNextPageUrl(protocolId, nextRaw, currentPage, lastPage) {
    if (typeof nextRaw === 'string' && nextRaw.trim()) {
      try {
        const base = new URL(processesPath(protocolId), location.origin);
        const resolved = new URL(nextRaw, base);
        const basePath = base.pathname.replace(/\/+$/, '');
        const resolvedPath = resolved.pathname.replace(/\/+$/, '');

        // Nunca segue paginação para outro host.
        if (
          resolved.origin === location.origin &&
          resolvedPath === basePath
        ) {
          return resolved.pathname + resolved.search;
        }
      } catch (_) {
        // Paginação inválida: não segue.
      }
    }

    if (currentPage != null && lastPage != null && currentPage < lastPage) {
      return processesUrl(protocolId, currentPage + 1);
    }

    return null;
  }

  // =========================================================================
  // Observação transparente das requisições já feitas pela aplicação
  // =========================================================================
  //
  // Objetivo: reaproveitar a resposta de /api/v2/protocols/{id}/processes que
  // o próprio sistema carrega, evitando uma segunda requisição idêntica.
  // Os wrappers apenas observam GETs desse endpoint e devolvem a resposta
  // original intacta.

  const XHR_URL = Symbol('ncsDatasSelosUrl');
  const XHR_METHOD = Symbol('ncsDatasSelosMethod');
  const XHR_TOKEN = Symbol('ncsDatasSelosToken');

  function getRequestUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') {
        return new URL(input.url, location.href).href;
      }
    } catch (_) {
      // URL inválida.
    }
    return null;
  }

  function getFetchMethod(input, init) {
    if (init && typeof init.method === 'string') return init.method.toUpperCase();
    if (input && typeof input === 'object' && typeof input.method === 'string') {
      return input.method.toUpperCase();
    }
    return 'GET';
  }

  function isProcessesUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin) return false;
      return /^\/api\/v2\/protocols\/[0-9a-f-]{36}\/processes\/?$/i.test(
        parsed.pathname
      );
    } catch (_) {
      return false;
    }
  }

  function protocolIdFromProcessesUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const match = parsed.pathname.match(
        /^\/api\/v2\/protocols\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/processes\/?$/i
      );
      return match ? normalizeId(match[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function pageFromProcessesUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return toPositiveInt(parsed.searchParams.get('page')) || 1;
    } catch (_) {
      return 1;
    }
  }

  function markPagePending(state, url) {
    const page = pageFromProcessesUrl(url);
    if (page != null) state.pendingPages.add(page);
  }

  function clearPagePending(state, url) {
    const page = pageFromProcessesUrl(url);
    if (page != null) state.pendingPages.delete(page);
  }

  function installFetchObserver() {
    const original = window.fetch;
    if (typeof original !== 'function' || original.__ncsDatasSelosWrapped) return;

    const wrapped = function (input, init) {
      const internal = Boolean(init && init[INTERNAL_FETCH]);
      const method = getFetchMethod(input, init);
      const url = getRequestUrl(input);
      const promise = original.apply(this, arguments);

      if (
        !internal &&
        method === 'GET' &&
        url &&
        isProcessesUrl(url) &&
        promise &&
        typeof promise.then === 'function'
      ) {
        const protocolId = protocolIdFromProcessesUrl(url);
        const state = protocolId ? getOrCreateState(protocolId) : null;
        if (state) markPagePending(state, url);

        promise
          .then(function (response) {
            if (state) clearPagePending(state, url);
            if (!response || !response.ok) return;

            const contentType =
              (response.headers && response.headers.get('content-type')) || '';
            if (contentType && !/json/i.test(contentType)) return;

            let clone = null;
            try {
              clone = response.clone();
            } catch (_) {
              return; // Corpo já consumido por outro código.
            }

            clone
              .json()
              .then(function (json) {
                if (!protocolId) return;

                ingestProcessesResponse(protocolId, json);
              })
              .catch(function () {
                // Resposta não JSON ou inválida: o fallback cobre a ausência.
              });
          })
          .catch(function () {
            if (state) clearPagePending(state, url);
            // A requisição original falhou; o fallback tenta novamente.
          });
      }

      return promise;
    };

    try {
      wrapped.__ncsDatasSelosWrapped = true;
      window.fetch = wrapped;
    } catch (_) {
      // Se não for possível envolver fetch, o fetch próprio continua funcionando.
    }
  }

  function installXhrObserver() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto) return;

    if (!proto.open.__ncsDatasSelosWrapped) {
      const originalOpen = proto.open;
      const wrappedOpen = function (method, url) {
        try {
          this[XHR_METHOD] =
            typeof method === 'string' ? method.toUpperCase() : 'GET';
          this[XHR_URL] =
            typeof url === 'string' ? url : url && url.href ? url.href : '';
        } catch (_) {
          // Ignora.
        }
        return originalOpen.apply(this, arguments);
      };
      wrappedOpen.__ncsDatasSelosWrapped = true;
      try {
        proto.open = wrappedOpen;
      } catch (_) {
        // Sem interceptação de XHR; fallback cobre.
      }
    }

    if (!proto.send.__ncsDatasSelosWrapped) {
      const originalSend = proto.send;
      const wrappedSend = function () {
        try {
          const method = this[XHR_METHOD] || 'GET';
          const url = this[XHR_URL];

          if (method === 'GET' && url && isProcessesUrl(url)) {
            const token = Symbol('ncsDatasSelosXhr');
            this[XHR_TOKEN] = token;

            const protocolId = protocolIdFromProcessesUrl(url);
            const state = protocolId ? getOrCreateState(protocolId) : null;
            if (state) markPagePending(state, url);

            function onDone() {
              if (state) clearPagePending(state, url);
            }

            this.addEventListener('load', onDone, { once: true });
            this.addEventListener('error', onDone, { once: true });
            this.addEventListener('abort', onDone, { once: true });

            this.addEventListener(
              'load',
              function () {
                // Protege contra reutilização do mesmo objeto XHR.
                if (this[XHR_TOKEN] !== token) return;

                try {
                  if (this.status < 200 || this.status >= 300) return;

                  const responseType = this.responseType;
                  let json = null;

                  if (responseType === '' || responseType === 'text') {
                    if (typeof this.responseText === 'string') {
                      json = JSON.parse(this.responseText);
                    }
                  } else if (responseType === 'json') {
                    json = this.response;
                  }

                  if (!json) return;

                  if (!protocolId) return;

                  ingestProcessesResponse(protocolId, json);
                } catch (_) {
                  // Resposta inválida: fallback cobre.
                }
              },
              { once: true }
            );
          }
        } catch (_) {
          // Ignora.
        }

        return originalSend.apply(this, arguments);
      };
      wrappedSend.__ncsDatasSelosWrapped = true;
      try {
        proto.send = wrappedSend;
      } catch (_) {
        // Sem interceptação de XHR; fallback cobre.
      }
    }
  }

  function installNetworkObserver() {
    installFetchObserver();
    installXhrObserver();
  }

  // =========================================================================
  // Consulta GET de fallback (somente quando a interface não forneceu os dados)
  // =========================================================================

  async function fetchJson(url, outerSignal) {
    const controller = new AbortController();
    let timedOut = false;

    function onOuterAbort() {
      controller.abort();
    }

    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const timeout = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, CONFIG.fetchTimeoutMs);

    try {
      const init = {
        method: 'GET',
        mode: 'same-origin',
        credentials: 'same-origin',
        // 'same-origin' não é valor válido para RequestRedirect (follow|manual|ignore).
        // mode: 'same-origin' já recusa redirecionamentos para outra origem.
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      };
      init[INTERNAL_FETCH] = true;

      const response = await fetch(url, init);

      if (!response.ok) {
        const error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/json/i.test(contentType)) {
        const error = new Error('Resposta não JSON');
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      // Timeout interno não é cancelamento de navegação: permite nova tentativa.
      // Se a navegação também abortou, prevalece o cancelamento.
      if (timedOut && isAbortError(error) && !(outerSignal && outerSignal.aborted)) {
        const timeoutError = new Error('Tempo esgotado');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  async function fetchJsonWithRetry(url, signal) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal && signal.aborted) throw createAbortError();

      try {
        return await fetchJson(url, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;

        // Erros 4xx (sessão, permissão, rota) não devem ser repetidos.
        if (error && error.status >= 400 && error.status < 500) throw error;

        lastError = error;
        if (attempt === 0) await delay(CONFIG.fetchRetryDelayMs, signal);
      }
    }

    throw lastError;
  }

  function getDomActIds() {
    const ids = new Set();
    const cards = new Set();
    const links = document.querySelectorAll(ACT_LINK_SELECTOR);

    for (let i = 0; i < links.length; i++) {
      const card = findActCard(links[i]);
      if (card) cards.add(card);
    }

    for (const card of cards) {
      const link = findActLinkForCard(card);
      if (!link) continue;

      const id = extractActId(link.getAttribute('href'));
      if (id) ids.add(id);
    }

    return ids;
  }

  function domIdsCovered(state) {
    const ids = getDomActIds();
    if (ids.size === 0) return true;

    for (const id of ids) {
      if (!state.processes.has(id)) return false;
    }
    return true;
  }

  /**
   * Consulta páginas somente até cobrir os atos presentes no DOM.
   * Em condições normais o observer captura a resposta da própria interface
   * e esta função nunca é chamada.
   */
  async function runFallbackFetch(state) {
    if (state.promise) return state.promise;
    if (!isCurrentProtocol(state.protocolId)) return null;
    if (
      state.status === 'error' &&
      Date.now() - state.lastErrorAt < CONFIG.errorCooldownMs
    ) {
      return null;
    }

    state.lastFallbackAt = Date.now();
    state.status = 'loading';
    debugLog('consultando atos via fallback', state.protocolId);

    const controller = new AbortController();
    state.abortController = controller;

    state.promise = (async function () {
      let page = 1;

      try {
        while (page <= CONFIG.maxFallbackPages && !controller.signal.aborted) {
          if (state.pendingPages.has(page)) {
            // A própria interface já iniciou esta página; aborta o fallback
            // para reaproveitar a resposta do observer em vez de duplicar.
            controller.abort();
            break;
          }

          if (!state.loadedPages.has(page)) {
            const url = processesUrl(state.protocolId, page);
            const json = await fetchJsonWithRetry(url, controller.signal);
            const info = ingestProcessesResponse(state.protocolId, json);

            if (!info) break;
            if (domIdsCovered(state)) break;

            // `ingestProcessesResponse` já atualizou state.lastPage/nextPageUrl.
            if (info.lastPage == null && !info.hasNext) break;
            if (state.lastPage != null && page >= state.lastPage) break;
          } else {
            // Página já conhecida: avança sem nova requisição.
            if (state.lastPage != null && page >= state.lastPage) break;
            if (state.lastPage == null && state.nextPageUrl == null) {
              let maxLoaded = 0;
              for (const loadedPage of state.loadedPages) {
                if (loadedPage > maxLoaded) maxLoaded = loadedPage;
              }
              if (page >= maxLoaded) break;
            }
          }

          page++;
        }

        if (!controller.signal.aborted) {
          state.status = 'ready';
          state.lastUpdatedAt = Date.now();
          state.lastErrorAt = 0;
        }
      } catch (error) {
        if (isAbortError(error)) {
          state.status = state.processes.size > 0 ? 'ready' : 'idle';
        } else {
          state.status = 'error';
          state.lastErrorAt = Date.now();

          if (!state.warned && state.processes.size === 0) {
            state.warned = true;
            console.warn(
              '[NoCartório Datas dos Selos] Não foi possível carregar as datas dos atos.'
            );
          }
        }
      } finally {
        state.promise = null;
        state.abortController = null;
        scheduleScan();
      }
    })();

    return state.promise;
  }

  function pagePropsMatchProtocol(protocolId) {
    const page = getHistoryPage();
    if (!page) return true;

    const info = extractProtocolInfo(page.props);
    if (!info || !info.id) return true;
    return info.id === protocolId;
  }

  function maybeScheduleFallback(state, delayMs) {
    if (!state || !isCurrentProtocol(state.protocolId) || !isTargetPage()) return;
    if (state.promise) return;
    if (
      state.status === 'error' &&
      Date.now() - state.lastErrorAt < CONFIG.errorCooldownMs
    ) {
      return;
    }

    // Evita consultas enquanto o Inertia ainda mostra props de outro serviço.
    if (!pagePropsMatchProtocol(state.protocolId)) return;

    // Evita tentativas repetidas em sequência.
    if (Date.now() - state.lastFallbackAt < 10_000) return;
    if (state.fallbackTimer) return;

    const ids = getDomActIds();
    if (ids.size === 0) return; // Nada a exibir ainda.

    let missing = false;
    for (const id of ids) {
      if (!state.processes.has(id)) {
        missing = true;
        break;
      }
    }
    if (!missing) return;

    // Todas as páginas conhecidas já foram carregadas e o ato do DOM não veio:
    // não há próxima página confirmada para buscar.
    if (
      state.processes.size > 0 &&
      state.nextPageUrl == null &&
      state.lastPage != null &&
      state.loadedPages.size >= state.lastPage
    ) {
      return;
    }

    state.fallbackTimer = setTimeout(
      function () {
        state.fallbackTimer = null;

        if (!isCurrentProtocol(state.protocolId) || !isTargetPage()) return;
        if (state.promise) return;
        if (
          state.status === 'error' &&
          Date.now() - state.lastErrorAt < CONFIG.errorCooldownMs
        ) {
          return;
        }

        const currentIds = getDomActIds();
        if (currentIds.size === 0) return;

        let stillMissing = false;
        for (const id of currentIds) {
          if (!state.processes.has(id)) {
            stillMissing = true;
            break;
          }
        }
        if (!stillMissing) return;

        runFallbackFetch(state);
      },
      delayMs == null ? CONFIG.fallbackDelayMs : delayMs
    );
  }

  // =========================================================================
  // Associação ao DOM
  // =========================================================================

  function extractActId(href) {
    if (!href) return null;

    const value = String(href);
    const match = value.match(
      /(?:^|\/)admin\/manager\/process\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
    );
    return match ? normalizeId(match[1]) : null;
  }

  function findActCard(link) {
    if (!link) return null;

    // Seletor confirmado no relatório.
    const slotCard = link.closest('[data-slot="card"]');
    if (slotCard) return slotCard;

    // Fallback estrutural: menor ancestral que ainda contém apenas este
    // link de ato. Evita agrupar vários atos em um contêiner de grade.
    let node = link.parentElement;
    let candidate = node;

    while (node && node !== document.body) {
      if (node.querySelectorAll(ACT_LINK_SELECTOR).length > 1) break;
      candidate = node;
      node = node.parentElement;
    }

    return candidate || link.parentElement;
  }

  function findActLinkForCard(card) {
    // Prefere o link com o aria-label confirmado no relatório.
    const preferred = card.querySelector(
      'a[aria-label="Ver detalhes do ato do processo"]'
    );
    if (preferred && findActCard(preferred) === card) return preferred;

    const links = card.querySelectorAll(ACT_LINK_SELECTOR);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (findActCard(link) === card) return link;
    }
    return null;
  }

  function findSealLabel(card) {
    const elements = card.querySelectorAll('p,span,dt,label,strong,b,div');

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.closest('[' + BOX_ATTR + ']')) continue;
      if (element.children.length > 0) continue;
      if (/^selo\s*:?$/i.test(normalizeText(element.textContent))) return element;
    }
    return null;
  }

  function bestNumberCandidate(root, target) {
    const elements = root.querySelectorAll(
      'p,span,strong,b,code,div,td,input,a,button'
    );
    const candidates = [];

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.closest('[' + BOX_ATTR + ']')) continue;
      if (element.matches('script,style,textarea,select,option')) continue;

      let text = null;
      if (element.matches('input')) {
        text = element.value;
      } else if (element.children.length === 0) {
        text = element.textContent;
      }
      if (text == null) continue;

      const normalized = normalizeStampNumber(text);
      if (!normalized) continue;

      let score = 0;
      if (normalized === target) {
        // Correspondência exata tem prioridade sobre qualquer aproximação,
        // mesmo que o elemento exato esteja em uma seção recolhida.
        score = 30;
      } else if (
        target.length >= 6 &&
        normalized.length <= target.length + 12 &&
        normalized.indexOf(target) !== -1
      ) {
        score = 10;
      } else {
        continue;
      }

      if (isElementVisible(element)) score += 5;
      score -= Math.min(normalized.length, 200) * 0.01;

      candidates.push({ element: element, score: score });
    }

    if (candidates.length === 0) return null;

    candidates.sort(function (a, b) {
      return b.score - a.score;
    });

    return candidates[0].element;
  }

  /**
   * Localiza o elemento que mostra o número do selo.
   * Primeiro restringe a busca ao bloco que contém o rótulo "Selo"; depois
   * faz uma busca no cartão inteiro. A associação principal, porém, é sempre
   * feita pelo UUID do ato, não pelo número.
   */
  function findStampNumberElement(card, number) {
    const target = normalizeStampNumber(number);
    if (!target) return null;

    const label = findSealLabel(card);
    if (label) {
      let scope = label.parentElement;
      let depth = 0;

      while (scope && scope !== card && depth < 6) {
        const found = bestNumberCandidate(scope, target);
        if (found) return found;
        scope = scope.parentElement;
        depth++;
      }
    }

    return bestNumberCandidate(card, target);
  }

  function chooseInsertionAnchor(card, numberElement) {
    let anchor = numberElement;
    const parent = numberElement.parentElement;

    if (parent && parent !== card) {
      if (parent.matches('a,button')) {
        anchor = parent;
      } else if (!parent.querySelector(ACT_LINK_SELECTOR)) {
        // Insere depois do bloco que contém o número (e não dentro dele),
        // preservando botões e indicadores existentes.
        anchor = parent;
      }
    }

    return anchor === card ? numberElement : anchor;
  }

  function insertAfterAnchor(anchor, box) {
    if (!anchor) return;

    const parent = anchor.parentElement;
    if (!parent) {
      anchor.appendChild(box);
      return;
    }

    const parentTag = parent.tagName;
    if (
      parentTag === 'TR' ||
      parentTag === 'UL' ||
      parentTag === 'OL' ||
      parentTag === 'SELECT'
    ) {
      anchor.appendChild(box);
      return;
    }

    // Mantém a ordem quando há mais de um selo sob o mesmo bloco.
    let last = anchor;
    while (
      last.nextElementSibling &&
      last.nextElementSibling.matches('[' + BOX_ATTR + ']')
    ) {
      last = last.nextElementSibling;
    }

    last.insertAdjacentElement('afterend', box);
  }

  function isBoxInCard(box, card) {
    const boxCard = box.closest('[data-slot="card"]');
    if (boxCard) return boxCard === card;
    return card.contains(box);
  }

  function findBoxesByKey(card, key) {
    const result = [];
    const boxes = card.querySelectorAll('[' + BOX_ATTR + ']');

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.getAttribute(BOX_KEY_ATTR) !== key) continue;
      if (!isBoxInCard(box, card)) continue;
      result.push(box);
    }

    return result;
  }

  function removeStaleBoxes(card, expectedKeys, protocolId) {
    const boxes = card.querySelectorAll('[' + BOX_ATTR + ']');

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!isBoxInCard(box, card)) continue;

      const key = box.getAttribute(BOX_KEY_ATTR);
      const boxProtocol = box.getAttribute(BOX_PROTOCOL_ATTR);

      if (boxProtocol !== protocolId || !expectedKeys.has(key)) {
        box.remove();
      }
    }
  }

  /**
   * Remove caixas que pertençam a outro ato. Protege contra reaproveitamento
   * do mesmo cartão pelo framework durante atualizações da lista.
   */
  function removeBoxesFromOtherActs(card, actId) {
    const boxes = card.querySelectorAll('[' + BOX_ATTR + ']');
    const prefix = actId + '::';

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!isBoxInCard(box, card)) continue;

      const key = box.getAttribute(BOX_KEY_ATTR) || '';
      if (key.indexOf(prefix) !== 0) box.remove();
    }
  }

  // =========================================================================
  // Construção visual
  // =========================================================================

  function buildLine(emoji, label, value, title) {
    const line = document.createElement('div');
    line.className = 'ncs-datas-selos__linha';
    line.title = title;
    line.style.cssText =
      'display:flex;align-items:baseline;gap:4px;margin:0;padding:0;min-width:0;';

    const icon = document.createElement('span');
    icon.className = 'ncs-datas-selos__emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = emoji;
    icon.style.cssText = 'flex:0 0 auto;font-size:0.7rem;line-height:1.2;';

    const text = document.createElement('span');
    text.className = 'ncs-datas-selos__texto';
    text.style.cssText =
      'min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;';

    const labelElement = document.createElement('span');
    labelElement.className = 'ncs-datas-selos__rotulo';
    labelElement.style.cssText = 'font-weight:500;';
    labelElement.textContent = label + ':';

    text.appendChild(labelElement);
    text.appendChild(document.createTextNode(' ' + value));

    line.appendChild(icon);
    line.appendChild(text);

    return line;
  }

  function setBoxContent(
    box,
    protocolFormatted,
    registrationFormatted,
    registrationSource,
    protocolTitle
  ) {
    box.textContent = '';

    if (protocolFormatted) {
      box.appendChild(
        buildLine('📅', 'Protocolado', protocolFormatted, protocolTitle)
      );
    }

    if (registrationFormatted) {
      const registrationTitle =
        registrationSource === 'stamp'
          ? 'Data de prática/registro do ato, conforme informada no selo.'
          : 'Data de prática/registro do ato vinculado ao selo.';

      box.appendChild(
        buildLine('✅', 'Registrado', registrationFormatted, registrationTitle)
      );
    }
  }

  function buildBox(
    protocolFormatted,
    registrationFormatted,
    registrationSource,
    protocolTitle
  ) {
    const box = document.createElement('div');
    box.className = 'ncs-datas-selos';
    box.setAttribute(BOX_ATTR, '1');
    box.setAttribute('role', 'note');
    box.setAttribute('aria-label', 'Datas do selo');

    // Estilos inline e escopados: não dependem de <style>, não usam
    // posicionamento absoluto e não interferem em botões/indicadores.
    box.style.cssText = [
      'display:flex',
      'flex-direction:column',
      'gap:2px',
      'margin:4px 0 0',
      'padding:4px 8px',
      'border-left:2px solid rgba(127,127,127,.28)',
      'background:rgba(127,127,127,.07)',
      'border-radius:4px',
      'font-family:inherit',
      'font-size:0.75rem',
      'font-weight:400',
      'font-style:normal',
      'line-height:1.4',
      'color:inherit',
      'text-align:left',
      'width:100%',
      'min-width:0',
      'max-width:100%',
      'box-sizing:border-box',
      'flex-basis:100%',
      'grid-column:1 / -1',
      'white-space:normal',
      'overflow-wrap:anywhere',
      'opacity:.82',
      'pointer-events:auto',
      'cursor:default',
    ].join(';');

    setBoxContent(
      box,
      protocolFormatted,
      registrationFormatted,
      registrationSource,
      protocolTitle
    );

    return box;
  }

  function renderCard(card, state) {
    if (!card || !card.isConnected) return;

    const link = findActLinkForCard(card);
    if (!link) return;

    const actId = extractActId(link.getAttribute('href'));
    if (!actId) return;

    // Se o cartão foi reaproveitado para outro ato, remove anotações antigas.
    removeBoxesFromOtherActs(card, actId);

    const act = state.processes.get(actId);
    if (!act) return; // Aguarda a resposta da interface ou do fallback.

    const protocolFormatted = formatDate(state.protocolRegisteredAt);
    const protocolTitle =
      'Data de protocolo do serviço (prenotação no livro de protocolo).';

    const expectedKeys = new Set();
    const keyCounts = new Map();
    let unmatchedStamps = 0;

    for (let i = 0; i < act.stamps.length; i++) {
      const stamp = act.stamps[i];
      const numberElement = findStampNumberElement(card, stamp.number);
      if (!numberElement) {
        unmatchedStamps++;
        continue;
      }

      // registeredAt do ato é a fonte canônica. O campo do selo é usado
      // somente quando o ISO do ato está ausente ou inválido.
      let registrationRaw = act.registeredAt || null;
      let registrationSource = act.registeredAt ? 'process' : null;
      let registrationFormatted = formatDate(registrationRaw);

      if (!registrationFormatted && stamp.registeredAt) {
        registrationRaw = stamp.registeredAt;
        registrationSource = 'stamp';
        registrationFormatted = formatDate(registrationRaw);
      }

      if (!protocolFormatted && !registrationFormatted) continue;

      const baseKey = actId + '::' + normalizeStampNumber(stamp.number);
      const count = keyCounts.get(baseKey) || 0;
      keyCounts.set(baseKey, count + 1);

      const key = baseKey + '::' + count;
      expectedKeys.add(key);

      const signature = [
        protocolFormatted || '',
        registrationFormatted || '',
        registrationSource || '',
      ].join('|');

      const existing = findBoxesByKey(card, key);
      if (existing.length > 0) {
        const box = existing[0];
        for (let extra = 1; extra < existing.length; extra++) {
          existing[extra].remove();
        }

        if (box.getAttribute(BOX_SIGNATURE_ATTR) !== signature) {
          setBoxContent(
            box,
            protocolFormatted,
            registrationFormatted,
            registrationSource,
            protocolTitle
          );
          box.setAttribute(BOX_SIGNATURE_ATTR, signature);
        }

        box.setAttribute(BOX_PROTOCOL_ATTR, state.protocolId);
        continue;
      }

      const box = buildBox(
        protocolFormatted,
        registrationFormatted,
        registrationSource,
        protocolTitle
      );
      box.setAttribute(BOX_KEY_ATTR, key);
      box.setAttribute(BOX_PROTOCOL_ATTR, state.protocolId);
      box.setAttribute(BOX_SIGNATURE_ATTR, signature);

      const anchor = chooseInsertionAnchor(card, numberElement);
      insertAfterAnchor(anchor, box);
    }

    // Remove caixas obsoletas do mesmo cartão, por exemplo quando o selo
    // deixou de existir ou o número exibido mudou. Se algum número ainda não
    // foi encontrado no DOM, aguarda a próxima varredura para não apagar uma
    // anotação válida durante uma renderização parcial.
    if (act.stamps.length === 0 || unmatchedStamps === 0) {
      removeStaleBoxes(card, expectedKeys, state.protocolId);
    }
  }

  function removeAllBoxes() {
    const boxes = document.querySelectorAll('[' + BOX_ATTR + ']');
    for (let i = 0; i < boxes.length; i++) boxes[i].remove();
  }

  function cleanupBoxesForProtocol(protocolId) {
    const boxes = document.querySelectorAll('[' + BOX_ATTR + ']');

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!protocolId || box.getAttribute(BOX_PROTOCOL_ATTR) !== protocolId) {
        box.remove();
      }
    }
  }

  // =========================================================================
  // Varredura e controle de rotas
  // =========================================================================

  let currentUrl = location.href;
  let currentProtocolId = null;
  let scanTimer = null;
  let routeTimer = null;

  function isCurrentProtocol(protocolId) {
    return normalizeId(protocolId) === getProtocolId();
  }

  function scan() {
    if (!isTargetPage()) {
      removeAllBoxes();
      return;
    }

    const protocolId = getProtocolId();
    if (!protocolId) return;

    // Defesa contra uma transição de rota ainda não processada.
    if (protocolId !== currentProtocolId) {
      scheduleRouteCheck();
      return;
    }

    const state = getOrCreateState(protocolId);
    refreshProtocolInfo(state);

    const cards = new Set();
    const links = document.querySelectorAll(ACT_LINK_SELECTOR);

    for (let i = 0; i < links.length; i++) {
      const card = findActCard(links[i]);
      if (card) cards.add(card);
    }

    for (const card of cards) {
      renderCard(card, state);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, CONFIG.scanDebounceMs);
  }

  function scheduleRouteCheck() {
    if (routeTimer) return;
    routeTimer = setTimeout(function () {
      routeTimer = null;
      handleRouteCheck();
    }, CONFIG.routeDebounceMs);
  }

  function handleRouteCheck() {
    const url = location.href;
    const target = isTargetPage();
    const newProtocolId = target ? getProtocolId() : null;

    if (url !== currentUrl || newProtocolId !== currentProtocolId) {
      currentUrl = url;

      if (newProtocolId !== currentProtocolId) {
        const oldProtocolId = currentProtocolId;
        currentProtocolId = newProtocolId;

        // Cancela consulta e timer do serviço anterior.
        if (oldProtocolId) {
          const oldState = protocolCache.get(oldProtocolId);
          if (oldState) {
            if (oldState.abortController) oldState.abortController.abort();
            if (oldState.fallbackTimer) {
              clearTimeout(oldState.fallbackTimer);
              oldState.fallbackTimer = null;
            }
            // Ao voltar ao serviço, permite nova tentativa imediata.
            oldState.lastFallbackAt = 0;
          }
        }

        // Remove imediatamente dados visuais do serviço anterior.
        cleanupBoxesForProtocol(newProtocolId);

        if (!newProtocolId) return;

        const state = getOrCreateState(newProtocolId);
        refreshProtocolInfo(state);
        scheduleScan();

        // Não dispara consulta aqui: os cartões recém-renderizados disparam o
        // MutationObserver. Isso evita duplicar a requisição que a própria
        // interface faz enquanto a nova página ainda está carregando.

        // Uma segunda varredura (sem rede) captura props do Inertia que
        // cheguem depois da troca de rota.
        setTimeout(function () {
          if (!isTargetPage() || !isCurrentProtocol(newProtocolId)) return;
          const currentState = getOrCreateState(newProtocolId);
          refreshProtocolInfo(currentState);
          scheduleScan();
        }, 1_500);

        return;
      }
    }

    if (!newProtocolId) return;

    const state = getOrCreateState(newProtocolId);
    refreshProtocolInfo(state);
    scheduleScan();
  }

  // =========================================================================
  // Observadores de DOM e de histórico
  // =========================================================================

  function isOurNode(node) {
    if (!node) return false;

    if (node.nodeType === Node.TEXT_NODE) {
      return Boolean(
        node.parentElement && node.parentElement.closest('[' + BOX_ATTR + ']')
      );
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches('[' + BOX_ATTR + ']')) return true;
    if (node.closest && node.closest('[' + BOX_ATTR + ']')) return true;
    return false;
  }

  function installDomObserver() {
    if (!document.body || document.body.__ncsDatasSelosObserved) return;
    document.body.__ncsDatasSelosObserved = true;

    const observer = new MutationObserver(function (mutations) {
      let relevant = false;

      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.type !== 'childList') continue;

        // Alterações internas das próprias caixas não reiniciam a varredura.
        const target = mutation.target;
        if (
          target &&
          target.nodeType === Node.ELEMENT_NODE &&
          target.closest &&
          target.closest('[' + BOX_ATTR + ']')
        ) {
          continue;
        }

        const nodes = [];
        mutation.addedNodes.forEach(function (node) {
          nodes.push(node);
        });
        mutation.removedNodes.forEach(function (node) {
          nodes.push(node);
        });

        if (nodes.length === 0) continue;

        // Inserções/remoções feitas pelo próprio script não geram nova rodada.
        if (nodes.every(isOurNode)) continue;

        relevant = true;
        break;
      }

      if (!relevant) return;

      // Fora da página de serviço, não há nada a anotar. Remove eventuais
      // caixas remanescentes e evita varreduras contínuas em outras rotas SPA.
      if (!isTargetPage()) {
        if (document.querySelector('[' + BOX_ATTR + ']')) removeAllBoxes();
        return;
      }

      scheduleRouteCheck();
      scheduleScan();

      const protocolId = getProtocolId();
      if (!protocolId) return;

      const state = getOrCreateState(protocolId);
      maybeScheduleFallback(state);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function installRouteObserver() {
    if (window.__ncsDatasSelosRouteObserved) return;
    window.__ncsDatasSelosRouteObserved = true;

    function wrapHistory(method) {
      const original = history[method];
      if (typeof original !== 'function' || original.__ncsDatasSelosWrapped) {
        return;
      }

      const wrapped = function () {
        const result = original.apply(this, arguments);
        scheduleRouteCheck();
        return result;
      };

      wrapped.__ncsDatasSelosWrapped = true;
      try {
        history[method] = wrapped;
      } catch (_) {
        // O MutationObserver continua detectando mudanças de URL.
      }
    }

    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', scheduleRouteCheck, true);
    window.addEventListener('hashchange', scheduleRouteCheck, true);
    window.addEventListener(
      'pageshow',
      function () {
        scheduleRouteCheck();
        setTimeout(function () {
          if (!currentProtocolId) return;
          maybeScheduleFallback(
            getOrCreateState(currentProtocolId),
            CONFIG.routeFallbackDelayMs
          );
        }, CONFIG.routeDebounceMs + 50);
      },
      true
    );
  }

  // =========================================================================
  // Inicialização
  // =========================================================================

  let initAttempts = 0;

  function handleOnline() {
    protocolCache.forEach(function (state) {
      if (state.status === 'error') {
        state.status = 'idle';
        state.lastErrorAt = 0;
        state.lastFallbackAt = 0;
        state.warned = false;
      }
    });

    const protocolId = getProtocolId();
    if (protocolId) {
      const state = getOrCreateState(protocolId);
      maybeScheduleFallback(state, 500);
    }
  }

  function init() {
    if (!document.body) {
      if (initAttempts++ < 40) {
        setTimeout(init, 50);
      }
      return;
    }

    // Reinstala caso a aplicação tenha substituído fetch/XHR após o
    // document-start. Os instaladores são idempotentes.
    installNetworkObserver();
    installRouteObserver();
    installDomObserver();

    if (!window.__ncsDatasSelosOnline) {
      window.__ncsDatasSelosOnline = true;
      window.addEventListener('online', handleOnline);
    }

    handleRouteCheck();
    scheduleScan();

    // Cobre injeção tardia/bfcache em que os cartões já existem e a resposta
    // da interface não pôde ser observada.
    if (currentProtocolId) {
      maybeScheduleFallback(
        getOrCreateState(currentProtocolId),
        CONFIG.routeFallbackDelayMs
      );
    }
  }

  // Observação de rede no document-start: é o ponto que permite reutilizar
  // a resposta que a própria interface solicita.
  installNetworkObserver();
  installRouteObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
