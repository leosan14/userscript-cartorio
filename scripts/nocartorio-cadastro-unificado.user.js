// ==UserScript==
// @name         NoCartório – Cadastro unificado
// @namespace    nocartorio-cadastro-unificado
// @version      0.4.2
// @description  Edita, cria e vincula, numa tela só, os documentos de todas as partes de um ato no NoCartório (telas v2). Também recebe dados prontos de outros scripts (ex.: ficha gerada por IA) para revisar e gravar tudo de uma vez.
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-cadastro-unificado.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-cadastro-unificado.user.js
// ==/UserScript==

/*
 * COMO FUNCIONA
 * - Nas telas de um ato (…/admin/manager/v2/process/{processo}/edit, …/part/{parte} e outras com a
 *   lista de partes) aparece o botão "Cadastro unificado" (ou Alt+U).
 * - O painel carrega TODAS as partes do ato, agrupadas por perfil (pessoa, empresa, imóvel…). Se o
 *   mesmo perfil aparece em mais de uma parte (ex.: Cedente e Sacador), os documentos dele aparecem
 *   uma vez só. Os já cadastrados entram para edição; os não cadastrados podem ser criados ("Criar").
 * - Se o perfil já tem um documento do tipo que falta na parte, o cartão oferece "Vincular" o existente
 *   em vez de criar outro. Documento criado ou vinculado numa parte pode ser vinculado também nas
 *   outras partes da mesma pessoa no ato (caixa "Vincular também em…").
 * - "Campos em comum" junta, dentro de cada perfil, os campos que aparecem em mais de um documento
 *   (endereço, nome, lote, quadra…), mostra os valores lado a lado e permite aplicar um valor a todos
 *   os documentos daquele perfil. Nada é copiado automaticamente e nada passa de um perfil para outro.
 * - Ao salvar: uma revisão para o ato inteiro → para cada documento, confere se ele mudou desde que foi
 *   carregado (se mudou, não grava) → envia o mesmo pacote que a tela nativa enviaria → recarrega e
 *   confere o que ficou gravado.
 * - Usa só os endereços da própria NoCartório, com a sua sessão. Nada é enviado a terceiros.
 *
 * DADOS PRONTOS (para outros scripts, ex.: "Ficha no cadastro unificado")
 * - window.NCU.openPrefilled(dados) abre o painel de um ato já preenchido: pessoas a cadastrar,
 *   papéis a incluir e valores de documentos (com a fonte de cada um). Nada é gravado sem a revisão.
 *   Campos vazios recebem o valor; campos já preenchidos com outro valor NÃO são trocados: aparece
 *   "Ficha: … [usar]" para a pessoa decidir. Ordem da gravação: matrículas → pessoas → papéis → documentos.
 * - Matrículas (imóveis já cadastrados na NoCartório) também podem vir nos dados prontos, com o papel
 *   de imóvel do ato: entram primeiro, porque a NoCartório inclui sozinha os proprietários; o resultado
 *   mostra quem foi incluído automaticamente e os avisos da NoCartório.
 *   (prefillApi 2: perfis com kind: 'imovel')
 *
 * LIMITES DESTA VERSÃO
 * - Não envia anexos (tipos que exigem arquivo devem ser criados pela tela nativa).
 * - Não cria o perfil de uma matrícula que ainda não tem cadastro na NoCartório (isso é feito pelo
 *   Livro Indicador Real, na tela nativa); só inclui no ato matrículas já cadastradas.
 * - Não altera campos-chave de documentos já cadastrados (na NoCartório isso é feito em "editar chaves"),
 *   nem "Tipo do imóvel" / "Situação do imóvel", nem as configurações do documento no ato.
 * - Se a NoCartório mudar o formato interno das telas, o script pode parar de funcionar; ele avisa em vez
 *   de gravar quando encontra algo inesperado.
 */

