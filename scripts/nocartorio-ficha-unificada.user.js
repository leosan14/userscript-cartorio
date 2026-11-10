// ==UserScript==
// @name         NoCartório – Ficha no cadastro unificado
// @namespace    nocartorio-ficha-unificada
// @version      0.3.1
// @description  Importa a ficha JSON (gerada por IA a partir da minuta) e abre tudo no Cadastro unificado para revisar e gravar de uma vez: pessoas novas, matrículas, papéis no ato e documentos. Requer o "NoCartório – Cadastro unificado" 0.4.0 ou mais novo.
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-ficha-unificada.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-ficha-unificada.user.js
// ==/UserScript==

/*
 * COMO FUNCIONA
 * - Na tela do serviço (…/v2/protocol/{id}) ou de um ato (…/v2/process/{id}/…) aparece o botão
 *   "Importar ficha" (ou Alt+I). Cole a ficha JSON (a mesma que a IA gera junto com a minuta).
 * - O script lê a ficha, escolhe o ato (dá para trocar), procura cada pessoa pelo CPF/CNPJ na NoCartório
 *   e mostra uma conferência: quem já está no ato, quem já tem cadastro mas está fora do ato, quem é
 *   nova, e em que papéis cada uma vai entrar (dá para tirar e pôr papéis).
 * - "Abrir no cadastro unificado" entrega tudo ao Cadastro unificado, que mostra numa tela só os dados
 *   das pessoas e os documentos já preenchidos com a ficha, para revisar e gravar de uma vez.
 * - Este script não grava nada: só lê a NoCartório. Quem grava, depois da revisão, é o Cadastro unificado.
 * - Matrículas: a ficha pode listar imóveis em "partes" ({"matricula": "8761"}, com "cnm" opcional e "papeis"
 *   opcional). O script acha o cadastro do imóvel na NoCartório e o inclui no papel de matrícula do ato
 *   ("Matrícula do Livro de Registro Geral", ou o papel indicado). Ao incluir, a NoCartório costuma incluir
 *   sozinha os proprietários. Matrícula sem cadastro (perfil) na NoCartório não é criada: o script aponta
 *   o termo no Livro Indicador Real, onde o perfil é gerado pela tela nativa.
 * - Registros do Livro 3 (Registro Auxiliar): {"registro_auxiliar": "6942"} (ou {"matricula": "R-6942"}),
 *   em "partes" ou como "parte" de um documento (ex.: a CPR vai no registro, não numa pessoa). Entra no papel
 *   "Matrícula do Livro de Registros Auxiliares". R-6942 e M-6942 são cadastros diferentes.
 * - A ficha fica guardada só nesta aba (sessionStorage) até você descartar ou fechar a aba.
 * - "Exportar catálogo" (na janela de importar) lê na NoCartório todos os tipos de documento e os campos
 *   de cada um (só leitura) e baixa catalogo-nocartorio.json e catalogo-nocartorio.md — o .md serve para
 *   atualizar a skill que gera a ficha.
 *
 * FORMATO DA FICHA (ficha_versao 1 — o mesmo do "Preenchedor por Ficha", com o bloco opcional "partes")
 *   {
 *     "ficha_versao": 1,
 *     "protocolo": "A-XXXX-0000000000",
 *     "ato": "Escritura de inventário",                      (opcional: ajuda a escolher o ato)
 *     "partes": [ { "nome": "…", "cpf": "…", "papeis": ["Herdeiros"] },
 *                 { "matricula": "8761", "cnm": "0292312000876117" },     (imóvel: papel opcional)
 *                 { "registro_auxiliar": "6942" } ],                      (Livro 3: papel opcional)
 *     "comum": { "alias": "valor" }, "fontes_comum": { "alias": "fonte" },
 *     "documentos": [ { "tipo": 6, "nome": "Certidão de nascimento", "parte": { "nome": "…", "cpf": "…" },
 *                       "campos": { "alias": "valor" }, "fontes": { "alias": "fonte" } } ]
 *   }
 */

