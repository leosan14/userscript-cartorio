// ==UserScript==
// @name         NoCartório – Apontamento assistido (Protesto)
// @namespace    leosan14/nocartorio
// @version      0.2.1
// @description  Abre serviços "Protesto" a partir da ficha JSON (CENPROT/CRA): apresentante, cedente, sacador, devedores e Título Apresentado para Protesto. Gera a relação título × serviço para conferência e selagem manual.
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/admin/manager/*
// @require      https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @grant        none
// @sandbox      raw
// @inject-into  page
// @run-at       document-idle
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-apontamento-assistido.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-apontamento-assistido.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const CFG = {
    processTypeId: 6525,                 // serviço "Protesto"
    docTitulo: 324,                      // Título Apresentado para Protesto
    docEnderecoPF: 32,                   // Declaração de endereço de residência
    docEnderecoPJ: 34,                   // Declaração de endereço da sede da empresa
    profileTypePF: 1,
    profileTypePJ: 2,
    cidadeServentia: "São João d'Aliança - Goiás",
    storeKey: 'ncs-apontamento-assistido',
  };
  const BASE = location.origin;
  const UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };

  // ---------------------------------------------------------------- utils
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`´]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const maskCPF = (d) => d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  const maskCNPJ = (d) => d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const docOf = (p) => (p && (p.cpf ? { tipo: 'PF', d: digits(p.cpf) } : p.cnpj ? { tipo: 'PJ', d: digits(p.cnpj) } : null));
  const brl = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const dbr = (iso) => (iso ? String(iso).split('-').reverse().join('/') : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rel = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '');

  function xsrf() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Lê a versão Inertia do HTML: <script data-page="app" type="application/json">{…}</script> (v2) ou <div data-page="{…}"> (v1).
  function versionFromHtml(html) {
    const m2 = html.match(/<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/);
    if (m2) { try { return JSON.parse(m2[1]).version; } catch (e) { /* */ } }
    const m1 = html.match(/data-page="(\{[^"]+)"/);
    if (m1) { const t = document.createElement('textarea'); t.innerHTML = m1[1]; try { return JSON.parse(t.value).version; } catch (e) { /* */ } }
    return null;
  }

  let _version = null;
  async function inertiaVersion() {
    if (_version) return _version;
    try {
      _version = document.querySelector('#app').__vue_app__.config.globalProperties.$page.version;
    } catch (e) { /* fallback abaixo */ }
    if (!_version) {
      const el = document.querySelector('[data-page]');
      if (el && el.dataset.page) { try { _version = JSON.parse(el.dataset.page).version; } catch (e) { try { _version = JSON.parse(el.textContent).version; } catch (e2) { /* */ } } }
    }
    if (!_version) {
      const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
      _version = versionFromHtml(html);
    }
    return _version;
  }

  async function inertiaHeaders(extra) {
    return Object.assign({
      'X-Inertia': 'true',
      'X-Inertia-Version': await inertiaVersion(),
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, application/xhtml+xml',
      'X-XSRF-TOKEN': xsrf(),
    }, extra || {});
  }

  // Versão nova publicada no meio do uso: lê a versão atual no HTML da página e repete.
  async function refreshVersion(url) {
    const html = await (await fetch(url || location.href, { credentials: 'same-origin' })).text();
    const v = versionFromHtml(html);
    if (v) _version = v;
    return !!v;
  }

  async function inertiaGet(url, retried) {
    const r = await fetch(url, { credentials: 'same-origin', headers: await inertiaHeaders() });
    if (r.status === 409 && !retried && await refreshVersion(url)) return inertiaGet(url, true);
    if (r.status === 409) throw new Error('O NoCartório foi atualizado. Recarregue a página (F5) e rode de novo.');
    if (!r.ok) throw new Error(`GET ${rel(url)} → HTTP ${r.status}`);
    return r.json();
  }

  // POST/PUT Inertia: o servidor responde com redirect; o fetch segue e devolve a página destino (JSON).
  async function inertiaSend(method, url, data, multipart) {
    const headers = await inertiaHeaders(multipart ? {} : { 'Content-Type': 'application/json' });
    const r = await fetch(url, { method, credentials: 'same-origin', headers, body: multipart ? data : JSON.stringify(data) });
    if (r.status === 409) {
      const loc = r.headers.get('x-inertia-location');
      if (loc) return inertiaGet(loc);
      throw new Error('O NoCartório foi atualizado. Recarregue a página (F5) e rode de novo.');
    }
    if (r.status === 419) throw new Error('Sessão expirada (419). Recarregue a página.');
    let page = null;
    try { page = await r.json(); } catch (e) { throw new Error(`${method} ${rel(url)} → HTTP ${r.status} (resposta não-JSON)`); }
    const errs = page && page.props && page.props.errors;
    if (errs && Object.keys(errs).length) {
      throw new Error('Validação: ' + Object.entries(errs).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join(' | '));
    }
    if (!r.ok) throw new Error(`${method} ${rel(url)} → HTTP ${r.status}`);
    page.__finalUrl = r.url;
    return page;
  }

  async function apiGet(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    if (!r.ok) throw new Error(`GET ${rel(url)} → HTTP ${r.status}`);
    return r.json();
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': xsrf() },
      body: JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (e) { /* */ }
    if (!r.ok) throw new Error((j && j.message) || `POST ${rel(url)} → HTTP ${r.status}`);
    return j;
  }

  function routeUrl(name, params, fallback) {
    try { if (typeof window.route === 'function') return window.route(name, params); } catch (e) { /* */ }
    return BASE + fallback;
  }

  // ---------------------------------------------------------------- catálogo (formulários lidos na hora)
  const cache = { createPage: null, docTypes: {}, profileTypes: {}, selects: {} };

  async function getCreatePage() {
    if (cache.createPage) return cache.createPage;
    const j = await inertiaGet(`${BASE}/admin/manager/v2/protocol/${CFG.processTypeId}/create`);
    const roles = j.props.process_type_roles || [];
    const ap = roles.find((r) => /apresentante/i.test(r.name)) || roles[0];
    if (!ap) throw new Error('Não achei o papel Apresentante na criação do serviço Protesto.');
    cache.createPage = { storeUrl: j.props.store_url, roleApresentante: ap.id, roles };
    return cache.createPage;
  }

  // Campos de um tipo de documento: lidos do formulário de cadastro num perfil qualquer.
  async function getDocType(profileId, docTypeId) {
    if (cache.docTypes[docTypeId]) return cache.docTypes[docTypeId];
    const j = await inertiaGet(`${BASE}/admin/manager/v2/profile/${profileId}/document/${docTypeId}/create`);
    cache.docTypes[docTypeId] = j.props.document_type;
    return j.props.document_type;
  }

  async function getProfileType(pt) {
    if (cache.profileTypes[pt]) return cache.profileTypes[pt];
    const j = await inertiaGet(`${BASE}/admin/manager/v2/profile/create/${pt}`);
    cache.profileTypes[pt] = { profileType: j.props.profile_type, documentType: j.props.document_type, storeUrl: j.props.store_url };
    return cache.profileTypes[pt];
  }

  // ---------------------------------------------------------------- selects
  function splitCidade(txt) {
    const s = String(txt || '').trim();
    let mun = s, est = '';
    const m = s.match(/^(.*?)\s*(?:-|\/)\s*([^-/]+)$/);
    if (m) { mun = m[1]; est = m[2]; }
    est = est.trim();
    if (/^[A-Za-z]{2}$/.test(est)) est = UF[est.toUpperCase()] || est;
    return { mun: mun.trim(), est };
  }

  async function searchSelect(field, q) {
    const key = field.alias + '|' + q;
    if (cache.selects[key]) return cache.selects[key];
    const base = field.data_url.startsWith('http') ? field.data_url : BASE + field.data_url;
    const url = base + (base.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q);
    const j = await apiGet(url);
    const list = (j.data || j || []).map((o) => ({ id: o.id != null ? o.id : o.value, name: o.name || o.label || o.text || '' }));
    cache.selects[key] = list;
    return list;
  }

  async function resolveSelect(field, value) {
    if (value == null || value === '') return null;
    const alias = field.alias || '';
    if (alias === 'especie_titulo_apresentado') {
      const sigla = String(value.sigla || value).trim().toUpperCase();
      const list = await searchSelect(field, sigla);
      const hit = list.find((o) => o.name.toUpperCase().startsWith('(' + sigla + ')'));
      if (!hit && value.texto) {
        const l2 = await searchSelect(field, value.texto);
        const h2 = l2.find((o) => norm(o.name).includes(norm(value.texto)));
        if (h2) return h2;
      }
      return hit || null;
    }
    if (/cidade|praca|naturalidade/.test(alias)) {
      const { mun, est } = splitCidade(value);
      const list = await searchSelect(field, mun);
      const nm = norm(mun), ne = norm(est);
      // nomes vêm como "Município - Estado (País) - (IBGE …)" ou "Município/UF"
      const parts = (name) => {
        const [m, rest = ''] = name.split(/\s+-\s+/);
        if (m.includes('/') && !rest) { const [m2, uf] = m.split('/'); return { m: m2, st: UF[(uf || '').trim().toUpperCase()] || uf || '' }; }
        return { m, st: rest.replace(/\(.*$/, '').trim() };
      };
      const cands = list.filter((o) => norm(parts(o.name).m) === nm);
      const hit = cands.find((o) => !ne || norm(parts(o.name).st) === ne) || (cands.length === 1 ? cands[0] : null);
      return hit || null;
    }
    const list = await searchSelect(field, String(value));
    return list.find((o) => norm(o.name) === norm(value)) || list.find((o) => norm(o.name).includes(norm(value))) || null;
  }

  // Monta document_fields no formato do formulário v2 (id, entries[{data}], marcas de IA).
  async function buildFields(docType, values, warn) {
    const out = {};
    for (const f of docType.fields) {
      let v = values[f.alias];
      let data;
      if (v == null || v === '') {
        data = f.type === 'boolean' ? false : '';
        if (f.is_required) warn(`campo obrigatório sem dado: ${f.name}`);
      } else if (f.type === 'select') {
        const opt = await resolveSelect(f, v);
        if (!opt) { warn(`não achei a opção "${typeof v === 'object' ? (v.sigla || v.texto) : v}" em ${f.name}`); data = ''; } else data = String(opt.id);
      } else if (f.type === 'money') {
        data = String(Math.round(Number(v) * 100));
      } else if (['cpf', 'cnpj', 'zipcode', 'phone'].includes(f.type)) {
        data = digits(v);
      } else if (f.type === 'boolean') {
        data = !!v;
      } else {
        data = String(v);
      }
      out[f.id] = { id: f.id, entries: [{ data }], extracted_by_ai: false, ai_extracted_value_changed: false };
    }
    return out;
  }

  // ---------------------------------------------------------------- pessoas
  async function searchProfileByDoc(doc) {
    const { roleApresentante } = await getCreatePage();
    const q = doc.tipo === 'PF' ? maskCPF(doc.d) : maskCNPJ(doc.d);
    const j = await apiGet(`${BASE}/api/profiles/search-by-process-type-role-autocomplete?id=${roleApresentante}&q=${encodeURIComponent(q)}`);
    const list = j.data || [];
    const hit = list.find((o) => digits((o.name.match(/N[úu]mero do (?:CPF|CNPJ):\s*([\d./-]+)/i) || [])[1]) === doc.d);
    return hit ? { id: hit.id, label: hit.name } : null;
  }

  async function createProfile(p, opts, warn) {
    const doc = docOf(p);
    const pt = doc.tipo === 'PF' ? CFG.profileTypePF : CFG.profileTypePJ;
    const form = await getProfileType(pt);
    const values = doc.tipo === 'PF'
      ? { numero_cpf: doc.d, nome: p.nome, genero: opts.genero || 'Ignorado', numero_telefone: p.telefone, endereco_eletronico: p.email }
      : { numero_cnpj: doc.d, nome: p.nome, numero_telefone: p.telefone, endereco_eletronico: p.email, endereco_cidade: p.endereco && p.endereco.cidade };
    const document_fields = await buildFields(form.documentType, values, warn);
    const url = form.storeUrl || routeUrl('v2.admin.manager.profile.store', { profileType: pt }, `/admin/manager/v2/profile/${pt}`);
    await inertiaSend('POST', url, {
      profile_type_id: form.profileType.id,
      document_type_id: form.documentType.id,
      document_fields,
      redirect_back_url: null,
      extraction_ids: [],
    });
    await sleep(400);
    const found = await searchProfileByDoc(doc);
    if (!found) throw new Error(`Cadastrei ${p.nome}, mas não consegui localizá-lo pelo documento.`);
    return found.id;
  }

  async function profileDocs(profileId) {
    const j = await inertiaGet(`${BASE}/admin/manager/v2/profile/${profileId}/document`);
    return (j.props.documents && j.props.documents.data) || [];
  }

  async function docValues(profileId, docId) {
    const j = await inertiaGet(`${BASE}/admin/manager/v2/profile/${profileId}/document/${docId}/edit`);
    const dt = j.props.document_type, fv = j.props.document.fields_values || {};
    const out = {};
    for (const f of dt.fields) { const v = fv[f.id]; if (v) out[f.alias] = v.select_option ? v.select_option.label : v.data; }
    return out;
  }

  async function createDocument(profileId, docTypeId, values, warn) {
    const dt = await getDocType(profileId, docTypeId);
    const document_fields = await buildFields(dt, values, warn);
    await inertiaSend('POST', routeUrl('v2.admin.manager.document.store', { profile: profileId, document_type: docTypeId }, `/admin/manager/v2/profile/${profileId}/document/${docTypeId}`), {
      document_type_id: docTypeId,
      document_fields,
      redirect_uri: null,
      process_part_id: null,
      extraction_ids: [],
    });
  }

  // Endereço: cria para pessoa nova; para pessoa existente compara e só cria se o modo permitir.
  async function ensureEndereco(profileId, p, novo, modo, warn) {
    const e = p.endereco;
    if (!e || !e.rua) return;
    const doc = docOf(p);
    const dt = doc.tipo === 'PF' ? CFG.docEnderecoPF : CFG.docEnderecoPJ;
    if (modo === 'nunca') return;
    if (!novo) {
      const docs = (await profileDocs(profileId)).filter((d) => d.document_type.id === dt);
      let igual = false;
      for (const d of docs.slice(0, 10)) {
        const v = await docValues(profileId, d.id);
        if (norm(v.endereco_rua).includes(norm(e.rua).slice(0, 12)) && (!e.cep || !v.endereco_cep || digits(v.endereco_cep) === digits(e.cep))) { igual = true; break; }
      }
      if (igual) return;
      if (modo === 'avisar') {
        warn(`${p.nome}: endereço do título não confere com os cadastrados — conferir/atualizar (${e.rua}${e.cep ? ', CEP ' + e.cep : ''})`);
        return;
      }
      warn(`${p.nome}: cadastrado o endereço do título (${e.rua}), diferente dos que já existiam`);
    }
    await createDocument(profileId, dt, {
      identificador_registro: `ENDEREÇO - ${e.rua}`.toUpperCase().slice(0, 190),
      endereco_cep: e.cep,
      endereco_rua: e.rua,
      endereco_numero: e.numero,
      endereco_complemento: e.complemento,
      endereco_bairro: e.bairro,
      endereco_cidade: e.cidade,
    }, warn);
  }

  // Resolve (e, se preciso, cadastra) a pessoa. Cache por documento dentro do lote.
  async function ensurePessoa(p, ctx, warn) {
    const doc = docOf(p);
    if (!doc || !doc.d) throw new Error(`Pessoa sem CPF/CNPJ na ficha: ${p && p.nome}`);
    if (ctx.pessoas[doc.d]) return ctx.pessoas[doc.d];
    let found = await searchProfileByDoc(doc);
    let novo = false;
    let id;
    if (found) id = found.id;
    else {
      id = await createProfile(p, { genero: (ctx.generos || {})[doc.d] }, warn);
      novo = true;
      warn(`${p.nome}: cadastrado como pessoa nova${doc.tipo === 'PF' ? ` (sexo: ${(ctx.generos || {})[doc.d] || 'Ignorado'})` : ''}`);
    }
    try { await ensureEndereco(id, p, novo, ctx.modoEndereco, warn); } catch (e) { warn(`${p.nome}: endereço não cadastrado (${e.message})`); }
    ctx.pessoas[doc.d] = id;
    return id;
  }

  // ---------------------------------------------------------------- serviço
  async function getProcesses(protocolId) {
    const all = [];
    for (let page = 1; page < 10; page++) {
      const j = await apiGet(`${BASE}/api/v2/protocols/${protocolId}/processes?page=${page}`);
      all.push(...(j.data || []));
      if (!j.last_page || page >= j.last_page) break;
    }
    return all;
  }

  function inputByLabel(proc, re) {
    return Object.values(proc.inputs || {}).find((i) => re.test(i.label || ''));
  }

  async function setRole(proc, input, wantIds, warn) {
    const role = input.meta && input.meta.processTypeRoleId;
    if (!role) { warn(`${proc.processType.name}: papel ${input.label} sem id`); return; }
    if (input.readonly) { warn(`${proc.processType.name}: papel ${input.label} está bloqueado`); return; }
    const cur = (input.initialSelection || []).map((s) => s.value);
    const want = [...new Set(wantIds)];
    for (const v of cur) {
      if (!want.includes(v)) await apiPost(`${BASE}/api/process/${proc.id}/process-type-role/${role}/detach-profile`, { profile_id: v });
    }
    for (const v of want) {
      if (!cur.includes(v)) await apiPost(`${BASE}/api/process/${proc.id}/process-type-role/${role}/attach-profile`, { profile_id: v });
    }
  }

  // Apresentante do SERVIÇO (não do ato): o serviço é um processo próprio com o papel Apresentante.
  async function serviceIdOf(protocolId) {
    const j = await inertiaGet(`${BASE}/admin/manager/v2/protocol/${protocolId}`);
    const d = j.props && j.props.protocol && j.props.protocol.data;
    return { sid: d && d.service && d.service.id, code: d && d.protocolInformation && d.protocolInformation.code };
  }

  async function ensureApresentanteServico(protocolId, apId, warn) {
    const { sid } = await serviceIdOf(protocolId);
    if (!sid) { warn('Não achei o processo do serviço para conferir o apresentante.'); return false; }
    const ed = await inertiaGet(`${BASE}/admin/manager/v2/process/${sid}/edit`);
    const inputs = Object.values((ed.props.content && ed.props.content.inputs) || {});
    const inp = inputs.find((i) => /^Apresentante/i.test(i.label || ''));
    if (!inp) { warn('Serviço sem papel Apresentante editável.'); return false; }
    const cur = (inp.initialSelection || []).map((x) => x.value);
    if (cur.includes(apId)) return false;
    if (cur.length) { warn('O serviço já tinha outro apresentante: mantido. Conferir.'); return false; }
    await apiPost(`${BASE}/api/process/${sid}/process-type-role/${inp.meta.processTypeRoleId}/attach-profile`, { profile_id: apId });
    return true;
  }

  // Corrige serviços já abertos que ficaram sem apresentante do serviço.
  // Usa o Apresentante do ato de apontamento; sem ele, o Sacador (com aviso).
  async function corrigirApresentantes(lista, log) {
    const out = [];
    for (const prot of lista) {
      const linha = { code: prot.code || prot.id, link: `${BASE}/admin/manager/v2/protocol/${prot.id}`, msg: '' };
      try {
        const procs = await getProcesses(prot.id);
        const apont = procs.find((p) => inputByLabel(p, /Apontamento do Tabelionato/i));
        if (!apont) throw new Error('sem ato de apontamento');
        const apIn = inputByLabel(apont, /^Apresentante$/i);
        const sacIn = inputByLabel(apont, /^Sacador$/i);
        let apId = apIn && apIn.initialSelection && apIn.initialSelection[0] && apIn.initialSelection[0].value;
        let origem = 'Apresentante do ato';
        if (!apId) { apId = sacIn && sacIn.initialSelection && sacIn.initialSelection[0] && sacIn.initialSelection[0].value; origem = 'Sacador (conferir)'; }
        if (!apId) throw new Error('ato sem Apresentante e sem Sacador');
        const avisos = [];
        const fez = await ensureApresentanteServico(prot.id, apId, (m) => avisos.push(m));
        if (apIn && !(apIn.initialSelection || []).length) await setRole(apont, apIn, [apId], (m) => avisos.push(m));
        linha.msg = (fez ? `incluído (${origem})` : 'já tinha') + (avisos.length ? ' — ' + avisos.join(' ') : '');
      } catch (e) { linha.msg = 'ERRO: ' + e.message; }
      log(`${linha.code}: ${linha.msg}`);
      out.push(linha);
    }
    return out;
  }

  async function createProtocol(apresentanteId) {
    const cp = await getCreatePage();
    const page = await inertiaSend('POST', cp.storeUrl, {
      // formato do formulário de criação: { <papel>: { id: <papel>, profiles: [<perfil>] } }
      process_type_roles: { [cp.roleApresentante]: { id: cp.roleApresentante, profiles: [apresentanteId] } },
      allow_empty_presenters: false,
    });
    const pd = page.props && page.props.protocol && page.props.protocol.data;
    let id = pd && pd.id;
    if (!id) {
      const m = String(page.url || page.__finalUrl || '').match(/protocol\/([0-9a-f-]{36})/);
      id = m && m[1];
    }
    if (!id) throw new Error('Serviço criado, mas não identifiquei o código (veja em Serviços → Não inicializados).');
    const code = (pd && pd.protocolInformation && pd.protocolInformation.code) || '';
    return { id, code };
  }

  async function uploadRequerimento(protocolId, blob, name) {
    const fd = new FormData();
    fd.append('file[0]', new File([blob], name, { type: 'application/pdf' }));
    await inertiaSend('POST', routeUrl('v2.admin.manager.protocol.requirements', { protocol: protocolId }, `/admin/manager/v2/protocol/${protocolId}/requirements`), fd, true);
  }

  async function pdfPaginas(ctx, paginas) {
    if (!ctx.pdfBytes) return null;
    if (!paginas || !paginas.length || !window.PDFLib) return new Blob([ctx.pdfBytes], { type: 'application/pdf' });
    const { PDFDocument } = window.PDFLib;
    const src = ctx.pdfDoc || (ctx.pdfDoc = await PDFDocument.load(ctx.pdfBytes));
    const out = await PDFDocument.create();
    const idx = paginas.map((n) => n - 1).filter((i) => i >= 0 && i < src.getPageCount());
    const pages = await out.copyPages(src, idx.length ? idx : src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  function tituloKey(f, t) {
    return [f.origem, t.titulo.numero, t.titulo.nosso_numero, (t.devedores || []).map((d) => digits(d.cpf || d.cnpj)).join('+'), t.titulo.valor].join('|');
  }

  function loadStore() { try { return JSON.parse(localStorage.getItem(CFG.storeKey) || '{}'); } catch (e) { return {}; } }
  function saveStore(s) { try { localStorage.setItem(CFG.storeKey, JSON.stringify(s)); } catch (e) { /* */ } }

  async function processarTitulo(ficha, t, ctx, log) {
    const avisos = [...(t.avisos || [])];
    const warn = (m) => { avisos.push(m); log('  ⚠ ' + m); };
    const res = { ref: t.ref, titulo: t.titulo, devedores: (t.devedores || []).map((d) => d.nome).join('; '), avisos, protocolo: null, ok: false };

    const apresentante = t.apresentante || t.sacador;
    if (!t.apresentante) warn('Ficha sem apresentante: usado o sacador.');
    const sacador = t.sacador || apresentante;
    const cedente = t.cedente || sacador;

    log('• Pessoas…');
    const apId = await ensurePessoa(apresentante, ctx, warn);
    const sacId = await ensurePessoa(sacador, ctx, warn);
    const cedId = await ensurePessoa(cedente, ctx, warn);
    const devIds = [];
    for (const d of t.devedores || []) devIds.push(await ensurePessoa(d, ctx, warn));
    if (!devIds.length) throw new Error('Ficha sem devedor.');

    const anterior = (ctx.store.feitos || {})[tituloKey(ficha, t)];
    let prot;
    if (anterior && anterior.id) {
      log(`• Completando o serviço já aberto ${anterior.code || anterior.id}…`);
      prot = { id: anterior.id, code: anterior.code };
    } else {
      log('• Criando serviço Protesto…');
      prot = await createProtocol(apId);
    }
    res.protocolo = { id: prot.id, code: prot.code, link: `${BASE}/admin/manager/v2/protocol/${prot.id}` };
    log(`  serviço ${prot.code || prot.id}`);
    ctx.store.feitos[tituloKey(ficha, t)] = res.protocolo; saveStore(ctx.store);

    try {
      if (await ensureApresentanteServico(prot.id, apId, warn)) warn('Apresentante do serviço estava vazio: incluído.');
    } catch (e) { warn('Não conferi o apresentante do serviço: ' + e.message); }

    log('• Partes dos atos…');
    let procs = await getProcesses(prot.id);
    const apont = procs.find((p) => inputByLabel(p, /Apontamento do Tabelionato/i)) || procs.find((p) => /^Apontamento/i.test(p.processType.name));
    if (!apont) throw new Error('Não achei o ato de Apontamento no serviço.');
    // Rede de segurança: garante o Apresentante no ato de apontamento.
    const apr = inputByLabel(apont, /^Apresentante$/i);
    if (apr) {
      const tinha = (apr.initialSelection || []).some((s) => s.value === apId);
      if (!tinha) { await setRole(apont, apr, [apId], warn); warn('Apresentante não veio da criação do serviço: incluído no ato de apontamento. Conferir o Apresentante do serviço.'); }
    } else warn('Ato de apontamento sem papel Apresentante');
    const ced = inputByLabel(apont, /^Cedente$/i); if (ced) await setRole(apont, ced, [cedId], warn); else warn('Ato de apontamento sem papel Cedente');
    const sac = inputByLabel(apont, /^Sacador$/i); if (sac) await setRole(apont, sac, [sacId], warn); else warn('Ato de apontamento sem papel Sacador');
    const dev = inputByLabel(apont, /^Devedor/i); if (dev) await setRole(apont, dev, devIds, warn); else warn('Ato de apontamento sem papel Devedor');

    // Outros atos com Devedor (Intimação etc.): relê porque a inclusão pode ter sido replicada.
    procs = await getProcesses(prot.id);
    for (const p of procs) {
      if (p.id === apont.id) continue;
      const di = inputByLabel(p, /^Devedor/i);
      if (di && !di.readonly) await setRole(p, di, devIds, warn);
    }

    log('• Título apresentado…');
    const apontNow = procs.find((p) => p.id === apont.id) || apont;
    const tmpIn = inputByLabel(apontNow, /Apontamento do Tabelionato/i);
    const tmpId = tmpIn && tmpIn.initialSelection && tmpIn.initialSelection[0] && tmpIn.initialSelection[0].value;
    if (!tmpId) throw new Error('Não achei o perfil temporário do apontamento.');
    const docs = await profileDocs(tmpId);
    let tituloOk = true;
    if (docs.some((d) => d.document_type.id === CFG.docTitulo)) warn('O apontamento já tinha um Título Apresentado: não criei outro.');
    else {
      const tt = t.titulo;
      if (!tt.praca) warn(`Praça de pagamento não informada: usada ${CFG.cidadeServentia}.`);
      const venc = vencimentoDe(tt, warn);
      try {
        await createDocument(tmpId, CFG.docTitulo, {
          especie_titulo_apresentado: { sigla: tt.especie_sigla, texto: tt.especie_texto },
          numero_titulo: tt.numero,
          nosso_numero: tt.nosso_numero,
          data_emissao: tt.data_emissao,
          data_vencimento: venc,
          valor: tt.valor,
          saldo: tt.saldo != null ? tt.saldo : tt.valor,
          praca_protesto: tt.praca || CFG.cidadeServentia,
          data_apresentacao: tt.data_apresentacao || ctx.hoje,
        }, warn);
      } catch (e) {
        tituloOk = false;
        warn('TÍTULO NÃO GRAVADO — cadastrar à mão no apontamento: ' + e.message);
      }
    }

    log('• Documentos das partes nos atos…');
    const hints = [apresentante, sacador, cedente, ...(t.devedores || [])].map((p) => p && p.endereco && p.endereco.rua).filter(Boolean);
    const pend = await vincularDocumentos(await getProcesses(prot.id), hints, warn, log);
    res.pendencias = pend;

    if (ctx.pdfBytes && ctx.anexarPdf) {
      log('• Requerimento (PDF)…');
      try {
        const blob = await pdfPaginas(ctx, t.paginas);
        await uploadRequerimento(prot.id, blob, `${ficha.origem || 'ficha'}-${(t.titulo.numero || t.ref || 'titulo').replace(/[^\w-]+/g, '_')}.pdf`);
      } catch (e) { warn('PDF não anexado: ' + e.message); }
    }

    res.ok = tituloOk && !pend.length;
    if (!res.ok) res.erro = !tituloOk ? 'Título Apresentado não gravado' : `${pend.length} documento(s) obrigatório(s) sem vínculo`;
    return res;
  }

  // Vencimento "à vista": o cartório lança a data de emissão (como nas CDAs).
  function vencimentoDe(tt, warn) {
    if (tt.data_vencimento) return tt.data_vencimento;
    if (tt.vencimento_a_vista || /vista/i.test(String(tt.vencimento_texto || ''))) {
      if (tt.data_emissao) { warn(`Vencimento à vista: lançada a data de emissão (${dbr(tt.data_emissao)}). Conferir.`); return tt.data_emissao; }
    }
    if (tt.data_emissao) { warn(`Título sem vencimento: lançada a data de emissão (${dbr(tt.data_emissao)}). Conferir.`); return tt.data_emissao; }
    return '';
  }

  // Seleciona, em cada ato e parte, o documento obrigatório que ainda não está vinculado
  // (endereço, título etc.). Sem isso o NoCartório recusa o registro do ato.
  async function vincularDocumentos(procs, hints, warn, log) {
    const pend = [];
    const nh = hints.map((h) => norm(h).slice(0, 12)).filter(Boolean);
    for (const proc of procs) {
      let parts = [];
      try {
        const ed = await inertiaGet(`${BASE}/admin/manager/v2/process/${proc.id}/edit`);
        parts = (ed.props.layout && ed.props.layout.parts) || [];
      } catch (e) { warn(`${proc.processType.name}: não li as partes (${e.message})`); continue; }
      for (const part of parts) {
        let items = [];
        try { items = (await apiGet(`${BASE}/api/process/${proc.id}/part/${part.partId}/documents`)).items || []; } catch (e) { warn(`${part.role}: documentos não lidos (${e.message})`); continue; }
        for (const it of items) {
          const req = (it.settings || []).some((s) => Number(s.isRequired) === 1) || (it.partDocument && it.partDocument.isRequired);
          if (!req || it.currentDocument || it.waivedDocument) continue;
          const dt = it.documentType;
          const quem = `${proc.processType.name.replace(/\s*\(.*\)$/, '')} › ${part.role} (${String(part.name).slice(0, 40)})`;
          let cands = [];
          try { cands = (await apiGet(`${BASE}/api/process/${proc.id}/part/${part.partId}/document-type/${dt.id}/search`)).data || []; } catch (e) { /* */ }
          if (!cands.length) { pend.push(`${quem}: ${dt.name}`); warn(`${quem}: não há ${dt.name} no cadastro — cadastrar e selecionar`); continue; }
          let escolha = cands.find((c) => nh.some((h) => norm(c.value || c.label || c.name).includes(h)));
          if (!escolha) {
            escolha = cands[0];
            if (cands.length > 1) warn(`${quem}: ${dt.name} — escolhido "${escolha.value || escolha.label}" entre ${cands.length}. Conferir.`);
          }
          try {
            await apiPost(`${BASE}/api/process/${proc.id}/part/${part.partId}/document-type/${dt.id}/attach`, { document_id: escolha.id });
            log(`  ${quem}: ${dt.name} ✓`);
          } catch (e) { pend.push(`${quem}: ${dt.name}`); warn(`${quem}: não vinculei ${dt.name} (${e.message})`); }
        }
      }
    }
    return pend;
  }

  // ---------------------------------------------------------------- conferência (só leitura)
  async function conferir(ficha) {
    const rows = [];
    const store = loadStore();
    const pessoasVistas = {};
    for (const [i, t] of (ficha.titulos || []).entries()) {
      const row = { i, t, pessoas: [], avisos: [...(t.avisos || [])], erro: null, feito: (store.feitos || {})[tituloKey(ficha, t)] || null };
      try {
        if (!t.titulo || !t.titulo.numero) throw new Error('Título sem número.');
        if (!(t.devedores || []).length) throw new Error('Título sem devedor.');
        const lista = [['Apresentante', t.apresentante || t.sacador], ['Sacador', t.sacador], ['Cedente', t.cedente], ...(t.devedores || []).map((d) => ['Devedor', d])];
        for (const [papel, p] of lista) {
          if (!p) continue;
          const doc = docOf(p);
          if (!doc) { row.avisos.push(`${papel} ${p.nome || ''} sem CPF/CNPJ`); continue; }
          let st = pessoasVistas[doc.d];
          if (!st) { const f = await searchProfileByDoc(doc); st = pessoasVistas[doc.d] = { existe: !!f, label: f ? f.label : '' }; }
          row.pessoas.push({ papel, nome: p.nome, doc, existe: st.existe });
        }
        // valida os selects do título
        const cp = await getCreatePage(); void cp;
        const fEsp = { alias: 'especie_titulo_apresentado', data_url: '/api/cenprot-especie-titulo/search-for-autocomplete' };
        const esp = await resolveSelect(fEsp, { sigla: t.titulo.especie_sigla, texto: t.titulo.especie_texto });
        row.especie = esp ? esp.name : null;
        if (!esp) row.avisos.push(`Espécie "${t.titulo.especie_sigla}" não encontrada no NoCartório`);
        const fCid = { alias: 'praca_protesto', data_url: '/api/city/search-for-autocomplete' };
        const praca = await resolveSelect(fCid, t.titulo.praca || CFG.cidadeServentia);
        row.praca = praca ? praca.name : null;
        if (!praca) row.avisos.push(`Praça "${t.titulo.praca}" não encontrada`);
        for (const req of ['data_emissao', 'valor']) if (t.titulo[req] == null || t.titulo[req] === '') row.avisos.push(`Título sem ${req}`);
        if (!t.titulo.data_vencimento) row.avisos.push(t.titulo.data_emissao ? `Sem data de vencimento${t.titulo.vencimento_a_vista ? ' (à vista)' : ''}: será lançada a data de emissão` : 'Título sem vencimento nem emissão: o NoCartório vai recusar');
      } catch (e) { row.erro = e.message; }
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------- UI
  const css = `
  #ncs-aa-btn{position:fixed;left:16px;bottom:16px;z-index:99998;background:#f97316;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 13px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
  #ncs-aa{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px}
  #ncs-aa .box{background:#fff;color:#111;width:min(1180px,100%);border-radius:12px;padding:18px 20px;font:13px/1.4 system-ui;box-shadow:0 10px 40px rgba(0,0,0,.35)}
  #ncs-aa h2{margin:0 0 4px;font-size:17px}#ncs-aa h3{margin:14px 0 6px;font-size:14px}
  #ncs-aa .muted{color:#666;font-size:12px}
  #ncs-aa textarea{width:100%;height:140px;font:12px ui-monospace,monospace;border:1px solid #ccc;border-radius:8px;padding:8px;box-sizing:border-box}
  #ncs-aa .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
  #ncs-aa button{border:1px solid #ccc;background:#f8f8f8;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12px system-ui}
  #ncs-aa button.pri{background:#f97316;color:#fff;border-color:#f97316}
  #ncs-aa button:disabled{opacity:.5;cursor:default}
  #ncs-aa table{border-collapse:collapse;width:100%;font-size:12px}
  #ncs-aa th,#ncs-aa td{border:1px solid #e3e3e3;padding:5px 6px;vertical-align:top;text-align:left}
  #ncs-aa th{background:#fafafa}
  #ncs-aa .tag{display:inline-block;border-radius:6px;padding:0 6px;font-size:11px;font-weight:600}
  #ncs-aa .novo{background:#fff4e5;color:#b45309}#ncs-aa .ok{background:#e8f7ee;color:#15803d}#ncs-aa .err{background:#fde8e8;color:#b91c1c}
  #ncs-aa .warn{color:#b45309;font-size:11px}
  #ncs-aa pre.log{background:#111;color:#ddd;max-height:220px;overflow:auto;padding:8px;border-radius:8px;font-size:11px;white-space:pre-wrap}
  #ncs-aa .x{float:right;border:0;background:none;font-size:20px;line-height:1}`;

  function mountButton() {
    if (document.getElementById('ncs-aa-btn')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const b = document.createElement('button');
    b.id = 'ncs-aa-btn'; b.textContent = 'Apontamento assistido';
    b.title = 'Abrir serviços de Protesto a partir da ficha JSON (CENPROT/CRA)';
    b.onclick = openPanel;
    document.body.appendChild(b);
  }

  function shouldShow() {
    const p = location.pathname;
    return /\/company\/protocol\/create\/[^/]+\/company-type\/3\b/.test(p) || new RegExp(`/v2/protocol/${CFG.processTypeId}/create`).test(p) || /\/v2\/protocol\/?$/.test(p);
  }

  let state = null;

  function openPanel() {
    const last = loadStore().ultimaRelacao;
    state = { ficha: null, rows: null, pdfBytes: null, results: [] };
    const ov = document.createElement('div'); ov.id = 'ncs-aa';
    ov.innerHTML = `<div class="box">
      <button class="x" data-a="close">×</button>
      <h2>Apontamento assistido — Protesto</h2>
      <div class="muted">Cole a ficha JSON gerada pela skill <b>ficha-protesto</b> (CENPROT/CRA). O script confere as pessoas, abre um serviço <b>Protesto</b> por título, preenche Apresentante, Cedente, Sacador, Devedor(es) e o <b>Título Apresentado para Protesto</b>. Selos e pagamento ficam com a escrevente.</div>
      <div class="row"><input type="file" accept=".json,application/json" data-a="json"> <span class="muted">ou cole abaixo</span></div>
      <textarea data-a="txt" placeholder='{"ficha_protesto_versao":1,"origem":"CENPROT","titulos":[...]}'></textarea>
      <div class="row">
        <label>PDF original (opcional, vai como Requerimento): <input type="file" accept="application/pdf" data-a="pdf"></label>
        <label><input type="checkbox" data-a="anexar" checked> anexar o PDF (só as páginas do título)</label>
      </div>
      <div class="row">
        <label>Endereço das partes: <select data-a="modo">
          <option value="diferente">cadastrar o do título quando não houver um igual</option>
          <option value="avisar">só avisar se for diferente (pessoas novas recebem)</option>
          <option value="nunca">não cadastrar</option>
        </select></label>
        <button class="pri" data-a="conferir">Conferir ficha</button>
        ${last ? '<button data-a="ultima">Última relação</button>' : ''}
        <button data-a="fixap" title="Inclui o apresentante do serviço nos serviços abertos pelo script que ficaram sem ele">Corrigir apresentante dos serviços abertos</button>
      </div>
      <div data-a="conf"></div>
      <div data-a="out"></div>
    </div>`;
    document.body.appendChild(ov);
    const $ = (a) => ov.querySelector(`[data-a="${a}"]`);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    $('close').onclick = close;
    function close() { ov.remove(); }
    $('json').onchange = async (e) => { const f = e.target.files[0]; if (f) $('txt').value = await f.text(); };
    $('pdf').onchange = async (e) => { const f = e.target.files[0]; state.pdfBytes = f ? new Uint8Array(await f.arrayBuffer()) : null; };
    if (last) $('ultima').onclick = () => renderRelacao($('out'), last.results, last.quando);
    $('fixap').onclick = async (ev) => {
      const feitos = Object.values(loadStore().feitos || {}).filter((p) => p && p.id);
      const extra = prompt(`Corrigir o apresentante de ${feitos.length} serviço(s) abertos pelo script.\nSe quiser incluir outros, cole os links ou códigos UUID (um por linha). Deixe vazio para seguir.`, '');
      if (extra === null) return;
      const ids = new Set(feitos.map((p) => p.id));
      const lista = [...feitos];
      for (const m of String(extra).matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)) if (!ids.has(m[1])) { ids.add(m[1]); lista.push({ id: m[1] }); }
      if (!lista.length) { alert('Nenhum serviço para corrigir.'); return; }
      ev.target.disabled = true;
      const out = $('out');
      out.innerHTML = '<h3>Apresentante dos serviços</h3><pre class="log"></pre>';
      const pre = out.querySelector('pre');
      const res = await corrigirApresentantes(lista, (m) => { pre.textContent += m + '\n'; });
      out.innerHTML = `<h3>Apresentante dos serviços</h3><table><thead><tr><th>Serviço</th><th>Resultado</th></tr></thead><tbody>${res.map((r) => `<tr><td><a href="${esc(r.link)}" target="_blank">${esc(r.code)}</a></td><td>${esc(r.msg)}</td></tr>`).join('')}</tbody></table>`;
      ev.target.disabled = false;
    };
    $('conferir').onclick = async () => {
      let ficha;
      try { ficha = JSON.parse($('txt').value); } catch (e) { $('conf').innerHTML = `<p class="err tag">JSON inválido: ${esc(e.message)}</p>`; return; }
      if (!ficha || !Array.isArray(ficha.titulos)) { $('conf').innerHTML = '<p class="err tag">A ficha precisa ter "titulos": [...]</p>'; return; }
      state.ficha = ficha;
      $('conf').innerHTML = '<p class="muted">Conferindo no NoCartório (só leitura)…</p>';
      try {
        state.rows = await conferir(ficha);
        renderConferencia($('conf'), ov);
      } catch (e) { $('conf').innerHTML = `<p class="err tag">${esc(e.message)}</p>`; }
    };
  }

  function renderConferencia(el, ov) {
    const rows = state.rows;
    const novosPF = {};
    rows.forEach((r) => r.pessoas.forEach((p) => { if (!p.existe && p.doc.tipo === 'PF') novosPF[p.doc.d] = p.nome; }));
    el.innerHTML = `<h3>Conferência (${rows.length} título(s))</h3>
      <table><thead><tr><th></th><th>Título</th><th>Valor / Venc.</th><th>Pessoas</th><th>Avisos</th></tr></thead><tbody>
      ${rows.map((r) => {
        const t = r.t.titulo || {};
        const pessoas = r.pessoas.map((p) => `${esc(p.papel)}: ${esc(p.nome)} <span class="tag ${p.existe ? 'ok' : 'novo'}">${p.existe ? 'cadastrado' : 'novo'}</span>`).join('<br>');
        const av = [...r.avisos, ...(r.feito ? [`Já aberto: ${r.feito.code} — marque para COMPLETAR este serviço (não cria outro)`] : [])].map((a) => `<div class="warn">• ${esc(a)}</div>`).join('');
        return `<tr><td><input type="checkbox" data-i="${r.i}" ${r.erro || r.feito ? '' : 'checked'} ${r.erro ? 'disabled' : ''}></td>
          <td><b>${esc(r.especie || t.especie_sigla)}</b> nº ${esc(t.numero)}<br><span class="muted">nosso nº ${esc(t.nosso_numero || '—')} · ${esc(r.t.ref || '')}</span>${r.erro ? `<br><span class="tag err">${esc(r.erro)}</span>` : ''}</td>
          <td>${brl(t.valor)}${t.saldo != null && t.saldo !== t.valor ? `<br><span class="muted">saldo ${brl(t.saldo)}</span>` : ''}<br><span class="muted">emissão ${dbr(t.data_emissao)} · venc. ${dbr(t.data_vencimento)}<br>apres. ${dbr(t.data_apresentacao) || '(hoje)'} · praça ${esc(r.praca || '?')}</span></td>
          <td>${pessoas}</td><td>${av}</td></tr>`;
      }).join('')}</tbody></table>
      ${Object.keys(novosPF).length ? `<h3>Pessoas físicas novas — sexo (obrigatório no cadastro do CPF)</h3>
        ${Object.entries(novosPF).map(([d, n]) => `<div class="row">${esc(n)} (${maskCPF(d)}): <select data-g="${d}"><option>Ignorado</option><option>Masculino</option><option>Feminino</option></select></div>`).join('')}` : ''}
      <div class="row"><button class="pri" data-a="run">Abrir serviços marcados</button><span class="muted">Cria um serviço Protesto por título. Nada é selado nem pago.</span></div>
      <pre class="log" data-a="log" style="display:none"></pre>`;
    el.querySelector('[data-a="run"]').onclick = async (ev) => {
      const sel = [...el.querySelectorAll('input[data-i]:checked')].map((c) => Number(c.dataset.i));
      if (!sel.length) return;
      if (!confirm(`Abrir ${sel.length} serviço(s) de Protesto no NoCartório?`)) return;
      ev.target.disabled = true;
      const generos = {}; el.querySelectorAll('select[data-g]').forEach((s) => { generos[s.dataset.g] = s.value; });
      const logEl = el.querySelector('[data-a="log"]'); logEl.style.display = 'block';
      const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
      const store = loadStore(); store.feitos = store.feitos || {};
      const ctx = {
        pessoas: {}, generos, store,
        modoEndereco: ov.querySelector('[data-a="modo"]').value,
        pdfBytes: state.pdfBytes, anexarPdf: ov.querySelector('[data-a="anexar"]').checked,
        hoje: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
      };
      const results = [];
      for (const i of sel) {
        const t = state.ficha.titulos[i];
        log(`\n▶ Título ${t.titulo.especie_sigla || ''} nº ${t.titulo.numero} — ${(t.devedores || []).map((d) => d.nome).join('; ')}`);
        try {
          results.push(await processarTitulo(state.ficha, t, ctx, log));
          log('  ✔ pronto');
        } catch (e) {
          log('  ✖ ' + e.message);
          results.push({ ref: t.ref, titulo: t.titulo, devedores: (t.devedores || []).map((d) => d.nome).join('; '), avisos: [...(t.avisos || [])], protocolo: (store.feitos || {})[tituloKey(state.ficha, t)] || null, ok: false, erro: e.message });
        }
      }
      const quando = new Date().toLocaleString('pt-BR');
      store.ultimaRelacao = { quando, results }; saveStore(store);
      renderRelacao(ov.querySelector('[data-a="out"]'), results, quando);
    };
  }

  function relacaoLinhas(results) {
    return results.map((r, n) => ({
      n: n + 1,
      titulo: `${r.titulo.especie_sigla || ''} ${r.titulo.numero || ''}`.trim(),
      nosso: r.titulo.nosso_numero || '',
      devedor: r.devedores,
      valor: brl(r.titulo.valor),
      venc: dbr(r.titulo.data_vencimento),
      servico: r.protocolo ? r.protocolo.code || r.protocolo.id : '',
      link: r.protocolo ? r.protocolo.link : '',
      situacao: r.ok ? (r.avisos.length ? 'Conferir avisos' : 'OK') : `ERRO: ${r.erro || ''}`,
      avisos: r.avisos.join(' | '),
    }));
  }

  function renderRelacao(el, results, quando) {
    const L = relacaoLinhas(results);
    el.innerHTML = `<h3>Relação título × serviço <span class="muted">(${esc(quando)})</span></h3>
      <table><thead><tr><th>#</th><th>Título</th><th>Nosso nº</th><th>Devedor</th><th>Valor</th><th>Venc.</th><th>Serviço</th><th>Situação</th></tr></thead><tbody>
      ${L.map((l, k) => `<tr><td>${l.n}</td><td>${esc(l.titulo)}</td><td>${esc(l.nosso)}</td><td>${esc(l.devedor)}</td><td>${l.valor}</td><td>${l.venc}</td>
        <td>${l.link ? `<a href="${esc(l.link)}" target="_blank">${esc(l.servico)}</a>` : '—'}</td>
        <td><span class="tag ${results[k].ok ? (l.avisos ? 'novo' : 'ok') : 'err'}">${esc(l.situacao.split(':')[0])}</span>${l.avisos ? `<div class="warn">${esc(l.avisos)}</div>` : ''}${!results[k].ok && results[k].erro ? `<div class="warn">${esc(results[k].erro)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>
      <div class="row"><button data-a="copy">Copiar relação</button><button data-a="csv">Baixar CSV</button>
      <span class="muted">Conferir cada serviço (partes e título), depois registrar o pagamento e gerar os selos manualmente.</span></div>`;
    const head = ['#', 'Título', 'Nosso número', 'Devedor', 'Valor', 'Vencimento', 'Serviço', 'Link', 'Situação', 'Avisos'];
    const rowsArr = L.map((l) => [l.n, l.titulo, l.nosso, l.devedor, l.valor, l.venc, l.servico, l.link, l.situacao, l.avisos]);
    el.querySelector('[data-a="copy"]').onclick = async () => {
      const tsv = [head, ...rowsArr].map((r) => r.join('\t')).join('\n');
      const html = `<table border="1"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rowsArr.map((r) => `<tr>${r.map((c, i) => `<td>${i === 6 && r[7] ? `<a href="${esc(r[7])}">${esc(c)}</a>` : esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([tsv], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      } catch (e) { await navigator.clipboard.writeText(tsv); }
      el.querySelector('[data-a="copy"]').textContent = 'Copiado ✓';
    };
    el.querySelector('[data-a="csv"]').onclick = () => {
      const csv = '﻿' + [head, ...rowsArr].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `relacao-apontamentos-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    };
  }

  // SPA: o NoCartório troca de página sem recarregar.
  function tick() {
    const b = document.getElementById('ncs-aa-btn');
    if (shouldShow()) mountButton(); else if (b) b.remove();
  }
  tick();
  setInterval(tick, 1200);

  // exposto para testes no console
  window.__ncsApontamento = { conferir, getCreatePage, searchProfileByDoc, resolveSelect, version: '0.2.1' };
})();