(function () {
  'use strict';

  const VERSION = '0.4.2';

  /* =====================================================================================
   * 1. FUNÇÕES PURAS (formatos de valores) — espelham a lógica da tela nativa
   * ===================================================================================== */

  const RE_DEC = /-?\d+(?:[.,]\d{3})*[.,]\d{1,2}(?!\d)/;
  const RE_INT = /^(-)?\s*(?:R\$)?\s*(\d+)$/i;

  function parseDecimalToken(s) {
    const neg = s.startsWith('-');
    const n = neg ? s.slice(1) : s;
    const i = Math.max(n.lastIndexOf(','), n.lastIndexOf('.'));
    const v = Number(`${n.slice(0, i).replace(/[.,]/g, '')}.${n.slice(i + 1)}`);
    return neg ? -v : v;
  }

  /** Leitura de valor monetário igual à da NoCartório ("1.234,56", "1234.5", "1500"). */
  function parseBRL(value) {
    const t = String(value).trim();
    if (t === '') return NaN;
    const m = t.match(RE_DEC);
    if (m) return parseDecimalToken(m[0]);
    const r = t.match(RE_INT);
    if (!r) return NaN;
    const v = Number(r[2]);
    return r[1] ? -v : v;
  }

  /** Conversão que a tela nativa aplica antes de enviar campos "money": reais → centavos (texto). */
  function moneyToCents(v) {
    if (v === '' || v == null) return '';
    const t = typeof v === 'number' ? v : parseBRL(String(v));
    return Number.isFinite(t) ? String(Math.round(t * 100)) : '';
  }

  /** Leitura do que a pessoa digita no campo de valor (aceita "1.234,56", "1234,5", "1234.56"). */
  function parseMoneyInput(s) {
    let t = String(s == null ? '' : s).replace(/R\$|\s/gi, '');
    if (t === '') return '';
    if (t.startsWith('-')) return NaN;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
    return Number(t);
  }

  const fmtBRL = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function parseNum(v) {
    if (typeof v === 'number') return v;
    const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
    if (s === '') return NaN;
    const t = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }

  const toBool = (v) => v === true || v === 1 || ['1', 'true', 'sim', 'yes'].includes(String(v).trim().toLowerCase());

  function normDate(v) {
    const s = String(v == null ? '' : v).trim();
    let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
  }
  function fmtDate(v) {
    const s = normDate(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  }
  function normTime(v) {
    const s = String(v == null ? '' : v).trim();
    return /^\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  }
  function normDateTime(v) {
    const s = String(v == null ? '' : v).trim().replace(' ', 'T');
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    return m ? m[1] : s;
  }
  function validIsoDate(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return y >= 1800 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  // Máscaras por tipo de campo (as mesmas da tela nativa). # = dígito, @ = letra/dígito (maiúscula), * = letra/dígito
  const MASKS = {
    cpf: '###.###.###-##',
    cnpj: '@@.@@@.@@@/@@@@-##',
    cib: '*******-*',
    cnh: '###########',
    do: '#########',
    dnv: '###########',
    zipcode: '#####-###',
    phone: ['(##) ####-####', '(##) #####-####'],
  };
  const MASK_TOKENS = { '#': { re: /\d/ }, '@': { re: /[A-Za-z0-9]/, up: true }, '*': { re: /[A-Za-z0-9]/ } };

  function applyMask(value, mask) {
    const src = String(value == null ? '' : value);
    if (Array.isArray(mask)) mask = src.replace(/\D/g, '').length > 10 ? mask[1] : mask[0];
    let out = '';
    let pend = '';
    let i = 0;
    for (let m = 0; m < mask.length; m++) {
      const tk = MASK_TOKENS[mask[m]];
      if (tk) {
        while (i < src.length && !tk.re.test(src[i])) i++;
        if (i >= src.length) break;
        out += pend + (tk.up ? src[i].toUpperCase() : src[i]);
        pend = '';
        i++;
      } else {
        pend += mask[m];
        if (src[i] === mask[m]) i++;
      }
    }
    return out;
  }

  // Matrícula de certidão (32 dígitos) — formatação e dígito verificador iguais aos da tela nativa.
  const MAT_GROUPS = [6, 2, 2, 4, 1, 5, 3, 7, 2];
  function matDigit(base, start) {
    let n = 0;
    let r = start;
    for (const c of base) {
      n += Number(c) * (r % 11);
      r += 1;
    }
    const i = n % 11;
    return i === 10 ? 1 : i;
  }
  function matCheck(v) {
    const t = String(v == null ? '' : v).replace(/\D/g, '');
    if (t.length !== 32) return null;
    const base = t.slice(0, 30);
    const d1 = matDigit(base, 2);
    const d2 = matDigit(`${base}${d1}`, 1);
    return `${d1}${d2}` === t.slice(30);
  }
  function matFormat(v) {
    const t = String(v == null ? '' : v).replace(/\D/g, '');
    if (t.length !== 32) return v;
    let n = 0;
    return MAT_GROUPS.map((g) => t.slice(n, (n += g))).join(' ');
  }

  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

  /** CPF com dígitos verificadores válidos. */
  function cpfOk(v) {
    const c = digitsOf(v);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    const dv = (len) => {
      let s = 0;
      for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
  }
  /** CNPJ numérico com dígitos verificadores válidos (o alfanumérico não é conferido). */
  function cnpjOk(v) {
    const c = digitsOf(v);
    if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
    const dv = (len) => {
      const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      let s = 0;
      for (let i = 0; i < len; i++) s += Number(c[i]) * w[i];
      const r = s % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
  }

  /** Tipo de controle para o campo (mesma ordem de decisão da tela nativa). */
  function fieldKind(f) {
    if (f.type === 'text' || f.type === 'boolean' || f.type === 'select' || f.type === 'money') return f.type;
    if (f.mask) return 'matricula';
    if (MASKS[f.type]) return 'masked';
    if (f.type === 'date' || f.type === 'time' || f.type === 'datetime' || f.type === 'numeric') return f.type;
    return 'string';
  }

  /** Valor bruto do servidor → valor do controle. */
  function stateFromRaw(f, raw, selectOption) {
    switch (fieldKind(f)) {
      case 'boolean':
        return toBool(raw);
      case 'select':
        if (raw === '' || raw == null || raw === false) return null;
        return { value: raw, label: selectOption && selectOption.label != null ? String(selectOption.label) : String(raw) };
      case 'money': {
        if (raw === '' || raw == null) return '';
        const n = typeof raw === 'number' ? raw : parseBRL(String(raw));
        return Number.isFinite(n) ? n : '';
      }
      case 'date':
        return raw == null ? '' : normDate(raw);
      case 'datetime':
        return raw == null ? '' : normDateTime(raw);
      default:
        return raw == null ? '' : String(raw);
    }
  }

  /** Valor do controle → "data" enviado (antes da conversão de money para centavos). */
  function dataFromState(f, st) {
    switch (fieldKind(f)) {
      case 'boolean':
        return !!st;
      case 'select':
        // a tela nativa envia o id da opção escolhida como texto ("1")
        return st && typeof st === 'object' && st.value != null ? String(st.value) : '';
      case 'money':
        return st === '' || st == null || typeof st !== 'number' || !Number.isFinite(st) ? '' : st;
      case 'numeric': {
        // a tela nativa usa <input type="number">, que envia texto com ponto decimal ("123.45")
        const s = String(st == null ? '' : st).trim().replace(/\s/g, '');
        if (s === '') return '';
        const t = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
        return /^-?\d+(\.\d+)?$/.test(t) ? t : s;
      }
      default:
        return st == null ? '' : String(st);
    }
  }

  /** Forma canônica para comparar valores (detecção de alteração, divergência e conflito). */
  function norm(kind, v) {
    switch (kind) {
      case 'boolean':
        return toBool(v) ? '1' : '0';
      case 'select':
        return v && typeof v === 'object' ? String(v.value == null ? '' : v.value) : String(v == null ? '' : v);
      case 'money':
        return moneyToCents(v);
      case 'numeric': {
        const n = parseNum(v);
        return Number.isFinite(n) ? String(n) : String(v == null ? '' : v).trim();
      }
      case 'date':
        return normDate(v);
      case 'time':
        return normTime(v);
      case 'datetime':
        return normDateTime(v);
      default:
        return String(v == null ? '' : v).trim();
    }
  }

  /** Texto para exibir um valor de controle. */
  function showState(f, st) {
    const k = fieldKind(f);
    if (k === 'select') return st && typeof st === 'object' ? String(st.label == null ? st.value : st.label) : '';
    if (k === 'boolean') return st ? 'Sim' : 'Não';
    if (k === 'money') return typeof st === 'number' && Number.isFinite(st) ? `R$ ${fmtBRL(st)}` : '';
    if (k === 'date') return fmtDate(st);
    if (k === 'datetime') {
      const s = normDateTime(st);
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/);
      return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : s;
    }
    return String(st == null ? '' : st).trim();
  }

  function cloneState(v) {
    return v && typeof v === 'object' ? { ...v } : v;
  }

  /** Nome curto do tipo de documento (sigla entre parênteses, sufixo " - XXX" ou o próprio nome). */
  function shortName(name) {
    const s = String(name || '');
    const groups = [...s.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
    const acr = groups.find((g) => /[A-Z]{2,}/.test(g));
    if (acr) return acr;
    const parts = s.split(' - ');
    if (parts.length > 1 && parts[parts.length - 1].length <= 12) return parts[parts.length - 1];
    return s.length > 30 ? `${s.slice(0, 29)}…` : s;
  }

  /* ----- modelo do documento ----- */

  /** Documento que já existe no perfil (edição ou vínculo de um existente). */
  const isExistingMode = (d) => d.mode === 'edit' || d.mode === 'link';

  function isLocked(d, f) {
    if (!isExistingMode(d)) return false;
    const p = d.props || {};
    return p.edit_keys_mode ? !f.is_key && !f.is_required : !!f.is_key;
  }

  function fieldChanged(d, f) {
    if (!d.dirty.has(f.id)) return false;
    const k = fieldKind(f);
    return norm(k, dataFromState(f, d.values[f.id])) !== norm(k, d.original[f.id].raw);
  }

  function effectiveData(d, f) {
    return fieldChanged(d, f) ? dataFromState(f, d.values[f.id]) : d.original[f.id].raw;
  }

  function showOrig(d, f) {
    const o = d.original[f.id];
    return showState(f, stateFromRaw(f, o.raw, o.select));
  }

  /** Preenche o documento a partir das props da página nativa (edição, vínculo ou criação). */
  function initDoc(d, p) {
    d.props = p;
    d.loadError = null;
    d.fileRequired = !!(p.document_type && p.document_type.file_required);
    d.fields = p.document_type.fields.slice().sort((a, b) => (Number(a.row) || 0) - (Number(b.row) || 0));
    const src = isExistingMode(d) ? (p.document && p.document.fields_values) || {} : p.prefill_values || {};
    d.original = {};
    d.values = {};
    d.dirty = new Set();
    d.errors = {};
    d.generalErrors = [];
    d.notices = {};
    for (const f of d.fields) {
      const o = src[f.id] || null;
      // igual à tela nativa: n?.data ?? (tipo !== 'boolean' && '')
      const raw = o && o.data != null ? o.data : f.type !== 'boolean' && '';
      const so = o && o.select_option
        ? { value: o.select_option.value, label: o.select_option.label != null ? o.select_option.label : o.select_option.text != null ? o.select_option.text : String(o.select_option.value) }
        : null;
      d.original[f.id] = {
        raw,
        select: so,
        ai: isExistingMode(d) && !!(o && o.extracted_by_ai),
        aiChanged: !!(o && o.ai_extracted_value_changed === true),
      };
      d.values[f.id] = stateFromRaw(f, raw, so);
    }
  }

  /** document_fields no formato que a tela nativa envia. */
  function buildFieldsPayload(d) {
    const out = {};
    for (const f of d.fields) {
      const o = d.original[f.id];
      const changed = fieldChanged(d, f);
      let data = changed ? dataFromState(f, d.values[f.id]) : o.raw;
      if (f.type === 'money') data = moneyToCents(data);
      out[f.id] = {
        id: f.id,
        entries: [{ data }],
        extracted_by_ai: o.ai,
        ai_extracted_value_changed: o.ai && (changed || o.aiChanged),
      };
    }
    return out;
  }

  /** Corpo do PUT de edição (igual ao da tela "Editar documento"). */
  function buildUpdatePayload(d, freshProps) {
    const p = freshProps || d.props;
    const body = {
      document_type_id: p.document_type.id,
      document_fields: buildFieldsPayload(d),
      change_document_type_id: p.document_type.id,
      onr_status: p.onr_status == null ? null : p.onr_status,
      redirect_uri: p.redirect_uri == null ? null : p.redirect_uri,
      process_id: p.process_id == null ? null : p.process_id,
    };
    if (p.edit_keys_mode || !p.can_change_type) delete body.change_document_type_id;
    if (p.edit_keys_mode || !p.show_onr_status) delete body.onr_status;
    return body;
  }

  /** Corpo do POST de criação (igual ao da tela "Novo documento", sem anexos). */
  function buildCreatePayload(d) {
    const p = d.props;
    return {
      document_type_id: p.document_type.id,
      document_fields: buildFieldsPayload(d),
      redirect_uri: p.redirect_uri == null ? null : p.redirect_uri,
      process_part_id: p.process_part_id == null ? null : p.process_part_id,
      extraction_ids: [],
    };
  }

  /** Corpo do POST de cadastro de pessoa/empresa como parte (igual ao da tela "Cadastrar Pessoa física"). */
  function buildProfileStorePayload(d) {
    const p = d.props;
    return {
      profile_type_id: p.profile_type.id,
      document_type_id: p.document_type.id,
      document_fields: buildFieldsPayload(d),
      redirect_back_url: null,
      extraction_ids: [],
    };
  }

  /** Props da tela "Cadastrar <tipo de perfil>" → formato usado por initDoc (pré-preenchimento por campo). */
  function adaptProfileCreateProps(p, createUrl) {
    const pre = {};
    for (const [fid, v] of Object.entries(p.prefill_fields || {})) pre[fid] = { data: v && v.value != null ? v.value : '' };
    return {
      document_type: p.document_type,
      prefill_values: pre,
      profile_type: p.profile_type,
      store_url: p.store_url || null,
      create_url: createUrl || null,
    };
  }

  /** Erros de validação do Laravel/Inertia → por campo / gerais. */
  function flattenErrors(errs, prefix) {
    const out = {};
    if (!errs || typeof errs !== 'object') return out;
    for (const [k, v] of Object.entries(errs)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) out[key] = String(v[0]);
      else if (v && typeof v === 'object') Object.assign(out, flattenErrors(v, key));
      else if (v != null && v !== '') out[key] = String(v);
    }
    return out;
  }
  function mapErrors(d, errs) {
    const byField = {};
    const general = [];
    const list = [];
    for (const [k, msg] of Object.entries(errs)) {
      const m = k.match(/document_fields\.(\d+)/);
      const f = m && d.fields.find((x) => String(x.id) === m[1]);
      if (f) {
        byField[f.id] = msg;
        list.push(`${f.name}: ${msg}`);
      } else {
        general.push(msg);
        list.push(msg);
      }
    }
    return { byField, general, list };
  }

  /* ----- valores vindos de fora (ficha): texto, opções, conversão e comparação ----- */

  /** Texto normalizado para comparar (sem acento, minúsculo, espaços simples). */
  function normText(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[’‘`´]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uniq = (arr) => [...new Set(arr)];
  const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

  /** Radical para comparar "Casada" × "Casado(a)", "Viúva" × "Viúvo(a)". */
  function stemWord(t) {
    return String(t).replace(/\((?:a|o|as|os)\)/g, '').trim().replace(/[ao]s?$/, '');
  }

  /**
   * Escolhe, numa lista de opções { value, label }, a que corresponde ao texto.
   * Retorna { option } | { ambiguous: [...] } | { none: true }.
   */
  function pickOption(options, wanted) {
    const w = normText(wanted);
    if (!w) return { none: true };
    const list = options.map((o) => ({ o, t: normText(o.label) }));
    const segs = (t) => t.split(/\s+[-|]\s+/).map((s) => s.replace(/\s*\(.*\)\s*$/, '').trim());
    const ws = stemWord(w);
    const word = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`);
    const tiers = [
      (x) => x.t === w,
      (x) => x.t.startsWith(`${w} -`) || x.t.startsWith(`${w} (`) || x.t.startsWith(`${w} |`),
      (x) => segs(x.t).includes(w),
      (x) => ws.length >= 3 && !/\s/.test(w) && segs(x.t).some((s) => !/\s/.test(s) && stemWord(s) === ws),
      (x) => w.length >= 3 && word.test(x.t),
    ];
    for (const tier of tiers) {
      const hits = list.filter(tier);
      if (!hits.length) continue;
      if (hits.length === 1 || new Set(hits.map((x) => x.t)).size === 1) return { option: hits[0].o };
      return { ambiguous: hits.map((x) => x.o) };
    }
    return { none: true };
  }

  const UF_NAMES = {
    AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
    ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
    MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
    RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
    SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
  };

  /** "Planaltina/GO", "Guaíra-SP", "…Naturais de Planaltina/GO" → { city, uf, stateName }. */
  function splitCityUf(t) {
    const s = String(t == null ? '' : t).trim();
    const m = s.match(/^(.*?)\s*(?:\/|\s-\s|-|–|\()\s*([A-Za-z]{2})\)?\s*$/);
    if (!m) return null;
    const uf = m[2].toUpperCase();
    if (!UF_NAMES[uf]) return null;
    let city = m[1].trim();
    const inst = city.match(/^(?:cart[oó]rio|of[ií]cio|serventia|tabelionato|registro|servi[cç]o)\b.*\s(?:de|do|da|em)\s+(.+)$/i);
    if (inst) city = inst[1].trim();
    return city ? { city, uf, stateName: UF_NAMES[uf] } : null;
  }

  /** Valor externo de um campo de seleção → textos para comparar e buscas para fazer na NoCartório. */
  function selectSpec(v) {
    const o = v && typeof v === 'object' && !Array.isArray(v) ? v : { texto: v };
    const texto = String(o.texto != null ? o.texto : o.label != null ? o.label : o.busca != null ? o.busca : '').trim();
    const textos = [texto];
    const buscas = [];
    if (o.busca) buscas.push(String(o.busca).trim());
    const loc = splitCityUf(texto);
    if (loc) {
      textos.push(`${loc.city} - ${loc.stateName}`, `${loc.city} - ${loc.uf}`);
      buscas.push(loc.city, `${loc.city} - ${loc.uf}`);
    }
    buscas.push(texto.split(' - ')[0].trim(), texto);
    if (loc) textos.push(loc.city);
    return {
      texto,
      textos: uniq(textos.filter(Boolean)),
      buscas: uniq(buscas.filter(Boolean)),
      cns: o.cns ? String(o.cns).trim() : '',
      cityQuery: loc ? `${loc.city} - ${loc.uf}` : '',
    };
  }

  /** Texto de um valor externo (para mostrar). */
  function extText(v) {
    if (Array.isArray(v)) return v.map(extText).join(', ');
    if (v && typeof v === 'object') return String(v.texto != null ? v.texto : v.label != null ? v.label : v.busca != null ? v.busca : '');
    if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
    return String(v == null ? '' : v);
  }

  /**
   * Valor externo → valor do controle do campo. Seleções não são resolvidas aqui (precisam da NoCartório):
   * retorna { select: spec }. Demais: { state, warn } | { error } | { empty: true }.
   */
  function stateFromExternal(f, v) {
    const k = fieldKind(f);
    if (isBlank(v) || (v && typeof v === 'object' && !Array.isArray(v) && extText(v).trim() === '')) return { empty: true };
    if (Array.isArray(v)) return { error: 'lista de valores (campo múltiplo): preencha à mão' };
    if (k === 'select') return { select: selectSpec(v) };
    const raw = v && typeof v === 'object' ? extText(v) : v;
    switch (k) {
      case 'boolean': {
        if (raw === true || raw === false) return { state: raw };
        const s = normText(raw);
        if (['sim', 's', 'true', '1', 'yes', 'verdadeiro'].includes(s)) return { state: true };
        if (['nao', 'n', 'false', '0', 'no', 'falso'].includes(s)) return { state: false };
        return { error: `“${raw}” não é Sim/Não` };
      }
      case 'money': {
        const n = typeof raw === 'number' ? raw : parseBRL(String(raw));
        return Number.isFinite(n) && n >= 0 ? { state: n } : { error: `“${raw}” não é um valor em reais` };
      }
      case 'numeric': {
        const n = typeof raw === 'number' ? raw : parseNum(String(raw));
        return Number.isFinite(n) ? { state: String(n) } : { error: `“${raw}” não é um número` };
      }
      case 'date': {
        const s = normDate(raw);
        return validIsoDate(s) ? { state: s } : { error: `data “${raw}” inválida (use aaaa-mm-dd ou dd/mm/aaaa)` };
      }
      case 'time': {
        const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || (m[3] && Number(m[3]) > 59)) return { error: `hora “${raw}” inválida` };
        return { state: `${m[1].padStart(2, '0')}:${m[2]}${m[3] ? `:${m[3]}` : ''}` };
      }
      case 'datetime': {
        const s = normDateTime(raw);
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && validIsoDate(s.slice(0, 10)) ? { state: s } : { error: `data e hora “${raw}” inválida` };
      }
      case 'masked': {
        const s = applyMask(String(raw), MASKS[f.type]);
        if (!s) return { error: `“${raw}” não tem o formato esperado` };
        let warn = null;
        if (f.type === 'cpf' && !cpfOk(s)) warn = 'CPF com dígito verificador inválido — confira';
        if (f.type === 'cnpj' && /^\d{14}$/.test(digitsOf(s)) && !cnpjOk(s)) warn = 'CNPJ com dígito verificador inválido — confira';
        return { state: s, warn };
      }
      case 'matricula': {
        const t = digitsOf(raw);
        if (t.length !== 32) return { state: String(raw).trim(), warn: 'matrícula sem os 32 dígitos — confira' };
        return { state: matFormat(t), warn: matCheck(t) ? null : 'matrícula com dígito verificador inválido — confira' };
      }
      default:
        return { state: String(raw).trim() };
    }
  }

  /** Controle "vazio" (para decidir se o valor externo preenche ou só sugere). */
  function isEmptyState(f, st) {
    const k = fieldKind(f);
    if (k === 'boolean') return !st;
    return norm(k, dataFromState(f, st)) === '';
  }

  /** Mesmo valor (ignorando maiúsculas e acentos em textos). */
  function sameValue(f, a, b) {
    const k = fieldKind(f);
    if (k === 'string' || k === 'text') return normText(a) === normText(b);
    if (k === 'masked' || k === 'matricula') return digitsOf(a) === digitsOf(b) && digitsOf(a) !== '';
    return norm(k, dataFromState(f, a)) === norm(k, dataFromState(f, b));
  }

  /** Valor externo de um campo (documento > calculado > comum). */
  function extFor(ext, alias) {
    if (!ext || !alias) return null;
    const has = (o) => o && Object.prototype.hasOwnProperty.call(o, alias) && !isBlank(o[alias]);
    if (has(ext.values)) return { value: ext.values[alias], fonte: (ext.sources || {})[alias] || '', origem: 'documento' };
    if (has(ext.derived)) {
      const x = ext.derived[alias];
      return x && typeof x === 'object' && 'value' in x
        ? { value: x.value, fonte: x.fonte || '', origem: 'calculado' }
        : { value: x, fonte: '', origem: 'calculado' };
    }
    if (has(ext.fallback)) return { value: ext.fallback[alias], fonte: (ext.fallbackSources || {})[alias] || '', origem: 'comum' };
    return null;
  }

  /** Mesmo valor entre um dado externo e um campo de documento já cadastrado ({ value, display }). */
  function looseSame(f, extVal, ex) {
    if (!ex) return false;
    const exVal = ex.value != null && ex.value !== '' ? ex.value : ex.display;
    if (exVal == null || exVal === '') return false;
    const k = fieldKind(f);
    if (k === 'select') {
      const sp = selectSpec(extVal);
      const label = String(ex.display != null && ex.display !== '' ? ex.display : ex.value);
      return sp.textos.some((t) => pickOption([{ value: 1, label }], t).option != null);
    }
    if (k === 'masked' || k === 'matricula') return digitsOf(extText(extVal)) === digitsOf(exVal);
    if (k === 'date') return normDate(extText(extVal)) === normDate(exVal);
    if (k === 'money') {
      const a = typeof extVal === 'number' ? extVal : parseBRL(extText(extVal));
      const b = typeof exVal === 'number' ? exVal : parseBRL(String(exVal));
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
    }
    if (k === 'numeric') return parseNum(extText(extVal)) === parseNum(exVal);
    if (k === 'boolean') return toBool(extVal) === toBool(exVal);
    return normText(extText(extVal)) === normText(exVal);
  }

  /**
   * Um documento já cadastrado é "o mesmo" que o externo? Compara os campos-chave informados
   * (ou, sem eles, o nome de identificação). Retorna 'igual' | 'diferente' | 'indefinido'.
   */
  function compareExisting(fields, extValues, existingById) {
    const has = (f) => !isBlank(extValues[f.alias]);
    const keys = fields.filter((f) => f.is_key && has(f));
    if (keys.length) return keys.every((f) => looseSame(f, extValues[f.alias], existingById[f.id])) ? 'igual' : 'diferente';
    const idf = fields.find((f) => f.alias === 'identificador_registro' && has(f));
    if (idf) return looseSame(idf, extValues[idf.alias], existingById[idf.id]) ? 'igual' : 'diferente';
    return 'indefinido';
  }

  /** "NOME | Pessoa física | Número do CPF: 000.000.000-00" → partes do rótulo de busca de perfis. */
  function parseProfileLabel(label) {
    const parts = String(label == null ? '' : label).split(' | ');
    return { name: (parts[0] || '').trim(), typeName: (parts[1] || '').trim(), rest: parts.slice(2).join(' | ').trim() };
  }

  /** Papéis do ato a partir do item da lista de atos do serviço (api v2 protocols/{id}/processes). */
  function parseActInputs(it) {
    const caps = (it && it.capabilities) || {};
    const roles = Object.values((it && it.inputs) || {})
      .filter((x) => x && x.meta && x.meta.processTypeRoleId)
      .map((x) => ({
        ptrId: x.meta.processTypeRoleId,
        label: String(x.label || ''),
        // igual à tela nativa: readonly || !capabilities.canRegisterAct
        readonly: !!x.readonly || !caps.canRegisterAct,
        selection: (x.initialSelection || []).map((s) => ({ profileId: s.value, label: String(s.label || '') })),
        types: (x.dropdownLinks || [])
          .map((l) => {
            const m = String((l && l.url) || '').match(/\/part-profile\/[0-9a-f-]{36}\/(\d+)\/create/i);
            return m ? { profileTypeId: Number(m[1]), label: String(l.label || '') } : null;
          })
          .filter(Boolean),
      }));
    return {
      processId: it && it.id,
      code: (it && it.code) || '',
      name: (it && it.processType && it.processType.name) || '',
      canRegisterAct: !!caps.canRegisterAct,
      roles,
    };
  }

  const PURE = {
    parseBRL, moneyToCents, parseMoneyInput, fmtBRL, parseNum, toBool, normDate, fmtDate, normTime, normDateTime, validIsoDate,
    applyMask, MASKS, matCheck, matFormat, cpfOk, cnpjOk, fieldKind, stateFromRaw, dataFromState, norm, showState, shortName,
    isLocked, fieldChanged, effectiveData, initDoc, buildFieldsPayload, buildUpdatePayload, buildCreatePayload,
    buildProfileStorePayload, adaptProfileCreateProps, flattenErrors, mapErrors,
    normText, stemWord, pickOption, splitCityUf, selectSpec, extText, stateFromExternal, isEmptyState, sameValue, extFor,
    looseSame, compareExisting, parseProfileLabel, parseActInputs,
  };

  // Permite testar as funções puras fora do navegador (node).
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__NCU_LOADED__) return;
  window.__NCU_LOADED__ = true;

  /* =====================================================================================
   * 2. REDE — mesmos endereços e cabeçalhos que a NoCartório usa
   * ===================================================================================== */

  const PROCESS_RE = /^\/admin\/manager\/v2\/process\/([0-9a-f-]{36})(?:\/|$)/i;
  const PART_RE = /^\/admin\/manager\/v2\/process\/([0-9a-f-]{36})\/part\/([0-9a-f-]{36})\/?$/i;
  const PROCESS_EDIT_RE = /^\/admin\/manager\/v2\/process\/([0-9a-f-]{36})\/edit\/?$/i;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  class UErr extends Error {}

  function xsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function routeUrl(name, params) {
    try {
      const app = document.getElementById('app');
      const r = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.route;
      if (typeof r === 'function') return String(r(name, params));
    } catch (e) {
      /* usa o modelo abaixo */
    }
    const qs = (skip) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (!skip.includes(k) && v != null) sp.set(k, v);
      const s = sp.toString();
      return s ? `?${s}` : '';
    };
    const base = '/admin/manager/v2/profile';
    const P = params;
    switch (name) {
      case 'v2.admin.manager.document.edit':
        return `${base}/${P.profile}/document/${P.document}/edit${qs(['profile', 'document'])}`;
      case 'v2.admin.manager.document.create':
        return `${base}/${P.profile}/document/${P.document_type}/create${qs(['profile', 'document_type'])}`;
      case 'v2.admin.manager.document.update':
        return `${base}/${P.profile}/document/${P.document}`;
      case 'v2.admin.manager.document.store':
        return `${base}/${P.profile}/document/${P.document_type}`;
      case 'v2.admin.manager.document.index':
        return `${base}/${P.profile}/document${qs(['profile'])}`;
      case 'v2.admin.manager.process.part-profile.create':
        return `/admin/manager/v2/process/${P.process}/part-profile/${P.processTypeRole}/${P.profileType}/create${qs(['process', 'processTypeRole', 'profileType'])}`;
      case 'v2.api.manager.protocols.processes':
        return `/api/v2/protocols/${P.protocol}/processes${qs(['protocol'])}`;
      case 'api.process.attach-profile':
        return `/api/process/${P.process_id}/process-type-role/${P.process_type_role_id}/attach-profile`;
      case 'api.process.part.document.attach':
        return `/api/process/${P.process_id}/part/${P.part_id}/document-type/${P.document_type_id}/attach`;
      case 'api.profiles.search-by-process-type-role-autocomplete':
        return `/api/profiles/search-by-process-type-role-autocomplete${qs([])}`;
      default:
        throw new UErr(`Rota desconhecida: ${name}`);
    }
  }

  async function timedFetch(url, init, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 60000);
    try {
      return await fetch(url, { credentials: 'same-origin', ...init, signal: ctl.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new UErr('A NoCartório demorou demais para responder.');
      throw new UErr(`Falha de rede: ${e && e.message ? e.message : e}`);
    } finally {
      clearTimeout(t);
    }
  }

  const Net = {
    version: null,
    currentVersion() {
      return this.version || (history.state && history.state.page && history.state.page.version) || '';
    },
    headers(extra) {
      return Object.assign(
        {
          'X-Inertia': 'true',
          'X-Inertia-Version': this.currentVersion(),
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'text/html, application/xhtml+xml',
        },
        extra || {}
      );
    },
    /** Dados (props) de uma página da NoCartório, como a própria aplicação os recebe. */
    async page(url, extraHeaders) {
      const res = await timedFetch(url, { headers: this.headers(extraHeaders) });
      if (res.status === 409) return this.pageFromHtml(url); // a NoCartório foi atualizada desde que a aba abriu
      if (res.status === 401 || res.status === 419) throw new UErr('Sessão expirada. Recarregue a página e entre de novo.');
      if (res.status === 403) throw new UErr('Sem permissão para abrir esta página.');
      if (res.status === 404) throw new UErr('Não encontrado.');
      if (!res.ok) throw new UErr(`A NoCartório respondeu com erro (${res.status}).`);
      if (!res.headers.get('x-inertia')) throw new UErr('Resposta inesperada (a sessão pode ter expirado).');
      const j = await res.json();
      if (j && j.version) this.version = j.version;
      return j;
    },
    async pageFromHtml(url) {
      const res = await timedFetch(url, { headers: { Accept: 'text/html' } });
      if (!res.ok) throw new UErr(`A NoCartório respondeu com erro (${res.status}).`);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const s = doc.querySelector('script[data-page]');
      const app = doc.getElementById('app');
      const txt = (s && s.textContent) || (app && app.getAttribute('data-page'));
      if (!txt) throw new UErr('Não consegui ler a página (a sessão pode ter expirado).');
      const j = JSON.parse(txt);
      if (j && j.version) this.version = j.version;
      return j;
    },
    async json(url, params) {
      const u = new URL(url, location.origin);
      if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const res = await timedFetch(u.toString(), { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      if (res.status === 401 || res.status === 419) throw new UErr('Sessão expirada. Recarregue a página e entre de novo.');
      if (!res.ok) throw new UErr(`A NoCartório respondeu com erro (${res.status}).`);
      return res.json();
    },
    /** PUT/POST no formato do Inertia. Retorna { errors } (vazio = aceito) ou { uncertain: true }. */
    async send(method, url, body) {
      const res = await timedFetch(
        url,
        {
          method,
          redirect: 'follow',
          headers: this.headers({ 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrfToken() }),
          body: JSON.stringify(body),
        },
        90000
      );
      if (res.status === 419) throw new UErr('Sessão expirada (419): nada foi gravado. Recarregue a página e entre de novo.');
      if (res.status === 403) throw new UErr('Sem permissão (403): nada foi gravado.');
      if (res.status === 422) {
        let j = {};
        try {
          j = await res.json();
        } catch (e) {
          /* sem corpo */
        }
        const errs = flattenErrors(j.errors || {});
        if (!Object.keys(errs).length) errs._ = j.message || 'Dados inválidos.';
        return { errors: errs };
      }
      if (res.status === 409) return { errors: {}, uncertain: true };
      if (res.ok && res.headers.get('x-inertia')) {
        const page = await res.json();
        if (page && page.version) this.version = page.version;
        return { errors: flattenErrors((page && page.props && page.props.errors) || {}), page };
      }
      if (res.status >= 500) throw new UErr(`Erro no servidor da NoCartório (${res.status}).`);
      if (!res.ok) throw new UErr(`A NoCartório recusou (${res.status}).`);
      return { errors: {}, uncertain: true };
    },
    /** POST nas APIs JSON da NoCartório (incluir parte, vincular documento). Retorna { ok, data } | { ok: false, message }. */
    async apiPost(url, body) {
      const res = await timedFetch(
        url,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-XSRF-TOKEN': xsrfToken(),
          },
          body: JSON.stringify(body || {}),
        },
        90000
      );
      let j = null;
      try {
        j = await res.json();
      } catch (e) {
        /* sem corpo */
      }
      if (res.status === 401 || res.status === 419) throw new UErr('Sessão expirada (419): nada foi gravado. Recarregue a página e entre de novo.');
      if (res.status === 403) return { ok: false, message: (j && j.message) || 'Sem permissão (403).' };
      if (res.status === 422) {
        const errs = flattenErrors((j && j.errors) || {});
        return { ok: false, message: (j && j.message) || Object.values(errs)[0] || 'Dados inválidos.' };
      }
      if (res.status >= 500) throw new UErr(`Erro no servidor da NoCartório (${res.status}).`);
      if (!res.ok) return { ok: false, message: (j && j.message) || `A NoCartório recusou (${res.status}).` };
      return { ok: true, data: j };
    },
  };

  const listUrl = (processId, partId) => `/api/process/${processId}/part/${partId}/documents`;
  const partPageUrl = (processId, partId) => `/admin/manager/v2/process/${processId}/part/${partId}`;
  const actUrl = (processId) => `/admin/manager/v2/process/${processId}/edit`;
  const editUrlOf = (ctx, docId) =>
    routeUrl('v2.admin.manager.document.edit', { profile: ctx.profileId, document: docId, redirect_uri: ctx.pageUrl, process_id: ctx.processId });
  const editUrl = (d) => editUrlOf(d.ctx, d.docId);
  const createUrl = (d) =>
    routeUrl('v2.admin.manager.document.create', d.ctx.partId
      ? { document_type: d.typeId, profile: d.ctx.profileId, redirect_uri: d.ctx.pageUrl, process_part_id: d.ctx.partId }
      : { document_type: d.typeId, profile: d.ctx.profileId });

  async function pool(items, n, fn) {
    const queue = items.slice();
    const workers = [];
    for (let i = 0; i < Math.min(n, queue.length); i++) {
      workers.push(
        (async () => {
          while (queue.length) await fn(queue.shift());
        })()
      );
    }
    await Promise.all(workers);
  }

  /* ----- leituras auxiliares (papéis do ato, documentos do perfil, opções de seleção) ----- */

  /** Papéis do ato (com os perfis já incluídos em cada um), pela lista de atos do serviço. */
  async function fetchActRoles(protocolId, processId) {
    if (!protocolId) return null;
    for (let page = 1; page <= 20; page++) {
      const j = await Net.json(routeUrl('v2.api.manager.protocols.processes', { protocol: protocolId }), { page });
      const flat = [];
      const walk = (p) => {
        if (!p || typeof p !== 'object') return;
        flat.push(p);
        if (Array.isArray(p.children)) p.children.forEach(walk);
      };
      (Array.isArray(j && j.data) ? j.data : []).forEach(walk);
      const it = flat.find((p) => p.id === processId);
      if (it) return parseActInputs(it);
      const last = (j && (j.last_page || (j.meta && j.meta.last_page))) || 1;
      if (page >= last) break;
    }
    return null;
  }

  // Documentos de cada perfil (para oferecer "Vincular" um já cadastrado e comparar com a ficha).
  const profileDocsCache = new Map();
  function normProfileDoc(x) {
    const fields = {};
    for (const grp of x.document_fields || []) {
      for (const f of grp.fields || []) {
        if (f && f.document_field_type_id != null && (f.value != null || f.display != null)) fields[f.document_field_type_id] = { value: f.value, display: f.display };
      }
    }
    return {
      id: x.id,
      typeId: x.document_type_id,
      typeName: (x.document_type && x.document_type.name) || '',
      createdAt: (x.dates && x.dates.created_at) || '',
      temporary: !!(x.flags && x.flags.is_temporary),
      fields,
    };
  }
  function profileDocs(profileId) {
    if (profileDocsCache.has(profileId)) return profileDocsCache.get(profileId);
    const p = (async () => {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const url = routeUrl('v2.admin.manager.document.index', { profile: profileId, page });
        const pg = await Net.page(url, { 'X-Inertia-Partial-Component': 'Document/Index/Index', 'X-Inertia-Partial-Data': 'documents' });
        const docs = pg && pg.props && pg.props.documents;
        if (!docs || !Array.isArray(docs.data)) break;
        all.push(...docs.data.map(normProfileDoc));
        const last = (docs.meta && docs.meta.last_page) || 1;
        if (page >= last) break;
      }
      return all;
    })();
    profileDocsCache.set(profileId, p);
    p.catch(() => profileDocsCache.delete(profileId));
    return p;
  }

  // Opções dos campos de seleção (mesma busca que a tela nativa faz).
  const optCache = new Map();
  function fetchOptions(f, q) {
    const key = `${f.data_url}\u0000${q}`;
    if (!optCache.has(key)) {
      const p = Net.json(f.data_url, { q }).then((res) => {
        const arr = Array.isArray(res) ? res : res && Array.isArray(res.data) ? res.data : [];
        return arr
          .filter((o) => o && typeof o === 'object')
          .map((o) => ({ value: o.id != null ? o.id : o.value, label: String(o.name != null ? o.name : o.label != null ? o.label : o.text != null ? o.text : o.id) }));
      });
      optCache.set(key, p);
      p.catch(() => optCache.delete(key));
    }
    return optCache.get(key);
  }

  /** Texto externo → opção do campo. { option, guess } | { ambiguous } | { none }. */
  async function resolveSelect(f, spec) {
    let amb = null;
    for (const q of spec.buscas.slice(0, 6)) {
      const opts = await fetchOptions(f, q);
      if (!opts.length) continue;
      let cands = opts;
      if (spec.cns) {
        const c = opts.filter((o) => normText(o.label).includes(normText(spec.cns)));
        if (c.length === 1) return { option: c[0] };
        if (!c.length) continue;
        cands = c;
      }
      for (const t of spec.textos) {
        const r = pickOption(cands, t);
        if (r.option) return r;
        if (r.ambiguous && !amb) amb = r.ambiguous;
      }
      if (!amb && spec.cityQuery && q === spec.cityQuery && cands.length === 1) return { option: cands[0], guess: true };
    }
    return amb ? { ambiguous: amb } : { none: true };
  }

  /** Perfis encontrados pela mesma busca do seletor de partes do ato (só tipos aceitos no papel). */
  async function searchProfilesForRole(processId, ptrId, q) {
    const url = routeUrl('api.profiles.search-by-process-type-role-autocomplete', { id: ptrId, process_id: processId });
    const j = await Net.json(url, { q });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    return arr.filter((o) => o && o.id).map((o) => ({ id: o.id, label: String(o.name != null ? o.name : o.label || '') }));
  }

  /** Perfil já cadastrado com o CPF/CNPJ (ou outra chave) informado? */
  async function findProfileByKey(pe, ptrIds) {
    if (!pe || !pe.keyDoc || !pe.keyDoc.value) return null;
    const keyDigits = digitsOf(pe.keyDoc.value);
    const want = normText(pe.profileTypeName || '');
    for (const ptrId of ptrIds) {
      let res;
      try {
        res = await searchProfilesForRole(S.act.processId, ptrId, String(pe.keyDoc.value));
      } catch (e) {
        continue;
      }
      const hits = res.filter((r) => {
        const L = parseProfileLabel(r.label);
        if (want && normText(L.typeName) !== want) return false;
        return keyDigits.length >= 11 ? digitsOf(L.rest).includes(keyDigits) : normText(r.label).includes(normText(pe.keyDoc.value));
      });
      if (hits.length) return hits[0];
    }
    return null;
  }

  /* =====================================================================================
   * 3. ESTADO E CARREGAMENTO
   *
   * O painel carrega o ATO inteiro: todas as partes, agrupadas por perfil (pessoa/imóvel).
   * Se a mesma pessoa aparece em mais de uma parte (ex.: Cedente e Sacador), os documentos
   * dela aparecem uma vez só. "Campos em comum" compara documentos dentro de cada perfil,
   * nunca entre perfis diferentes.
   *
   * Com dados prontos (S.ext), entram também perfis que ainda não estão no ato ("virtuais":
   * pessoa nova ou cadastrada fora do ato), com os papéis a incluir e os documentos a gravar.
   * ===================================================================================== */

  const S = {
    open: false,
    loading: false,
    saving: false,
    fatal: null,
    loadMsg: '',
    act: null,
    groups: [],
    docs: [],
    simulate: false,
    needsReload: false,
    ext: null,
    extRoles: null,
    extWarnings: [],
    partProfile: new Map(),
  };
  try {
    S.simulate = localStorage.getItem('ncu:simulate') === '1';
  } catch (e) {
    /* sem armazenamento */
  }

  function actFromPage(page, processId, focusPartId) {
    const L = (page && page.props && page.props.layout) || {};
    const parts = (Array.isArray(L.parts) ? L.parts : [])
      .filter((p) => p && p.partId)
      .map((p) => ({ partId: p.partId, name: p.name || '', role: p.role || '' }));
    // ato sem nenhuma parte ainda é válido (a ficha pode incluir todas); erro só se a página não trouxer a lista
    if (!Array.isArray(L.parts)) throw new UErr('Não encontrei as partes deste ato nesta página.');
    return {
      processId,
      protocolId: (L.protocol && L.protocol.id) || null,
      code: L.code || '',
      actName: (L.processType && L.processType.name) || '',
      parts,
      focusPartId: focusPartId || null,
    };
  }

  /** Perfil (pessoa/imóvel) de uma parte. Pede só o bloco "content" da página da parte. */
  async function loadPartInfo(act, part) {
    const url = partPageUrl(act.processId, part.partId);
    const pick = (page) => {
      const c = page && page.props && page.props.content;
      if (!c || !c.part || !c.part.profileId) return null;
      const prof = c.profile || {};
      return {
        profileId: c.part.profileId,
        profileName: prof.name || part.name || part.role,
        profileType: (prof.profileType && prof.profileType.name) || (c.part.profileType && c.part.profileType.name) || '',
        pageUrl: (page && page.url) || url,
      };
    };
    let info = pick(await Net.page(url, { 'X-Inertia-Partial-Component': 'Process/pages/part/Index', 'X-Inertia-Partial-Data': 'content' }));
    if (!info) info = pick(await Net.page(url));
    if (!info) throw new UErr('Não encontrei os dados desta parte.');
    S.partProfile.set(part.partId, info);
    return info;
  }

  let docSeq = 0;
  function bareDoc(g, typeId, typeName, mode) {
    return {
      key: `d${++docSeq}`,
      item: null,
      ctx: { processId: S.act ? S.act.processId : null, profileId: g ? g.profileId : null, partId: null, pageUrl: location.pathname },
      group: g || null,
      roles: [],
      pendingIn: [],
      extraParts: [],
      alsoLink: false,
      typeId,
      typeName,
      short: shortName(typeName),
      docId: null,
      docName: '',
      currentDocId: null,
      mode,
      active: false,
      reason: '',
      props: null,
      createProps: null,
      fields: [],
      original: {},
      values: {},
      dirty: new Set(),
      errors: {},
      generalErrors: [],
      notices: {},
      status: null,
      loadError: null,
      loading: false,
      fileRequired: false,
      nChg: 0,
      virtual: false,
      ext: null,
      xinfo: new Map(),
      candidates: null,
      noDefs: false,
      consumed: false,
    };
  }

  function makeDoc(it, ctx, role) {
    const cur = it.currentDocument || null;
    const d = bareDoc(null, it.documentType.id, it.documentType.name, 'unavailable');
    d.item = it;
    d.ctx = ctx;
    d.roles = [role];
    d.docId = cur ? cur.id : null;
    d.docName = cur ? cur.name : '';
    d.currentDocId = cur ? cur.id : null;
    const r = it.rendering || {};
    if (cur) {
      if (r.canBeEdited === false) d.reason = 'A NoCartório não permite editar este documento aqui.';
      else {
        d.mode = 'edit';
        d.active = true;
      }
    } else if (r.canBeAddedManually) {
      d.mode = 'create';
    } else {
      d.reason = 'Este tipo não pode ser cadastrado manualmente.';
    }
    return d;
  }

  function newGroup(idx, info, part) {
    return {
      key: `g${idx}`,
      profileId: info ? info.profileId : null,
      name: info ? info.profileName : part.name || part.role || 'Parte',
      profileType: info ? info.profileType : '',
      parts: [],
      docs: [],
      common: {},
      commonCollapsed: false,
      collapsed: false,
      divergences: [],
      loadError: null,
      nChg: 0,
      virtual: false,
      isNew: false,
      plannedRoles: [],
      keyDoc: null,
      ext: null,
      extNotes: [],
      status: null,
    };
  }

  /** Num perfil com mais de uma parte, junta itens do mesmo tipo para não oferecer duplicatas. */
  function mergeGroupDocs(g) {
    const out = [];
    for (const d of g.docs) {
      if (d.mode === 'edit' || d.docId) {
        out.push(d);
        continue;
      }
      const host = g.docs.find((x) => x !== d && x.mode === 'edit' && x.typeId === d.typeId);
      if (host) {
        for (const r of d.roles) if (!host.roles.includes(r) && !host.pendingIn.includes(r)) host.pendingIn.push(r);
        if (d.mode === 'create' && d.ctx.partId && !host.extraParts.some((p) => p.partId === d.ctx.partId)) host.extraParts.push({ partId: d.ctx.partId, role: d.roles[0], pageUrl: d.ctx.pageUrl });
        continue;
      }
      const twin = out.find((x) => !x.docId && x.mode === d.mode && x.typeId === d.typeId);
      if (twin) {
        for (const r of d.roles) if (!twin.roles.includes(r)) twin.roles.push(r);
        if (d.mode === 'create' && d.ctx.partId && !twin.extraParts.some((p) => p.partId === d.ctx.partId)) {
          twin.extraParts.push({ partId: d.ctx.partId, role: d.roles[0], pageUrl: d.ctx.pageUrl });
          twin.alsoLink = true; // criado para as duas partes da mesma pessoa: vincula nas duas
        }
        continue;
      }
      out.push(d);
    }
    g.docs = out;
  }

  function buildGroups(act, recs) {
    const groups = [];
    const byProfile = new Map();
    for (const part of act.parts) {
      const rec = recs.get(part.partId) || { error: 'Não carregou.' };
      let g = rec.info ? byProfile.get(rec.info.profileId) : null;
      if (!g) {
        g = newGroup(groups.length, rec.info, part);
        if (rec.info) byProfile.set(rec.info.profileId, g);
        groups.push(g);
      }
      const pageUrl = rec.info ? rec.info.pageUrl : partPageUrl(act.processId, part.partId);
      g.parts.push({ partId: part.partId, role: part.role, name: part.name, pageUrl });
      if (!rec.info) {
        g.loadError = rec.error || 'Não foi possível carregar esta parte.';
        continue;
      }
      for (const dv of rec.divergences || []) {
        if (dv && !g.divergences.some((x) => x.fieldTypeId === dv.fieldTypeId)) g.divergences.push(dv);
      }
      const ctx = { processId: act.processId, profileId: rec.info.profileId, partId: part.partId, pageUrl };
      for (const it of rec.items || []) {
        if (!it || !it.documentType) continue;
        const cur = it.currentDocument;
        const same = cur && g.docs.find((x) => x.docId === cur.id);
        if (same) {
          if (!same.roles.includes(part.role)) same.roles.push(part.role);
          continue;
        }
        const d = makeDoc(it, ctx, part.role);
        d.group = g;
        g.docs.push(d);
      }
    }
    for (const g of groups) mergeGroupDocs(g);
    S.groups = groups;
    S.docs = groups.flatMap((g) => g.docs);
  }

  async function loadDocProps(d) {
    const page = await Net.page(d.mode === 'create' ? createUrl(d) : editUrl(d));
    const p = (page && page.props) || {};
    if (!p.document_type || !Array.isArray(p.document_type.fields)) throw new UErr('A NoCartório respondeu num formato inesperado.');
    if (isExistingMode(d) && (!p.document || p.document.id !== d.docId)) throw new UErr('Documento não encontrado.');
    if (d.mode === 'create') d.createProps = p;
    initDoc(d, p);
  }

  const docChanged = (d) => !!d.props && d.fields.some((f) => fieldChanged(d, f));

  function activeDocs(g) {
    return (g ? g.docs : S.docs).filter(
      (d) => d.props && !d.loadError && (isExistingMode(d) || d.mode === 'newprofile' || (d.mode === 'create' && d.active))
    );
  }

  function hasChanges() {
    return collectOps().length > 0;
  }

  function setLoadMsg(t) {
    S.loadMsg = t;
    if (UI.loadMsg) UI.loadMsg.textContent = t;
  }

  /** Lista atualizada das partes do ato (a página aberta pode estar desatualizada ou ser de outro ato). */
  async function fetchAct(prev) {
    const here = location.pathname.match(PROCESS_RE);
    let page;
    if (here && here[1].toLowerCase() === String(prev.processId).toLowerCase()) {
      const comp = history.state && history.state.page && history.state.page.component;
      const partial = comp ? { 'X-Inertia-Partial-Component': comp, 'X-Inertia-Partial-Data': 'layout' } : undefined;
      page = await Net.page(location.pathname + location.search, partial);
    } else {
      page = await Net.page(actUrl(prev.processId), { 'X-Inertia-Partial-Component': 'Process/pages/general_info/Index', 'X-Inertia-Partial-Data': 'layout' });
    }
    return actFromPage(page, prev.processId, prev.focusPartId);
  }

  async function loadAct() {
    let act = S.act;
    S.loading = true;
    S.fatal = null;
    S.groups = [];
    S.docs = [];
    S.extWarnings = [];
    S.partProfile = new Map();
    profileDocsCache.clear();
    S.loadMsg = 'Carregando as partes do ato…';
    renderAll();
    try {
      act = await fetchAct(act);
    } catch (e) {
      if (!act.parts.length) {
        if (S.act !== act) return;
        S.fatal = `${e.message} Recarregue a página e tente de novo.`;
        S.loading = false;
        renderAll();
        return;
      }
    }
    if (!S.act || S.act.processId !== act.processId) return;
    S.act = act;
    renderHeader();
    try {
      const recs = new Map();
      let done = 0;
      await pool(act.parts, 4, async (part) => {
        const rec = {};
        try {
          const [info, api] = await Promise.all([loadPartInfo(act, part), Net.json(listUrl(act.processId, part.partId))]);
          rec.info = info;
          rec.items = (api && api.items) || [];
          rec.divergences = (api && api.dataDivergences && api.dataDivergences.items) || [];
        } catch (e) {
          rec.error = e.message;
        }
        recs.set(part.partId, rec);
        done++;
        setLoadMsg(`Carregando as partes do ato (${done}/${act.parts.length})…`);
      });
      if (S.act !== act) return;
      buildGroups(act, recs);
      const toLoad = S.docs.filter((d) => d.mode === 'edit');
      let n = 0;
      setLoadMsg(`Carregando documentos (0/${toLoad.length})…`);
      await pool(toLoad, 5, async (d) => {
        try {
          await loadDocProps(d);
        } catch (e) {
          d.loadError = e.message;
        }
        n++;
        setLoadMsg(`Carregando documentos (${n}/${toLoad.length})…`);
      });
      if (S.ext && S.act === act) await applyExt(act);
    } catch (e) {
      S.fatal = e.message;
    }
    if (S.act !== act) return;
    S.loading = false;
    renderAll();
    if (act.focusPartId) {
      const g = S.groups.find((x) => x.parts.some((p) => p.partId === act.focusPartId));
      if (g && S.groups.length > 1) requestAnimationFrame(() => scrollToGroup(g, 'auto'));
    }
  }

  /* ----- vínculo de documento já cadastrado no perfil ----- */

  function candidateLabel(d, x) {
    const keys = d.fields.filter((f) => f.is_key || f.alias === 'identificador_registro');
    const bits = [];
    for (const f of keys) {
      const v = x.fields[f.id];
      const t = v ? String(v.display != null && v.display !== '' ? v.display : v.value == null ? '' : v.value).trim() : '';
      if (t && !bits.includes(t)) bits.push(t);
    }
    const when = x.createdAt ? ` · cadastrado em ${fmtDate(String(x.createdAt).slice(0, 10))}` : '';
    return `${bits.slice(0, 3).join(' · ') || x.typeName || d.typeName}${when}`;
  }

  function extByAlias(d) {
    const out = {};
    if (!d.ext) return out;
    for (const f of d.fields) {
      const s = extFor(d.ext, f.alias);
      if (s) out[f.alias] = s.value;
    }
    return out;
  }

  /** Documentos do mesmo tipo já cadastrados no perfil (exceto o vinculado nesta parte), do mais novo ao mais antigo. */
  async function linkCandidates(d) {
    const pid = d.group && d.group.profileId;
    if (!pid || !d.fields.length) return [];
    let docs;
    try {
      docs = await profileDocs(pid);
    } catch (e) {
      return [];
    }
    const ext = d.ext ? extByAlias(d) : null;
    return docs
      .filter((x) => x.typeId === d.typeId && !x.temporary && x.id !== d.currentDocId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((x) => ({ id: x.id, label: candidateLabel(d, x), match: ext ? compareExisting(d.fields, ext, x.fields) : 'indefinido' }));
  }

  /**
   * Criar novo × vincular existente. Recarrega os campos conforme a escolha e reaplica os dados prontos.
   * dec = { create: true } | { link: docId }
   */
  async function setDecision(d, dec, opt) {
    d.loading = true;
    if (!opt || !opt.silent) renderAll();
    try {
      if (dec.link) {
        d.mode = 'link';
        d.docId = dec.link;
        d.active = true;
        const page = await Net.page(editUrl(d));
        const p = (page && page.props) || {};
        if (!p.document_type || !Array.isArray(p.document_type.fields) || !p.document || p.document.id !== d.docId) throw new UErr('Não consegui abrir o documento escolhido.');
        initDoc(d, p);
        const c = (d.candidates || []).find((x) => x.id === d.docId);
        d.docName = c ? c.label : '';
      } else {
        d.mode = 'create';
        d.docId = null;
        d.docName = '';
        d.active = true;
        if (!d.createProps) {
          const page = await Net.page(createUrl(d));
          const p = (page && page.props) || {};
          if (!p.document_type || !Array.isArray(p.document_type.fields)) throw new UErr('A NoCartório respondeu num formato inesperado.');
          d.createProps = d.virtual && d.tplProfile ? { ...p, prefill_values: {} } : p;
        }
        initDoc(d, d.createProps);
      }
      d.loadError = null;
      if (d.ext) await applyPrefill(d);
    } catch (e) {
      d.loadError = e.message;
    }
    d.loading = false;
    if (!opt || !opt.silent) renderAll();
  }

  /* ----- dados prontos (ficha) ----- */

  function validateExt(x) {
    if (!x || typeof x !== 'object') return 'Dados inválidos.';
    if (!UUID_RE.test(String(x.processId || ''))) return 'Ato não informado.';
    if (!Array.isArray(x.profiles)) return 'Lista de partes ausente.';
    for (const pe of x.profiles) {
      if (!pe || typeof pe !== 'object') return 'Parte inválida.';
      if (pe.profileId != null && !UUID_RE.test(String(pe.profileId))) return `Perfil inválido: ${pe.name || ''}`;
      if (!Array.isArray(pe.docs || [])) return `Documentos inválidos: ${pe.name || ''}`;
    }
    return null;
  }

  /** Aplica os valores externos aos campos do documento (preenche vazios; sugere quando diverge). */
  async function applyPrefill(d) {
    d.xinfo = new Map();
    if (!d.ext || !d.props) return;
    await Promise.all(
      d.fields.map((f) => {
        const src = extFor(d.ext, f.alias);
        return src ? applyExtField(d, f, src) : null;
      })
    );
    // campos da ficha que este formulário não tem (alias errado ou de outro tipo de documento)
    if (!d.unknownNoted && d.group) {
      const known = new Set(d.fields.map((f) => f.alias));
      const unknown = Object.keys(d.ext.values || {}).filter((a) => !known.has(a) && !isBlank(d.ext.values[a]));
      if (unknown.length) {
        d.unknownNoted = true;
        d.group.extNotes.push(`${d.typeName}: a ficha traz campos que este formulário não tem e foram ignorados: ${unknown.join(', ')}.`);
      }
    }
  }

  async function applyExtField(d, f, src) {
    const conv = stateFromExternal(f, src.value);
    if (conv.empty) return;
    const show = extText(src.value);
    if (conv.error) {
      d.xinfo.set(f.id, { kind: 'note', src, msg: `Ficha: “${show}” — ${conv.error}.` });
      return;
    }
    let st = conv.state;
    let warn = conv.warn || null;
    if (conv.select) {
      if (!f.data_url) {
        d.xinfo.set(f.id, { kind: 'note', src, msg: `Ficha: “${show}” — campo sem lista de opções; preencha à mão.` });
        return;
      }
      let r;
      try {
        r = await resolveSelect(f, conv.select);
      } catch (e) {
        d.xinfo.set(f.id, { kind: 'note', src, msg: `Ficha: “${show}” — erro ao buscar as opções (${e.message}).` });
        return;
      }
      if (r.ambiguous) {
        d.xinfo.set(f.id, { kind: 'choices', src, options: r.ambiguous.slice(0, 8), msg: `Ficha: “${show}” — mais de uma opção. Escolha:` });
        return;
      }
      if (!r.option) {
        d.xinfo.set(f.id, { kind: 'note', src, msg: `Ficha: “${show}” — opção não encontrada na NoCartório; escolha à mão.` });
        return;
      }
      st = { value: r.option.value, label: r.option.label };
      if (r.guess) warn = 'opção escolhida pela cidade — confira';
    }
    const cur = d.values[f.id];
    const curEmpty = isEmptyState(f, cur);
    if (!curEmpty && sameValue(f, cur, st)) {
      d.xinfo.set(f.id, { kind: 'same', src, warn });
      return;
    }
    if (isLocked(d, f)) {
      d.xinfo.set(f.id, { kind: 'note', src, msg: `Ficha: “${showState(f, st)}” — campo-chave, não é alterado aqui (use “editar chaves” na tela nativa).` });
      return;
    }
    if (curEmpty || d.mode === 'create' || d.mode === 'newprofile') {
      d.xinfo.set(f.id, { kind: 'filled', src, before: curEmpty ? null : cloneState(cur), warn });
      d.values[f.id] = st;
      d.dirty.add(f.id);
      return;
    }
    d.xinfo.set(f.id, { kind: 'suggest', src, state: st, warn });
  }

  function roleOf(ptrId) {
    return S.extRoles ? S.extRoles.roles.find((r) => r.ptrId === ptrId) || null : null;
  }

  function templateProfileFor(g) {
    const X = S.ext || {};
    const t = X.templates && g.ext && g.ext.profileTypeId != null ? X.templates[g.ext.profileTypeId] : null;
    if (t && UUID_RE.test(String(t))) return t;
    const same = S.groups.find((x) => x !== g && x.profileId && !x.virtual && normText(x.profileType) === normText(g.profileType));
    return same ? same.profileId : null;
  }

  async function applyExt(act) {
    const X = S.ext;
    setLoadMsg('Aplicando os dados da ficha…');
    S.extWarnings = (X.warnings || []).map(String);
    S.extRoles = null;
    try {
      S.extRoles = await fetchActRoles(act.protocolId, act.processId);
    } catch (e) {
      S.extWarnings.push(`Não consegui ler os papéis do ato: ${e.message}. Inclusões de partes ficam desativadas.`);
    }
    if (!S.extRoles && (X.profiles || []).some((pe) => (pe.addRoles || []).length)) {
      S.extWarnings.push('Não encontrei os papéis deste ato na lista do serviço: inclusões de partes ficam desativadas.');
    }
    let n = 0;
    const list = (X.profiles || []).map((pe, i) => ({ pe, i }));
    setLoadMsg(`Aplicando os dados da ficha (0/${list.length})…`);
    await pool(list, 3, async ({ pe, i }) => {
      try {
        const g = await applyExtProfile(pe);
        if (g) g.extIndex = i;
      } catch (e) {
        S.extWarnings.push(`${pe.name || 'Parte'}: ${e.message}`);
      }
      n++;
      setLoadMsg(`Aplicando os dados da ficha (${n}/${list.length})…`);
    });
    // ordem estável: partes do ato primeiro (como estão), depois as da ficha na ordem da ficha
    const pos = (g) => (g.virtual ? 1e6 + (g.extIndex || 0) : S.groups.indexOf(g));
    S.groups = S.groups.slice().sort((a, b) => pos(a) - pos(b));
    S.docs = S.groups.flatMap((g) => g.docs);
  }

  async function applyExtProfile(pe) {
    const roles = (pe.addRoles || []).map((r) => roleOf(r.ptrId) || null).filter(Boolean);
    // Pessoa "nova" pode ter sido cadastrada depois que a ficha foi lida (ou na gravação anterior).
    let profileId = pe.profileId || null;
    if (!profileId && pe.keyDoc && pe.keyDoc.value && S.extRoles) {
      const ptrs = uniq([...roles.map((r) => r.ptrId), ...S.extRoles.roles.map((r) => r.ptrId)]).slice(0, 3);
      const found = await findProfileByKey(pe, ptrs);
      if (found) profileId = found.id;
    }
    const isProperty = pe.kind === 'imovel';
    if (isProperty && !profileId) {
      // matrícula sem perfil na NoCartório: esta versão não cria o perfil do imóvel
      S.extWarnings.push(`${pe.name || 'Imóvel'}: sem cadastro (perfil) na NoCartório — não será incluído.`);
      return null;
    }
    let g = profileId ? S.groups.find((x) => x.profileId === profileId) : null;
    if (!g) {
      g = newGroup(S.groups.length, null, { name: pe.name, role: '' });
      g.key = `g${S.groups.length}x`;
      g.virtual = true;
      g.profileId = profileId;
      g.isNew = !profileId;
      g.name = pe.name || 'Parte';
      g.profileType = pe.profileTypeName || '';
      S.groups.push(g);
    }
    g.ext = pe;
    g.isProperty = isProperty;
    g.isAuxRecord = isProperty && Number(pe.livro) === 3; // registro do Livro 3 (Registro Auxiliar)
    g.extNotes = (pe.notes || []).map(String);
    for (const r of pe.addRoles || []) {
      if (!roleOf(r.ptrId)) {
        if (S.extRoles) g.extNotes.push(`Papel “${r.label}” não existe neste ato: não será incluído.`);
        continue;
      }
    }
    g.plannedRoles = roles.filter((r) => {
      if (g.parts.some((p) => normText(p.role) === normText(r.label))) return false;
      if (r.selection.some((s) => profileId && s.profileId === profileId)) return false;
      if (r.readonly) {
        g.extNotes.push(`Papel “${r.label}”: o ato não permite incluir partes agora (ato já lavrado, cancelado ou sem pagamento?).`);
        return false;
      }
      return true;
    });
    if (g.virtual && !g.plannedRoles.length) g.extNotes.push('Esta parte não está no ato e nenhum papel será incluído: os dados dela não serão gravados.');
    if (g.isNew) await prepareNewProfile(g, pe);
    const seen = new Set();
    const jobs = [];
    for (const xd of pe.docs || []) {
      if (!xd || !Number.isFinite(Number(xd.typeId))) continue;
      const typeId = Number(xd.typeId);
      if (g.keyDoc && typeId === g.keyDoc.typeId) continue; // usado no cadastro da pessoa
      if (seen.has(typeId)) {
        g.extNotes.push(`${xd.typeName || `Tipo ${typeId}`}: a ficha traz mais de um documento deste tipo para esta parte; só o primeiro foi usado.`);
        continue;
      }
      seen.add(typeId);
      // começa todos juntos (cada um faz as suas buscas); a ordem dos cartões segue a da ficha
      jobs.push(
        applyExtDoc(g, { ...xd, typeId }).catch((e) => {
          g.extNotes.push(`${xd.typeName || `Tipo ${typeId}`}: ${e.message}`);
        })
      );
    }
    await Promise.all(jobs);
    return g;
  }

  /** Pessoa nova: carrega a tela "Cadastrar <tipo>" do primeiro papel e preenche o documento principal (CPF/CNPJ). */
  async function prepareNewProfile(g, pe) {
    const role = g.plannedRoles[0];
    if (!role) {
      g.extNotes.push('Pessoa não cadastrada e sem papel neste ato: não dá para cadastrá-la por aqui.');
      return;
    }
    let typeId = pe.profileTypeId;
    const okType = role.types.find((t) => t.profileTypeId === typeId) || role.types.find((t) => normText(t.label) === normText(pe.profileTypeName));
    if (!okType) {
      g.extNotes.push(`O papel “${role.label}” não aceita “${pe.profileTypeName || 'este tipo de parte'}”.`);
      return;
    }
    typeId = okType.profileTypeId;
    const url = routeUrl('v2.admin.manager.process.part-profile.create', { process: S.act.processId, processTypeRole: role.ptrId, profileType: typeId });
    const page = await Net.page(url);
    const p = page && page.props;
    if (!p || !p.document_type || !Array.isArray(p.document_type.fields) || !p.profile_type) throw new UErr('Não consegui abrir o cadastro de pessoa deste papel.');
    const d = bareDoc(g, p.document_type.id, p.document_type.name, 'newprofile');
    d.virtual = true;
    d.active = true;
    initDoc(d, adaptProfileCreateProps(p, url));
    d.createRole = role;
    const xd = (pe.docs || []).find((x) => Number(x.typeId) === p.document_type.id) || { typeId: p.document_type.id };
    const values = { ...(xd.values || {}) };
    if (pe.keyDoc && pe.keyDoc.alias && isBlank(values[pe.keyDoc.alias])) values[pe.keyDoc.alias] = pe.keyDoc.value;
    if (pe.name && isBlank(values.nome) && d.fields.some((f) => f.alias === 'nome')) values.nome = pe.name;
    d.ext = { ...xd, values };
    await applyPrefill(d);
    g.keyDoc = d;
    g.profileType = p.profile_type.name || g.profileType;
    g.docs.unshift(d);
  }

  async function applyExtDoc(g, xd) {
    if (!g.virtual) {
      const d = g.docs.find((x) => x.typeId === xd.typeId && x.mode !== 'newprofile');
      if (d) return applyExtToRealDoc(g, d, xd);
      if (g.plannedRoles.length) return addPendingDoc(g, xd);
      g.extNotes.push(
        `${xd.typeName || `Tipo ${xd.typeId}`}: a NoCartório não pede este documento para ${g.parts.map((p) => p.role).join(' / ') || 'esta parte'} neste ato — não será gravado.`
      );
      return null;
    }
    return addPendingDoc(g, xd);
  }

  async function applyExtToRealDoc(g, d, xd) {
    d.ext = xd;
    if (d.extraParts.length) d.alsoLink = true;
    if (d.mode === 'edit') {
      if (d.props && !d.loadError) await applyPrefill(d);
      return;
    }
    if (d.mode === 'create') {
      d.active = true;
      try {
        await loadDocProps(d);
      } catch (e) {
        d.loadError = e.message;
        return;
      }
      d.candidates = await linkCandidates(d);
      const match = d.candidates.find((c) => c.match === 'igual');
      if (match) await setDecision(d, { link: match.id }, { silent: true });
      else await applyPrefill(d);
      return;
    }
    g.extNotes.push(`${d.typeName}: ${d.reason || 'a NoCartório não permite cadastrar este documento aqui'} — dados da ficha não aplicados.`);
  }

  /** Documento de uma parte que ainda vai ser incluída no ato: gravado depois da inclusão. */
  async function addPendingDoc(g, xd) {
    const d = bareDoc(g, xd.typeId, xd.typeName || `Tipo ${xd.typeId}`, 'create');
    d.virtual = true;
    d.active = true;
    d.alsoLink = true;
    d.ext = xd;
    g.docs.push(d);
    const tpl = g.profileId || templateProfileFor(g);
    if (!tpl) {
      d.noDefs = true;
      return;
    }
    try {
      d.tplProfile = g.profileId ? null : tpl;
      const page = await Net.page(routeUrl('v2.admin.manager.document.create', { document_type: xd.typeId, profile: tpl }));
      const p = page && page.props;
      if (!p || !p.document_type || !Array.isArray(p.document_type.fields)) throw new UErr('formato inesperado');
      d.typeName = p.document_type.name || d.typeName;
      d.short = shortName(d.typeName);
      // perfil-modelo: só a lista de campos; nunca os dados dele
      d.createProps = g.profileId ? p : { ...p, prefill_values: {} };
      initDoc(d, d.createProps);
      if (g.profileId) {
        d.candidates = await linkCandidates(d);
        const match = d.candidates.find((c) => c.match === 'igual');
        if (match) {
          await setDecision(d, { link: match.id }, { silent: true });
          return;
        }
      }
      await applyPrefill(d);
    } catch (e) {
      d.props = null;
      d.noDefs = true;
      d.defsError = e.message;
    }
  }

  /* =====================================================================================
   * 4. INTERFACE
   * ===================================================================================== */

  const UI = {};

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  function svg(paths, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  }
  const ICON_STACK = ['M4 6h16', 'M4 12h16', 'M4 18h10', 'M18 16l3 3-3 3'];
  const ICON_DOWN = ['M6 9l6 6 6-6'];
  const ICON_RIGHT = ['M9 6l6 6-6 6'];

  const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none !important}
.ov{position:fixed;inset:0;z-index:2147482000;background:rgba(17,17,17,.5);display:flex;padding:12px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1c1917;-webkit-font-smoothing:antialiased}
.panel{position:relative;margin:auto;width:100%;max-width:1680px;height:100%;background:#f5f5f4;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.4)}
.hd{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#141414;color:#fafaf9;flex-wrap:wrap}
.t1{font-size:15px;font-weight:650}
.t1 .ver{font-size:11px;font-weight:400;color:#a8a29e;margin-left:6px}
.t2{font-size:12px;color:#d6d3d1;margin-top:1px}
.t2 .src{color:#fdba74}
.hd-act{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sim{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#e7e5e4;cursor:pointer;user-select:none}
.btn{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid #d6d3d1;background:#fff;color:#1c1917;border-radius:7px;padding:6px 12px;cursor:pointer;line-height:1.2;white-space:nowrap}
.btn:hover:not(:disabled){background:#fafaf9}
.btn:focus-visible,.in:focus-visible,.si-name:focus-visible,.sg-hd:focus-visible,.grp-tg:focus-visible,.chip:focus-visible,.xbtn:focus-visible,.dec:focus-visible{outline:2px solid #fb923c;outline-offset:1px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:#ea580c;border-color:#ea580c;color:#fff;font-weight:600}
.btn.primary:hover:not(:disabled){background:#c2410c}
.hd .btn:not(.primary){background:#262626;border-color:#404040;color:#fafaf9}
.hd .btn:not(.primary):hover:not(:disabled){background:#333}
.hd .btn.warnbtn{border-color:#f59e0b;color:#fde68a}
.btn.sm{padding:4px 9px;font-size:12px}
.btn.ghost{background:transparent;border-color:transparent;color:#57534e}
.bd{flex:1;display:flex;min-height:0}
.side{width:310px;flex:none;background:#fff;border-right:1px solid #e7e5e4;overflow:auto;padding:8px 0}
.side-hd{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#78716c;padding:6px 14px}
.sg{padding:4px 0 6px;border-top:1px solid #f5f5f4}
.sg-hd{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;padding:6px 14px 3px 11px;border-left:3px solid transparent}
.sg.dirty .sg-hd{border-left-color:#f59e0b}
.sg-name{display:block;font-weight:650;color:#1c1917;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sg-hd:hover .sg-name{text-decoration:underline}
.sg-sub{display:block;font-size:11.5px;color:#78716c}
.sg-sub .warn{color:#c2410c}
.sg-sub .plan{color:#c2410c;font-weight:600}
.si{display:flex;align-items:flex-start;gap:8px;padding:5px 14px 5px 23px;border-left:3px solid transparent}
.si.act{background:#fafaf9}
.si.dirty{border-left-color:#f59e0b}
.dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;background:#d6d3d1}
.m-edit .dot{background:#16a34a}
.m-link .dot{background:#2563eb}
.m-newprofile .dot,.m-create.act .dot{background:#ea580c}
.m-unavailable{opacity:.6}
.si-txt{flex:1;min-width:0}
.si-name{all:unset;cursor:pointer;display:block;font-weight:500;color:#1c1917;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.si-name:hover{text-decoration:underline}
.si-sub{font-size:11.5px;color:#78716c}
.si-tg{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#57534e;cursor:pointer;flex:none;margin-top:1px}
.side-ft{padding:10px 14px;font-size:11px;color:#a8a29e;border-top:1px solid #f5f5f4;margin-top:8px}
.main{flex:1;overflow:auto;padding:0 16px 48px}
.grp{margin:0 0 6px}
.grp-hd{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#f5f5f4;border-bottom:1px solid #d6d3d1;padding:12px 2px 8px;margin:0 0 12px}
.grp-tg{all:unset;cursor:pointer;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:#44403c;font-size:12px;flex:none}
.grp-tg:hover{background:#e7e5e4}
.grp-name{font-size:15px;font-weight:700}
.roles{display:inline-flex;gap:4px;flex-wrap:wrap}
.role{font-size:11px;font-weight:600;background:#292524;color:#fafaf9;border-radius:999px;padding:1px 8px}
.role.plan{background:#fff7ed;color:#9a3412;border:1px dashed #fb923c;display:inline-flex;align-items:center;gap:4px}
.xbtn{all:unset;cursor:pointer;font-size:12px;line-height:1;color:#9a3412;padding:0 2px;border-radius:3px}
.xbtn:hover{background:#fed7aa}
.dv{font-size:11.5px;color:#9a3412;background:#ffedd5;border:1px solid #fdba74;border-radius:6px;padding:1px 7px;cursor:help}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:10px;padding:12px 14px;margin:0 0 14px}
.card.virtual{border-style:dashed;border-color:#fdba74}
.card-hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:600}
.card-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px}
.badge.ok{background:#dcfce7;color:#166534}
.badge.new{background:#ffedd5;color:#9a3412}
.badge.link{background:#dbeafe;color:#1e40af}
.badge.src{background:#fef3c7;color:#92400e}
.badge.out{background:#e0f2fe;color:#075985}
.muted{color:#78716c;font-weight:400;font-size:12px}
.chg{font-size:12px;font-weight:600;color:#b45309}
.lnk{color:#c2410c;text-decoration:none;font-size:12px}
.lnk:hover{text-decoration:underline}
.dec{font:inherit;font-size:12.5px;border:1px solid #93c5fd;background:#eff6ff;color:#1e3a8a;border-radius:7px;padding:4px 8px;max-width:100%}
.dec-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.dec-row .muted{font-size:12px}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px 12px}
.fld{min-width:0;position:relative}
.lbl{display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:12px;font-weight:500;color:#44403c;min-height:18px}
.lbl label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.req{color:#ea580c;font-size:9px}
.opt{color:#a8a29e;font-weight:400;font-size:11px;white-space:nowrap}
.tag{font-size:10px;border:1px solid #d6d3d1;color:#78716c;border-radius:4px;padding:0 4px;font-weight:500;white-space:nowrap}
.xt{font-size:10px;border-radius:4px;padding:0 4px;font-weight:600;white-space:nowrap;cursor:help;background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
.xt.same{background:#f5f5f4;color:#78716c;border-color:#e7e5e4;font-weight:500}
.xt.calc{background:#ede9fe;color:#5b21b6;border-color:#c4b5fd}
.shr{font-size:10.5px;color:#57534e;background:#f5f5f4;border:1px solid #e7e5e4;border-radius:4px;padding:0 4px;cursor:help;margin-left:auto;flex:none;white-space:nowrap}
.shr.diverge{background:#ffedd5;border-color:#fdba74;color:#9a3412}
.in{font:inherit;width:100%;border:1px solid #d6d3d1;border-radius:7px;padding:6px 9px;background:#fff;color:#1c1917;min-height:32px}
textarea.in{resize:vertical;min-height:60px}
.in:focus{border-color:#fb923c;outline:2px solid #fed7aa;outline-offset:0}
.in:disabled{background:#f5f5f4;color:#57534e;cursor:not-allowed}
.in.bad{border-color:#dc2626}
.fld.changed .in,.fld.changed .chk{background:#fffbeb;border-color:#f59e0b}
.fld.has-err .in{border-color:#dc2626}
.ferr{color:#b91c1c;font-size:12px;margin-top:3px}
.fnote{color:#b45309;font-size:12px;margin-top:3px}
.xl{font-size:12px;margin-top:3px;color:#92400e;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.xl.info{color:#57534e}
.xl .xa{all:unset;cursor:pointer;color:#c2410c;font-weight:600;text-decoration:underline}
.xl .xa:hover{color:#9a3412}
.xl .chip{max-width:260px}
.chk{display:flex;align-items:center;gap:8px;border:1px solid #d6d3d1;border-radius:7px;padding:6px 9px;min-height:32px;cursor:pointer}
.money-wrap{position:relative}
.money-wrap .cur{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#78716c;font-size:12px;pointer-events:none}
.money-wrap .in{padding-left:30px;text-align:right}
.cb{position:relative}
.cb .in{padding-right:28px}
.cb-x{all:unset;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;text-align:center;line-height:18px;border-radius:4px;color:#78716c;cursor:pointer;font-size:15px}
.cb-x:hover{background:#f5f5f4;color:#1c1917}
.cb-list{position:absolute;left:0;right:0;top:calc(100% + 3px);background:#fff;border:1px solid #d6d3d1;border-radius:8px;box-shadow:0 12px 28px rgba(0,0,0,.14);max-height:260px;overflow:auto;z-index:30;padding:4px}
.cb-it{padding:6px 8px;border-radius:5px;cursor:pointer}
.cb-it.hi,.cb-it:hover{background:#fff7ed}
.cb-msg{padding:8px;color:#78716c}
.cb-msg.err{color:#b91c1c}
.common .hint{font-size:12px;color:#57534e;margin:-2px 0 10px}
.ct{width:100%;border-collapse:collapse}
.ct th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78716c;font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid #e7e5e4}
.ct td{padding:7px 8px;border-bottom:1px solid #f5f5f4;vertical-align:middle}
.ct .c-name{font-weight:500;width:22%}
.ct .c-in{width:30%}
.ct .c-btn{width:1%;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.chip{all:unset;cursor:pointer;font-size:12px;border:1px solid #e7e5e4;background:#fafaf9;border-radius:999px;padding:2px 9px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip b{font-weight:600;color:#57534e}
.chip:hover{border-color:#fdba74}
.chip.is-empty{color:#a8a29e}
.chip.diverge{background:#fff7ed;border-color:#fdba74;color:#9a3412}
.chip.locked{border-style:dashed}
.alert{border-radius:8px;padding:8px 10px;font-size:12.5px;margin:6px 0}
.alert.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.alert.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.alert.info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}
.alert.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.alert ul{margin:4px 0 0 18px;padding:0}
.also{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#1e3a8a;cursor:pointer;margin:6px 0}
.pv{margin:6px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px 14px}
.pv li{font-size:12.5px}
.pv b{font-weight:600;color:#57534e}
.loading{display:flex;align-items:center;gap:10px;color:#57534e;padding:16px}
.spin{width:16px;height:16px;border:2px solid #fed7aa;border-top-color:#ea580c;border-radius:50%;animation:sp .8s linear infinite;flex:none}
@keyframes sp{to{transform:rotate(360deg)}}
.empty-state{padding:28px 20px;text-align:center;color:#78716c;background:#fff;border:1px dashed #d6d3d1;border-radius:10px;margin:0 0 14px}
.layer{position:absolute;inset:0;background:rgba(17,17,17,.35);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
.modal{background:#fff;border-radius:12px;width:min(880px,100%);max-height:100%;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.35)}
.modal.small{width:min(460px,100%)}
.m-hd{padding:14px 18px;font-size:15px;font-weight:650;border-bottom:1px solid #e7e5e4}
.m-bd{padding:14px 18px;overflow:auto}
.m-bd p{margin:0}
.m-ft{padding:12px 18px;border-top:1px solid #e7e5e4;display:flex;justify-content:flex-end;gap:8px}
.rv-grp{margin:0 0 14px}
.rv-grp-hd{font-weight:700;font-size:13px;color:#292524;margin:0 0 6px}
.rv-grp-hd .muted{margin-left:6px}
.rv-doc{border:1px solid #e7e5e4;border-radius:9px;padding:10px 12px;margin-bottom:8px}
.rv-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.op{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:5px;padding:1px 6px}
.op.update{background:#e0f2fe;color:#075985}
.op.create{background:#ffedd5;color:#9a3412}
.op.link,.op.linkextra{background:#dbeafe;color:#1e40af}
.op.newprofile{background:#fde68a;color:#78350f}
.op.attach{background:#ede9fe;color:#5b21b6}
.rv ul{margin:0;padding-left:18px}
.rv li{margin:2px 0}
.old{color:#a8a29e;text-decoration:line-through}
.new{color:#166534;font-weight:500}
.rv-st{width:18px;text-align:center;font-weight:700}
.rv-st.ok{color:#16a34a}.rv-st.err{color:#dc2626}.rv-st.warn{color:#d97706}.rv-st.run{color:#ea580c}
.stage{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#78716c;margin:14px 0 6px}
pre{background:#1c1917;color:#e7e5e4;border-radius:8px;padding:10px;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:4px 0 0}
details summary{cursor:pointer;color:#57534e;font-size:12px;margin:6px 0 0}
.toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:#1c1917;color:#fff;padding:8px 14px;border-radius:8px;font-size:12.5px;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90%}
@media (max-width:900px){.ov{padding:0}.panel{border-radius:0}.bd{flex-direction:column}.side{width:auto;max-height:32vh;border-right:0;border-bottom:1px solid #e7e5e4}.grid{grid-template-columns:1fr}.fld{grid-column:auto !important}.ct .c-name,.ct .c-in{width:auto}.hd-act{margin-left:0}}
`;

  const FAB_CSS = `
:host{all:initial}
:host([hidden]){display:none !important}
.fab{position:fixed;right:92px;bottom:24px;z-index:2147481000;display:inline-flex;align-items:center;gap:8px;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;background:#ea580c;border:0;border-radius:999px;padding:11px 16px;cursor:pointer;box-shadow:0 8px 24px rgba(234,88,12,.35)}
.fab:hover{background:#c2410c}
.fab:focus-visible{outline:3px solid #fed7aa;outline-offset:2px}
`;

  /* ----- controles de campo ----- */

  function makeControl(f, value, opt) {
    const k = fieldKind(f);
    const dis = !!opt.disabled;
    const emit = (v) => opt.onChange && opt.onChange(v);

    if (k === 'boolean') {
      const cb = h('input', { type: 'checkbox', id: opt.id, checked: !!value, disabled: dis });
      cb.addEventListener('change', () => emit(cb.checked));
      return { el: h('label', { class: 'chk' }, cb, h('span', null, 'Sim')), set: (v) => (cb.checked = !!v) };
    }
    if (k === 'select') return makeCombo(f, value, opt);
    if (k === 'text') {
      const ta = h('textarea', { class: 'in', id: opt.id, rows: '3', disabled: dis, value: value == null ? '' : value });
      ta.addEventListener('input', () => emit(ta.value));
      return { el: ta, set: (v) => (ta.value = v == null ? '' : v) };
    }
    if (k === 'money') {
      let cur = value;
      const inp = h('input', { class: 'in', id: opt.id, type: 'text', inputmode: 'decimal', placeholder: '0,00', disabled: dis, autocomplete: 'off' });
      const paint = () => (inp.value = typeof cur === 'number' && Number.isFinite(cur) ? fmtBRL(cur) : '');
      paint();
      inp.addEventListener('input', () => {
        const v = parseMoneyInput(inp.value);
        if (typeof v === 'number' && Number.isNaN(v)) {
          inp.classList.add('bad');
          inp.title = 'Valor inválido';
          return;
        }
        inp.classList.remove('bad');
        inp.title = '';
        cur = v;
        emit(v);
      });
      inp.addEventListener('blur', () => {
        inp.classList.remove('bad');
        paint();
      });
      return {
        el: h('div', { class: 'money-wrap' }, h('span', { class: 'cur' }, 'R$'), inp),
        set: (v) => {
          cur = v;
          paint();
        },
      };
    }

    const type = k === 'date' ? 'date' : k === 'time' ? 'time' : k === 'datetime' ? 'datetime-local' : 'text';
    const inp = h('input', { class: 'in', id: opt.id, type, disabled: dis, value: value == null ? '' : value, autocomplete: 'off' });
    if (k === 'time') inp.step = '1';
    if (k === 'numeric') inp.inputMode = 'decimal';
    if (k === 'masked') {
      inp.addEventListener('input', () => {
        const m = applyMask(inp.value, MASKS[f.type]);
        if (m !== inp.value) inp.value = m;
        emit(m);
      });
    } else {
      inp.addEventListener('input', () => emit(inp.value));
    }
    if (k === 'matricula') {
      inp.addEventListener('blur', () => {
        const ok = matCheck(inp.value);
        if (ok === null) {
          if (opt.onNotice) opt.onNotice(null);
          return;
        }
        const fmt = matFormat(inp.value);
        if (fmt !== inp.value) {
          inp.value = fmt;
          emit(fmt);
        }
        if (opt.onNotice) opt.onNotice(ok ? null : 'Matrícula com dígito verificador inválido — confira o número na certidão.');
      });
    }
    return { el: inp, set: (v) => (inp.value = v == null ? '' : v) };
  }

  function makeCombo(f, value, opt) {
    let cur = value || null;
    let items = [];
    let hi = -1;
    let req = 0;
    let open = false;
    const dis = !!opt.disabled;
    const inp = h('input', { class: 'in', id: opt.id, type: 'text', placeholder: 'Selecione…', autocomplete: 'off', disabled: dis, value: cur ? cur.label : '' });
    const btnX = h('button', { class: 'cb-x', type: 'button', title: 'Limpar', tabindex: '-1', hidden: !cur || dis }, '×');
    const list = h('div', { class: 'cb-list', role: 'listbox', hidden: true });
    const wrap = h('div', { class: 'cb' }, inp, btnX, list);
    const setOpen = (v) => {
      open = v;
      list.hidden = !v;
    };
    const paint = () => {
      if (!items.length) {
        list.replaceChildren(h('div', { class: 'cb-msg' }, 'Nenhuma opção encontrada'));
        return;
      }
      list.replaceChildren(
        ...items.map((it, i) =>
          h(
            'div',
            {
              class: `cb-it${i === hi ? ' hi' : ''}`,
              role: 'option',
              onmousedown: (e) => {
                e.preventDefault();
                choose(it);
              },
            },
            it.label
          )
        )
      );
      const el = list.children[hi];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    };
    const search = async (q) => {
      const my = ++req;
      setOpen(true);
      list.replaceChildren(h('div', { class: 'cb-msg' }, 'Carregando…'));
      try {
        if (!f.data_url) throw new UErr('Campo sem lista de opções');
        const res = await Net.json(f.data_url, { q });
        if (my !== req) return;
        const arr = Array.isArray(res) ? res : res && Array.isArray(res.data) ? res.data : [];
        items = arr
          .filter((o) => o && typeof o === 'object')
          .map((o) => ({ value: o.id != null ? o.id : o.value, label: String(o.name != null ? o.name : o.label != null ? o.label : o.text != null ? o.text : o.id) }));
        hi = items.length ? 0 : -1;
        paint();
      } catch (e) {
        if (my === req) list.replaceChildren(h('div', { class: 'cb-msg err' }, 'Erro ao buscar opções'));
      }
    };
    const searchLater = debounce((q) => search(q), 250);
    const choose = (it) => {
      cur = it ? { value: it.value, label: it.label } : null;
      inp.value = cur ? cur.label : '';
      btnX.hidden = !cur;
      setOpen(false);
      if (opt.onChange) opt.onChange(cur);
    };
    inp.addEventListener('focus', () => {
      if (dis) return;
      inp.select();
      search('');
    });
    inp.addEventListener('input', () => searchLater(inp.value.trim()));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) search(inp.value.trim());
        else if (items.length) {
          hi = Math.min(items.length - 1, hi + 1);
          paint();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
          hi = Math.max(0, hi - 1);
          paint();
        }
      } else if (e.key === 'Enter') {
        if (open && items[hi]) {
          e.preventDefault();
          choose(items[hi]);
        }
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        inp.value = cur ? cur.label : '';
      }
    });
    inp.addEventListener('blur', () =>
      setTimeout(() => {
        setOpen(false);
        req++;
        inp.value = cur ? cur.label : '';
      }, 150)
    );
    btnX.addEventListener('click', () => choose(null));
    return {
      el: wrap,
      set: (v) => {
        cur = v || null;
        inp.value = cur ? cur.label : '';
        btnX.hidden = !cur || dis;
      },
    };
  }

  /* ----- montagem da tela ----- */

  function ensureUI() {
    if (UI.host) return;
    const host = h('div', { id: 'ncu-host' });
    const root = host.attachShadow({ mode: 'open' });
    UI.host = host;
    UI.root = root;

    UI.t2 = h('div', { class: 't2' });
    UI.simChk = h('input', { type: 'checkbox' });
    UI.simChk.addEventListener('change', () => {
      S.simulate = UI.simChk.checked;
      try {
        localStorage.setItem('ncu:simulate', S.simulate ? '1' : '0');
      } catch (e) {
        /* sem armazenamento */
      }
    });
    UI.warnBtn = h('button', { class: 'btn warnbtn', type: 'button', title: 'Avisos sobre os dados prontos (ficha)', hidden: true }, 'Avisos');
    UI.warnBtn.addEventListener('click', () => openWarnings());
    UI.foldBtn = h('button', { class: 'btn', type: 'button', title: 'Recolher ou expandir todas as partes' }, 'Recolher tudo');
    UI.foldBtn.addEventListener('click', () => {
      const fold = S.groups.some((g) => !g.collapsed);
      for (const g of S.groups) setGroupCollapsed(g, fold);
      renderHeader();
    });
    UI.reloadBtn = h('button', { class: 'btn', type: 'button', title: 'Recarregar todas as partes do ato' }, 'Recarregar');
    UI.reloadBtn.addEventListener('click', async () => {
      if (S.loading || S.saving || !S.act) return;
      if (hasChanges() && !(await confirmBox('Há alterações não salvas. Recarregar e descartar?', 'Descartar e recarregar'))) return;
      S.act.focusPartId = null;
      loadAct();
    });
    UI.saveBtn = h('button', { class: 'btn primary', type: 'button', title: 'Revisar e gravar (Ctrl+S)' }, 'Revisar e salvar');
    UI.saveBtn.addEventListener('click', () => openReview());
    UI.closeBtn = h('button', { class: 'btn', type: 'button', title: 'Fechar (Esc)', 'aria-label': 'Fechar' }, '✕');
    UI.closeBtn.addEventListener('click', () => closePanel());

    const header = h(
      'header',
      { class: 'hd' },
      h('div', null, h('div', { class: 't1' }, 'Cadastro unificado do ato', h('span', { class: 'ver' }, `v${VERSION}`)), UI.t2),
      h(
        'div',
        { class: 'hd-act' },
        h('label', { class: 'sim', title: 'Mostra o que seria enviado, sem gravar nada' }, UI.simChk, 'Simular (não grava)'),
        UI.warnBtn,
        UI.foldBtn,
        UI.reloadBtn,
        UI.saveBtn,
        UI.closeBtn
      )
    );
    UI.side = h('aside', { class: 'side' });
    UI.main = h('main', { class: 'main' });
    UI.panel = h('div', { class: 'panel' }, header, h('div', { class: 'bd' }, UI.side, UI.main));
    UI.overlay = h('div', { class: 'ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cadastro unificado do ato', hidden: true }, UI.panel);
    UI.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const layers = UI.overlay.querySelectorAll('.layer');
        if (layers.length) layers[layers.length - 1].ncuClose();
        else closePanel();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!UI.saveBtn.disabled && !UI.overlay.querySelector('.layer')) openReview();
      }
    });
    // Impede que atalhos de teclado da própria NoCartório reajam ao que se digita no painel.
    for (const ev of ['keydown', 'keyup', 'keypress']) host.addEventListener(ev, (e) => e.stopPropagation());

    root.append(h('style', null, CSS), UI.overlay);
    document.body.append(host);
  }

  function renderAll() {
    if (!UI.host) return;
    renderHeader();
    renderSide();
    renderMain();
    refreshMeta();
  }

  function extWarningCount() {
    return S.extWarnings.length + S.groups.reduce((a, g) => a + (g.extNotes ? g.extNotes.length : 0), 0);
  }

  function renderHeader() {
    const a = S.act;
    const nParts = a ? a.parts.length : 0;
    const bits = a ? [a.actName, a.code, `${nParts} ${nParts === 1 ? 'parte' : 'partes'}`].filter(Boolean) : [];
    UI.t2.replaceChildren(bits.join(' · '), S.ext ? h('span', { class: 'src' }, ` · ${S.ext.source && S.ext.source.label ? S.ext.source.label : 'Dados prontos'}`) : '');
    UI.reloadBtn.disabled = S.loading || S.saving || !a;
    UI.foldBtn.hidden = S.groups.length < 2;
    UI.foldBtn.textContent = S.groups.some((g) => !g.collapsed) ? 'Recolher tudo' : 'Expandir tudo';
    UI.simChk.checked = S.simulate;
    const nw = S.ext ? extWarningCount() : 0;
    UI.warnBtn.hidden = !S.ext || S.loading;
    UI.warnBtn.textContent = nw ? `Avisos da ficha (${nw})` : 'Ficha: sem avisos';
    UI.warnBtn.classList.toggle('warnbtn', nw > 0);
  }

  function modeText(d) {
    if (d.mode === 'newprofile') return 'Cadastro da pessoa (será criada)';
    if (d.mode === 'link') return 'Vincular o já cadastrado';
    if (d.mode === 'edit') return d.loadError ? 'Erro ao carregar' : d.nChg ? `Cadastrado · ${d.nChg} ${d.nChg === 1 ? 'alteração' : 'alterações'}` : 'Cadastrado';
    if (d.mode === 'create') {
      if (d.loading) return 'Carregando…';
      if (!d.active) return 'Não cadastrado';
      if (d.fileRequired) return 'Exige anexo (use a tela nativa)';
      return d.virtual ? 'Será criado após a inclusão' : 'Será criado';
    }
    return d.reason || 'Indisponível';
  }

  function sideDocRow(d) {
    const sub = h('div', { class: 'si-sub' });
    const name = h('button', { class: 'si-name', type: 'button', title: d.typeName }, d.typeName);
    name.addEventListener('click', () => scrollToDoc(d));
    let toggle = null;
    if (d.mode === 'create' || d.mode === 'link') {
      const cb = h('input', { type: 'checkbox', checked: d.active, disabled: S.saving || d.loading });
      cb.addEventListener('change', () => setActive(d, cb.checked));
      toggle = h('label', { class: 'si-tg', title: d.mode === 'link' ? 'Vincular o documento já cadastrado' : 'Cadastrar este documento' }, cb, d.mode === 'link' ? 'Vincular' : 'Criar');
    }
    const row = h('div', { class: `si m-${d.mode}${d.active ? ' act' : ''}`, title: d.reason || '' }, h('span', { class: 'dot' }), h('div', { class: 'si-txt' }, name, sub), toggle);
    UI.sideRefs.set(d.key, { row, sub });
    return row;
  }

  function renderSide() {
    UI.sideRefs = new Map();
    UI.sideGroupRefs = new Map();
    const blocks = S.groups.map((g) => {
      const sub = h('span', { class: 'sg-sub' });
      const head = h('button', { class: 'sg-hd', type: 'button', title: g.name }, h('span', { class: 'sg-name' }, g.name), sub);
      head.addEventListener('click', () => scrollToGroup(g));
      const block = h('div', { class: 'sg' }, head, g.docs.map(sideDocRow));
      UI.sideGroupRefs.set(g.key, { block, sub });
      return block;
    });
    const body = S.loading && !S.groups.length ? [h('div', { class: 'loading' }, 'Carregando…')] : blocks.length ? blocks : [h('div', { class: 'muted', style: 'padding:8px 14px' }, 'Nenhuma parte encontrada.')];
    UI.side.replaceChildren(
      h('div', { class: 'side-hd' }, 'Partes e documentos'),
      ...body,
      h('div', { class: 'side-ft' }, '● verde: cadastrado · ● azul: vincular existente · ● laranja: será criado · cinza: não cadastrado. Borda amarela = há alterações.')
    );
  }

  function statusText(st) {
    if (!st) return '';
    return { ok: 'gravado', warn: 'gravado (ver aviso)', error: 'recusado', conflict: 'não gravado (conflito)', sim: 'simulado', uncertain: 'conferir', skip: 'não gravado' }[st.type] || '';
  }

  function renderSideMeta() {
    if (!UI.sideRefs) return;
    for (const d of S.docs) {
      const ref = UI.sideRefs.get(d.key);
      if (!ref) continue;
      const txt = modeText(d);
      const s = statusText(d.status);
      ref.sub.textContent = s ? `${txt} · ${s}` : txt;
      ref.row.classList.toggle('dirty', !!d.nChg || d.mode === 'link' || d.mode === 'newprofile' || (d.mode === 'create' && d.active));
    }
    if (!UI.sideGroupRefs) return;
    for (const g of S.groups) {
      const ref = UI.sideGroupRefs.get(g.key);
      if (!ref) continue;
      const roles = g.parts.map((p) => p.role).join(' / ');
      const plan = g.plannedRoles.map((r) => `+ ${r.label}`).join(' / ');
      const bits = [];
      if (g.loadError) bits.push('erro ao carregar');
      else if (g.nChg) bits.push(`${g.nChg} ${g.nChg === 1 ? 'alteração' : 'alterações'}`);
      ref.sub.replaceChildren(
        g.isNew ? h('span', { class: 'plan' }, 'Nova · ') : g.virtual ? h('span', { class: 'plan' }, 'Fora do ato · ') : '',
        roles,
        plan ? h('span', { class: 'plan' }, `${roles ? ' / ' : ''}${plan}`) : '',
        bits.length ? ` · ${bits.join(' · ')}` : '',
        g.divergences.length ? h('span', { class: 'warn' }, ` · ⚠ ${g.divergences.length} diverg.`) : ''
      );
      ref.block.classList.toggle('dirty', !!g.nChg || !!g.plannedRoles.length || g.docs.some((d) => d.mode === 'link' || (d.mode === 'create' && d.active)));
    }
  }

  function renderMain() {
    const main = UI.main;
    const st = main.scrollTop;
    UI.fieldRefs = new Map();
    UI.commonRefs = new Map();
    UI.cardRefs = new Map();
    UI.groupRefs = new Map();
    UI.loadMsg = null;
    const kids = [];
    if (S.fatal) kids.push(h('div', { class: 'alert err', style: 'margin-top:14px' }, S.fatal));
    if (S.loading) {
      UI.loadMsg = h('span', null, S.loadMsg || 'Carregando…');
      kids.push(h('div', { class: 'loading' }, h('span', { class: 'spin' }), UI.loadMsg));
    } else if (!S.fatal) {
      if (S.ext && S.extWarnings.length) {
        kids.push(
          h(
            'div',
            { class: 'alert warn', style: 'margin-top:14px' },
            h('b', null, 'Avisos da ficha:'),
            h('ul', null, S.extWarnings.slice(0, 6).map((w) => h('li', null, w))),
            S.extWarnings.length > 6 ? h('div', null, `… e mais ${S.extWarnings.length - 6} (botão “Avisos da ficha”).`) : null
          )
        );
      }
      if (!S.groups.length) kids.push(h('div', { class: 'empty-state', style: 'margin-top:14px' }, 'Nenhuma parte encontrada neste ato.'));
      for (const g of S.groups) kids.push(groupSection(g));
    }
    main.replaceChildren(...kids);
    main.scrollTop = st;
  }

  function divergenceTitle(g) {
    return g.divergences
      .map((dv) => {
        const vals = (dv.values || []).map((v) => `   • ${v.documentTypeName || 'Documento'}: ${v.display != null ? v.display : '(vazio)'}`).join('\n');
        return `${dv.label || 'Campo'}:\n${vals}`;
      })
      .join('\n');
  }

  function plannedRoleChip(g, r) {
    const x = h('button', { class: 'xbtn', type: 'button', title: 'Não incluir neste papel', disabled: S.saving }, '✕');
    x.addEventListener('click', () => {
      g.plannedRoles = g.plannedRoles.filter((p) => p !== r);
      if (g.isNew && g.keyDoc && g.plannedRoles.length && g.keyDoc.createRole !== g.plannedRoles[0]) {
        toast(`O cadastro da pessoa será feito pelo papel “${g.plannedRoles[0].label}”.`);
      }
      renderAll();
    });
    return h('span', { class: 'role plan', title: 'Papel a incluir ao gravar' }, `+ ${r.label}`, x);
  }

  function groupSection(g) {
    const chg = h('span', { class: 'chg' });
    const tg = h('button', { class: 'grp-tg', type: 'button', title: g.collapsed ? 'Mostrar' : 'Recolher', 'aria-expanded': String(!g.collapsed) }, svg(g.collapsed ? ICON_RIGHT : ICON_DOWN, 16));
    tg.addEventListener('click', () => {
      setGroupCollapsed(g, !g.collapsed);
      renderHeader();
    });
    const body = h('div', { class: 'grp-bd', hidden: g.collapsed });
    const links = h(
      'div',
      { class: 'card-actions' },
      g.parts.map((p) => h('a', { class: 'lnk', href: p.pageUrl, target: '_blank', rel: 'noopener', title: `Abrir a tela desta parte (${p.role}) na NoCartório` }, `${p.role} ↗`))
    );
    const dv = g.divergences.length
      ? h(
          'span',
          { class: 'dv', title: `Divergências apontadas pela NoCartório entre os documentos:\n${divergenceTitle(g)}` },
          `⚠ ${g.divergences.length} ${g.divergences.length === 1 ? 'divergência' : 'divergências'} entre documentos: ${g.divergences.map((x) => x.label).filter(Boolean).join(', ')}`
        )
      : null;
    const head = h(
      'div',
      { class: 'grp-hd' },
      tg,
      h('span', { class: 'grp-name' }, g.name),
      g.isNew ? h('span', { class: 'badge new', title: 'Não há cadastro desta pessoa na NoCartório: será cadastrada ao gravar' }, 'Nova pessoa') : null,
      !g.isNew && g.virtual ? h('span', { class: 'badge out', title: 'Já cadastrada na NoCartório, mas ainda não está neste ato' }, 'Fora do ato') : null,
      g.profileType ? h('span', { class: 'muted' }, g.profileType) : null,
      h('span', { class: 'roles' }, g.parts.map((p) => h('span', { class: 'role' }, p.role)), g.plannedRoles.map((r) => plannedRoleChip(g, r))),
      dv,
      chg,
      links
    );
    const sec = h('section', { class: 'grp', id: `ncu-${g.key}` }, head, body);
    UI.groupRefs.set(g.key, { sec, body, tg, chg });
    if (g.loadError) {
      body.append(h('div', { class: 'alert err' }, `Não foi possível carregar esta parte: ${g.loadError}`));
      return sec;
    }
    if (g.extNotes && g.extNotes.length) body.append(h('div', { class: 'alert warn' }, h('ul', null, g.extNotes.map((t) => h('li', null, t)))));
    if (g.status) body.append(h('div', { class: `alert ${g.status.type === 'ok' ? 'ok' : g.status.type === 'error' ? 'err' : 'warn'}` }, g.status.msg));
    if (g.virtual && g.plannedRoles.length) {
      body.append(
        h(
          'div',
          { class: 'alert info' },
          g.isNew
            ? `Ao gravar: cadastra a pessoa, inclui como ${g.plannedRoles.map((r) => r.label).join(' e ')} e depois grava os documentos abaixo.`
            : `Ao gravar: inclui como ${g.plannedRoles.map((r) => r.label).join(' e ')} e depois grava os documentos abaixo.`
        )
      );
    }
    const common = commonCard(g);
    if (common) body.append(common);
    const shown = g.docs.filter((d) => d.mode === 'edit' || d.mode === 'link' || d.mode === 'newprofile' || (d.mode === 'create' && (d.active || d.loading)));
    if (!shown.length) {
      body.append(
        h(
          'div',
          { class: 'empty-state' },
          g.docs.length ? 'Nenhum documento cadastrado nesta parte. Marque “Criar” na lista ao lado para cadastrar.' : 'A NoCartório não lista documentos para esta parte do ato.'
        )
      );
    }
    for (const d of shown) body.append(docCard(d));
    return sec;
  }

  function setGroupCollapsed(g, v) {
    g.collapsed = v;
    const ref = UI.groupRefs && UI.groupRefs.get(g.key);
    if (!ref) return;
    ref.body.hidden = v;
    ref.tg.replaceChildren(svg(v ? ICON_RIGHT : ICON_DOWN, 16));
    ref.tg.title = v ? 'Mostrar' : 'Recolher';
    ref.tg.setAttribute('aria-expanded', String(!v));
  }

  function decisionRow(d) {
    const c = d.candidates || [];
    if (!c.length || !(d.mode === 'create' || d.mode === 'link')) return null;
    const matchTxt = (x) => (x.match === 'igual' ? ' — igual à ficha' : x.match === 'diferente' ? ' — diferente da ficha' : '');
    const sel = h(
      'select',
      { class: 'dec', disabled: S.saving || d.loading, title: 'O perfil já tem documento deste tipo' },
      h('option', { value: '', selected: d.mode === 'create' }, 'Criar um documento novo'),
      c.map((x) => h('option', { value: x.id, selected: d.mode === 'link' && d.docId === x.id }, `Vincular o já cadastrado: ${x.label}${matchTxt(x)}`))
    );
    sel.addEventListener('change', async () => {
      if (docChanged(d) && !(await confirmBox('Trocar a escolha descarta o que foi alterado neste documento. Continuar?', 'Trocar'))) {
        sel.value = d.mode === 'link' ? d.docId : '';
        return;
      }
      await setDecision(d, sel.value ? { link: sel.value } : { create: true });
    });
    const n = c.length;
    return h(
      'div',
      { class: 'dec-row' },
      sel,
      h('span', { class: 'muted' }, `O perfil já tem ${n} ${n === 1 ? 'documento' : 'documentos'} deste tipo${d.mode === 'create' ? ': se for o mesmo, vincule em vez de criar outro.' : '.'}`)
    );
  }

  function docCard(d) {
    const isNew = d.mode === 'create' || d.mode === 'newprofile';
    const chg = h('span', { class: 'chg' });
    const actions = h('div', { class: 'card-actions' });
    if (isExistingMode(d) && d.docId && d.ctx.profileId) actions.append(h('a', { class: 'lnk', href: editUrl(d), target: '_blank', rel: 'noopener' }, 'Abrir na NoCartório ↗'));
    if (d.mode === 'create' && !d.virtual) {
      actions.append(h('a', { class: 'lnk', href: createUrl(d), target: '_blank', rel: 'noopener' }, 'Tela nativa ↗'));
    }
    if (d.mode === 'create' || d.mode === 'link') {
      const b = h('button', { class: 'btn sm', type: 'button', disabled: S.saving }, d.mode === 'link' ? 'Não vincular' : 'Não criar');
      b.addEventListener('click', () => setActive(d, false));
      actions.append(b);
    }
    const badge =
      d.mode === 'newprofile'
        ? h('span', { class: 'badge new' }, 'Nova pessoa')
        : d.mode === 'link'
          ? h('span', { class: 'badge link' }, 'Vincular existente')
          : h('span', { class: `badge ${isNew ? 'new' : 'ok'}` }, isNew ? 'Novo' : 'Cadastrado');
    const title = h(
      'div',
      { class: 'card-title' },
      h('span', null, d.mode === 'newprofile' ? `Cadastro da pessoa — ${d.typeName}` : d.typeName),
      badge,
      d.ext ? h('span', { class: 'badge src', title: 'Há dados da ficha neste documento' }, 'ficha') : null,
      isExistingMode(d) && d.docName ? h('span', { class: 'muted' }, d.docName) : null,
      d.group && d.group.parts.length > 1 && d.roles.length ? h('span', { class: 'muted', title: 'Partes do ato que usam este documento' }, `em: ${d.roles.join(' / ')}`) : null,
      chg
    );
    const msg = h('div', { class: 'card-msg' });
    const card = h('section', { class: `card doc${d.virtual ? ' virtual' : ''}`, id: `ncu-${d.key}` }, h('div', { class: 'card-hd' }, title, actions), msg);
    UI.cardRefs.set(d.key, { chg, msg });
    if (d.loading) {
      card.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Carregando…'));
      return card;
    }
    const dec = decisionRow(d);
    if (dec) card.append(dec);
    if (d.loadError) {
      card.append(h('div', { class: 'alert err' }, `Não foi possível carregar: ${d.loadError}`));
      return card;
    }
    if (!d.props) {
      if (d.noDefs && d.ext) {
        const vals = Object.entries(d.ext.values || {}).filter(([, v]) => !isBlank(v));
        card.append(
          h('div', { class: 'alert info' }, 'Os campos deste documento aparecem depois que a pessoa for cadastrada. Os valores da ficha abaixo serão aplicados na gravação — confira o resultado depois.'),
          vals.length ? h('ul', { class: 'pv' }, vals.map(([k, v]) => h('li', null, h('b', null, `${k}: `), extText(v)))) : h('div', { class: 'muted' }, 'A ficha não traz valores para este documento.')
        );
      }
      return card;
    }
    const grid = h('div', { class: 'grid' });
    let lastRow;
    for (const f of d.fields) {
      const first = f.row !== lastRow;
      lastRow = f.row;
      grid.append(fieldEl(d, f, first));
    }
    card.append(grid);
    return card;
  }

  function renderCardMsg(d, el) {
    const kids = [];
    if (d.mode === 'create' && d.fileRequired) kids.push(h('div', { class: 'alert warn' }, 'Este tipo de documento exige anexo. Nesta versão, crie-o pela tela nativa (link acima).'));
    if (d.mode === 'newprofile' && d.props && !d.status) {
      const miss = missingRequired(d);
      if (miss.length) kids.push(h('div', { class: 'alert warn' }, `Para cadastrar a pessoa, preencha: ${miss.join(', ')}. Sem isso, nada desta pessoa é gravado.`));
    }
    if (d.virtual && d.mode !== 'newprofile' && d.group && d.group.plannedRoles.length) {
      kids.push(h('div', { class: 'alert info' }, 'Gravado depois da inclusão da parte, se a NoCartório pedir este documento para o papel.'));
    }
    if (!d.virtual && d.extraParts.length && (d.mode === 'create' || d.mode === 'link' || d.mode === 'edit')) {
      const cb = h('input', { type: 'checkbox', checked: d.alsoLink, disabled: S.saving });
      cb.addEventListener('change', () => {
        d.alsoLink = cb.checked;
        refreshMeta();
      });
      const roles = d.extraParts.map((p) => p.role).join(' / ');
      kids.push(
        h(
          'label',
          { class: 'also', title: 'A mesma pessoa está em mais de um papel neste ato; cada papel tem a sua lista de documentos.' },
          cb,
          d.mode === 'edit' ? `Vincular este documento também em: ${roles} (lá ainda não está vinculado)` : `Vincular também em: ${roles}`
        )
      );
    }
    const st = d.status;
    if (st) {
      if (st.type === 'ok') kids.push(h('div', { class: 'alert ok' }, st.msg || 'Gravado.'));
      else if (st.type === 'sim') kids.push(h('div', { class: 'alert info' }, 'Simulação: nada foi gravado.'));
      else if (st.type === 'conflict' || st.type === 'skip') kids.push(h('div', { class: 'alert warn' }, st.msg));
      else if (st.type === 'warn' || st.type === 'uncertain') kids.push(h('div', { class: 'alert warn' }, st.msg || 'Confira este documento na tela nativa.'));
      else if (st.type === 'error') kids.push(h('div', { class: 'alert err' }, st.msg || 'A NoCartório recusou a gravação.', st.list && st.list.length ? h('ul', null, st.list.map((t) => h('li', null, t))) : null));
    }
    el.replaceChildren(...kids);
  }

  function srcTitle(xi) {
    const o = { documento: 'documento da ficha', calculado: 'calculado', comum: 'dado comum da ficha' }[xi.src.origem] || 'ficha';
    return `Origem: ${o}${xi.src.fonte ? `\nFonte: ${xi.src.fonte}` : ''}`;
  }

  /** Linha "Ficha: …" embaixo do campo (sugestão, valor anterior, aviso ou opções para escolher). */
  function renderXLine(ref) {
    const { d, f, xl, xt } = ref;
    const xi = d.xinfo.get(f.id);
    xt.hidden = !xi || !(xi.kind === 'filled' || xi.kind === 'same');
    if (xi && !xt.hidden) {
      xt.className = `xt${xi.kind === 'same' ? ' same' : xi.src.origem === 'calculado' ? ' calc' : ''}`;
      xt.textContent = xi.kind === 'same' ? 'ficha ✓' : xi.src.origem === 'calculado' ? 'calculado' : 'ficha';
      xt.title = `${xi.kind === 'same' ? 'Igual ao que a ficha traz.\n' : 'Preenchido com a ficha.\n'}${srcTitle(xi)}`;
    }
    const kids = [];
    let cls = 'xl';
    if (xi) {
      const lock = isLocked(d, f) || S.saving;
      if (xi.kind === 'suggest') {
        const use = h('button', { class: 'xa', type: 'button', disabled: lock, title: srcTitle(xi) }, 'usar');
        use.addEventListener('click', () => {
          const before = cloneState(d.values[f.id]);
          setFieldValue(d, f, xi.state);
          d.xinfo.set(f.id, { kind: 'filled', src: xi.src, before, warn: xi.warn });
          refreshMeta();
        });
        kids.push(`Ficha: ${showState(f, xi.state)}`, use);
      } else if (xi.kind === 'filled' && xi.before != null && !isEmptyState(f, xi.before)) {
        const back = h('button', { class: 'xa', type: 'button', disabled: lock }, 'voltar');
        back.addEventListener('click', () => {
          const fichaState = cloneState(d.values[f.id]);
          setFieldValue(d, f, xi.before);
          d.xinfo.set(f.id, { kind: 'suggest', src: xi.src, state: fichaState, warn: xi.warn });
          refreshMeta();
        });
        cls = 'xl info';
        kids.push(`Antes: ${showState(f, xi.before)}`, back);
      } else if (xi.kind === 'note') {
        kids.push(xi.msg);
      } else if (xi.kind === 'choices') {
        kids.push(xi.msg);
        for (const o of xi.options) {
          const c = h('button', { class: 'chip', type: 'button', disabled: lock, title: o.label }, o.label);
          c.addEventListener('click', () => {
            setFieldValue(d, f, { value: o.value, label: o.label });
            d.xinfo.set(f.id, { kind: 'filled', src: xi.src, before: null });
            refreshMeta();
          });
          kids.push(c);
        }
      }
      if (xi.warn && (xi.kind === 'filled' || xi.kind === 'same' || xi.kind === 'suggest')) kids.push(h('span', null, `⚠ ${xi.warn}`));
    }
    xl.className = cls;
    xl.hidden = !kids.length;
    xl.replaceChildren(...kids);
  }

  function setFieldValue(d, f, v) {
    d.values[f.id] = cloneState(v);
    d.dirty.add(f.id);
    delete d.errors[f.id];
    const ref = UI.fieldRefs && UI.fieldRefs.get(`${d.key}:${f.id}`);
    if (ref) ref.ctrl.set(d.values[f.id]);
  }

  function fieldEl(d, f, first) {
    const lock = isLocked(d, f);
    const id = `f-${d.key}-${f.id}`;
    const span = Math.max(1, Math.min(12, Number(f.col) || 12));
    const wrap = h('div', { class: `fld${lock ? ' locked' : ''}`, style: `grid-column:${first ? '1 / ' : ''}span ${span}` });
    const shr = h('span', { class: 'shr', hidden: true });
    const xt = h('span', { class: 'xt', hidden: true });
    const label = h(
      'div',
      { class: 'lbl' },
      h('label', { for: id, title: f.name }, f.name),
      f.is_required ? h('span', { class: 'req', title: 'Obrigatório' }, '◆') : h('span', { class: 'opt' }, '(Opcional)'),
      lock ? h('span', { class: 'tag', title: 'Campo-chave: para alterar, use "editar chaves" na tela nativa.' }, 'chave') : null,
      xt,
      shr
    );
    const err = h('div', { class: 'ferr', hidden: true });
    const note = h('div', { class: 'fnote', hidden: true });
    const xl = h('div', { class: 'xl', hidden: true });
    const ctrl = makeControl(f, d.values[f.id], {
      id,
      disabled: lock || S.saving,
      onChange: (v) => {
        d.values[f.id] = v;
        d.dirty.add(f.id);
        delete d.errors[f.id];
        const xi = d.xinfo.get(f.id);
        if (xi && (xi.kind === 'filled' || xi.kind === 'same' || xi.kind === 'choices')) d.xinfo.delete(f.id);
        scheduleRefresh();
      },
      onNotice: (m) => {
        if (m) d.notices[f.id] = m;
        else delete d.notices[f.id];
        scheduleRefresh();
      },
    });
    wrap.append(label, ctrl.el, xl, err, note);
    UI.fieldRefs.set(`${d.key}:${f.id}`, { d, f, wrap, shr, err, note, ctrl, xl, xt });
    return wrap;
  }

  /* ----- campos em comum (dentro de cada perfil) ----- */

  // Campos que normalmente são próprios de cada documento (não entram em "Campos em comum").
  const PER_DOC_RE = /identifica[cç][aã]o do documento|data de emiss[aã]o|data de validade|n[uú]mero do documento|valor pago|data do pagamento|autentica[cç][aã]o|duam|resumo executivo|valor de avalia[cç][aã]o/i;

  function computeCommon(g) {
    const map = new Map();
    for (const d of activeDocs(g)) {
      for (const f of d.fields) {
        if (PER_DOC_RE.test(f.name || '')) continue;
        let e = map.get(f.id);
        if (!e) map.set(f.id, (e = { fid: f.id, field: f, docs: [] }));
        e.docs.push(d);
      }
    }
    return [...map.values()].filter((e) => e.docs.length > 1);
  }

  function emptyState(f) {
    return stateFromRaw(f, f.type === 'boolean' ? false : '', null);
  }

  function initialCommon(r) {
    const f = r.field;
    const k = fieldKind(f);
    const vals = r.docs.map((d) => d.values[f.id]).filter((v) => norm(k, dataFromState(f, v)) !== '');
    if (vals.length && vals.every((v) => norm(k, dataFromState(f, v)) === norm(k, dataFromState(f, vals[0])))) return cloneState(vals[0]);
    return emptyState(f);
  }

  function commonCard(g) {
    const rows = computeCommon(g);
    if (!rows.length) return null;
    const tbody = h('tbody');
    for (const r of rows) {
      const f = r.field;
      const fid = f.id;
      const key = `${g.key}:${fid}`;
      if (!(fid in g.common)) g.common[fid] = initialCommon(r);
      const chips = h('div', { class: 'chips' });
      const ctrl = makeControl(f, g.common[fid], {
        id: `c-${g.key}-${fid}`,
        disabled: S.saving,
        onChange: (v) => {
          g.common[fid] = v;
          refreshCommonRow(key);
        },
      });
      const btn = h('button', { class: 'btn sm', type: 'button', disabled: S.saving }, 'Aplicar a todos');
      btn.addEventListener('click', () => applyCommon(g, r, btn));
      tbody.append(
        h(
          'tr',
          null,
          h('td', { class: 'c-name' }, f.name, f.is_required ? h('span', { class: 'req' }, ' ◆') : null),
          h('td', null, chips),
          h('td', { class: 'c-in' }, ctrl.el),
          h('td', { class: 'c-btn' }, btn)
        )
      );
      UI.commonRefs.set(key, { g, r, chips, ctrl, btn });
    }
    const table = h(
      'table',
      { class: 'ct', hidden: g.commonCollapsed },
      h('thead', null, h('tr', null, h('th', null, 'Campo'), h('th', null, 'Valor em cada documento (clique para usar)'), h('th', null, 'Valor para aplicar'), h('th'))),
      tbody
    );
    const hint = h(
      'div',
      {
        class: 'hint',
        hidden: g.commonCollapsed,
        title:
          'Digite (ou clique num valor existente) e use “Aplicar a todos” para copiar o valor para os documentos desta parte que têm o campo. Nada é copiado sem esse clique, nada passa para outras partes e campos-chave de documentos já cadastrados não são alterados. Campos próprios de cada documento (data de emissão, nome de identificação, valores pagos…) ficam só nos cartões abaixo.',
      },
      'Valores diferentes entre os documentos desta parte ficam em laranja. “Aplicar a todos” copia o valor só para os documentos desta parte.'
    );
    const toggle = h('button', { class: 'btn sm ghost', type: 'button' }, g.commonCollapsed ? 'Mostrar' : 'Recolher');
    toggle.addEventListener('click', () => {
      g.commonCollapsed = !g.commonCollapsed;
      table.hidden = g.commonCollapsed;
      hint.hidden = g.commonCollapsed;
      toggle.textContent = g.commonCollapsed ? 'Mostrar' : 'Recolher';
    });
    return h(
      'section',
      { class: 'card common' },
      h(
        'div',
        { class: 'card-hd' },
        h('div', { class: 'card-title' }, 'Campos em comum', h('span', { class: 'muted' }, `${rows.length} ${rows.length === 1 ? 'campo' : 'campos'}`)),
        h('div', { class: 'card-actions' }, toggle)
      ),
      hint,
      table
    );
  }

  function refreshCommonRow(key) {
    const ref = UI.commonRefs && UI.commonRefs.get(key);
    if (!ref) return;
    const g = ref.g;
    const f = ref.r.field;
    const fid = f.id;
    const k = fieldKind(f);
    const vals = ref.r.docs.map((d) => norm(k, dataFromState(f, d.values[fid])));
    const distinct = new Set(vals.filter((v) => v !== ''));
    ref.chips.replaceChildren(
      ...ref.r.docs.map((d, i) => {
        const df = d.fields.find((x) => x.id === fid) || f;
        const txt = showState(f, d.values[fid]);
        const lock = isLocked(d, df);
        const cls = ['chip'];
        if (vals[i] === '') cls.push('is-empty');
        else if (distinct.size > 1) cls.push('diverge');
        if (lock) cls.push('locked');
        const chip = h(
          'button',
          { class: cls.join(' '), type: 'button', title: `${d.typeName}: ${txt || '(vazio)'}${lock ? ' — campo-chave, não será alterado' : ''}\nClique para usar este valor.` },
          h('b', null, `${d.short}: `),
          txt || '—'
        );
        chip.addEventListener('click', () => {
          g.common[fid] = cloneState(d.values[fid]);
          ref.ctrl.set(g.common[fid]);
          refreshCommonRow(key);
        });
        return chip;
      })
    );
    const master = norm(k, dataFromState(f, g.common[fid]));
    ref.btn.disabled = S.saving || (master === '' && k !== 'boolean');
  }

  function applyCommon(g, r, btn) {
    const fid = r.field.id;
    const v = g.common[fid];
    let n = 0;
    let skipped = 0;
    for (const d of r.docs) {
      const df = d.fields.find((x) => x.id === fid);
      if (!df) continue;
      if (isLocked(d, df)) {
        skipped++;
        continue;
      }
      d.values[fid] = cloneState(v);
      d.dirty.add(fid);
      delete d.errors[fid];
      const ref = UI.fieldRefs.get(`${d.key}:${fid}`);
      if (ref) ref.ctrl.set(d.values[fid]);
      n++;
    }
    btn.textContent = `Aplicado em ${n}${skipped ? ` (${skipped} chave)` : ''}`;
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = 'Aplicar a todos';
    }, 1800);
    refreshMeta();
  }

  /* ----- indicadores (alterações, divergências, contadores) ----- */

  function refreshMeta() {
    if (!UI.host) return;
    for (const d of S.docs) {
      d.nChg = d.props ? d.fields.reduce((a, f) => a + (fieldChanged(d, f) ? 1 : 0), 0) : 0;
      const cr = UI.cardRefs && UI.cardRefs.get(d.key);
      if (cr) {
        cr.chg.textContent = d.nChg ? `${d.nChg} ${d.nChg === 1 ? 'alteração' : 'alterações'}` : '';
        renderCardMsg(d, cr.msg);
      }
    }
    for (const g of S.groups) {
      g.nChg = g.docs.reduce((a, d) => a + d.nChg, 0);
      const gr = UI.groupRefs && UI.groupRefs.get(g.key);
      if (gr) gr.chg.textContent = g.nChg ? `${g.nChg} ${g.nChg === 1 ? 'alteração' : 'alterações'}` : '';
    }
    if (UI.fieldRefs) {
      const actByGroup = new Map(S.groups.map((g) => [g, activeDocs(g)]));
      for (const ref of UI.fieldRefs.values()) {
        const { d, f, wrap, shr, err, note } = ref;
        wrap.classList.toggle('changed', fieldChanged(d, f));
        const e = d.errors[f.id];
        err.hidden = !e;
        err.textContent = e || '';
        wrap.classList.toggle('has-err', !!e);
        const nt = d.notices[f.id];
        note.hidden = !nt;
        note.textContent = nt || '';
        renderXLine(ref);
        const others = (actByGroup.get(d.group) || []).filter((o) => o !== d && o.fields.some((x) => x.id === f.id));
        if (!others.length) {
          shr.hidden = true;
          continue;
        }
        const k = fieldKind(f);
        const mine = norm(k, dataFromState(f, d.values[f.id]));
        const diverge = others.some((o) => {
          const v = norm(k, dataFromState(f, o.values[f.id]));
          return v !== '' && mine !== '' && v !== mine;
        });
        shr.hidden = false;
        shr.classList.toggle('diverge', diverge);
        shr.textContent = `⇄ ${others.length}`;
        shr.title = `${diverge ? 'Valores diferentes em outros documentos desta parte' : 'Também em'}:\n${others.map((o) => `• ${o.typeName}: ${showState(f, o.values[f.id]) || '(vazio)'}`).join('\n')}`;
      }
    }
    if (UI.commonRefs) for (const key of UI.commonRefs.keys()) refreshCommonRow(key);
    renderSideMeta();
    const ops = collectOps();
    const toSave = ops.filter((p) => !p.blocked).length;
    UI.saveBtn.textContent = ops.length ? `Revisar e salvar (${toSave})` : 'Revisar e salvar';
    UI.saveBtn.disabled = S.loading || S.saving || !ops.length;
  }
  const scheduleRefresh = debounce(refreshMeta, 80);

  /* ----- ações ----- */

  function scrollToGroup(g, behavior) {
    const el = UI.root && UI.root.getElementById(`ncu-${g.key}`);
    if (el) el.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
  }

  function scrollToDoc(d) {
    if (d.group && d.group.collapsed) {
      setGroupCollapsed(d.group, false);
      renderHeader();
    }
    const el = UI.root && UI.root.getElementById(`ncu-${d.key}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (d.mode === 'create' && !d.active) toast('Marque “Criar” para preencher este documento.');
    else if (d.reason) toast(d.reason);
  }

  async function setActive(d, on) {
    if (!on) {
      if (d.nChg && !(await confirmBox(`Descartar o que foi preenchido em “${d.typeName}”?`, 'Descartar'))) {
        renderSide();
        renderSideMeta();
        return;
      }
      d.active = false;
      d.status = null;
      if (d.mode === 'link') {
        // volta para "não cadastrado" (criar), mantendo a opção de vincular
        d.mode = 'create';
        d.docId = null;
        d.docName = '';
        if (d.createProps) initDoc(d, d.createProps);
      } else if (d.props) initDoc(d, d.props);
      if (d.ext && d.props) await applyPrefill(d);
      renderAll();
      return;
    }
    d.active = true;
    if (d.group && d.group.collapsed) setGroupCollapsed(d.group, false);
    if (!d.props && !d.noDefs) {
      d.loading = true;
      renderAll();
      try {
        await loadDocProps(d);
        if (d.candidates == null) d.candidates = await linkCandidates(d);
        if (d.ext) await applyPrefill(d);
      } catch (e) {
        d.loadError = e.message;
      }
      d.loading = false;
    }
    renderAll();
    scrollToDoc(d);
  }

  /* ----- modais ----- */

  function modal(title, body, buttons, opts) {
    opts = opts || {};
    const box = h('div', { class: `modal${opts.small ? ' small' : ''}`, role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'm-hd' }, title), h('div', { class: 'm-bd' }, body), h('div', { class: 'm-ft' }, buttons));
    const layer = h('div', { class: 'layer' }, box);
    let locked = false;
    let closed = false;
    const api = {
      box,
      lock: (v) => (locked = v),
      close: () => {
        if (locked || closed) return;
        closed = true;
        layer.remove();
        if (opts.onClose) opts.onClose();
      },
    };
    layer.ncuClose = api.close;
    layer.addEventListener('mousedown', (e) => {
      if (e.target === layer) api.close();
    });
    UI.panel.append(layer);
    return api;
  }

  function confirmBox(text, okLabel) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => {
        if (answered) return;
        answered = true;
        resolve(v);
      };
      const ok = h('button', { class: 'btn primary', type: 'button' }, okLabel || 'Confirmar');
      const no = h('button', { class: 'btn', type: 'button' }, 'Cancelar');
      const m = modal('Confirmação', h('p', null, text), [no, ok], { small: true, onClose: () => done(false) });
      ok.addEventListener('click', () => {
        done(true);
        m.close();
      });
      no.addEventListener('click', () => m.close());
      setTimeout(() => ok.focus(), 0);
    });
  }

  function toast(text) {
    if (!UI.panel) return;
    if (UI.toastEl) UI.toastEl.remove();
    const t = h('div', { class: 'toast', role: 'status' }, text);
    UI.panel.append(t);
    UI.toastEl = t;
    setTimeout(() => t.remove(), 3200);
  }

  function openWarnings() {
    const groups = S.groups.filter((g) => g.extNotes && g.extNotes.length);
    const body = h(
      'div',
      { class: 'rv' },
      S.extWarnings.length ? h('div', { class: 'rv-grp' }, h('div', { class: 'rv-grp-hd' }, 'Gerais'), h('ul', null, S.extWarnings.map((w) => h('li', null, w)))) : null,
      groups.map((g) => h('div', { class: 'rv-grp' }, h('div', { class: 'rv-grp-hd' }, g.name), h('ul', null, g.extNotes.map((w) => h('li', null, w))))),
      !S.extWarnings.length && !groups.length ? h('p', null, 'Nenhum aviso.') : null
    );
    const close = h('button', { class: 'btn', type: 'button' }, 'Fechar');
    const m = modal('Avisos da ficha', body, [close]);
    close.addEventListener('click', () => m.close());
  }

  /* ----- revisão e gravação ----- */

  const FILE_MSG = 'Este tipo exige anexo: crie pela tela nativa.';

  /**
   * Tudo o que será gravado, na ordem: imóveis (matrículas) → pessoas e papéis → documentos.
   * Os imóveis vão primeiro porque, ao incluir uma matrícula, a NoCartório inclui sozinha os proprietários.
   */
  function collectOps() {
    const ops = [];
    const waiting = new Map(); // grupo → motivo (pessoa nova que ainda não pode ser cadastrada)
    const ordered = [...S.groups.filter((g) => g.isProperty), ...S.groups.filter((g) => !g.isProperty)];
    for (const g of ordered) {
      if (g.loadError) continue;
      if (g.isNew) {
        if (g.keyDoc && g.keyDoc.props && !g.keyDoc.loadError && g.plannedRoles.length) {
          const miss = missingRequired(g.keyDoc);
          const why = miss.length ? `Preencha antes, no cadastro da pessoa: ${miss.join(', ')}.` : null;
          if (why) waiting.set(g, 'Depende do cadastro da pessoa, que ainda tem obrigatórios vazios.');
          ops.push({ op: 'newprofile', g, d: g.keyDoc, role: g.plannedRoles[0], blocked: why });
          for (const r of g.plannedRoles.slice(1)) ops.push({ op: 'attach', g, role: r, blocked: why ? waiting.get(g) : null });
        }
        continue;
      }
      if (g.profileId) for (const r of g.plannedRoles) ops.push({ op: 'attach', g, role: r });
    }
    for (const d of S.docs) {
      if (d.mode === 'newprofile' || d.loadError || d.loading) continue;
      const g = d.group;
      if (d.virtual) {
        const willExist = g && g.plannedRoles.length && (g.profileId || (g.isNew && g.keyDoc && g.keyDoc.props));
        if (!willExist || !(d.props || d.noDefs) || !d.active) continue;
        const wait = waiting.get(g) || null;
        if (d.mode === 'link') ops.push({ op: 'link', d, blocked: wait });
        else if (d.mode === 'create') ops.push({ op: 'create', d, blocked: wait || (d.fileRequired ? FILE_MSG : null) });
        continue;
      }
      if (!d.props) continue;
      if (d.mode === 'edit') {
        if (docChanged(d)) ops.push({ op: 'update', d });
        else if (d.alsoLink && d.extraParts.length) ops.push({ op: 'linkextra', d });
      } else if (d.mode === 'create' && d.active) ops.push({ op: 'create', d, blocked: d.fileRequired ? FILE_MSG : null });
      else if (d.mode === 'link' && d.active) ops.push({ op: 'link', d });
    }
    return ops;
  }

  const OP_LABEL = { update: 'Atualizar', create: 'Criar', link: 'Vincular', linkextra: 'Vincular', newprofile: 'Cadastrar pessoa', attach: 'Incluir no ato' };

  function fieldLines(d, asCreate) {
    const lines = [];
    for (const f of d.fields) {
      if (!asCreate) {
        if (!fieldChanged(d, f)) continue;
        lines.push(h('li', null, h('b', null, `${f.name}: `), h('span', { class: 'old' }, showOrig(d, f) || '(vazio)'), ' → ', h('span', { class: 'new' }, showState(f, d.values[f.id]) || '(vazio)')));
      } else {
        const k = fieldKind(f);
        const data = effectiveData(d, f);
        if (norm(k, data) === '' || (k === 'boolean' && !toBool(data))) continue;
        lines.push(h('li', null, h('b', null, `${f.name}: `), h('span', { class: 'new' }, showState(f, d.values[f.id]))));
      }
    }
    return lines;
  }

  function missingRequired(d) {
    return d.fields.filter((f) => f.is_required && fieldKind(f) !== 'boolean' && norm(fieldKind(f), effectiveData(d, f)) === '').map((f) => f.name);
  }

  function reviewItem(p) {
    const st = h('span', { class: 'rv-st' });
    const extra = h('div');
    const kids = [];
    let title;
    if (p.op === 'attach') {
      title = `${p.g.name} como ${p.role.label}`;
      if (p.blocked) kids.push(h('div', { class: 'alert warn' }, p.blocked));
      kids.push(
        h(
          'div',
          { class: 'muted' },
          p.g.isNew
            ? 'Depois do cadastro da pessoa.'
            : p.g.isAuxRecord
              ? 'Inclui o registro do Livro 3 (Registro Auxiliar) neste papel do ato (a NoCartório pode repetir a inclusão nos outros atos do serviço).'
              : p.g.isProperty
              ? 'Inclui a matrícula neste papel do ato. A NoCartório costuma incluir sozinha os proprietários do imóvel (e pode repetir a inclusão nos outros atos do serviço).'
              : 'Inclui a parte neste papel do ato (a NoCartório pode repetir a inclusão nos outros atos do serviço).'
        )
      );
    } else if (p.op === 'newprofile') {
      const d = p.d;
      title = `${p.g.name} — ${d.typeName}`;
      const lines = fieldLines(d, true);
      if (p.blocked) kids.push(h('div', { class: 'alert warn' }, `${p.blocked} Feche esta revisão, complete o campo e volte.`));
      kids.push(h('div', { class: 'muted' }, `Cadastra a pessoa na NoCartório e inclui como ${p.role.label}.`));
      if (lines.length) kids.push(h('ul', null, lines));
    } else {
      const d = p.d;
      title = d.typeName;
      if (p.blocked) kids.push(h('div', { class: 'alert warn' }, p.blocked));
      if (d.virtual) kids.push(h('div', { class: 'muted' }, 'Depois da inclusão da parte no ato (só se a NoCartório pedir este tipo para o papel).'));
      if (p.op === 'link') kids.push(h('div', { class: 'muted' }, `Vincula o documento já cadastrado${d.docName ? `: ${d.docName}` : ''}.`));
      if (p.op === 'linkextra') kids.push(h('div', { class: 'muted' }, `Vincula também em: ${d.extraParts.map((x) => x.role).join(' / ')}.`));
      if (!d.props) {
        const vals = Object.entries((d.ext && d.ext.values) || {}).filter(([, v]) => !isBlank(v));
        kids.push(h('div', { class: 'muted' }, 'Valores da ficha aplicados na gravação:'));
        if (vals.length) kids.push(h('ul', null, vals.map(([k, v]) => h('li', null, h('b', null, `${k}: `), extText(v)))));
      } else if (p.op !== 'linkextra') {
        const lines = fieldLines(d, p.op === 'create');
        kids.push(lines.length ? h('ul', null, lines) : h('div', { class: 'muted' }, p.op === 'create' ? 'Nenhum campo preenchido.' : p.op === 'link' ? 'Sem alterações nos campos.' : ''));
        if (p.op === 'create' || (p.op === 'link' && docChanged(d))) {
          const miss = missingRequired(d);
          if (miss.length) kids.push(h('div', { class: 'alert warn' }, `Obrigatórios vazios: ${miss.join(', ')}. A NoCartório deve recusar.`));
        }
      }
      if (p.op !== 'linkextra' && !d.virtual && d.alsoLink && d.extraParts.length) kids.push(h('div', { class: 'muted' }, `E vincula também em: ${d.extraParts.map((x) => x.role).join(' / ')}.`));
    }
    const el = h('div', { class: 'rv-doc' }, h('div', { class: 'rv-hd' }, st, h('span', { class: `op ${p.op}` }, OP_LABEL[p.op]), h('b', null, title)), kids, extra);
    return { p, el, st, extra };
  }

  const groupOf = (p) => p.g || (p.d && p.d.group) || null;

  function reviewBlocks(items) {
    const byGroup = new Map();
    for (const it of items) {
      const g = groupOf(it.p);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(it);
    }
    return [...byGroup].map(([g, its]) =>
      h(
        'div',
        { class: 'rv-grp' },
        h('div', { class: 'rv-grp-hd' }, g ? g.name : 'Parte', h('span', { class: 'muted' }, g ? [...g.parts.map((p) => p.role), ...g.plannedRoles.map((r) => `+ ${r.label}`)].join(' / ') : '')),
        its.map((i) => i.el)
      )
    );
  }

  function openReview() {
    if (S.loading || S.saving) return;
    refreshMeta();
    const ops = collectOps();
    if (!ops.length) {
      toast('Não há alterações para salvar.');
      return;
    }
    const items = ops.map(reviewItem);
    const okCount = ops.filter((p) => !p.blocked).length;
    const sim = S.simulate;
    const partItems = items.filter((i) => i.p.op === 'newprofile' || i.p.op === 'attach');
    const docItems = items.filter((i) => !partItems.includes(i));
    const body = h(
      'div',
      { class: 'rv' },
      sim
        ? h('div', { class: 'alert info' }, 'Modo simulação: nada será gravado. Os dados que seriam enviados aparecem em cada item e no console do navegador.')
        : h(
            'div',
            { class: 'alert info' },
            partItems.length
              ? 'Grava primeiro as pessoas e os papéis; depois os documentos, um a um. Antes de cada documento, o script confere se ele não foi alterado por outra pessoa desde que foi carregado.'
              : 'Cada documento é gravado separadamente. Antes de gravar, o script confere se o documento não foi alterado por outra pessoa desde que foi carregado.'
          ),
      partItems.length ? [h('div', { class: 'stage' }, '1. Pessoas e papéis no ato'), reviewBlocks(partItems)] : null,
      docItems.length ? [partItems.length ? h('div', { class: 'stage' }, '2. Documentos') : null, reviewBlocks(docItems)] : null
    );
    const go = h('button', { class: 'btn primary', type: 'button', disabled: !okCount }, sim ? `Simular ${okCount} ${okCount === 1 ? 'item' : 'itens'}` : `Gravar ${okCount} ${okCount === 1 ? 'item' : 'itens'}`);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancelar');
    const m = modal(sim ? 'Revisar (simulação)' : 'Revisar antes de gravar', body, [cancel, go]);
    cancel.addEventListener('click', () => m.close());
    go.addEventListener('click', async () => {
      go.disabled = true;
      cancel.disabled = true;
      m.lock(true);
      try {
        await runSave(items, sim);
      } finally {
        m.lock(false);
        cancel.disabled = false;
        cancel.textContent = 'Fechar';
        go.hidden = true;
      }
    });
    setTimeout(() => go.focus(), 0);
  }

  async function saveUpdate(d) {
    // 1) O documento mudou desde que foi carregado? Se mudou, não grava.
    const fresh = await Net.page(editUrl(d));
    const fp = (fresh && fresh.props) || {};
    if (!fp.document || fp.document.id !== d.docId || !fp.document_type || !Array.isArray(fp.document_type.fields)) {
      throw new UErr('Não consegui recarregar o documento antes de gravar. Nada foi gravado.');
    }
    const fv = fp.document.fields_values || {};
    const conflicts = [];
    const freshIds = fp.document_type.fields.map((f) => f.id).join(',');
    const myIds = d.props.document_type.fields.map((f) => f.id).join(',');
    if (freshIds !== myIds) conflicts.push('configuração dos campos do documento');
    for (const f of d.fields) {
      const o = fv[f.id];
      const raw = o && o.data != null ? o.data : f.type !== 'boolean' && '';
      const k = fieldKind(f);
      if (norm(k, raw) !== norm(k, d.original[f.id].raw)) conflicts.push(f.name);
    }
    if (conflicts.length) return { conflict: conflicts };
    // 2) Envia o mesmo pacote da tela nativa.
    const body = buildUpdatePayload(d, fp);
    const res = await Net.send('PUT', routeUrl('v2.admin.manager.document.update', { profile: d.ctx.profileId, document: d.docId }), body);
    return { res, body };
  }

  async function saveCreate(d) {
    // 1) A tela de criação continua disponível? (também atualiza a versão da aplicação, se mudou)
    const fresh = await Net.page(createUrl(d));
    const fp = (fresh && fresh.props) || {};
    if (!fp.document_type || fp.document_type.id !== d.typeId) throw new UErr('Não consegui abrir a criação deste documento. Nada foi gravado.');
    // 2) Alguém já cadastrou este documento enquanto o painel estava aberto?
    const api = await Net.json(listUrl(d.ctx.processId, d.ctx.partId));
    const it = (api.items || []).find((x) => x.documentType && x.documentType.id === d.typeId);
    if (!it) throw new UErr('A parte não pede mais este tipo de documento. Nada foi gravado.');
    if (it.currentDocument && !(d.allowReplace && it.currentDocument.id === d.prevCurrentId)) return { conflict: ['já existe um documento deste tipo vinculado à parte'] };
    // 3) Envia o mesmo pacote da tela nativa.
    const body = buildCreatePayload(d);
    const res = await Net.send('POST', routeUrl('v2.admin.manager.document.store', { profile: d.ctx.profileId, document_type: d.typeId }), body);
    return { res, body };
  }

  /** Vincula à parte um documento que o perfil já tem; depois grava as alterações nos campos, se houver. */
  async function saveLink(d) {
    const api = await Net.json(listUrl(d.ctx.processId, d.ctx.partId));
    const it = (api.items || []).find((x) => x.documentType && x.documentType.id === d.typeId);
    if (!it) throw new UErr('A parte não pede mais este tipo de documento. Nada foi gravado.');
    const cur = it.currentDocument || null;
    let linked = false;
    if (!(cur && cur.id === d.docId)) {
      if (cur && !(d.allowReplace && cur.id === d.prevCurrentId)) return { conflict: ['outro documento deste tipo foi vinculado à parte enquanto o painel estava aberto'] };
      const r = await Net.apiPost(routeUrl('api.process.part.document.attach', { process_id: d.ctx.processId, part_id: d.ctx.partId, document_type_id: d.typeId }), { document_id: d.docId });
      if (!r.ok) return { res: { errors: { _: r.message } }, body: { document_id: d.docId } };
      linked = true;
    }
    if (docChanged(d)) {
      const u = await saveUpdate(d);
      if (u.conflict) return { conflict: u.conflict, linked };
      return { ...u, linked };
    }
    return { res: { errors: {} }, body: null, linked };
  }

  /** Cadastra a pessoa/empresa como parte (a tela nativa faz o cadastro e a inclusão no papel juntos). */
  async function saveNewProfile(g, p, sim) {
    const d = p.d;
    const body = buildProfileStorePayload(d);
    if (sim) return { sim: true, body };
    const ptrs = uniq([p.role.ptrId, ...g.plannedRoles.map((r) => r.ptrId)]);
    const before = await findProfileByKey(g.ext, ptrs);
    if (before) {
      setProfile(g, before.id);
      return { existed: true };
    }
    const url = routeUrl('v2.admin.manager.process.part-profile.create', { process: S.act.processId, processTypeRole: p.role.ptrId, profileType: d.props.profile_type.id });
    const fresh = await Net.page(url);
    const fp = fresh && fresh.props;
    if (!fp || !fp.document_type || fp.document_type.id !== d.typeId || !fp.profile_type || !fp.store_url) throw new UErr('Não consegui abrir o cadastro da pessoa. Nada foi gravado.');
    const res = await Net.send('POST', fp.store_url, body);
    if (Object.keys(res.errors).length) return { res, body };
    const after = await findProfileByKey(g.ext, ptrs);
    if (!after) return { res, body, notFound: true };
    setProfile(g, after.id);
    return { res, body };
  }

  function setProfile(g, profileId) {
    g.profileId = profileId;
    g.isNew = false;
    for (const x of g.docs) x.ctx.profileId = profileId;
  }

  /** Inclui um perfil já cadastrado num papel do ato (mesma chamada do seletor de partes). */
  async function saveAttach(g, role, sim, rolesNow) {
    if (sim) return { sim: true, body: { profile_id: g.profileId || '(perfil cadastrado no passo anterior)' } };
    if (!g.profileId) return { skip: 'A pessoa não foi cadastrada.' };
    const r = rolesNow && rolesNow.roles.find((x) => x.ptrId === role.ptrId);
    if (r && r.selection.some((s) => s.profileId === g.profileId)) return { already: true };
    if (r && r.readonly) return { error: 'O ato não permite incluir partes agora.' };
    const res = await Net.apiPost(routeUrl('api.process.attach-profile', { process_id: S.act.processId, process_type_role_id: role.ptrId }), { profile_id: g.profileId });
    if (!res.ok) return { error: res.message };
    const data = (res.data && typeof res.data === 'object' && res.data.data && typeof res.data.data === 'object' ? res.data.data : res.data) || {};
    const notices = (Array.isArray(data.part_notices) ? data.part_notices : []).map((n) => n && (n.description || n.title)).filter(Boolean);
    // Matrícula: a NoCartório inclui sozinha os proprietários (e avisa quando não consegue).
    const nameOf = (x) => (x && typeof x === 'object' ? String(x.name || x.label || x.nome || '') : String(x == null ? '' : x)).trim();
    const owners = (Array.isArray(data.auto_included_owners) ? data.auto_included_owners : []).map(nameOf).filter(Boolean);
    const ownerWarnings = (Array.isArray(data.auto_include_warnings) ? data.auto_include_warnings : []).map(nameOf).filter(Boolean);
    return { ok: true, replicated: Number(data.replicated_acts || 0), notices, owners, ownerWarnings };
  }

  /** Depois das inclusões: partes atualizadas do ato e o perfil de cada uma. */
  async function refreshActParts() {
    const act = await fetchAct(S.act);
    S.act.parts = act.parts;
    const unknown = act.parts.filter((p) => !S.partProfile.has(p.partId));
    await pool(unknown, 4, async (part) => {
      try {
        await loadPartInfo(S.act, part);
      } catch (e) {
        /* parte sem dados: fica de fora */
      }
    });
    for (const g of S.groups) {
      if (!g.profileId) continue;
      const mine = act.parts.filter((p) => {
        const info = S.partProfile.get(p.partId);
        return info && info.profileId === g.profileId;
      });
      if (mine.length) g.parts = mine.map((p) => ({ partId: p.partId, role: p.role, name: p.name, pageUrl: S.partProfile.get(p.partId).pageUrl || partPageUrl(S.act.processId, p.partId) }));
    }
  }

  /** Documento pendente → documento de uma parte real (a primeira parte da pessoa que pede o tipo). */
  async function materializeDoc(d, getItems) {
    const g = d.group;
    if (!g || !g.profileId) return { skip: 'A pessoa não foi cadastrada: documento não gravado.' };
    if (!g.parts.length) return { skip: 'A parte não ficou no ato (a inclusão falhou): documento não gravado.' };
    let target = null;
    const others = [];
    for (const part of g.parts) {
      const items = await getItems(part.partId);
      const it = items.find((x) => x.documentType && x.documentType.id === d.typeId);
      if (!it) continue;
      if (!target) target = { part, it };
      else others.push({ part, it });
    }
    if (!target) return { skip: `A NoCartório não pede “${d.typeName}” para ${g.parts.map((p) => p.role).join(' / ')} neste ato: documento não gravado.` };
    const { part, it } = target;
    d.ctx = { processId: S.act.processId, profileId: g.profileId, partId: part.partId, pageUrl: part.pageUrl };
    d.item = it;
    d.roles = [part.role];
    d.extraParts = others.map((o) => ({ partId: o.part.partId, role: o.part.role, pageUrl: o.part.pageUrl }));
    const cur = it.currentDocument || null;
    d.currentDocId = cur ? cur.id : null;
    d.prevCurrentId = d.currentDocId;
    d.allowReplace = true;
    const keep = d.props ? { values: d.values, dirty: d.dirty } : null;
    if (d.mode === 'link') {
      if (cur && cur.id === d.docId) d.mode = 'edit';
      const page = await Net.page(editUrl(d));
      const p = page && page.props;
      if (!p || !p.document || p.document.id !== d.docId || !p.document_type) throw new UErr('Não consegui reabrir o documento escolhido. Nada foi gravado.');
      initDoc(d, p);
    } else {
      if (it.rendering && it.rendering.canBeAddedManually === false) return { skip: `A NoCartório não permite cadastrar “${d.typeName}” à mão nesta parte.` };
      const page = await Net.page(createUrl(d));
      const p = page && page.props;
      if (!p || !p.document_type || p.document_type.id !== d.typeId) throw new UErr('Não consegui abrir o cadastro do documento. Nada foi gravado.');
      d.createProps = p;
      initDoc(d, p);
    }
    if (keep) {
      for (const fid of keep.dirty) {
        if (!(fid in d.original)) continue;
        d.values[fid] = keep.values[fid];
        d.dirty.add(fid);
      }
    } else if (d.ext) {
      await applyPrefill(d);
    }
    d.virtual = false;
    return { ok: true };
  }

  function setMark(st, cls, txt) {
    st.className = `rv-st ${cls}`;
    st.textContent = txt;
  }

  async function runSave(items, sim) {
    S.saving = true;
    renderHeader();
    refreshMeta();
    const partItems = items.filter((i) => i.p.op === 'newprofile' || i.p.op === 'attach');
    const docItems = items.filter((i) => !partItems.includes(i));
    const failed = new Set();
    let partsChanged = false;

    // Etapa 1 — pessoas e papéis
    let rolesNow = null;
    if (partItems.length && !sim) {
      try {
        rolesNow = await fetchActRoles(S.act.protocolId, S.act.processId);
      } catch (e) {
        rolesNow = null;
      }
    }
    for (const it of partItems) {
      const { p, st, extra } = it;
      const g = p.g;
      if (p.blocked) {
        if (p.op === 'newprofile') failed.add(g);
        st.textContent = '–';
        continue;
      }
      setMark(st, 'run', '…');
      try {
        if (failed.has(g)) {
          setMark(st, 'warn', '–');
          extra.replaceChildren(h('div', { class: 'alert warn' }, 'Não feito: o cadastro da pessoa não foi concluído.'));
          continue;
        }
        if (p.op === 'newprofile') {
          const r = await saveNewProfile(g, p, sim);
          if (r.sim) {
            console.info('[Cadastro unificado] simulação — cadastrar pessoa', g.name, r.body);
            extra.replaceChildren(h('details', null, h('summary', null, 'Dados que seriam enviados'), h('pre', null, JSON.stringify(r.body, null, 2))));
            setMark(st, 'ok', '✓');
            continue;
          }
          if (r.existed) {
            partsChanged = true;
            setMark(st, 'warn', '!');
            extra.replaceChildren(h('div', { class: 'alert warn' }, 'A pessoa já estava cadastrada (foi cadastrada enquanto o painel estava aberto): usei o cadastro existente.'));
            // inclui no papel do cadastro, que não foi feito
            const a = await saveAttach(g, p.role, false, rolesNow);
            if (a.error || a.skip) {
              failed.add(g);
              extra.append(h('div', { class: 'alert err' }, `Não consegui incluir como ${p.role.label}: ${a.error || a.skip}`));
            } else {
              roleDone(g, p.role);
            }
            continue;
          }
          const errs = (r.res && r.res.errors) || {};
          if (Object.keys(errs).length) {
            failed.add(g);
            const mapped = mapErrors(p.d, errs);
            p.d.errors = mapped.byField;
            p.d.status = { type: 'error', msg: 'A NoCartório recusou o cadastro:', list: mapped.list };
            setMark(st, 'err', '✗');
            extra.replaceChildren(h('div', { class: 'alert err' }, 'A NoCartório recusou o cadastro:', h('ul', null, mapped.list.map((t) => h('li', null, t)))));
            continue;
          }
          partsChanged = true;
          if (r.notFound) {
            failed.add(g);
            setMark(st, 'warn', '!');
            extra.replaceChildren(h('div', { class: 'alert warn' }, 'A NoCartório aceitou, mas não encontrei o cadastro novo pelo CPF/CNPJ. Confira na tela do ato antes de gravar de novo.'));
            continue;
          }
          p.d.status = { type: 'ok', msg: 'Pessoa cadastrada e incluída no ato.' };
          roleDone(g, p.role);
          setMark(st, 'ok', '✓');
          extra.replaceChildren(h('div', { class: 'alert ok' }, `Cadastrada e incluída como ${p.role.label}.`));
          continue;
        }
        // inclusão em papel
        const r = await saveAttach(g, p.role, sim, rolesNow);
        if (r.sim) {
          console.info('[Cadastro unificado] simulação — incluir parte', g.name, p.role.label, r.body);
          extra.replaceChildren(h('div', { class: 'muted' }, `Incluiria ${g.name} como ${p.role.label}.`));
          setMark(st, 'ok', '✓');
          continue;
        }
        if (r.skip) {
          setMark(st, 'warn', '–');
          extra.replaceChildren(h('div', { class: 'alert warn' }, r.skip));
          continue;
        }
        if (r.error) {
          setMark(st, 'err', '✗');
          extra.replaceChildren(h('div', { class: 'alert err' }, r.error));
          continue;
        }
        partsChanged = true;
        roleDone(g, p.role);
        const ownerWarn = r.ownerWarnings && r.ownerWarnings.length;
        setMark(st, ownerWarn ? 'warn' : 'ok', ownerWarn ? '!' : '✓');
        const bits = [r.already ? 'Já estava neste papel.' : g.isAuxRecord ? `Registro incluído como ${p.role.label}.` : g.isProperty ? `Matrícula incluída como ${p.role.label}.` : `Incluída como ${p.role.label}.`];
        if (r.replicated) bits.push(`A NoCartório incluiu também em ${r.replicated} outro(s) ato(s) do serviço.`);
        if (r.owners && r.owners.length) bits.push(`Proprietários incluídos automaticamente pela NoCartório: ${r.owners.join(', ')}.`);
        extra.replaceChildren(h('div', { class: 'alert ok' }, bits.join(' ')));
        if (ownerWarn) extra.append(h('div', { class: 'alert warn' }, h('b', null, 'Proprietários não incluídos:'), h('ul', null, r.ownerWarnings.map((t) => h('li', null, t)))));
        if (r.notices && r.notices.length) extra.append(h('div', { class: 'alert info' }, h('ul', null, r.notices.map((t) => h('li', null, t)))));
        // a inclusão automática de proprietários muda os papéis do ato: relê antes das próximas inclusões
        if (!r.already && (g.isProperty || (r.owners && r.owners.length))) {
          try {
            rolesNow = await fetchActRoles(S.act.protocolId, S.act.processId);
          } catch (e2) {
            /* segue com a lista anterior */
          }
        }
      } catch (e) {
        if (p.op === 'newprofile') failed.add(g);
        setMark(st, 'err', '✗');
        extra.replaceChildren(h('div', { class: 'alert err' }, e.message));
      }
    }
    if (partsChanged) S.needsReload = true;

    // Etapa 2 — partes recém-incluídas: localizar no ato
    const lists = new Map();
    const getItems = (partId) => {
      if (!lists.has(partId)) {
        const pr = Net.json(listUrl(S.act.processId, partId)).then((j) => (j && j.items) || []);
        lists.set(partId, pr);
        pr.catch(() => lists.delete(partId));
      }
      return lists.get(partId);
    };
    let refreshError = null;
    if (!sim && docItems.some((i) => i.p.d.virtual) && partsChanged) {
      try {
        await refreshActParts();
      } catch (e) {
        refreshError = e.message;
      }
    }

    // Etapa 3 — documentos
    const saved = [];
    for (const it of docItems) {
      const { p, st, extra } = it;
      const d = p.d;
      if (p.blocked) {
        st.textContent = '–';
        continue;
      }
      setMark(st, 'run', '…');
      try {
        if (sim) {
          let body;
          if (p.op === 'linkextra') body = { vincular_em: d.extraParts.map((x) => x.role), document_id: d.docId };
          else if (p.op === 'link') body = { vincular: { document_id: d.docId }, atualizar: docChanged(d) ? buildUpdatePayload(d) : null };
          else if (p.op === 'update') body = buildUpdatePayload(d);
          else body = d.props ? buildCreatePayload(d) : { valores_da_ficha: (d.ext && d.ext.values) || {} };
          if (d.virtual) body = { observacao: 'gravado depois da inclusão da parte no ato', ...body };
          console.info('[Cadastro unificado] simulação —', d.group ? d.group.name : '', '—', d.typeName, body);
          extra.replaceChildren(h('details', null, h('summary', null, 'Dados que seriam enviados'), h('pre', null, JSON.stringify(body, null, 2))));
          d.status = { type: 'sim' };
          setMark(st, 'ok', '✓');
          continue;
        }
        if (d.virtual) {
          if (d.group && failed.has(d.group)) {
            d.status = { type: 'skip', msg: 'Não gravado: a pessoa não foi cadastrada ou incluída.' };
            setMark(st, 'warn', '–');
            extra.replaceChildren(h('div', { class: 'alert warn' }, d.status.msg));
            continue;
          }
          if (refreshError) throw new UErr(`Não consegui recarregar as partes do ato: ${refreshError}`);
          const m = await materializeDoc(d, getItems);
          if (m.skip) {
            d.status = { type: 'skip', msg: m.skip };
            setMark(st, 'warn', '–');
            extra.replaceChildren(h('div', { class: 'alert warn' }, m.skip));
            continue;
          }
        }
        let r;
        if (d.mode === 'create') r = await saveCreate(d);
        else if (d.mode === 'link') r = await saveLink(d);
        else if (docChanged(d)) r = await saveUpdate(d);
        else r = { res: { errors: {} }, body: null };
        if (r.conflict) {
          d.status = { type: 'conflict', msg: `Não gravado: ${r.conflict.join(', ')}. Use “Recarregar” e refaça.` };
          setMark(st, 'warn', '!');
          extra.replaceChildren(h('div', { class: 'alert warn' }, d.status.msg));
          continue;
        }
        const errs = (r.res && r.res.errors) || {};
        if (Object.keys(errs).length) {
          const mapped = mapErrors(d, errs);
          d.errors = mapped.byField;
          d.generalErrors = mapped.general;
          d.status = { type: 'error', msg: 'A NoCartório recusou:', list: mapped.list };
          setMark(st, 'err', '✗');
          extra.replaceChildren(h('div', { class: 'alert err' }, 'A NoCartório recusou:', h('ul', null, mapped.list.map((t) => h('li', null, t)))));
          continue;
        }
        d.status = { type: r.res.uncertain ? 'uncertain' : 'ok', sent: r.body, op: d.mode, linked: !!r.linked };
        saved.push({ d, extra, st });
        setMark(st, 'ok', '✓');
        extra.replaceChildren(h('div', { class: 'muted' }, 'Gravado. Conferindo…'));
      } catch (e) {
        d.status = { type: 'error', msg: e.message };
        setMark(st, 'err', '✗');
        extra.replaceChildren(h('div', { class: 'alert err' }, e.message));
      }
    }
    if (saved.length) {
      S.needsReload = true;
      await verifySaved(saved);
    }
    for (const g of S.groups) {
      if (g.virtual && g.parts.length && g.profileId) g.virtual = false;
    }
    S.saving = false;
    renderAll();
  }

  /** Papel incluído: sai da lista de inclusões pendentes do grupo. */
  function roleDone(g, role) {
    g.plannedRoles = g.plannedRoles.filter((r) => r.ptrId !== role.ptrId);
  }

  /** Vincula o documento nas outras partes da mesma pessoa que pedem o tipo e ainda não têm documento. */
  async function linkExtraParts(d, getList) {
    const done = [];
    const skipped = [];
    for (const xp of d.extraParts) {
      const list = await getList(xp.partId);
      const it = list.get(d.typeId);
      if (!it) {
        skipped.push(`${xp.role} (não pede este tipo)`);
        continue;
      }
      if (it.currentDocument && it.currentDocument.id === d.docId) {
        done.push(xp.role);
        continue;
      }
      if (it.currentDocument) {
        skipped.push(`${xp.role} (já tem outro documento vinculado)`);
        continue;
      }
      const r = await Net.apiPost(routeUrl('api.process.part.document.attach', { process_id: S.act.processId, part_id: xp.partId, document_type_id: d.typeId }), { document_id: d.docId });
      if (r.ok) done.push(xp.role);
      else skipped.push(`${xp.role} (${r.message})`);
    }
    return { done, skipped };
  }

  /** Recarrega os documentos gravados e confere se o servidor guardou o que foi enviado. */
  async function verifySaved(saved) {
    const lists = new Map(); // parte → (tipo → item)
    const getList = async (pid) => {
      if (!lists.has(pid)) {
        try {
          const api = await Net.json(listUrl(S.act.processId, pid));
          lists.set(pid, new Map((api.items || []).map((it) => [it.documentType.id, it])));
        } catch (e) {
          lists.set(pid, new Map());
        }
      }
      return lists.get(pid);
    };
    for (const { d, extra, st } of saved) {
      const sent = d.status && d.status.sent;
      const wasCreate = d.mode === 'create';
      const wasLink = d.mode === 'link';
      const changedIds = wasCreate ? null : new Set(d.fields.filter((f) => fieldChanged(d, f)).map((f) => f.id));
      const it = (await getList(d.ctx.partId)).get(d.typeId);
      if (it) d.item = it;
      const notes = [];
      try {
        if (wasCreate) {
          if (!it || !it.currentDocument) throw new UErr('não encontrei o documento novo na lista da parte');
          if (d.prevCurrentId && it.currentDocument.id === d.prevCurrentId) throw new UErr('a parte continua com o documento anterior vinculado');
          d.mode = 'edit';
          d.docId = it.currentDocument.id;
          d.docName = it.currentDocument.name;
          d.active = true;
        } else if (wasLink) {
          if (!it || !it.currentDocument || it.currentDocument.id !== d.docId) throw new UErr('o documento não aparece vinculado na parte');
          d.mode = 'edit';
          d.docName = it.currentDocument.name;
        }
        d.currentDocId = d.docId;
        const diffs = [];
        if (sent || wasCreate || wasLink) {
          await loadDocProps(d);
          d.xinfo = new Map();
          if (sent && sent.document_fields) {
            for (const f of d.fields) {
              if (changedIds && !changedIds.has(f.id)) continue;
              const e = sent.document_fields[f.id];
              if (!e) continue;
              const sentData = e.entries && e.entries[0] ? e.entries[0].data : '';
              const k = fieldKind(f);
              const now = d.original[f.id].raw;
              const a = f.type === 'money' ? moneyToCents(now) : norm(k, now);
              const b = f.type === 'money' ? String(sentData) : norm(k, sentData);
              if (wasCreate && b === '') continue;
              if (a !== b) diffs.push(`${f.name} (ficou: ${showOrig(d, f) || 'vazio'})`);
            }
          }
        }
        if (d.alsoLink && d.extraParts.length) {
          const r = await linkExtraParts(d, getList);
          if (r.done.length) notes.push(`Vinculado também em: ${r.done.join(' / ')}.`);
          if (r.skipped.length) notes.push(`Não vinculado em: ${r.skipped.join('; ')}.`);
          d.extraParts = d.extraParts.filter((x) => !r.done.includes(x.role));
          if (!d.extraParts.length) d.alsoLink = false;
        }
        const base = wasCreate ? 'Criado e conferido.' : wasLink ? 'Vinculado e conferido.' : sent ? 'Gravado e conferido.' : 'Conferido.';
        d.status = diffs.length
          ? { type: 'warn', msg: `Gravado, mas a NoCartório guardou diferente do enviado em: ${diffs.join('; ')}. ${notes.join(' ')}`.trim() }
          : { type: notes.some((t) => t.startsWith('Não vinculado')) ? 'warn' : 'ok', msg: `${base} ${notes.join(' ')}`.trim() };
      } catch (e) {
        d.status = { type: 'warn', msg: `A NoCartório aceitou, mas não consegui conferir: ${e.message}. Confira na tela nativa.` };
      }
      if (d.status.type === 'ok') {
        extra.replaceChildren(h('div', { class: 'alert ok' }, d.status.msg));
      } else {
        setMark(st, 'warn', '!');
        extra.replaceChildren(h('div', { class: 'alert warn' }, d.status.msg));
      }
    }
  }

  /* ----- abrir / fechar ----- */

  /** O botão aparece nas telas do ato que têm a lista de partes (tela do ato, tela da parte…). */
  function actAvailable() {
    const path = location.pathname;
    if (PART_RE.test(path) || PROCESS_EDIT_RE.test(path)) return true;
    if (!PROCESS_RE.test(path)) return false;
    const pg = history.state && history.state.page;
    const parts = pg && pg.props && pg.props.layout && pg.props.layout.parts;
    return Array.isArray(parts) && parts.length > 0;
  }

  /** Abre o painel do ato da página atual ou, com opts.processId, de qualquer ato (ex.: a partir da tela do serviço). */
  async function openPanel(opts) {
    opts = opts || {};
    let processId = opts.processId || null;
    let focus = null;
    const here = location.pathname.match(PROCESS_RE);
    if (!processId) {
      if (!here || !actAvailable()) return false;
      processId = here[1];
    }
    if (S.open) return false;
    if (here && here[1].toLowerCase() === processId.toLowerCase()) {
      const pm = location.pathname.match(PART_RE);
      focus = pm ? pm[2] : null;
    }
    ensureUI();
    S.open = true;
    S.needsReload = false;
    S.fatal = null;
    S.ext = opts.ext || null;
    S.extRoles = null;
    S.extWarnings = [];
    UI.overlay.hidden = false;
    UI.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    syncFab();
    // Começa com o que a página já tem; loadAct() busca a lista de partes atualizada.
    S.act = { processId, protocolId: null, code: '', actName: '', parts: [], focusPartId: focus };
    if (here && here[1].toLowerCase() === processId.toLowerCase()) {
      try {
        S.act = actFromPage(history.state && history.state.page, processId, focus);
      } catch (e) {
        /* será buscada em loadAct() */
      }
    }
    UI.closeBtn.focus();
    await loadAct();
    return true;
  }

  async function closePanel(force, noReload) {
    if (!S.open) return;
    if (!force && S.saving) {
      toast('Aguarde terminar a gravação.');
      return;
    }
    if (!force && hasChanges() && !(await confirmBox('Há alterações não salvas. Fechar e descartar?', 'Descartar'))) return;
    S.open = false;
    S.act = null;
    S.ext = null;
    UI.overlay.hidden = true;
    UI.overlay.querySelectorAll('.layer').forEach((l) => l.remove());
    document.documentElement.style.overflow = UI.prevOverflow || '';
    syncFab();
    if (S.needsReload && !noReload) {
      S.needsReload = false;
      location.reload();
    }
  }

  /** API para outros scripts: abre o painel de um ato já com dados prontos (ex.: ficha). */
  async function openPrefilled(payload) {
    const err = validateExt(payload);
    if (err) throw new UErr(err);
    if (S.open) {
      if (S.saving) throw new UErr('Aguarde terminar a gravação em andamento.');
      if (hasChanges()) throw new UErr('O cadastro unificado está aberto com alterações não salvas. Salve ou feche antes de abrir a ficha.');
      await closePanel(true, true);
    }
    return openPanel({ processId: payload.processId, ext: JSON.parse(JSON.stringify(payload)) });
  }

  /* ----- botão flutuante ----- */

  function ensureFab() {
    if (UI.fabHost || !document.body) return;
    const host = h('div', { id: 'ncu-fab-host' });
    const root = host.attachShadow({ mode: 'open' });
    const btn = h('button', { class: 'fab', type: 'button', title: 'Editar e criar os documentos de todas as partes deste ato numa tela só (Alt+U)' }, svg(ICON_STACK, 16), h('span', null, 'Cadastro unificado'));
    btn.addEventListener('click', () => openPanel());
    root.append(h('style', null, FAB_CSS), btn);
    document.body.append(host);
    UI.fabHost = host;
  }

  function syncFab() {
    ensureFab();
    if (UI.fabHost) UI.fabHost.hidden = S.open || !actAvailable();
  }

  const onKey = (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'u' || e.key === 'U') && !S.open && actAvailable()) {
      e.preventDefault();
      openPanel();
    }
  };
  const onBeforeUnload = (e) => {
    if (S.open && (S.saving || hasChanges())) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('inertia:navigate', syncFab);
  window.addEventListener('popstate', syncFab);
  window.addEventListener('beforeunload', onBeforeUnload);
  const timer = setInterval(syncFab, 1500);
  syncFab();

  function destroy() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('inertia:navigate', syncFab);
    window.removeEventListener('popstate', syncFab);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (UI.host) UI.host.remove();
    if (UI.fabHost) UI.fabHost.remove();
    if (S.open) document.documentElement.style.overflow = UI.prevOverflow || '';
    for (const k of Object.keys(UI)) delete UI[k];
    S.open = false;
    delete window.__NCU_LOADED__;
    delete window.NCU;
  }

  // Acesso para diagnóstico pelo console (F12): NCU.payloads() mostra o que seria enviado.
  window.NCU = {
    version: VERSION,
    /** Versão do formato aceito por openPrefilled. */
    prefillApi: 2,
    open: (processId) => openPanel(processId ? { processId } : undefined),
    openPrefilled,
    close: closePanel,
    destroy,
    state: S,
    payloads: () =>
      collectOps().map((p) => {
        const d = p.d;
        if (p.op === 'attach') return { parte: p.g.name, operacao: 'incluir no papel', papel: p.role.label };
        if (p.op === 'newprofile') return { parte: p.g.name, operacao: 'cadastrar pessoa', papel: p.role.label, dados: buildProfileStorePayload(d) };
        return {
          parte: d.group ? d.group.name : '',
          papeis: d.roles.join(' / '),
          tipo: d.typeName,
          operacao: p.op,
          pendente: !!d.virtual,
          dados: !d.props ? (d.ext && d.ext.values) || {} : p.op === 'update' || p.op === 'link' ? buildUpdatePayload(d) : p.op === 'create' ? buildCreatePayload(d) : null,
        };
      }),
    _pure: PURE,
    _internals: { Net, routeUrl, saveUpdate, saveCreate, saveLink, verifySaved, loadAct, editUrl, createUrl, collectOps, fetchActRoles, profileDocs, resolveSelect },
  };
  try {
    window.dispatchEvent(new CustomEvent('ncu:ready', { detail: { version: VERSION, prefillApi: 2 } }));
  } catch (e) {
    /* sem eventos */
  }
})();