(function () {
  'use strict';

  const VERSION = '0.3.1';
  const FICHA_VERSION = 1;
  const MIN_NCU_PREFILL_API = 2;

  /* =====================================================================================
   * 1. FUNÇÕES PURAS (ficha → plano)
   * ===================================================================================== */

  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

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

  function fmtCpf(v) {
    const d = digitsOf(v);
    return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(v == null ? '' : v).trim();
  }
  function fmtCnpj(v) {
    const s = String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-Z]/g, '');
    return s.length === 14 ? `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}` : String(v == null ? '' : v).trim();
  }
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

  // Campos que NUNCA vêm do bloco "comum" (mesmo nome, significado diferente em cada documento).
  const NEVER_COMMON = new Set([
    'identificador_registro', 'data_emissao', 'data_validade', 'data_expiracao',
    'numero_certificado', 'numero_documento', 'valor', 'valor_pago',
    'data_pagamento', 'local_pagamento', 'autenticacao_pagamento',
    'codigo_controle', 'observacoes', 'resumo_executivo', 'descricao_documento',
    'livro', 'pagina', 'folha_inicial_livro', 'folha_final_livro',
    'data_registro', 'data_lavratura', 'hora_emissao', 'numero_referencia',
    'periodo_apuracao', 'numero_registro_prefeitura', 'tipo_certificado',
    'certidao_numero', 'numero_controle_autenticacao', 'nome',
  ]);

  /* ----- matrículas de imóvel ----- */

  /** Número da matrícula sem pontos nem zeros à esquerda ("8.761", "M-08761" → "8761"). */
  function matNumber(v) {
    const d = digitsOf(v).replace(/^0+/, '');
    return d || '';
  }
  /** Código Nacional de Matrícula informado na parte (só dígitos). */
  function cnmOf(p) {
    const v = p && (p.cnm != null ? p.cnm : p.codigo_nacional_matricula);
    return v == null ? '' : digitsOf(v);
  }
  /** "R-6942", "R 6.942" → é referência a registro do Livro 3 (Registro Auxiliar). */
  const isRegRef = (v) => /^\s*R\s*-?\s*\d/i.test(String(v == null ? '' : v));
  const filled = (v) => v != null && String(v).trim() !== '';
  /** Imóvel/registro de uma parte da ficha → { book: 2 (matrícula) | 3 (registro auxiliar), raw, num } | null. */
  function propRefOf(p) {
    if (!p || typeof p !== 'object') return null;
    if (filled(p.registro_auxiliar)) return { book: 3, raw: String(p.registro_auxiliar).trim(), num: matNumber(p.registro_auxiliar) };
    if (filled(p.matricula)) return { book: isRegRef(p.matricula) ? 3 : 2, raw: String(p.matricula).trim(), num: matNumber(p.matricula) };
    return null;
  }
  /** Nome legível: "Matrícula 8761" ou "Registro auxiliar R-6942". */
  function propName(e) {
    return e.book === 3 ? `Registro auxiliar R-${matNumber(e.matricula)}` : `Matrícula ${e.matricula}`;
  }
  /** O CNM contém o número da matrícula/registro (e, com book, é do livro certo)? (CNM = CNS + tipo de livro + número com zeros + DV) */
  function cnmMatches(cnm, num, book) {
    const c = digitsOf(cnm);
    const n = matNumber(num);
    if (!n) return true;
    if (c.length === 16) return matNumber(c.slice(7, 14)) === n && (!book || c[6] === String(book)); // CNS(6) + livro(1) + número(7) + DV(2)
    if (c.length < 10) return true;
    return new RegExp(`0*${n}\\d{2}$`).test(c);
  }

  /**
   * Rótulo de perfil de imóvel da NoCartório → { number, cnm, cns, typeName }.
   * Formatos vistos: "M-8761 (02.923-1) Terreno/Fração | Terreno/Fração | Código Nacional de Matrícula (CNM): …,
   * Número da matrícula do imóvel: 8761, Cartório de origem: (02.923-1) | …" e "Terreno/Fração M-2876 - (02.923-1) | …".
   */
  function parsePropertyLabel(label) {
    const s = String(label == null ? '' : label);
    const parts = s.split(' | ');
    // Registro Auxiliar (Livro 3): "R-6942 (02.923-1) Ato Garantia Crédito | … Número de Matrícula no Registro Auxiliar: 6942"
    const reg = s.match(/registro auxiliar:\s*([\d.]+)/i) || s.match(/(?:^|[\s(])R-\s*([\d.]+)/);
    const mat = s.match(/n[uú]mero da matr[ií]cula do im[oó]vel:\s*([\d.]+)/i) || s.match(/(?:^|[\s(])M-?\s*([\d.]+)/i);
    const cnmM = s.match(/\(CNM\):\s*([\d.\s-]+?)(?:,|\||$)/i);
    const cnm = cnmM ? digitsOf(cnmM[1]) : '';
    const cns = s.match(/\((\d{2}\.\d{3}-\d)\)/);
    let book = cnm.length === 16 && /[23]/.test(cnm[6]) ? Number(cnm[6]) : 0;
    if (!book) book = reg && !mat ? 3 : mat ? 2 : 0;
    const num = book === 3 ? reg || mat : mat || reg;
    return {
      number: num ? matNumber(num[1]) : '',
      book,
      cnm,
      cns: cns ? cns[1] : '',
      typeName: (parts[1] || '').trim(),
      short: (parts[0] || '').trim(),
    };
  }
  /** O perfil de imóvel (rótulo) é a matrícula da ficha? */
  function propertyMatches(label, e) {
    const L = parsePropertyLabel(label);
    if (!L.number || L.number !== matNumber(e.matricula)) return false;
    if ((L.book || 2) !== (e.book || 2)) return false; // M-6942 (imóvel) ≠ R-6942 (registro auxiliar)
    if (e.cnm && L.cnm) return L.cnm === digitsOf(e.cnm);
    return true;
  }

  /** Confere a estrutura da ficha. Retorna { errors, warnings }. */
  function validateFicha(f) {
    const errors = [];
    const warnings = [];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { errors: ['A ficha não é um objeto JSON.'], warnings };
    const ver = f.ficha_versao != null ? f.ficha_versao : f.versao;
    if (ver !== FICHA_VERSION) errors.push(`"ficha_versao" deve ser ${FICHA_VERSION}.`);
    if (f.documentos != null && !Array.isArray(f.documentos)) errors.push('"documentos" deve ser uma lista.');
    if (f.partes != null && !Array.isArray(f.partes)) errors.push('"partes" deve ser uma lista.');
    if (f.comum != null && (typeof f.comum !== 'object' || Array.isArray(f.comum))) errors.push('"comum" deve ser um objeto.');
    if (!(f.documentos || []).length && !(f.partes || []).length) errors.push('A ficha não tem "documentos" nem "partes".');
    (f.partes || []).forEach((p, i) => {
      if (!p || typeof p !== 'object') return errors.push(`partes[${i}] não é um objeto.`);
      if (!p.nome && !p.cpf && !p.cnpj && !filled(p.matricula) && !filled(p.registro_auxiliar) && !p.codigo) errors.push(`partes[${i}]: falta nome e CPF/CNPJ (ou matrícula / registro auxiliar).`);
      checkPropRef(p, `partes[${i}]`, errors, warnings);
      if (p.papeis != null && !Array.isArray(p.papeis)) errors.push(`partes[${i}]: "papeis" deve ser uma lista.`);
      if (p.cpf && !cpfOk(p.cpf)) warnings.push(`${p.nome || `partes[${i}]`}: CPF ${p.cpf} com dígito verificador inválido.`);
    });
    (f.documentos || []).forEach((d, i) => {
      if (!d || typeof d !== 'object') return errors.push(`documentos[${i}] não é um objeto.`);
      if (!Number.isInteger(d.tipo)) errors.push(`documentos[${i}]: "tipo" deve ser o número do tipo de documento na NoCartório.`);
      if (!d.campos || typeof d.campos !== 'object' || Array.isArray(d.campos)) errors.push(`documentos[${i}]: falta "campos".`);
      if (!d.parte || typeof d.parte !== 'object') warnings.push(`documentos[${i}] (${d.nome || d.tipo}): sem "parte" — ignorado.`);
      else checkPropRef(d.parte, `documentos[${i}].parte`, errors, warnings);
    });
    return { errors, warnings };
  }
  /** Confere matrícula / registro auxiliar de uma parte. */
  function checkPropRef(p, where, errors, warnings) {
    if (filled(p.matricula) && filled(p.registro_auxiliar)) {
      errors.push(`${where}: use "matricula" (Livro 2) ou "registro_auxiliar" (Livro 3), não os dois.`);
      return;
    }
    const pr = propRefOf(p);
    if (!pr) {
      if (p.matricula != null && String(p.matricula).trim() === '' && !p.cpf && !p.cnpj && !p.codigo) errors.push(`${where}: matrícula vazia.`);
      return;
    }
    if (!pr.num) errors.push(`${where}: ${pr.book === 3 ? 'registro auxiliar' : 'matrícula'} “${pr.raw}” sem número.`);
    else if (cnmOf(p) && !cnmMatches(cnmOf(p), pr.num, pr.book))
      warnings.push(`${propName({ matricula: pr.raw, book: pr.book })}: o CNM ${cnmOf(p)} não corresponde a este número${pr.book === 3 ? ' no Livro 3' : ''} — confira.`);
  }

  /** Chave de identificação de uma parte da ficha. */
  function parteKey(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.cpf && digitsOf(p.cpf).length === 11) return `cpf:${digitsOf(p.cpf)}`;
    if (p.cnpj && String(p.cnpj).replace(/[^0-9A-Za-z]/g, '').length === 14) return `cnpj:${String(p.cnpj).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`;
    const pr = propRefOf(p);
    if (pr && pr.num) return `${pr.book === 3 ? 'reg' : 'mat'}:${pr.num}`;
    if (p.codigo) return `cod:${String(p.codigo).trim().toUpperCase()}`;
    if (p.nome) return `nome:${normText(p.nome)}`;
    return null;
  }

  /** Partes da ficha (pessoas, imóveis, formulários) com os documentos de cada uma. */
  function entitiesFromFicha(f) {
    const list = [];
    const byKey = new Map();
    const warnings = [];
    const add = (p, fromPartes) => {
      let k = parteKey(p);
      if (!k) return null;
      let e = byKey.get(k);
      // mesmo nome sem CPF numa e com CPF na outra: junta pelo nome
      if (!e && p.nome) {
        const n = normText(p.nome);
        e = list.find((x) => normText(x.nome) === n && (k.startsWith('nome:') || x.key.startsWith('nome:')) && x.kind === 'pessoa');
        if (e && e.key.startsWith('nome:') && !k.startsWith('nome:')) {
          byKey.delete(e.key);
          e.key = k;
          byKey.set(k, e);
        }
      }
      if (!e) {
        const kind = propRefOf(p) ? 'imovel' : p.codigo ? 'temporario' : 'pessoa';
        e = { key: k, kind, nome: '', cpf: '', cnpj: '', matricula: '', book: 0, cnm: '', codigo: '', tipoPerfil: '', papeis: [], docs: [], fromPartes: false };
        list.push(e);
        byKey.set(k, e);
      }
      if (p.nome && (!e.nome || fromPartes)) e.nome = String(p.nome).trim();
      if (p.cpf && !e.cpf) e.cpf = fmtCpf(p.cpf);
      if (p.cnpj && !e.cnpj) e.cnpj = fmtCnpj(p.cnpj);
      const pr = propRefOf(p);
      if (pr && !e.matricula) {
        e.matricula = pr.raw; // número como veio (para matrícula ou registro auxiliar)
        e.book = pr.book;
      }
      if (pr && cnmOf(p) && !e.cnm) e.cnm = cnmOf(p);
      if (p.codigo && !e.codigo) e.codigo = String(p.codigo).trim().toUpperCase();
      if (p.tipo_perfil && !e.tipoPerfil) e.tipoPerfil = String(p.tipo_perfil).trim();
      for (const r of Array.isArray(p.papeis) ? p.papeis : []) {
        const t = String(r || '').trim();
        if (t && !e.papeis.some((x) => normText(x) === normText(t))) e.papeis.push(t);
      }
      if (fromPartes) e.fromPartes = true;
      return e;
    };
    for (const p of f.partes || []) add(p, true);
    (f.documentos || []).forEach((d, i) => {
      if (!d || !d.parte || !Number.isInteger(d.tipo)) return;
      const e = add(d.parte, false);
      if (!e) {
        warnings.push(`documentos[${i}] (${d.nome || d.tipo}): parte sem identificação — ignorado.`);
        return;
      }
      e.docs.push(i);
    });
    return { list, warnings };
  }

  /** Matrícula de certidão do Registro Civil (32 dígitos) → partes. */
  function parseMatriculaRC(v) {
    const t = digitsOf(v);
    if (t.length !== 32) return null;
    return {
      digits: t,
      cns: t.slice(0, 6),
      cnsFmt: `${t.slice(0, 2)}.${t.slice(2, 5)}-${t.slice(5, 6)}`,
      acervo: t.slice(6, 8),
      servico: t.slice(8, 10),
      ano: t.slice(10, 14),
      tipoLivro: t.slice(14, 15),
      livro: t.slice(15, 20),
      folha: t.slice(20, 23),
      termo: t.slice(23, 30),
      dv: t.slice(30),
    };
  }
  function matDvOk(t) {
    const dig = (base, start) => {
      let n = 0;
      let r = start;
      for (const c of base) {
        n += Number(c) * (r % 11);
        r += 1;
      }
      const i = n % 11;
      return i === 10 ? 1 : i;
    };
    const base = t.slice(0, 30);
    const d1 = dig(base, 2);
    const d2 = dig(`${base}${d1}`, 1);
    return `${d1}${d2}` === t.slice(30);
  }
  const stripZeros = (s) => String(Number(s));
  const MAT_ALIASES = ['numero_matricula_registro_nascimento', 'numero_certificado', 'matricula', 'numero_matricula', 'matricula_certidao'];
  // tipo de documento → tipos de livro esperados (1 = A nascimento, 2/3 = B casamento, 4/5 = C óbito)
  const BOOK_FOR_TYPE = { 6: ['1'], 8: ['2', '3'], 7: ['4', '5'] };

  /**
   * Livro, folha e termo (e o CNS da serventia) a partir da matrícula da certidão, quando a ficha não os traz.
   * Retorna { derived: { alias: { value, fonte } }, cns, warnings }.
   */
  function deriveFromMatricula(doc) {
    const out = { derived: {}, cns: '', warnings: [] };
    const campos = doc.campos || {};
    let alias = null;
    let m = null;
    for (const a of MAT_ALIASES) {
      const x = parseMatriculaRC(campos[a]);
      if (x) {
        alias = a;
        m = x;
        break;
      }
    }
    if (!m) return out;
    const label = doc.nome || `tipo ${doc.tipo}`;
    if (!matDvOk(m.digits)) out.warnings.push(`${label}: a matrícula ${campos[alias]} tem dígito verificador inválido — confira (livro/folha/termo não foram calculados).`);
    else {
      const books = BOOK_FOR_TYPE[doc.tipo];
      if (books && !books.includes(m.tipoLivro)) out.warnings.push(`${label}: a matrícula ${campos[alias]} é de outro tipo de livro (${m.tipoLivro}) — confira se é a certidão certa.`);
      if (m.servico !== '55') out.warnings.push(`${label}: a matrícula ${campos[alias]} não parece ser de Registro Civil (serviço ${m.servico}).`);
      const fonte = `calculado da matrícula ${campos[alias]}`;
      const put = (a, v) => {
        if (isBlank(campos[a])) out.derived[a] = { value: v, fonte };
      };
      put('livro', stripZeros(m.livro));
      put('pagina', stripZeros(m.folha));
      put('folha', stripZeros(m.folha));
      put('termo', stripZeros(m.termo));
      put('numero_termo_assento_registro_nascimento', stripZeros(m.termo));
      put('numero_termo_registro_casamento', stripZeros(m.termo));
      out.cns = m.cnsFmt;
    }
    return out;
  }

  /** Papel da ficha → papel do ato. { role } | { ambiguous } | { none }. */
  function matchRole(label, roles) {
    const w = normText(label);
    if (!w) return { none: true };
    const L = roles.map((r) => ({ r, t: normText(r.label) }));
    const sing = (t) => t.replace(/s$/, '');
    const stem = (t) => t.replace(/\((?:a|o|as|os)\)/g, '').trim().replace(/[ao]s?$/, '');
    const tiers = [
      (x) => x.t === w,
      (x) => sing(x.t) === sing(w),
      (x) => w.length >= 4 && stem(x.t) === stem(w),
      (x) => w.length >= 4 && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(x.t),
    ];
    for (const tier of tiers) {
      const hits = L.filter(tier);
      if (hits.length === 1) return { role: hits[0].r };
      if (hits.length > 1) return { ambiguous: hits.map((x) => x.r) };
    }
    return { none: true };
  }

  /** Valores de um documento da ficha no formato do Cadastro unificado. */
  function docForPlan(f, doc) {
    const der = deriveFromMatricula(doc);
    const values = { ...(doc.campos || {}) };
    if (der.cns && !isBlank(values.nome_serventia)) {
      const v = values.nome_serventia;
      values.nome_serventia = v && typeof v === 'object' ? { ...v, cns: v.cns || der.cns } : { texto: String(v), cns: der.cns };
    }
    const fallback = {};
    if (doc.usar_comum !== false) {
      for (const [k, v] of Object.entries(f.comum || {})) if (!NEVER_COMMON.has(k) && !isBlank(v)) fallback[k] = v;
    }
    return {
      plan: {
        typeId: doc.tipo,
        typeName: String(doc.nome || ''),
        label: String(doc.rotulo || ''),
        values,
        sources: doc.fontes && typeof doc.fontes === 'object' ? doc.fontes : {},
        derived: der.derived,
        fallback,
        fallbackSources: f.fontes_comum && typeof f.fontes_comum === 'object' ? f.fontes_comum : {},
      },
      warnings: der.warnings,
    };
  }

  /** Tipo de perfil desejado para uma pessoa da ficha. */
  function wantedProfileType(e) {
    if (e.tipoPerfil) return e.tipoPerfil;
    if (e.cnpj) return 'Pessoa jurídica';
    return 'Pessoa física';
  }

  /** Rótulo de busca → é deste CPF/CNPJ e deste tipo de perfil? */
  function labelMatches(label, e) {
    const parts = String(label || '').split(' | ');
    const typeName = normText(parts[1] || '');
    const rest = parts.slice(2).join(' | ');
    if (normText(wantedProfileType(e)) !== typeName) return false;
    const key = e.cpf ? digitsOf(e.cpf) : e.cnpj ? String(e.cnpj).replace(/[^0-9A-Za-z]/g, '').toUpperCase() : '';
    if (!key) return false;
    return e.cpf ? digitsOf(rest).includes(key) : String(rest).replace(/[^0-9A-Za-z]/g, '').toUpperCase().includes(key);
  }

  /** Imóvel/formulário do ato pela matrícula ou pelo código do ato (como o "Preenchedor por Ficha"). */
  function selectionMatchesOther(label, e) {
    const n = normText(label);
    if (e.matricula) return propertyMatches(label, e);
    if (e.codigo) return n.includes(normText(e.codigo));
    return false;
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
    return { processId: it && it.id, code: (it && it.code) || '', name: (it && it.processType && it.processType.name) || '', canRegisterAct: !!caps.canRegisterAct, roles };
  }

  // Tipos de perfil de imóvel da NoCartório (api/profile-type/autocomplete-real-estate).
  const REAL_ESTATE_TYPES = new Set([5, 7, 8, 9, 17, 18, 19, 20, 64, 70, 85, 87, 100, 101]);

  // Tipos de perfil do Registro Auxiliar (Livro 3): Matrícula LRA e os "Ato …" (Garantia Crédito, Organização da Propriedade…).
  const AUX_TYPES = new Set([14, 104, 106, 108, 110, 112, 114]);
  const AUX_ROLE_RE = /registros? auxiliar/i;

  /** Papéis do ato que recebem matrícula (book 2) ou registro auxiliar (book 3); com typeName, os que aceitam esse tipo. */
  function propertyRoles(roles, typeName, book) {
    const aux = book === 3;
    const pr = (roles || []).filter((r) =>
      aux ? AUX_ROLE_RE.test(r.label) || r.types.some((t) => AUX_TYPES.has(t.profileTypeId)) : !AUX_ROLE_RE.test(r.label) && r.types.some((t) => REAL_ESTATE_TYPES.has(t.profileTypeId))
    );
    if (!typeName) return pr;
    const n = normText(typeName);
    const ok = pr.filter((r) => r.types.some((t) => normText(t.label) === n));
    return ok.length ? ok : pr;
  }
  /** Papel padrão: o de "Registro Geral" (Livro 2) ou o de "Registros Auxiliares" (Livro 3), senão o primeiro. */
  function defaultPropertyRole(pRoles, book) {
    const open = pRoles.filter((r) => !r.readonly);
    const pool = open.length ? open : pRoles;
    const re = book === 3 ? AUX_ROLE_RE : /registro geral/i;
    return pool.find((r) => re.test(r.label)) || pool[0] || null;
  }

  /** Ato inicial: o da página (se servir para a ficha), o de mesmo nome, ou o que tem mais papéis da ficha. */
  function chooseDefaultAct(acts, ficha, ctx) {
    const papeis = [];
    for (const p of ficha.partes || []) for (const r of p.papeis || []) papeis.push(r);
    const score = (a) => papeis.filter((r) => matchRole(r, a.roles).role).length;
    const editable = acts.filter((a) => a.roles.some((r) => !r.readonly));
    const here = ctx.processId ? acts.find((a) => a.processId === ctx.processId) : null;
    if (here && here.roles.length && (score(here) > 0 || !papeis.length) && here.roles.some((r) => !r.readonly || r.selection.length > 1)) return here;
    const want = normText(ficha.ato || '');
    if (want) {
      const pool = editable.length ? editable : acts;
      const byName = pool.find((a) => normText(a.name) === want) || pool.find((a) => normText(a.name).includes(want) || want.includes(normText(a.name)));
      if (byName) return byName;
    }
    let best = null;
    let bestScore = -1;
    for (const a of editable) {
      const sc = score(a) * 10 + a.roles.length / 100;
      if (sc > bestScore) {
        best = a;
        bestScore = sc;
      }
    }
    return best || here || acts.find((a) => a.roles.length) || null;
  }

  /* ----- catálogo de tipos de documento ----- */

  const TYPE_CODES = { date: 'd', datetime: 'dh', time: 'h', money: '$', numeric: 'n', text: 't', boolean: 'b', cpf: 'cpf', cnpj: 'cnpj', zipcode: 'cep', phone: 'tel', cib: 'cib', cnh: 'cnh', do: 'do', dnv: 'dnv' };

  /** Nome curto de uma lista de opções a partir do endereço de busca (/api/civil-status/search-… → civil-status). */
  function listKey(dataUrl) {
    try {
      const path = new URL(String(dataUrl), 'https://x').pathname
        .replace(/^\/api\/(v2\/)?/, '')
        .split('/')
        .filter((seg) => seg && !/^search-for-autocomplete$/.test(seg))
        .join('/');
      return path || String(dataUrl);
    } catch (e) {
      return String(dataUrl);
    }
  }

  /** Campo → "alias*K[tipo]" (compacto, para o .md). */
  function fieldCode(f) {
    let t = '';
    if (f.tipo === 'select') t = `s:${f.lista || '?'}`;
    else if (f.mascara) t = 'mat';
    else if (TYPE_CODES[f.tipo]) t = TYPE_CODES[f.tipo];
    return `${f.alias}${f.obrigatorio ? '*' : ''}${f.chave ? 'K' : ''}${t ? `[${t}]` : ''}${f.multiplo ? '[lista]' : ''}`;
  }

  /** Catálogo (JSON) → texto .md compacto para a skill. */
  function catalogToMarkdown(cat) {
    const lines = [];
    lines.push('## Catálogo de tipos de documento da NoCartório');
    lines.push('');
    lines.push(`Gerado em ${cat.gerado_em} pelo script "Ficha no cadastro unificado" v${cat.versao_script} · ${cat.tipos.length} tipos.`);
    lines.push('Formato: tipo | nome | campos. Legenda: * obrigatório · K campo-chave · [d] data · [dh] data e hora · [h] hora · [$] dinheiro · [n] número · [t] texto longo · [b] sim/não · [cpf] [cnpj] [cep] [tel] [cnh] [cib] com máscara · [mat] matrícula de 32 dígitos · [s:lista] seleção (ver "Listas de opções") · [lista] vários valores · (anexo) exige arquivo.');
    lines.push('');
    for (const t of cat.tipos) {
      if (t.erro) {
        lines.push(`- ${t.id} | ${t.nome} | (campos não lidos: ${t.erro})`);
        continue;
      }
      lines.push(`- ${t.id} | ${t.nome}${t.exige_arquivo ? ' (anexo)' : ''} | ${t.campos.map(fieldCode).join(', ')}`);
    }
    lines.push('');
    lines.push('### Listas de opções');
    lines.push('');
    for (const [k, l] of Object.entries(cat.listas).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (l.opcoes && l.opcoes.length) lines.push(`- ${k}: ${l.opcoes.join(' | ')}`);
      else lines.push(`- ${k}: lista grande — escreva o texto da opção, o script busca na NoCartório${l.exemplos && l.exemplos.length ? ` (ex.: ${l.exemplos.join(' | ')})` : ''}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  const PURE = {
    normText, fmtCpf, fmtCnpj, cpfOk, validateFicha, parteKey, entitiesFromFicha, parseMatriculaRC, matDvOk,
    deriveFromMatricula, matchRole, docForPlan, wantedProfileType, labelMatches, selectionMatchesOther, NEVER_COMMON,
    parseActInputs, chooseDefaultAct, listKey, fieldCode, catalogToMarkdown,
    matNumber, cnmMatches, parsePropertyLabel, propertyMatches, propertyRoles, defaultPropertyRole, REAL_ESTATE_TYPES, propRefOf, propName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__NCF_LOADED__) return;
  window.__NCF_LOADED__ = true;

  /* =====================================================================================
   * 2. LEITURAS NA NOCARTÓRIO (somente GET)
   * ===================================================================================== */

  const PROCESS_RE = /^\/admin\/manager\/v2\/process\/([0-9a-f-]{36})(?:\/|$)/i;
  const PROTOCOL_RE = /^\/admin\/manager\/v2\/protocol\/([0-9a-f-]{36})\/?$/i;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  class UErr extends Error {}

  function routeUrl(name, params, fallback) {
    try {
      const app = document.getElementById('app');
      const r = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.route;
      if (typeof r === 'function') return String(r(name, params));
    } catch (e) {
      /* usa o modelo */
    }
    return fallback;
  }

  async function getJson(url, params) {
    const u = new URL(url, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(u.toString(), { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    } catch (e) {
      throw new UErr(`Falha de rede: ${e && e.message ? e.message : e}`);
    }
    if (res.status === 401 || res.status === 419) throw new UErr('Sessão expirada. Recarregue a página e entre de novo.');
    if (!res.ok) throw new UErr(`A NoCartório respondeu com erro (${res.status}).`);
    return res.json();
  }

  async function getPage(url, partial) {
    const pg = history.state && history.state.page;
    const headers = { 'X-Inertia': 'true', 'X-Inertia-Version': (pg && pg.version) || '', 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, application/xhtml+xml' };
    if (partial) Object.assign(headers, partial);
    const res = await fetch(url, { credentials: 'same-origin', headers });
    if (res.status === 409) {
      const r2 = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
      const doc = new DOMParser().parseFromString(await r2.text(), 'text/html');
      const s = doc.querySelector('script[data-page]');
      const app = doc.getElementById('app');
      const txt = (s && s.textContent) || (app && app.getAttribute('data-page'));
      if (!txt) throw new UErr('Não consegui ler a página (a sessão pode ter expirado).');
      return JSON.parse(txt);
    }
    if (!res.ok || !res.headers.get('x-inertia')) throw new UErr(`A NoCartório respondeu com erro (${res.status}).`);
    return res.json();
  }

  /** Página atual: serviço (protocolId) e, se for tela de ato, o ato. */
  function pageContext() {
    const pg = history.state && history.state.page;
    const props = (pg && pg.props) || {};
    const mp = location.pathname.match(PROTOCOL_RE);
    if (mp) {
      const data = props.protocol && props.protocol.data;
      const code = data && data.protocolInformation && data.protocolInformation.code;
      return { protocolId: mp[1], processId: null, protocolCode: code || '' };
    }
    const ma = location.pathname.match(PROCESS_RE);
    if (ma) {
      const L = props.layout || {};
      return { protocolId: (L.protocol && L.protocol.id) || null, processId: ma[1], protocolCode: (L.protocol && L.protocol.code) || '' };
    }
    return null;
  }

  /** Atos do serviço com os papéis de cada um. */
  async function loadActs(protocolId) {
    const acts = [];
    for (let page = 1; page <= 20; page++) {
      const url = routeUrl('v2.api.manager.protocols.processes', { protocol: protocolId }, `/api/v2/protocols/${protocolId}/processes`);
      const j = await getJson(url, { page });
      const walk = (p, parent) => {
        if (!p || typeof p !== 'object') return;
        const a = parseActInputs(p);
        a.parentCode = parent ? parent.code : '';
        acts.push(a);
        if (Array.isArray(p.children)) p.children.forEach((c) => walk(c, p));
      };
      (Array.isArray(j && j.data) ? j.data : []).forEach((p) => walk(p, null));
      const last = (j && (j.last_page || (j.meta && j.meta.last_page))) || 1;
      if (page >= last) break;
    }
    return acts;
  }

  async function searchRole(processId, ptrId, q) {
    const url = routeUrl('api.profiles.search-by-process-type-role-autocomplete', { id: ptrId, process_id: processId }, `/api/profiles/search-by-process-type-role-autocomplete?id=${encodeURIComponent(ptrId)}&process_id=${encodeURIComponent(processId)}`);
    const j = await getJson(url, { q });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    return arr.filter((o) => o && o.id).map((o) => ({ id: o.id, label: String(o.name != null ? o.name : o.label || '') }));
  }

  async function searchGlobal(q) {
    const url = routeUrl('api.profiles.search-for-autocomplete', {}, '/api/profiles/search-for-autocomplete');
    const j = await getJson(url, { q });
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    return arr.filter((o) => o && o.id).map((o) => ({ id: o.id, label: String(o.name != null ? o.name : o.label || '') }));
  }

  /** Requerente do serviço (serve de "modelo" para ler a lista de campos dos documentos de pessoas novas). */
  async function loadRequerentes(protocolId) {
    try {
      const pg = await getPage(`/admin/manager/v2/protocol/${protocolId}`, { 'X-Inertia-Partial-Component': 'Protocol/Edit/Index', 'X-Inertia-Partial-Data': 'parts' });
      const parts = (pg && pg.props && pg.props.parts) || [];
      const out = [];
      for (const grp of parts) for (const it of grp.items || []) {
        const p = it && it.data && it.data.profile;
        if (p && p.id) out.push({ id: p.id, typeName: (p.type && p.type.name) || '' });
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  /** Todos os tipos de documento (a busca devolve no máximo 100 por vez: refina por letras quando enche). */
  async function listAllTypes(onProgress) {
    const all = new Map();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
    const queue = chars.slice();
    let calls = 0;
    const worker = async () => {
      while (queue.length) {
        const q = queue.shift();
        const url = routeUrl('v2.api.manager.document-types.index', {}, '/api/v2/document-types');
        const j = await getJson(url, { q, max_results: 100 });
        const d = (j && Array.isArray(j.data)) ? j.data : [];
        calls++;
        let fresh = 0;
        for (const x of d) {
          if (x && x.id != null && !all.has(x.id)) {
            all.set(x.id, String(x.name || ''));
            fresh++;
          }
        }
        // busca cheia (100) pode esconder tipos: refina — mas só os ramos que ainda trazem tipos novos
        if (d.length >= 100 && q.length < 4 && (q.length === 1 || fresh > 0)) for (const c of chars) queue.push(q + c);
        if (onProgress) onProgress(`Listando os tipos de documento… ${all.size} encontrados (${calls} buscas)`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    return [...all].map(([id, nome]) => ({ id: Number(id), nome })).sort((a, b) => a.id - b.id);
  }

  /** Lê, na NoCartório, todos os tipos de documento e os campos de cada um (só leitura). */
  async function buildCatalog(profileId, onProgress) {
    const tipos = await listAllTypes(onProgress);
    const listas = {};
    const listUrls = new Map();
    let done = 0;
    const queue = tipos.slice();
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          const pg = await getPage(`/admin/manager/v2/profile/${profileId}/document/${t.id}/create`, { 'X-Inertia-Partial-Component': 'Document/Create/Index', 'X-Inertia-Partial-Data': 'document_type' });
          const dt = pg && pg.props && pg.props.document_type;
          if (!dt || !Array.isArray(dt.fields)) throw new Error('formulário não encontrado');
          t.nome = dt.name || t.nome;
          t.exige_arquivo = !!dt.file_required;
          t.campos = dt.fields
            .slice()
            .sort((a, b) => (Number(a.row) || 0) - (Number(b.row) || 0))
            .map((f) => {
              const c = { alias: f.alias, nome: f.name, tipo: f.type, obrigatorio: !!f.is_required, chave: !!f.is_key };
              if (f.mask) c.mascara = f.mask;
              if (f.is_multiple) c.multiplo = true;
              if (f.type === 'select' && f.data_url) {
                c.lista = listKey(f.data_url);
                if (!listUrls.has(c.lista)) listUrls.set(c.lista, f.data_url);
              }
              return c;
            });
        } catch (e) {
          t.erro = e.message;
        }
        done++;
        if (onProgress) onProgress(`Lendo os campos de cada tipo… ${done}/${tipos.length}`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    let n = 0;
    for (const [k, url] of listUrls) {
      n++;
      if (onProgress) onProgress(`Lendo as listas de opções… ${n}/${listUrls.size}`);
      try {
        const read = async (q) => {
          const j = await getJson(url, { q });
          const arr = (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : [])).filter((o) => o && typeof o === 'object');
          return arr.map((o) => String(o.name != null ? o.name : o.label != null ? o.label : o.text != null ? o.text : '')).filter(Boolean);
        };
        const first = [...new Set(await read(''))];
        // a lista está completa? outras buscas não podem trazer opções novas
        let complete = first.length > 0;
        for (const q of ['a', 'o', 'e']) {
          if (!complete) break;
          const more = await read(q);
          if (more.some((x) => !first.includes(x))) complete = false;
        }
        listas[k] = complete && first.length <= 40 ? { opcoes: first } : { opcoes: null, exemplos: first.slice(0, 3) };
      } catch (e) {
        listas[k] = { opcoes: null };
      }
    }
    return {
      gerado_em: new Date().toLocaleString('pt-BR'),
      origem: location.origin,
      versao_script: VERSION,
      tipos,
      listas,
    };
  }

  function downloadText(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }

  /** Um perfil qualquer do serviço (a tela "novo documento" precisa de um perfil para mostrar os campos). */
  async function anyProfileId(ctx) {
    const req = await loadRequerentes(ctx.protocolId);
    if (req.length) return req[0].id;
    const acts = await loadActs(ctx.protocolId);
    for (const a of acts) for (const r of a.roles) for (const s of r.selection) if (s.profileId) return s.profileId;
    return null;
  }

  /* =====================================================================================
   * 3. ESTADO: ficha lida + conferência no ato
   * ===================================================================================== */

  const STORE_KEY = 'ncf:ficha:v1';
  const S = { raw: '', ficha: null, valid: null, ents: [], entWarnings: [], ctx: null, acts: [], act: null, res: new Map(), loading: false, busyMsg: '', requerentes: null };

  function storeRaw(raw) {
    try {
      if (raw) sessionStorage.setItem(STORE_KEY, JSON.stringify({ raw, at: Date.now() }));
      else sessionStorage.removeItem(STORE_KEY);
    } catch (e) {
      /* sem armazenamento */
    }
  }
  function loadRaw() {
    try {
      const j = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      return j && j.raw ? j : null;
    } catch (e) {
      return null;
    }
  }

  /** Matrícula que não está no ato: procura o cadastro (perfil) do imóvel na NoCartório e escolhe o papel. */
  async function resolveProperty(e, r, act) {
    const num = matNumber(e.matricula);
    const aux = e.book === 3;
    const what = propName(e);
    const pRoles = propertyRoles(act.roles, '', e.book);
    if (!pRoles.length) {
      r.notes.push(`Este ato não tem papel para ${aux ? 'registro do Livro 3 (Registro Auxiliar)' : 'matrícula de imóvel'}: ${what} não pode ser incluído nele.`);
      return;
    }
    const byId = new Map();
    const take = (list) => {
      for (const x of list) if (propertyMatches(x.label, e) && !byId.has(x.id)) byId.set(x.id, x);
    };
    let searchErr = null;
    for (const role of pRoles.slice(0, 2)) {
      try {
        take(await searchRole(act.processId, role.ptrId, num));
      } catch (err) {
        searchErr = err;
      }
      if (byId.size) break;
    }
    if (!byId.size) {
      try {
        take(await searchGlobal(`${aux ? 'R' : 'M'}-${num}`));
        if (!byId.size) take(await searchGlobal(num));
      } catch (err) {
        searchErr = searchErr || err;
      }
    }
    const hits = [...byId.values()];
    if (!hits.length) {
      if (searchErr) {
        r.notes.push(`Não consegui procurar ${aux ? 'o' : 'a'} ${what}: ${searchErr.message}`);
        return;
      }
      r.status = 'sem-perfil';
      const entry = aux ? null : await findBookEntry(num, e.cnm).catch(() => null);
      if (entry) {
        r.bookUrl = entry.url;
        r.notes.push(
          `A matrícula ${e.matricula} está no Livro Indicador Real, mas ainda não tem cadastro (perfil) na NoCartório. Gere o perfil pela tela do livro e importe a ficha de novo; os documentos dela ficam de fora por enquanto.`
        );
      } else {
        r.notes.push(`${what} não encontrad${aux ? 'o' : 'a'} na NoCartório${e.cnm ? ` (CNM ${e.cnm})` : ''}. Os documentos ficam de fora.`);
      }
      return;
    }
    r.choices = hits;
    if (hits.length > 1) {
      r.status = 'ambigua';
      r.notes.push(`Há ${hits.length} cadastros para ${what} (cartórios ou tipos diferentes). Escolha qual é${e.cnm ? '' : ' — ou informe o CNM na ficha'}.`);
      return;
    }
    chooseProperty(e, r, hits[0], act);
  }

  /** Imóvel escolhido: perfil, papéis atuais e papel a incluir (o pedido na ficha ou o papel de matrícula do ato). */
  function chooseProperty(e, r, hit, act) {
    r.profileId = hit.id;
    r.label = hit.label;
    r.typeName = parsePropertyLabel(hit.label).typeName;
    r.current = act.roles.filter((x) => x.selection.some((s) => s.profileId === hit.id)).map((x) => x.label);
    r.status = r.current.length ? 'no-ato' : 'fora-do-ato';
    r.planned = [];
    const pRoles = propertyRoles(act.roles, r.typeName, e.book);
    for (const p of e.papeis) {
      const m = matchRole(p, act.roles);
      if (m.role && pRoles.includes(m.role)) {
        if (!r.planned.includes(m.role)) r.planned.push(m.role);
      } else if (m.role) r.notes.push(`Papel “${p}” não aceita ${e.book === 3 ? 'registro' : 'imóvel'} do tipo “${r.typeName || '?'}” — escolha abaixo.`);
      else r.notes.push(`Papel “${p}” não existe neste ato — escolha abaixo, se for o caso.`);
    }
    if (!e.papeis.length && !r.current.length) {
      const def = defaultPropertyRole(pRoles, e.book);
      if (def) r.planned.push(def);
      else r.notes.push(`Nenhum papel deste ato aceita ${e.book === 3 ? 'registro' : 'imóvel'} do tipo “${r.typeName || '?'}”.`);
    }
    r.planned = r.planned.filter((x) => !r.current.some((c) => normText(c) === normText(x.label)));
    for (const x of r.planned.filter((p) => p.readonly)) r.notes.push(`Papel “${x.label}”: o ato não permite incluir partes agora.`);
    r.planned = r.planned.filter((p) => !p.readonly);
  }

  /** Termo da matrícula no Livro Indicador Real (só para apontar onde gerar o perfil). */
  async function findBookEntry(num, cnm) {
    const co = companyId();
    if (!co) return null;
    const url = routeUrl('api.ri-real-indicator-book.search-for-autocomplete', { company_id: co }, `/api/search-for-autocomplete/${co}/ri-real-indicator-book`);
    const j = await getJson(url, { q: num });
    const arr = (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : []).filter((o) => o && o.id);
    const hit = arr.find((o) => {
      const t = String(o.name || o.label || '');
      const term = t.match(/termo:\s*([\d.]+)/i);
      const mat = t.match(/matr[ií]cula:\s*(\d+)/i);
      if (cnm && mat) return digitsOf(mat[1]) === digitsOf(cnm);
      return term ? matNumber(term[1]) === num : false;
    });
    if (!hit) return null;
    return { id: hit.id, url: routeUrl('v2.admin.manager.ri-real-indicator-book.show', { bookEntry: hit.id }, `/admin/manager/v2/ri-real-indicator-book/${hit.id}`) };
  }

  /** Empresa (serventia) da sessão, a partir dos dados da página. */
  function companyId() {
    const pg = history.state && history.state.page;
    const find = (o, d) => {
      if (!o || typeof o !== 'object' || d > 4) return null;
      for (const [k, v] of Object.entries(o)) {
        if (/company/i.test(k) && v && typeof v === 'object' && UUID_RE.test(String(v.id || ''))) return v.id;
        const x = find(v, d + 1);
        if (x) return x;
      }
      return null;
    };
    return pg && pg.props ? find(pg.props.auth, 0) || find(pg.props.menu, 0) : null;
  }

  /** Localiza cada parte da ficha no ato / na NoCartório e calcula os papéis. */
  async function resolveAll() {
    const act = S.act;
    S.res = new Map();
    if (!act) return;
    const anyRole = act.roles.find((r) => !r.readonly) || null;
    const attachedRoles = (profileId) => act.roles.filter((r) => r.selection.some((s) => s.profileId === profileId)).map((r) => r.label);
    let done = 0;
    setBusy(`Procurando as partes na NoCartório (0/${S.ents.length})…`);
    const resolveOne = async (e) => {
      const r = { profileId: null, status: 'nao-localizada', typeName: e.kind === 'pessoa' ? wantedProfileType(e) : '', current: [], planned: [], notes: [], label: '' };
      S.res.set(e.key, r);
      if (e.kind === 'pessoa') {
        // papéis pedidos na ficha
        for (const p of e.papeis) {
          const m = matchRole(p, act.roles);
          if (m.role) {
            if (!r.planned.some((x) => x.ptrId === m.role.ptrId)) r.planned.push(m.role);
          } else if (m.ambiguous) r.notes.push(`Papel “${p}”: corresponde a mais de um papel do ato (${m.ambiguous.map((x) => x.label).join(', ')}) — escolha abaixo.`);
          else r.notes.push(`Papel “${p}” não existe neste ato — escolha abaixo, se for o caso.`);
        }
        const key = e.cpf || e.cnpj;
        if (key) {
          let hits = [];
          try {
            hits = await searchGlobal(key);
          } catch (err) {
            const roleForSearch = r.planned.find((x) => !x.readonly) || anyRole;
            try {
              hits = roleForSearch ? await searchRole(act.processId, roleForSearch.ptrId, key) : [];
            } catch (err2) {
              r.notes.push(`Não consegui procurar o ${e.cpf ? 'CPF' : 'CNPJ'}: ${err2.message}`);
            }
          }
          const ok = hits.filter((x) => labelMatches(x.label, e));
          const inAct = ok.find((x) => attachedRoles(x.id).length);
          const hit = inAct || ok[0] || null;
          if (ok.length > 1) r.notes.push(`Há ${ok.length} cadastros com este ${e.cpf ? 'CPF' : 'CNPJ'} na NoCartório; usei ${inAct ? 'o que já está no ato' : 'o primeiro'}.`);
          if (hit) {
            r.profileId = hit.id;
            r.label = hit.label;
            r.current = attachedRoles(hit.id);
            r.status = r.current.length ? 'no-ato' : 'fora-do-ato';
          } else {
            r.status = 'nova';
          }
        } else {
          // sem CPF/CNPJ: só dá para achar entre as partes do ato, pelo nome
          for (const role of act.roles) {
            const s = role.selection.find((x) => normText(String(x.label).split(' | ')[0]) === normText(e.nome));
            if (s) {
              r.profileId = s.profileId;
              r.label = s.label;
              break;
            }
          }
          if (r.profileId) {
            r.current = attachedRoles(r.profileId);
            r.status = 'no-ato';
          } else r.notes.push('Sem CPF/CNPJ na ficha e fora do ato: não dá para localizar nem cadastrar. Os documentos dela ficam de fora.');
        }
        r.planned = r.planned.filter((x) => !r.current.some((c) => normText(c) === normText(x.label)));
        for (const x of r.planned.filter((p) => p.readonly)) r.notes.push(`Papel “${x.label}”: o ato não permite incluir partes agora.`);
        r.planned = r.planned.filter((p) => !p.readonly);
      } else {
        for (const role of act.roles) {
          const s = role.selection.find((x) => selectionMatchesOther(x.label, e));
          if (s) {
            r.profileId = s.profileId;
            r.label = s.label;
            break;
          }
        }
        if (r.profileId) {
          r.current = attachedRoles(r.profileId);
          r.status = 'no-ato';
          if (e.kind === 'imovel') r.typeName = parsePropertyLabel(r.label).typeName;
        } else if (e.kind === 'imovel') {
          await resolveProperty(e, r, act);
        } else {
          r.notes.push(`O formulário do ato ${e.codigo} não foi encontrado neste serviço.`);
        }
      }
    };
    const queue = S.ents.slice();
    const worker = async () => {
      while (queue.length) {
        const e = queue.shift();
        try {
          await resolveOne(e);
        } catch (err) {
          const r = S.res.get(e.key);
          if (r) r.notes.push(`Erro ao procurar: ${err.message}`);
        }
        done++;
        setBusy(`Procurando as partes na NoCartório (${done}/${S.ents.length})…`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setBusy('');
  }

  function profileTypeIdFor(typeName) {
    const n = normText(typeName);
    for (const r of (S.act && S.act.roles) || []) for (const t of r.types) if (normText(t.label) === n) return t.profileTypeId;
    return null;
  }

  async function templatesFor() {
    const out = {};
    const want = new Map(); // typeId → typeName
    for (const e of S.ents) {
      const r = S.res.get(e.key);
      if (r && r.status === 'nova') {
        const id = profileTypeIdFor(r.typeName);
        if (id != null) want.set(id, r.typeName);
      }
    }
    if (!want.size) return out;
    const candidates = [];
    for (const e of S.ents) {
      const r = S.res.get(e.key);
      if (r && r.profileId && r.label) candidates.push({ id: r.profileId, typeName: String(r.label).split(' | ')[1] || '' });
    }
    for (const a of S.acts) for (const role of a.roles) for (const s of role.selection) candidates.push({ id: s.profileId, typeName: String(s.label).split(' | ')[1] || '' });
    if (S.requerentes == null && S.ctx && S.ctx.protocolId) S.requerentes = await loadRequerentes(S.ctx.protocolId);
    for (const q of S.requerentes || []) candidates.push(q);
    for (const [id, name] of want) {
      const c = candidates.find((x) => x.id && normText(x.typeName) === normText(name));
      if (c) out[id] = c.id;
    }
    return out;
  }

  /** Monta os dados para o Cadastro unificado (NCU.openPrefilled). */
  async function buildPayload() {
    const f = S.ficha;
    const act = S.act;
    const warnings = [...S.valid.warnings, ...S.entWarnings];
    if (f.protocolo && S.ctx.protocolCode && normText(f.protocolo) !== normText(S.ctx.protocolCode)) {
      warnings.unshift(`A ficha é do protocolo ${f.protocolo}, mas este serviço é o ${S.ctx.protocolCode}. Confira se é a ficha certa.`);
    }
    const profiles = [];
    for (const e of S.ents) {
      const r = S.res.get(e.key);
      if (!r) continue;
      const docs = [];
      for (const idx of e.docs) {
        const d = f.documentos[idx];
        const x = docForPlan(f, d);
        docs.push(x.plan);
        for (const w of x.warnings) warnings.push(`${e.nome || e.key}: ${w}`);
      }
      if (!r.profileId && r.status !== 'nova') {
        if (docs.length) warnings.push(`${e.nome || (e.matricula ? propName(e) : '') || e.codigo}: ${r.notes[r.notes.length - 1] || 'não localizada'} (${docs.length} documento(s) ignorado(s)).`);
        continue;
      }
      if (!r.current.length && !r.planned.length) {
        warnings.push(`${e.nome || e.key}: não está no ato e nenhum papel foi escolhido — ignorada${docs.length ? ` (${docs.length} documento(s))` : ''}.`);
        continue;
      }
      const typeName = r.typeName;
      const isProperty = e.kind === 'imovel';
      profiles.push({
        key: e.key,
        kind: isProperty ? 'imovel' : e.kind,
        matricula: isProperty ? e.matricula : undefined,
        livro: isProperty ? e.book || 2 : undefined, // 2 = matrícula (Registro Geral), 3 = Registro Auxiliar
        name: e.nome || (isProperty ? `${propName(e)}${typeName ? ` (${typeName})` : ''}` : r.label ? String(r.label).split(' | ')[0] : e.key),
        profileId: r.profileId,
        profileTypeName: typeName,
        profileTypeId: profileTypeIdFor(typeName),
        keyDoc: e.cpf ? { alias: 'numero_cpf', value: e.cpf } : e.cnpj ? { alias: 'numero_cnpj', value: e.cnpj } : null,
        addRoles: r.planned.map((x) => ({ ptrId: x.ptrId, label: x.label })),
        docs,
        notes: r.notes.filter((t) => !/escolha abaixo/.test(t)),
      });
    }
    return {
      version: 1,
      source: { kind: 'ficha', label: `Ficha ${f.protocolo || ''}`.trim(), version: VERSION },
      processId: act.processId,
      templates: await templatesFor(),
      profiles,
      warnings,
    };
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

  /** replaceChildren que aceita listas e ignora null/false. */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
    return el;
  }

  const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none !important}
.ov{position:fixed;inset:0;z-index:2147482500;background:rgba(17,17,17,.5);display:flex;padding:16px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1c1917}
.box{margin:auto;width:min(1100px,100%);max-height:100%;background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.4)}
.hd{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#141414;color:#fafaf9}
.hd b{font-size:15px}
.hd .ver{font-size:11px;color:#a8a29e}
.hd .x{margin-left:auto}
.bd{padding:14px 16px;overflow:auto}
.ft{padding:12px 16px;border-top:1px solid #e7e5e4;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;align-items:center}
.ft .left{margin-right:auto;color:#78716c;font-size:12px}
.btn{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid #d6d3d1;background:#fff;color:#1c1917;border-radius:7px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.btn:hover:not(:disabled){background:#fafaf9}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:#ea580c;border-color:#ea580c;color:#fff;font-weight:600}
.btn.primary:hover:not(:disabled){background:#c2410c}
.hd .btn{background:#262626;border-color:#404040;color:#fafaf9}
.btn:focus-visible,.sel:focus-visible,textarea:focus-visible,.xb:focus-visible{outline:2px solid #fb923c;outline-offset:1px}
textarea{width:100%;height:46vh;min-height:220px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid #d6d3d1;border-radius:8px;padding:10px;resize:vertical}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.muted{color:#78716c;font-size:12px}
.alert{border-radius:8px;padding:8px 10px;font-size:12.5px;margin:8px 0}
.alert.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.alert.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.alert.info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}
.alert ul{margin:4px 0 0 18px;padding:0}
.sel{font:inherit;border:1px solid #d6d3d1;border-radius:7px;padding:5px 8px;background:#fff;max-width:100%}
table{width:100%;border-collapse:collapse;margin:4px 0 12px}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78716c;font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid #e7e5e4}
td{padding:8px;border-bottom:1px solid #f5f5f4;vertical-align:top}
.nm{font-weight:650}
.sub{font-size:12px;color:#78716c}
.badge{display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;margin:0 4px 2px 0}
.b-ok{background:#dcfce7;color:#166534}.b-new{background:#ffedd5;color:#9a3412}.b-out{background:#e0f2fe;color:#075985}.b-bad{background:#fee2e2;color:#991b1b}
.role{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;border-radius:999px;padding:1px 8px;margin:0 4px 4px 0}
.role.cur{background:#292524;color:#fafaf9}
.role.plan{background:#fff7ed;color:#9a3412;border:1px dashed #fb923c}
.xb{all:unset;cursor:pointer;color:#9a3412;font-size:12px;padding:0 2px;border-radius:3px}
.xb:hover{background:#fed7aa}
.notes{margin:4px 0 0 16px;padding:0;color:#92400e;font-size:12px}
.h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#57534e;margin:14px 0 4px}
.spin{width:14px;height:14px;border:2px solid #fed7aa;border-top-color:#ea580c;border-radius:50%;animation:sp .8s linear infinite;display:inline-block;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
@media (max-width:760px){.ov{padding:0}.box{border-radius:0}td,th{padding:6px 4px}}
`;
  const FAB_CSS = `
:host{all:initial}
:host([hidden]){display:none !important}
.fab{position:fixed;right:92px;bottom:76px;z-index:2147481000;display:inline-flex;align-items:center;gap:8px;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;background:#1c1917;border:0;border-radius:999px;padding:11px 16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.fab:hover{background:#000}
.fab:focus-visible{outline:3px solid #fed7aa;outline-offset:2px}
.fab small{font-weight:500;color:#fdba74}
`;

  function ensureUI() {
    if (UI.host) return;
    const host = h('div', { id: 'ncf-host' });
    const root = host.attachShadow({ mode: 'open' });
    UI.host = host;
    UI.title = h('b', null, 'Importar ficha');
    UI.body = h('div', { class: 'bd' });
    UI.foot = h('div', { class: 'ft' });
    const close = h('button', { class: 'btn x', type: 'button', title: 'Fechar (Esc)' }, '✕');
    close.addEventListener('click', () => closeUI());
    UI.ov = h('div', { class: 'ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Importar ficha', hidden: true }, h('div', { class: 'box' }, h('div', { class: 'hd' }, UI.title, h('span', { class: 'ver' }, `v${VERSION}`), close), UI.body, UI.foot));
    UI.ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeUI();
      }
    });
    for (const ev of ['keydown', 'keyup', 'keypress']) host.addEventListener(ev, (e) => e.stopPropagation());
    root.append(h('style', null, CSS), UI.ov);
    document.body.append(host);
  }

  function openUI() {
    if (!pageContext()) return;
    ensureUI();
    UI.ov.hidden = false;
    S.ctx = pageContext();
    renderPaste();
  }
  function closeUI() {
    if (UI.ov) UI.ov.hidden = true;
    syncFab();
  }

  function setBusy(msg) {
    S.busyMsg = msg;
    if (UI.busy) {
      UI.busy.hidden = !msg;
      UI.busy.replaceChildren(h('span', { class: 'spin' }), ' ', msg);
    }
  }

  function ncuStatus() {
    const N = window.NCU;
    if (!N) return 'O “Cadastro unificado” não está ativo nesta aba. Instale/ative o script “NoCartório – Cadastro unificado” (0.4.0 ou mais novo) e recarregue a página.';
    if (!(N.prefillApi >= MIN_NCU_PREFILL_API) || typeof N.openPrefilled !== 'function') return `O “Cadastro unificado” instalado (v${N.version || '?'}) é antigo. Atualize para 0.4.0 ou mais novo e recarregue a página.`;
    return null;
  }

  /* ----- passo 1: colar ----- */

  function renderPaste(errors) {
    UI.title.textContent = 'Importar ficha';
    const saved = loadRaw();
    const ta = h('textarea', { placeholder: 'Cole aqui a ficha JSON gerada junto com a minuta…', spellcheck: 'false' });
    ta.value = S.raw || (saved ? saved.raw : '');
    const file = h('input', { type: 'file', accept: '.json,application/json,text/plain', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (f) ta.value = await f.text();
    });
    const paste = h('button', { class: 'btn', type: 'button' }, 'Colar da área de transferência');
    paste.addEventListener('click', async () => {
      try {
        ta.value = await navigator.clipboard.readText();
      } catch (e) {
        msg.replaceChildren(h('div', { class: 'alert warn' }, 'Não consegui ler a área de transferência; cole com Ctrl+V.'));
      }
    });
    const open = h('button', { class: 'btn', type: 'button' }, 'Abrir arquivo .json');
    open.addEventListener('click', () => file.click());
    const discard = h('button', { class: 'btn', type: 'button', hidden: !ta.value }, 'Descartar ficha');
    discard.addEventListener('click', () => {
      S.raw = '';
      storeRaw('');
      ta.value = '';
      discard.hidden = true;
    });
    const exp = h('button', { class: 'btn', type: 'button', title: 'Lê na NoCartório todos os tipos de documento e os campos de cada um e baixa o catálogo (.json e .md) para atualizar a skill' }, 'Exportar catálogo');
    exp.addEventListener('click', () => renderCatalog());
    const msg = h('div');
    if (errors && errors.length) msg.append(h('div', { class: 'alert err' }, h('b', null, 'A ficha tem problemas:'), h('ul', null, errors.map((t) => h('li', null, t)))));
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Ler ficha');
    go.addEventListener('click', () => readFicha(ta.value));
    fill(
      UI.body,
      h('div', { class: 'row' }, paste, open, discard, exp, saved ? h('span', { class: 'muted' }, `Ficha guardada nesta aba às ${new Date(saved.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`) : null),
      ta,
      file,
      msg
    );
    const nst = ncuStatus();
    UI.foot.replaceChildren(nst ? h('span', { class: 'left' }, `⚠ ${nst}`) : h('span', { class: 'left' }, 'Nada é gravado nesta etapa.'), go);
    setTimeout(() => ta.focus(), 0);
  }

  /* ----- catálogo ----- */

  async function renderCatalog() {
    UI.title.textContent = 'Exportar catálogo da NoCartório';
    UI.busy = h('div', { class: 'muted' });
    const back = h('button', { class: 'btn', type: 'button' }, 'Voltar');
    back.addEventListener('click', () => renderPaste());
    const go = h('button', { class: 'btn primary', type: 'button' }, 'Gerar e baixar');
    fill(
      UI.body,
      h(
        'div',
        { class: 'alert info' },
        'Lê na NoCartório a lista de todos os tipos de documento e os campos de cada um (só leitura; leva uns 3 a 5 minutos). No fim, baixa catalogo-nocartorio.json (completo) e catalogo-nocartorio.md (resumido). Leve o .md ao Claude e peça para atualizar a skill “ficha-cadastro-unificado”.'
      ),
      UI.busy
    );
    fill(UI.foot, back, go);
    go.addEventListener('click', async () => {
      go.disabled = true;
      back.disabled = true;
      try {
        const ctx = pageContext();
        if (!ctx || !ctx.protocolId) throw new UErr('Abra a tela de um serviço ou de um ato para gerar o catálogo.');
        setBusy('Procurando um perfil para ler os formulários…');
        const pid = await anyProfileId(ctx);
        if (!pid) throw new UErr('Este serviço não tem nenhuma parte cadastrada; abra outro serviço para gerar o catálogo.');
        const cat = await buildCatalog(pid, setBusy);
        const md = catalogToMarkdown(cat);
        downloadText('catalogo-nocartorio.json', JSON.stringify(cat, null, 1), 'application/json');
        downloadText('catalogo-nocartorio.md', md, 'text/markdown');
        const errs = cat.tipos.filter((t) => t.erro).length;
        setBusy('');
        UI.body.append(h('div', { class: 'alert info' }, `Pronto: ${cat.tipos.length} tipos${errs ? ` (${errs} sem campos lidos)` : ''}, ${Object.keys(cat.listas).length} listas de opções. Os arquivos foram baixados.`));
      } catch (e) {
        setBusy('');
        UI.body.append(h('div', { class: 'alert err' }, e.message));
      }
      back.disabled = false;
    });
  }

  async function readFicha(raw) {
    let obj;
    const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      obj = JSON.parse(text);
    } catch (e) {
      renderPaste([`JSON inválido: ${e.message}`]);
      return;
    }
    const v = validateFicha(obj);
    if (v.errors.length) {
      S.raw = text;
      renderPaste(v.errors);
      return;
    }
    S.raw = text;
    storeRaw(text);
    S.ficha = obj;
    S.valid = v;
    const ents = entitiesFromFicha(obj);
    S.ents = ents.list;
    S.entWarnings = ents.warnings;
    S.requerentes = null;
    await loadContext();
  }

  /* ----- passo 2: conferir ----- */

  async function loadContext() {
    UI.title.textContent = 'Conferir antes de abrir';
    UI.busy = h('div', { class: 'muted' });
    UI.body.replaceChildren(UI.busy);
    UI.foot.replaceChildren();
    setBusy('Lendo os atos do serviço…');
    try {
      S.ctx = pageContext();
      if (!S.ctx || !S.ctx.protocolId) throw new UErr('Não identifiquei o serviço desta página. Abra a tela do serviço ou do ato.');
      if (!window.NCU || !window.NCU._pure) throw new UErr(ncuStatus() || 'Cadastro unificado indisponível.');
      S.acts = await loadActs(S.ctx.protocolId);
      S.act = chooseDefaultAct(S.acts, S.ficha, S.ctx);
      if (!S.act) throw new UErr('Nenhum ato deste serviço tem papéis de partes.');
      await resolveAll();
      renderReview();
    } catch (e) {
      setBusy('');
      UI.body.replaceChildren(h('div', { class: 'alert err' }, e.message));
      const back = h('button', { class: 'btn', type: 'button' }, 'Voltar');
      back.addEventListener('click', () => renderPaste());
      UI.foot.replaceChildren(back);
    }
  }

  const STATUS = {
    'no-ato': ['No ato', 'b-ok'],
    'fora-do-ato': ['Cadastrada, fora do ato', 'b-out'],
    nova: ['Nova — será cadastrada', 'b-new'],
    'nao-localizada': ['Não localizada', 'b-bad'],
    ambigua: ['Mais de um cadastro — escolha', 'b-bad'],
    'sem-perfil': ['Sem cadastro na NoCartório', 'b-bad'],
  };
  const STATUS_IMOVEL = { 'fora-do-ato': ['Cadastrada, fora do ato — será incluída', 'b-out'] };

  function personRow(e) {
    const r = S.res.get(e.key);
    const isProperty = e.kind === 'imovel';
    const tr = h('tr');
    const draw = () => {
      const [stTxt, stCls] = (isProperty && STATUS_IMOVEL[r.status]) || STATUS[r.status] || ['?', ''];
      const roles = h('div');
      const pool = isProperty ? propertyRoles(S.act.roles, r.typeName, e.book) : S.act.roles;
      const paint = () => {
        const editable = pool.filter((x) => !x.readonly && !r.planned.includes(x) && !r.current.some((c) => normText(c) === normText(x.label)));
        const add = h('select', { class: 'sel', title: 'Incluir em mais um papel', disabled: !editable.length || (!r.profileId && r.status !== 'nova') }, h('option', { value: '' }, '+ papel…'), editable.map((x) => h('option', { value: x.ptrId }, x.label)));
        add.addEventListener('change', () => {
          const x = S.act.roles.find((y) => y.ptrId === add.value);
          if (x) r.planned.push(x);
          paint();
        });
        fill(
          roles,
          r.current.map((c) => h('span', { class: 'role cur', title: 'Já está neste papel' }, c)),
          r.planned.map((x) => {
            const del = h('button', { class: 'xb', type: 'button', title: 'Não incluir neste papel' }, '✕');
            del.addEventListener('click', () => {
              r.planned = r.planned.filter((y) => y !== x);
              paint();
            });
            return h('span', { class: 'role plan', title: 'Será incluída neste papel' }, `+ ${x.label}`, del);
          }),
          e.kind === 'pessoa' || (isProperty && r.profileId) ? add : null
        );
      };
      paint();
      // matrícula com mais de um cadastro: escolher qual
      let pick = null;
      if (isProperty && r.choices && r.choices.length > 1) {
        pick = h(
          'select',
          { class: 'sel', title: 'Qual cadastro é esta matrícula?' },
          h('option', { value: '' }, r.profileId ? '' : 'Escolha o cadastro…'),
          r.choices.map((c) => h('option', { value: c.id, selected: c.id === r.profileId }, c.label.split(' | ').slice(0, 2).join(' · ')))
        );
        pick.addEventListener('change', () => {
          const c = r.choices.find((x) => x.id === pick.value);
          if (!c) return;
          r.notes = r.notes.filter((t) => !/^Há \d+ cadastros para /.test(t));
          chooseProperty(e, r, c, S.act);
          draw();
        });
      }
      const notes = r.notes.length ? h('ul', { class: 'notes' }, r.notes.map((t) => h('li', null, t))) : null;
      const book = r.bookUrl ? h('a', { href: r.bookUrl, target: '_blank', rel: 'noopener', class: 'sub' }, 'Abrir no Livro Indicador Real ↗') : null;
      const key = e.cpf || e.cnpj || (e.matricula ? `${propName(e)}${e.cnm ? ` · CNM ${e.cnm}` : ''}` : e.codigo || '');
      const title = isProperty
        ? e.nome || (r.label ? parsePropertyLabel(r.label).short : propName(e))
        : e.nome || (r.label ? String(r.label).split(' | ')[0] : '—');
      fill(
        tr,
        h('td', null, h('div', { class: 'nm' }, title), h('div', { class: 'sub' }, key), notes, book),
        h('td', null, h('span', { class: `badge ${stCls}` }, stTxt), r.profileId && r.status !== 'no-ato' && r.typeName ? h('div', { class: 'sub' }, r.typeName) : null, pick),
        h('td', null, roles),
        h('td', null, String(e.docs.length))
      );
    };
    draw();
    return tr;
  }

  function renderReview() {
    setBusy('');
    const f = S.ficha;
    const actSel = h(
      'select',
      { class: 'sel' },
      S.acts
        .filter((a) => a.roles.length)
        .map((a) => h('option', { value: a.processId, selected: a === S.act }, `${a.code} · ${a.name}${a.roles.some((r) => !r.readonly) ? '' : ' (sem inclusão de partes agora)'}`))
    );
    actSel.addEventListener('change', async () => {
      S.act = S.acts.find((a) => a.processId === actSel.value) || S.act;
      UI.body.replaceChildren(UI.busy);
      await resolveAll();
      renderReview();
    });
    const pessoas = S.ents.filter((e) => e.kind === 'pessoa');
    const outras = S.ents.filter((e) => e.kind !== 'pessoa');
    const warn = [...S.valid.warnings, ...S.entWarnings];
    if (f.protocolo && S.ctx.protocolCode && normText(f.protocolo) !== normText(S.ctx.protocolCode)) warn.unshift(`A ficha é do protocolo ${f.protocolo}, mas este serviço é o ${S.ctx.protocolCode}. Confira se é a ficha certa.`);
    if (!S.act.roles.some((r) => !r.readonly)) warn.unshift('Este ato não permite incluir partes agora (já lavrado, cancelado ou sem pagamento?). Só os documentos das partes que já estão no ato serão aplicados.');
    const nst = ncuStatus();
    const table = (rows) =>
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'Parte'), h('th', null, 'Situação'), h('th', null, 'Papéis no ato'), h('th', null, 'Docs.'))), h('tbody', null, rows));
    fill(
      UI.body,
      UI.busy,
      h('div', { class: 'row' }, h('b', null, 'Ato:'), actSel, f.protocolo ? h('span', { class: 'muted' }, `Ficha do protocolo ${f.protocolo}`) : null),
      warn.length ? h('div', { class: 'alert warn' }, h('b', null, 'Avisos:'), h('ul', null, warn.map((t) => h('li', null, t)))) : null,
      pessoas.length ? [h('div', { class: 'h3' }, 'Pessoas'), table(pessoas.map(personRow))] : null,
      outras.length ? [h('div', { class: 'h3' }, 'Imóveis, registros e formulários'), table(outras.map(personRow))] : null,
      outras.some((e) => e.kind === 'imovel' && e.book !== 3 && S.res.get(e.key) && S.res.get(e.key).planned.length)
        ? h('div', { class: 'alert info' }, 'Ao incluir uma matrícula no ato, a NoCartório costuma incluir sozinha os proprietários do imóvel. As matrículas são gravadas antes das pessoas, e o resultado mostra quem foi incluído automaticamente.')
        : null,
      h(
        'div',
        { class: 'alert info' },
        'Ao abrir, o Cadastro unificado mostra tudo numa tela só, já preenchido com a ficha. Campos vazios recebem o valor da ficha; campos já preenchidos com outro valor não são trocados — aparece “Ficha: … usar”. Nada é gravado antes da revisão.'
      )
    );
    const back = h('button', { class: 'btn', type: 'button' }, 'Voltar');
    back.addEventListener('click', () => renderPaste());
    const go = h('button', { class: 'btn primary', type: 'button', disabled: !!nst }, 'Abrir no cadastro unificado');
    go.addEventListener('click', async () => {
      go.disabled = true;
      setBusy('Preparando…');
      try {
        const payload = await buildPayload();
        if (!payload.profiles.length) throw new UErr('Nenhuma parte da ficha pôde ser localizada ou incluída neste ato.');
        closeUI();
        await window.NCU.openPrefilled(payload);
      } catch (e) {
        setBusy('');
        go.disabled = false;
        if (UI.ov.hidden) {
          UI.ov.hidden = false;
          renderReview();
        }
        UI.body.prepend(h('div', { class: 'alert err' }, e.message));
      }
    });
    fill(UI.foot, nst ? h('span', { class: 'left' }, `⚠ ${nst}`) : h('span', { class: 'left' }, `${pessoas.length} pessoa(s) · ${(f.documentos || []).length} documento(s) na ficha`), back, go);
  }

  /* ----- botão flutuante ----- */

  function ensureFab() {
    if (UI.fabHost || !document.body) return;
    const host = h('div', { id: 'ncf-fab-host' });
    const root = host.attachShadow({ mode: 'open' });
    UI.fabSmall = h('small');
    const btn = h('button', { class: 'fab', type: 'button', title: 'Importar a ficha JSON da minuta e abrir no Cadastro unificado (Alt+I)' }, h('span', null, 'Importar ficha'), UI.fabSmall);
    btn.addEventListener('click', () => openUI());
    root.append(h('style', null, FAB_CSS), btn);
    document.body.append(host);
    UI.fabHost = host;
  }
  function syncFab() {
    ensureFab();
    if (!UI.fabHost) return;
    const ncuOpen = !!(window.NCU && window.NCU.state && window.NCU.state.open);
    UI.fabHost.hidden = !pageContext() || ncuOpen || (UI.ov && !UI.ov.hidden);
    const saved = loadRaw();
    if (UI.fabSmall) UI.fabSmall.textContent = saved ? '● carregada' : '';
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'i' || e.key === 'I') && pageContext() && !(UI.ov && !UI.ov.hidden)) {
      e.preventDefault();
      openUI();
    }
  });
  document.addEventListener('inertia:navigate', syncFab);
  window.addEventListener('popstate', syncFab);
  window.addEventListener('ncu:ready', syncFab);
  setInterval(syncFab, 1500);
  syncFab();

  window.NCF = { version: VERSION, open: openUI, state: S, _pure: PURE, _catalog: { buildCatalog, catalogToMarkdown } };
})();
