// ==UserScript==
// @name         NoCartório — Anexos em mosaico
// @namespace    https://cartoriosja.com.br/userscripts
// @version      1.0.1
// @description  Painel em mosaico para anexar imagens e PDFs aos documentos ativos de todas as partes do ato, com arrastar e soltar e envio de tudo no final.
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Como funciona
 * - Botão "Anexar arquivos" aparece em qualquer tela de ato (/admin/manager/v2/process/...), acima do
 *   botão do Cadastro unificado.
 * - Lê as partes do ato (props do Inertia; se não der, os links de "Configurações das Partes").
 * - Para cada parte busca GET /api/process/{ato}/part/{parte}/documents e mostra só os documentos
 *   ativos (com partDocument). "Imagens da parte" vem de GET .../files, num cartão discreto.
 * - Os arquivos ficam numa fila local. Nada é enviado antes de clicar em "Salvar".
 * - Envio: um arquivo por vez, POST multipart "file" para as mesmas rotas que a tela usa:
 *     documento -> admin.manager.document.add-image-from-drop-zone
 *     parte     -> admin.manager.process-part-file.add-file
 */

(function () {
  'use strict';

  if (window.__nca) return;

  const VERSION = '1.0.1';
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const PROCESS_RE = new RegExp('/admin/manager/v2/process/(' + UUID + ')', 'i');
  const PART_RE = new RegExp('/part/(' + UUID + ')', 'i');

  // ---------------------------------------------------------------- utilidades
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|bmp|tiff?|heic|heif)$/i;
  const JUNK = /^(\.|thumbs\.db$|desktop\.ini$)/i;
  const isImg = (f) => /^image\//i.test(f.type || '') || IMG_EXT.test(f.name || '');
  const isPdf = (f) => /pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name || '');
  const canPreview = (f) => isImg(f) && !/\.(heic|heif|tiff?)$/i.test(f.name || '') && !/hei[cf]|tiff/i.test(f.type || '');
  const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }
  function readCookie(name) {
    const list = document.cookie ? document.cookie.split('; ') : [];
    for (const c of list) {
      const i = c.indexOf('=');
      if (c.slice(0, i) === name) return safeDecode(c.slice(i + 1));
    }
    return null;
  }
  async function pool(list, n, fn) {
    const q = list.slice();
    const run = async () => {
      while (q.length) {
        const x = q.shift();
        try { await fn(x); } catch (_) { /* o erro já fica registrado na parte */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, run));
  }

  // ---------------------------------------------------------------- contexto do ato
  function vueApp() {
    try {
      const el = document.querySelector('#app');
      return (el && el.__vue_app__) || null;
    } catch (_) { return null; }
  }
  function inertiaLayout() {
    try {
      const app = vueApp();
      const page = app && app.config && app.config.globalProperties && app.config.globalProperties.$page;
      return (page && page.props && page.props.layout) || null;
    } catch (_) { return null; }
  }
  function currentProcessId() {
    const m = location.pathname.match(PROCESS_RE);
    return m ? m[1].toLowerCase() : null;
  }

  function getContext() {
    const pid = currentProcessId();
    if (!pid) return null;

    const L = inertiaLayout();
    if (L && L.id && String(L.id).toLowerCase() === pid && Array.isArray(L.parts)) {
      return {
        processId: pid,
        processCode: L.code || '',
        protocolId: (L.protocol && L.protocol.id) || null,
        protocolCode: (L.protocol && L.protocol.code) || '',
        parts: L.parts
          .filter((p) => p && p.partId)
          .map((p) => ({ id: String(p.partId).toLowerCase(), name: p.name || 'Parte', role: p.role || '' })),
        source: 'inertia',
      };
    }

    // Plano B: links da lista "Configurações das Partes"
    const seen = new Set();
    const parts = [];
    const re = new RegExp('/process/' + pid + '/part/(' + UUID + ')', 'i');
    document.querySelectorAll('a[href*="/part/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(re);
      if (!m) return;
      const id = m[1].toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      parts.push({ id, name: lines[0] || 'Parte', role: lines.length > 1 ? lines[lines.length - 1] : '' });
    });
    const cur = location.pathname.match(PART_RE);
    if (cur && !seen.has(cur[1].toLowerCase())) parts.push({ id: cur[1].toLowerCase(), name: 'Parte atual', role: '' });

    // protocolo (serviço) só é usado para "Imagens da parte"; só aceita se houver um único na tela
    const prot = new Set();
    document.querySelectorAll('a[href*="/protocol/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(new RegExp('/v2/protocol/(' + UUID + ')', 'i'));
      if (m) prot.add(m[1].toLowerCase());
    });
    return {
      processId: pid,
      processCode: '',
      protocolId: prot.size === 1 ? [...prot][0] : null,
      protocolCode: '',
      parts,
      source: 'dom',
    };
  }

  // ---------------------------------------------------------------- rotas e HTTP
  function routeUrl(name, params, fallback) {
    try {
      let r = typeof window.route === 'function' ? window.route : null;
      if (!r) {
        const app = vueApp();
        const pr = app && app._context && app._context.provides;
        if (pr && typeof pr.route === 'function') r = pr.route;
      }
      if (r) {
        const u = String(r(name, params));
        if (u && u.indexOf('undefined') === -1) return u;
      }
    } catch (_) { /* rota fora do Ziggy: usa o caminho conhecido */ }
    return fallback;
  }

  const API = {
    documents: (pid, partId) =>
      routeUrl('api.process.part.documents', { process: pid, part: partId }, `/api/process/${pid}/part/${partId}/documents`),
    partFiles: (pid, partId) =>
      routeUrl('api.process.part.files', { process: pid, part: partId }, `/api/process/${pid}/part/${partId}/files`),
    docUpload: (docId) =>
      routeUrl('admin.manager.document.add-image-from-drop-zone', { id: docId },
        `/admin/manager/document/${docId}/add-image-from-drop-zone`),
    partUpload: (pid, partId, protocolId) =>
      routeUrl('admin.manager.process-part-file.add-file',
        { process_id: pid, process_part_id: partId, protocol_id: protocolId },
        `/admin/manager/process/${pid}/process-part/${partId}/protocol/${protocolId}/add-file`),
  };

  function reqHeaders() {
    const h = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    const x = readCookie('XSRF-TOKEN');
    if (x) h['X-XSRF-TOKEN'] = x;
    return h;
  }
  async function httpError(res) {
    let msg = '';
    try {
      const j = await res.clone().json();
      msg = j.message || '';
      if (j.errors && typeof j.errors === 'object') {
        const det = Object.values(j.errors).flat().filter(Boolean).join(' ');
        if (det && det !== msg) msg = msg ? `${msg} ${det}` : det;
      }
    } catch (_) { /* resposta não é JSON */ }
    if (!msg) {
      const known = {
        401: 'Sessão expirada. Faça login de novo.',
        403: 'Sem permissão para esta ação.',
        404: 'Rota não encontrada (o NoCartório pode ter mudado).',
        413: 'Arquivo grande demais para o servidor.',
        419: 'Sessão expirada (CSRF). Recarregue a página e tente de novo.',
        422: 'Arquivo recusado pelo sistema.',
      };
      msg = known[res.status] || `Erro HTTP ${res.status}`;
    }
    const e = new Error(msg);
    e.status = res.status;
    return e;
  }
  async function httpJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: reqHeaders() });
    if (!res.ok) throw await httpError(res);
    return res.json();
  }
  async function uploadFile(url, file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin', headers: reqHeaders() });
    if (res.redirected && /\/login\b/i.test(res.url)) {
      const e = new Error('Sessão expirada. Faça login de novo.');
      e.status = 401;
      throw e;
    }
    if (!res.ok) throw await httpError(res);
    return true;
  }
  // Faz a própria tela do NoCartório recarregar documentos/arquivos da parte aberta.
  function invalidateNative() {
    try {
      const app = vueApp();
      const qc = app && app._context && app._context.provides && app._context.provides.VUE_QUERY_CLIENT;
      if (qc && S.ctx) qc.invalidateQueries({ queryKey: ['process', S.ctx.processId] });
    } catch (_) { /* sem acesso ao vue-query: o usuário recarrega a página */ }
  }

  // ---------------------------------------------------------------- estado
  const S = {
    ctx: null,
    parts: [], // { id, name, role, loading, loaded, error, targets: [], partTarget }
    targets: new Map(), // key -> destino
    items: [], // { id, file, url, img, preview, target, status: queued|uploading|done|error, error }
    selected: new Set(),
    collapsed: new Set(),
    open: false,
    saving: false,
    refreshing: false,
    cancel: false,
    progress: { done: 0, total: 0, ok: 0, fail: 0 },
    drag: null, // ids arrastados dentro do painel
    hoverTarget: null, // cartão sob o mouse (destino do Ctrl+V)
    pickTarget: 'tray',
  };
  const LB = { scope: null, id: null, idx: 0, shown: null, dest: [] };
  let seq = 0;

  function normFile(f) {
    const url = f.url || f.downloadUrl || f.path || '';
    const name = f.name || safeDecode(url.split('?')[0].split('/').pop() || '') || String(f.id);
    const img = f.isImage != null ? !!f.isImage : IMG_EXT.test(name);
    return { id: f.id, url, thumb: f.thumbUrl || (img ? url : ''), img, name };
  }

  function buildDocTargets(part, data) {
    const list = data && Array.isArray(data.items) ? data.items : [];
    return list
      .filter((it) => it && it.partDocument)
      .map((it) => {
        const cur = it.currentDocument || null;
        const ok = !!(cur && cur.id);
        return {
          key: `doc:${part.id}:${it.partDocument.id}`,
          kind: 'doc',
          partId: part.id,
          title: (it.documentType && it.documentType.name) || 'Documento',
          subtitle: (cur && cur.name) || '',
          documentId: ok ? cur.id : null,
          existing: [].concat(it.images || [], it.documents || []).map(normFile),
          enabled: ok,
          reason: ok ? '' : 'Documento ativo, mas sem documento vinculado. Escolha o documento na tela da parte para poder anexar.',
          onlyImages: false,
        };
      });
  }

  function buildPartTarget(part, files) {
    const failed = !files || !!files.__error;
    const hasProtocol = !!(S.ctx && S.ctx.protocolId);
    const enabled = hasProtocol && !failed;
    let reason = '';
    if (failed) reason = 'Não foi possível carregar as imagens da parte.';
    else if (!hasProtocol) reason = 'Não identifiquei o serviço (protocolo) deste ato.';
    return {
      key: `part:${part.id}`,
      kind: 'part',
      partId: part.id,
      title: 'Imagens da parte',
      subtitle: 'Opcional · somente imagens',
      documentId: null,
      existing: failed ? [] : (files.images || []).map(normFile),
      enabled,
      reason,
      onlyImages: true,
    };
  }

  function syncParts(ctx) {
    const old = new Map(S.parts.map((p) => [p.id, p]));
    S.parts = ctx.parts.map((p) => {
      const o = old.get(p.id);
      if (o) {
        o.name = p.name;
        o.role = p.role;
        return o;
      }
      return { id: p.id, name: p.name, role: p.role, loading: false, loaded: false, error: '', targets: [], partTarget: null };
    });
  }

  function rebuildTargets() {
    S.targets.clear();
    for (const p of S.parts) {
      for (const t of p.targets || []) S.targets.set(t.key, t);
      if (p.partTarget) S.targets.set(p.partTarget.key, p.partTarget);
    }
    // arquivos cujo destino sumiu ou ficou indisponível voltam para a bandeja
    let moved = 0;
    for (const it of S.items) {
      if (it.target === 'tray' || it.status === 'uploading' || it.status === 'done') continue;
      const t = S.targets.get(it.target);
      if (t && t.enabled) continue;
      const part = S.parts.find((p) => p.id === it.target.split(':')[1]);
      if (part && (part.loading || part.error || !part.loaded)) continue;
      it.target = 'tray';
      it.status = 'queued';
      it.error = '';
      moved++;
    }
    if (moved) {
      toast(`${plural(moved, 'arquivo voltou', 'arquivos voltaram')} para a bandeja porque o documento não está mais disponível.`, 'warn', 7000);
    }
  }

  async function loadPart(part) {
    if (!S.ctx) return;
    const pid = S.ctx.processId;
    part.loading = true;
    part.error = '';
    render();
    try {
      const [docs, files] = await Promise.all([
        httpJson(API.documents(pid, part.id)),
        httpJson(API.partFiles(pid, part.id)).catch((e) => ({ __error: e })),
      ]);
      if (!S.ctx || S.ctx.processId !== pid) return; // mudou de ato no meio
      part.targets = buildDocTargets(part, docs);
      part.partTarget = buildPartTarget(part, files);
      part.loaded = true;
    } catch (e) {
      part.error = e.message || String(e);
    } finally {
      part.loading = false;
    }
    rebuildTargets();
    render();
  }

  function loadAll() {
    return pool(S.parts.slice(), 4, loadPart);
  }

  // ---------------------------------------------------------------- fila
  const targetOf = (key) => (key === 'tray' ? null : S.targets.get(key) || null);
  const findItem = (id) => S.items.find((i) => i.id === id) || null;

  function targetLabel(key) {
    if (key === 'tray') return 'Bandeja';
    const t = targetOf(key);
    if (!t) return '—';
    const p = S.parts.find((x) => x.id === t.partId);
    return `${t.title}${p ? ` (${p.name})` : ''}`;
  }

  function makeItem(file, target) {
    return {
      id: 'n' + ++seq,
      file,
      url: URL.createObjectURL(file),
      img: isImg(file),
      preview: canPreview(file),
      target,
      status: 'queued',
      error: '',
    };
  }

  function insertItems(list, beforeId) {
    if (!list.length) return;
    const idx = beforeId ? S.items.findIndex((i) => i.id === beforeId) : -1;
    if (idx < 0) S.items.push(...list);
    else S.items.splice(idx, 0, ...list);
  }

  function addFiles(fileList, key, beforeId) {
    if (S.saving) {
      toast('Aguarde o envio terminar.', 'warn');
      return 0;
    }
    let t = targetOf(key);
    if (key !== 'tray' && (!t || !t.enabled)) {
      toast(`${(t && t.reason) || 'Destino indisponível.'} Os arquivos foram para a bandeja.`, 'warn', 7000);
      key = 'tray';
      t = null;
      beforeId = null;
    }
    const files = Array.from(fileList || [])
      .filter((f) => f && !JUNK.test(f.name || ''))
      .sort((a, b) => collator.compare(a.name || '', b.name || ''));
    const add = [];
    const toTray = [];
    let ignored = 0;
    let dup = 0;
    for (const f of files) {
      if (!isImg(f) && !isPdf(f)) { ignored++; continue; }
      const dest = t && t.onlyImages && !isImg(f) ? 'tray' : key;
      if (S.items.some((i) => i.target === dest && sameFile(i.file, f))) { dup++; continue; }
      (dest === key ? add : toTray).push(f);
    }
    const created = add.map((f) => makeItem(f, key));
    insertItems(created, beforeId);
    if (toTray.length) {
      S.items.push(...toTray.map((f) => makeItem(f, 'tray')));
      toast(`${plural(toTray.length, 'PDF foi', 'PDFs foram')} para a bandeja: "Imagens da parte" aceita só imagens.`, 'warn', 7000);
    }
    if (ignored) toast(`${plural(ignored, 'arquivo ignorado', 'arquivos ignorados')}: só imagens e PDF são aceitos.`, 'warn', 7000);
    if (dup) toast(`${plural(dup, 'arquivo já estava', 'arquivos já estavam')} na fila desse destino.`, 'info');
    render();
    return created.length;
  }

  function moveItems(ids, key, beforeId) {
    if (S.saving || !ids || !ids.length) return;
    const t = targetOf(key);
    if (key !== 'tray' && (!t || !t.enabled)) {
      toast((t && t.reason) || 'Destino indisponível.', 'warn', 7000);
      return;
    }
    const idSet = new Set(ids);
    let moving = S.items.filter((i) => idSet.has(i.id) && i.status !== 'uploading' && i.status !== 'done');
    if (t && t.onlyImages) {
      const n = moving.length;
      moving = moving.filter((i) => i.img);
      if (moving.length < n) toast('"Imagens da parte" aceita só imagens; os PDFs ficaram onde estavam.', 'warn', 7000);
    }
    if (!moving.length) return;
    if (beforeId && idSet.has(beforeId)) {
      if (moving.every((i) => i.target === key)) return; // soltou em cima de si mesmo
      beforeId = null;
    }
    const movingSet = new Set(moving);
    S.items = S.items.filter((i) => !movingSet.has(i));
    for (const i of moving) {
      i.target = key;
      if (i.status === 'error') {
        i.status = 'queued';
        i.error = '';
      }
    }
    insertItems(moving, beforeId);
    S.selected.clear();
    render();
  }

  function removeItems(ids) {
    if (S.saving) return;
    const idSet = new Set(ids);
    S.items = S.items.filter((i) => {
      if (!idSet.has(i.id)) return true;
      URL.revokeObjectURL(i.url);
      S.selected.delete(i.id);
      return false;
    });
    render();
  }

  function resetQueue() {
    S.items.forEach((i) => URL.revokeObjectURL(i.url));
    S.items = [];
    S.selected.clear();
  }

  function clearQueue() {
    if (S.saving || !S.items.length) return;
    if (!confirm(`Tirar ${plural(S.items.length, 'arquivo', 'arquivos')} da fila?\n\nNada do que está na fila foi enviado.`)) return;
    resetQueue();
    closePreview();
    render();
  }

  // ---------------------------------------------------------------- envio
  async function save() {
    if (S.saving) return;
    const jobs = S.items.filter((i) => i.target !== 'tray' && (i.status === 'queued' || i.status === 'error'));
    const inTray = S.items.filter((i) => i.target === 'tray').length;
    if (!jobs.length) {
      toast(inTray
        ? 'Os arquivos ainda estão na bandeja. Arraste cada um para o documento certo antes de salvar.'
        : 'Nada para enviar.', 'warn', 7000);
      return;
    }
    if (inTray && !confirm(`${plural(inTray, 'arquivo continua', 'arquivos continuam')} na bandeja e não ${inTray === 1 ? 'será enviado' : 'serão enviados'}.\n\nEnviar os outros ${jobs.length} agora?`)) return;

    closePreview();
    S.saving = true;
    S.cancel = false;
    S.selected.clear();
    S.progress = { done: 0, total: jobs.length, ok: 0, fail: 0 };
    render();

    const touched = new Set();
    let fatal = null;
    for (const it of jobs) {
      if (S.cancel || fatal) break;
      const t = targetOf(it.target);
      if (!t || !t.enabled) {
        it.status = 'error';
        it.error = 'Destino indisponível.';
        S.progress.fail++;
        S.progress.done++;
        render();
        continue;
      }
      it.status = 'uploading';
      it.error = '';
      render();
      try {
        const url = t.kind === 'doc'
          ? API.docUpload(t.documentId)
          : API.partUpload(S.ctx.processId, t.partId, S.ctx.protocolId);
        await uploadFile(url, it.file);
        it.status = 'done';
        S.progress.ok++;
        touched.add(t.partId);
      } catch (e) {
        it.status = 'error';
        it.error = e.message || String(e);
        S.progress.fail++;
        if (e.status === 401 || e.status === 419) fatal = e;
      }
      S.progress.done++;
      render();
    }

    S.refreshing = true;
    render();
    await pool(S.parts.filter((p) => touched.has(p.id)), 4, loadPart);
    S.refreshing = false;

    S.items = S.items.filter((i) => {
      if (i.status !== 'done') return true;
      URL.revokeObjectURL(i.url);
      return false;
    });
    S.saving = false;
    render();
    if (touched.size) invalidateNative();

    const { ok, fail, done, total } = S.progress;
    const notTried = total - done;
    if (fatal) {
      toast(`Envio interrompido: ${fatal.message} ${ok ? `${plural(ok, 'arquivo enviado', 'arquivos enviados')}; ` : ''}o resto continua na fila.`, 'err', 12000);
    } else if (S.cancel) {
      toast(`Envio parado. ${plural(ok, 'arquivo enviado', 'arquivos enviados')}; ${notTried + fail} na fila.`, 'warn', 8000);
    } else if (fail) {
      toast(`${plural(ok, 'arquivo enviado', 'arquivos enviados')}, ${fail} com erro. Os que falharam ficaram na fila com "!" (passe o mouse para ver o motivo).`, 'err', 12000);
    } else {
      toast(`${plural(ok, 'arquivo enviado', 'arquivos enviados')} com sucesso.`, 'ok', 6000);
    }
  }

  // ---------------------------------------------------------------- interface
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
button{font:inherit}
.fab{position:fixed;right:92px;bottom:72px;z-index:2147481000;display:inline-flex;align-items:center;gap:8px;font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#c2410c;background:#fff;border:1.5px solid #ea580c;border-radius:999px;padding:10px 15px;cursor:pointer;box-shadow:0 8px 24px rgba(234,88,12,.22)}
.fab:hover{background:#fff7ed}
.fab:focus-visible{outline:3px solid #fed7aa;outline-offset:2px}
.fab .badge{background:#ea580c;color:#fff;border-radius:999px;padding:3px 7px;font-size:11px;line-height:1}
.overlay{position:fixed;inset:0;z-index:2147482000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a}
.dlg{width:min(1480px,97vw);height:94vh;background:#f8fafc;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}
.hd{display:flex;align-items:center;gap:10px;padding:14px 18px;background:#fff;border-bottom:1px solid #e2e8f0}
.hd h2{margin:0;font-size:16px;font-weight:700}
.hd .sub{color:#64748b;font-size:12px;margin-top:2px}
.sp{flex:1}
.btn{font-weight:600;font-size:13px;border-radius:8px;padding:8px 12px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;cursor:pointer;white-space:nowrap}
.btn:hover:not(:disabled){background:#f1f5f9}
.btn.primary{background:#ea580c;border-color:#ea580c;color:#fff}
.btn.primary:hover:not(:disabled){background:#c2410c}
.btn.ghost{background:transparent}
.btn.sm{padding:5px 9px;font-size:12px}
.btn.icon{padding:6px 10px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.tray{margin:12px 18px 0;border:2px dashed #cbd5e1;border-radius:12px;background:#fff;padding:10px 12px;transition:border-color .12s,background .12s}
.tray.over{border-color:#ea580c;background:#fff7ed}
.tray-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tray-h .tt{font-weight:700}
.tray-h .ti{flex:1;min-width:240px;color:#64748b;font-size:12px}
.tray-h .ti b{color:#c2410c}
.tray-h .ta{display:flex;gap:6px;flex-wrap:wrap}
.tray .tg{margin-top:10px;max-height:30vh;overflow:auto;padding:2px}
.tray.empty .tg{display:none}
.tray .thumb.q{width:92px;height:92px}
.body{flex:1;min-height:0;overflow:auto;padding:6px 18px 18px}
.part{margin-top:14px}
.part-h{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:4px 2px 8px;border-bottom:1px solid #e2e8f0;margin-bottom:10px}
.part-h .pname{font-weight:700;font-size:14px}
.part-h .prole{font-size:11px;font-weight:600;color:#9a3412;background:#ffedd5;border-radius:999px;padding:2px 8px}
.part-h .pcount{color:#64748b;font-size:12px;margin-left:auto}
.chev{display:inline-block;color:#64748b;transition:transform .15s;width:12px}
.part.collapsed .chev{transform:rotate(-90deg)}
.part.collapsed .grid,.part.collapsed .pmsg{display:none}
.pmsg{color:#64748b;font-size:12.5px;padding:6px 2px 10px;display:flex;align-items:center;gap:10px}
.pmsg.err{color:#b91c1c}
.mini-spin{width:12px;height:12px;border:2px solid #fed7aa;border-top-color:#ea580c;border-radius:50%;animation:sp .8s linear infinite}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;align-items:start}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 1px 2px rgba(15,23,42,.04);transition:border-color .12s,box-shadow .12s;min-width:0}
.card.filled{border-color:#fdba74}
.card.over{border-color:#ea580c;box-shadow:0 0 0 3px rgba(234,88,12,.2)}
.card-h{min-width:0}
.card .ct{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px}
.card .qc{background:#ea580c;color:#fff;border-radius:999px;font-size:10.5px;padding:1px 7px;font-weight:700}
.card .cs{color:#64748b;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.card.disabled{background:#f1f5f9}
.card.disabled .ct{color:#64748b}
.card.minor{background:transparent;border-style:dashed;box-shadow:none;padding:8px}
.card.minor .ct{font-weight:600;color:#64748b;font-size:12px}
.card.minor .cs{font-size:11px}
.card.minor .drop{min-height:46px;padding:6px}
.card.minor .hint{font-size:11px}
.exrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:#475569}
.exrow.muted{color:#94a3b8}
.exthumbs{display:flex;gap:4px;flex-wrap:wrap}
.more{font-size:11px;color:#64748b;align-self:center}
.drop{border:1.5px dashed #cbd5e1;border-radius:10px;min-height:86px;padding:8px;display:flex;align-items:center;justify-content:center;background:#fcfcfd}
.drop[data-action]{cursor:pointer}
.drop[data-action]:hover{border-color:#fdba74;background:#fff7ed}
.drop.has{display:block}
.card.disabled .drop{background:#f8fafc}
.hint{color:#94a3b8;font-size:12px;text-align:center;line-height:1.5}
.hint u{color:#c2410c;text-decoration:none;font-weight:600}
.reason{font-size:11.5px;color:#b45309}
.movehere{font-size:12px;font-weight:600;color:#c2410c;background:#fff7ed;border:1.5px dashed #fb923c;border-radius:8px;padding:6px 8px;cursor:pointer}
.movehere:hover{background:#ffedd5}
.qgrid{display:flex;flex-wrap:wrap;gap:8px}
.thumb{position:relative;width:76px;height:76px;border-radius:8px;overflow:hidden;background:#e2e8f0;border:1px solid #cbd5e1;flex:none;user-select:none;display:block}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.thumb.q{cursor:grab}
.thumb.q:active{cursor:grabbing}
.thumb.dragging{opacity:.35}
.thumb.ins{box-shadow:-5px 0 0 0 #ea580c}
.thumb .tname{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(15,23,42,.8));color:#fff;font-size:9.5px;padding:12px 4px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.thumb .tb{position:absolute;top:3px;width:21px;height:21px;border-radius:999px;border:0;background:rgba(15,23,42,.72);color:#fff;font-size:13px;line-height:21px;padding:0;cursor:pointer;opacity:0;transition:opacity .12s;text-align:center}
.thumb .x{right:3px}
.thumb .zoom{left:3px}
.thumb:hover .tb{opacity:1}
.thumb.sel{outline:3px solid #ea580c;outline-offset:-3px}
.thumb.sel::after{content:"✓";position:absolute;right:4px;bottom:17px;width:18px;height:18px;border-radius:999px;background:#ea580c;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center}
.thumb.st-error{outline:3px solid #dc2626;outline-offset:-3px}
.errb{position:absolute;left:4px;bottom:17px;width:18px;height:18px;border-radius:999px;background:#dc2626;color:#fff;font-size:12px;font-weight:800;line-height:18px;text-align:center}
.thumb.st-uploading::before,.thumb.st-done::before{content:"";position:absolute;inset:0;background:rgba(255,255,255,.6)}
.spin{position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border:3px solid #fed7aa;border-top-color:#ea580c;border-radius:50%;animation:sp .8s linear infinite}
.done{position:absolute;left:50%;top:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:999px;background:#16a34a;color:#fff;font-size:16px;font-weight:800;line-height:28px;text-align:center}
@keyframes sp{to{transform:rotate(360deg)}}
.ficon{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#b91c1c;background:#fee2e2;font-size:13px;letter-spacing:.04em}
.ficon.img{color:#475569;background:#e2e8f0}
.thumb.ex{width:36px;height:36px;border-radius:6px}
.thumb.ex .ficon{font-size:9px}
.thumb.noimg img{display:none}
.thumb.noimg::before{content:"IMG";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:10px;color:#475569}
.addtile{width:76px;height:76px;border:1.5px dashed #cbd5e1;border-radius:8px;background:#fff;color:#94a3b8;font-size:24px;cursor:pointer;flex:none}
.addtile:hover{border-color:#fb923c;color:#ea580c}
.card .qgrid{gap:6px}
.card .thumb.q,.card .addtile{width:68px;height:68px}
.errline{font-size:11.5px;color:#b91c1c}
.empty-msg{color:#64748b;padding:40px;text-align:center}
.ft{display:flex;align-items:center;gap:10px;padding:12px 18px;background:#fff;border-top:1px solid #e2e8f0}
.ft .sum{flex:1;color:#334155;min-width:0}
.prog{width:220px;height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;display:none}
.prog.on{display:block}
.prog .bar{height:100%;width:0;background:#ea580c;transition:width .2s}
.lb{position:fixed;inset:0;z-index:5;background:rgba(2,6,23,.93);display:flex}
.lb-main{flex:1;display:flex;flex-direction:column;min-width:0}
.lb-media{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px}
.lb-media img{max-width:100%;max-height:100%;object-fit:contain;background:#fff;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.lb-media iframe{width:100%;height:100%;border:0;background:#fff;border-radius:6px}
.nopv{color:#e2e8f0;text-align:center;line-height:1.6}
.lb-bar{display:flex;align-items:center;justify-content:center;gap:12px;padding:0 16px 16px;color:#e2e8f0}
.lb-cap{font-size:12.5px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbn{color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px}
.lbn:hover{background:rgba(255,255,255,.2)}
.lb-side{width:310px;background:#fff;display:flex;flex-direction:column}
.lb-h{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;font-weight:700;border-bottom:1px solid #e2e8f0}
.lb-dest{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px}
.dpart{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.02em}
.dpart span{text-transform:none;font-weight:600;color:#9a3412}
.dbtn{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font-size:12.5px;padding:7px 9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;margin-top:5px;color:#0f172a}
.dbtn:hover{border-color:#fb923c;background:#fff7ed}
.dbtn.cur{border-color:#ea580c;background:#ffedd5;font-weight:700}
.dbtn.minor{color:#64748b;border-style:dashed}
.dbtn .k{flex:none;min-width:18px;height:18px;border-radius:5px;background:#f1f5f9;color:#475569;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.dbtn .n{margin-left:auto;color:#ea580c;font-weight:700;font-size:11px}
.lb-help{padding:10px 14px;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0;line-height:1.5}
.toasts{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.toast{pointer-events:auto;background:#0f172a;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:min(620px,90vw);transition:opacity .3s}
.toast.ok{background:#166534}
.toast.warn{background:#9a3412}
.toast.err{background:#991b1b}
.toast.out{opacity:0}
.ghost{position:fixed;top:-300px;left:-300px;padding:7px 11px;background:#ea580c;color:#fff;border-radius:8px;font:600 12px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
`;

  const CLIP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  const SKELETON = `
<button type="button" class="fab" data-action="open" hidden aria-label="Anexar arquivos aos documentos">${CLIP}<span>Anexar arquivos</span><span class="badge" hidden></span></button>
<div class="overlay" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-label="Anexar arquivos aos documentos">
    <div class="hd">
      <div><h2>Anexar arquivos aos documentos</h2><div class="sub"></div></div>
      <div class="sp"></div>
      <button type="button" class="btn" data-action="reload" title="Buscar de novo os documentos ativos de todas as partes">Recarregar</button>
      <button type="button" class="btn icon" data-action="close" title="Fechar (a fila continua guardada enquanto a página estiver aberta)">✕</button>
    </div>
    <div class="tray empty" data-target="tray">
      <div class="tray-h"><span class="tt">Bandeja</span><span class="ti"></span><span class="ta"></span></div>
      <div class="qgrid tg"></div>
    </div>
    <div class="body"></div>
    <div class="ft">
      <div class="sum"></div>
      <div class="prog"><div class="bar"></div></div>
      <button type="button" class="btn" data-action="cancel-save" hidden>Parar envio</button>
      <button type="button" class="btn ghost" data-action="clear-queue">Descartar fila</button>
      <button type="button" class="btn primary" data-action="save">Salvar</button>
    </div>
  </div>
  <div class="lb" hidden>
    <div class="lb-main">
      <div class="lb-media"></div>
      <div class="lb-bar">
        <button type="button" class="lbn" data-action="lb-prev">‹ Anterior</button>
        <span class="lb-cap"></span>
        <button type="button" class="lbn" data-action="lb-next">Próxima ›</button>
      </div>
    </div>
    <aside class="lb-side">
      <div class="lb-h"><span>Mover para</span><button type="button" class="btn icon" data-action="lb-close" title="Fechar (Esc)">✕</button></div>
      <div class="lb-dest"></div>
      <div class="lb-help">← → mudam de arquivo · 1–9 movem para o destino numerado · 0 devolve à bandeja · Delete tira da fila · Esc fecha</div>
    </aside>
  </div>
</div>
<div class="toasts" aria-live="polite"></div>
<div class="ghost"></div>
<input type="file" multiple hidden>`;

  let host = null;
  let root = null;
  const els = {};

  function ensureHost() {
    if (host && host.isConnected) return;
    if (!document.body) return;
    host = document.createElement('div');
    host.id = 'nca-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${SKELETON}`;
    const q = (s) => root.querySelector(s);
    Object.assign(els, {
      fab: q('.fab'),
      badge: q('.fab .badge'),
      overlay: q('.overlay'),
      sub: q('.hd .sub'),
      reload: q('[data-action="reload"]'),
      tray: q('.tray'),
      trayInfo: q('.tray .ti'),
      trayActions: q('.tray .ta'),
      trayGrid: q('.tray .tg'),
      body: q('.body'),
      sum: q('.ft .sum'),
      prog: q('.ft .prog'),
      bar: q('.ft .bar'),
      save: q('[data-action="save"]'),
      clear: q('[data-action="clear-queue"]'),
      cancel: q('[data-action="cancel-save"]'),
      lb: q('.lb'),
      lbMedia: q('.lb-media'),
      lbCap: q('.lb-cap'),
      lbDest: q('.lb-dest'),
      toasts: q('.toasts'),
      ghost: q('.ghost'),
      file: q('input[type=file]'),
    });
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('error', onImgError, true);
    els.overlay.addEventListener('dragover', onDragOver);
    els.overlay.addEventListener('dragleave', onDragLeave);
    els.overlay.addEventListener('drop', onDrop);
    els.overlay.addEventListener('mouseover', onHover);
    els.file.addEventListener('change', onFileChosen);
    document.body.appendChild(host);
    if (S.open) els.overlay.hidden = false;
    render();
  }

  function toast(msg, type, ms) {
    if (!els.toasts) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 4) els.toasts.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 350);
    }, ms || 4500);
  }

  // ---------- templates
  function thumbQ(it) {
    const sel = S.selected.has(it.id);
    const name = it.file.name || 'arquivo';
    const tip = `${name} · ${fmtSize(it.file.size)}`
      + (it.status === 'error' ? `\nErro: ${it.error}` : '')
      + (S.saving ? '' : '\nClique: selecionar · duplo clique: ver · arraste: mover');
    const media = it.preview
      ? `<img src="${esc(it.url)}" alt="">`
      : `<div class="ficon${it.img ? ' img' : ''}">${it.img ? 'IMG' : 'PDF'}</div>`;
    let state = '';
    if (it.status === 'uploading') state = '<span class="spin"></span>';
    else if (it.status === 'done') state = '<span class="done">✓</span>';
    else if (it.status === 'error') state = '<span class="errb">!</span>';
    const tools = S.saving ? '' :
      `<button type="button" class="tb zoom" data-action="preview" data-item="${it.id}" title="Ver">⤢</button>`
      + `<button type="button" class="tb x" data-action="remove" data-item="${it.id}" title="Tirar da fila">×</button>`;
    return `<div class="thumb q st-${it.status}${sel ? ' sel' : ''}" draggable="${S.saving ? 'false' : 'true'}" data-item="${it.id}" title="${esc(tip)}">${media}<span class="tname">${esc(name)}</span>${state}${tools}</div>`;
  }

  function thumbEx(f) {
    const media = f.img && f.thumb
      ? `<img src="${esc(f.thumb)}" alt="" loading="lazy" draggable="false">`
      : `<div class="ficon${f.img ? ' img' : ''}">${f.img ? 'IMG' : 'PDF'}</div>`;
    return `<a class="thumb ex" href="${esc(f.url)}" target="_blank" rel="noopener" draggable="false" title="${esc(f.name)} (já anexado — clique para abrir)">${media}</a>`;
  }

  function selectionElsewhere(key) {
    if (!S.selected.size) return false;
    for (const id of S.selected) {
      const it = findItem(id);
      if (it && it.target !== key) return true;
    }
    return false;
  }

  function card(t) {
    const q = S.items.filter((i) => i.target === t.key);
    const nSel = S.selected.size;
    const showMove = !S.saving && t.enabled && selectionElsewhere(t.key);
    const accept = t.onlyImages ? 'imagens' : 'imagens ou PDF';
    let ex = '';
    if (t.existing.length) {
      const shown = t.existing.slice(0, 12).map(thumbEx).join('');
      const more = t.existing.length > 12 ? `<span class="more">+${t.existing.length - 12}</span>` : '';
      ex = `<div class="exrow"><span>${plural(t.existing.length, 'arquivo anexado', 'arquivos anexados')}</span><div class="exthumbs">${shown}${more}</div></div>`;
    } else if (t.kind === 'doc') {
      ex = '<div class="exrow muted">Nenhum arquivo anexado ainda</div>';
    }
    let drop;
    if (q.length) {
      const add = S.saving ? '' : `<button type="button" class="addtile" data-action="pick" data-target="${t.key}" title="Escolher mais arquivos">+</button>`;
      drop = `<div class="drop has" data-target="${t.key}"><div class="qgrid">${q.map(thumbQ).join('')}${add}</div></div>`;
    } else {
      const clickable = t.enabled && !S.saving;
      const hint = t.enabled ? `Arraste ${accept} aqui<br>ou <u>clique para escolher</u>` : 'Indisponível';
      drop = `<div class="drop" data-target="${t.key}"${clickable ? ` data-action="pick"` : ''}><div class="hint">${hint}</div></div>`;
    }
    const errs = q.filter((i) => i.status === 'error');
    const errLine = errs.length
      ? `<div class="errline">${plural(errs.length, 'arquivo', 'arquivos')} com erro: ${esc(errs[0].error)}</div>`
      : '';
    const cls = ['card'];
    if (!t.enabled) cls.push('disabled');
    if (t.kind === 'part') cls.push('minor');
    if (q.length) cls.push('filled');
    return `<section class="${cls.join(' ')}" data-target="${t.key}">`
      + `<header class="card-h"><div class="ct">${esc(t.title)}${q.length ? `<span class="qc">${q.length}</span>` : ''}</div>`
      + `${t.subtitle ? `<div class="cs" title="${esc(t.subtitle)}">${esc(t.subtitle)}</div>` : ''}</header>`
      + (showMove ? `<button type="button" class="movehere" data-action="move-here" data-target="${t.key}">Mover ${plural(nSel, 'selecionado', 'selecionados')} para cá</button>` : '')
      + ex + drop + errLine
      + (t.enabled ? '' : `<div class="reason">${esc(t.reason)}</div>`)
      + '</section>';
  }

  function partBlock(p) {
    const collapsed = S.collapsed.has(p.id);
    const docs = p.targets || [];
    const queued = S.items.filter((i) => i.target !== 'tray' && i.target.split(':')[1] === p.id).length;
    const retry = `<button type="button" class="btn sm" data-action="retry-part" data-part="${p.id}">Tentar de novo</button>`;
    let inner;
    if (!p.loaded && p.error) {
      inner = `<div class="pmsg err">Erro ao carregar: ${esc(p.error)} ${retry}</div>`;
    } else if (!p.loaded) {
      inner = '<div class="pmsg"><span class="mini-spin"></span> Carregando documentos…</div>';
    } else {
      inner = (p.error ? `<div class="pmsg err">Falha ao atualizar: ${esc(p.error)} ${retry}</div>` : '')
        + (docs.length ? '' : '<div class="pmsg">Nenhum documento ativo nesta parte.</div>')
        + `<div class="grid">${docs.map(card).join('')}${p.partTarget ? card(p.partTarget) : ''}</div>`;
    }
    const info = p.loaded
      ? plural(docs.length, 'documento ativo', 'documentos ativos') + (queued ? ` · ${queued} na fila` : '')
      : '';
    return `<div class="part${collapsed ? ' collapsed' : ''}" data-part="${p.id}">`
      + `<div class="part-h" data-action="toggle-part" data-part="${p.id}" title="Clique para recolher/expandir">`
      + `<span class="chev">▾</span><span class="pname">${esc(p.name)}</span>`
      + (p.role ? `<span class="prole">${esc(p.role)}</span>` : '')
      + (p.loading && p.loaded ? '<span class="mini-spin"></span>' : '')
      + `<span class="pcount">${info}</span></div>${inner}</div>`;
  }

  // ---------- render
  function updateFab() {
    if (!els.fab) return;
    els.fab.hidden = !currentProcessId();
    const n = S.items.length;
    els.badge.hidden = !n;
    els.badge.textContent = String(n);
    // empilha acima dos botões dos outros scripts (Cadastro unificado, Importar ficha, ...)
    let bottom = 24;
    try {
      let minTop = Infinity;
      document.querySelectorAll('[id$="-fab-host"]').forEach((h) => {
        if (h === host || h.hidden || !h.shadowRoot) return;
        h.shadowRoot.querySelectorAll('.fab, button').forEach((b) => {
          if (getComputedStyle(b).position !== 'fixed') return;
          const r = b.getBoundingClientRect();
          if (r.height > 0 && r.right > window.innerWidth - 400) minTop = Math.min(minTop, r.top);
        });
      });
      if (minTop !== Infinity) bottom = Math.max(24, Math.round(window.innerHeight - minTop) + 10);
    } catch (_) { /* sem outros scripts */ }
    els.fab.style.bottom = bottom + 'px';
  }

  function renderHeader() {
    const c = S.ctx || {};
    els.sub.textContent = [
      c.processCode && `Ato ${c.processCode}`,
      c.protocolCode && `Serviço ${c.protocolCode}`,
      plural(S.parts.length, 'parte', 'partes'),
      'só documentos ativos',
    ].filter(Boolean).join(' · ');
    els.reload.disabled = S.saving;
  }

  function renderTray() {
    const q = S.items.filter((i) => i.target === 'tray');
    els.tray.classList.toggle('empty', !q.length);
    els.trayInfo.innerHTML = q.length
      ? `<b>${q.length}</b> na bandeja. Arraste para o documento certo (clique para selecionar vários, duplo clique para ver e distribuir um por um).`
      : 'Solte aqui vários arquivos ou uma pasta de uma vez (ou cole com Ctrl+V) e depois distribua entre os documentos. Também dá para soltar direto em cada documento.';
    let actions = '';
    if (S.selected.size && !S.saving) {
      actions += `<button type="button" class="btn sm" data-action="clear-sel">Limpar seleção (${S.selected.size})</button>`;
      if (selectionElsewhere('tray')) actions += '<button type="button" class="btn sm" data-action="move-here" data-target="tray">Devolver à bandeja</button>';
    }
    actions += `<button type="button" class="btn sm" data-action="pick" data-target="tray"${S.saving ? ' disabled' : ''}>Escolher arquivos…</button>`;
    els.trayActions.innerHTML = actions;
    els.trayGrid.innerHTML = q.map(thumbQ).join('');
  }

  function renderBody() {
    const st = els.body.scrollTop;
    els.body.innerHTML = S.parts.length
      ? S.parts.map(partBlock).join('')
      : '<div class="empty-msg">Não encontrei as partes deste ato. Abra o ato pela tela de uma das partes e tente de novo.</div>';
    els.body.scrollTop = st;
  }

  function renderFooter() {
    const toSend = S.items.filter((i) => i.target !== 'tray' && i.status !== 'done');
    const nDocs = new Set(toSend.map((i) => i.target)).size;
    const inTray = S.items.filter((i) => i.target === 'tray').length;
    const errs = S.items.filter((i) => i.status === 'error').length;
    if (S.saving) {
      const p = S.progress;
      els.sum.textContent = S.refreshing
        ? 'Atualizando a lista de arquivos…'
        : `Enviando ${Math.min(p.done + 1, p.total)} de ${p.total}…${p.fail ? ` (${p.fail} com erro)` : ''}`;
      els.bar.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + '%';
    } else {
      const bits = [toSend.length
        ? `${plural(toSend.length, 'arquivo', 'arquivos')} para enviar em ${plural(nDocs, 'destino', 'destinos')}`
        : 'Nenhum arquivo na fila'];
      if (errs) bits.push(`${errs} com erro`);
      if (inTray) bits.push(`${inTray} na bandeja (não ${inTray === 1 ? 'será enviado' : 'serão enviados'})`);
      els.sum.textContent = bits.join(' · ');
      els.bar.style.width = '0%';
    }
    els.prog.classList.toggle('on', S.saving);
    els.save.disabled = S.saving || !toSend.length;
    els.save.textContent = S.saving ? 'Enviando…' : toSend.length ? `Salvar ${plural(toSend.length, 'arquivo', 'arquivos')}` : 'Salvar';
    els.clear.disabled = S.saving || !S.items.length;
    els.cancel.hidden = !S.saving;
    els.cancel.disabled = S.cancel || S.refreshing;
  }

  function render() {
    if (!root) return;
    updateFab();
    if (!S.open) return;
    renderHeader();
    renderTray();
    renderBody();
    renderFooter();
    if (!els.lb.hidden) renderLb();
  }

  // ---------- visualizar e distribuir (lightbox)
  const lbList = () => S.items.filter((i) => i.target === LB.scope);

  function preview(id) {
    const it = findItem(id);
    if (!it) return;
    LB.scope = it.target;
    LB.id = id;
    LB.shown = null;
    els.lb.hidden = false;
    renderLb();
  }

  function closePreview() {
    if (!els.lb) return;
    els.lb.hidden = true;
    els.lbMedia.innerHTML = '';
    LB.id = null;
    LB.shown = null;
  }

  function renderLb() {
    const list = lbList();
    if (!list.length) {
      closePreview();
      return;
    }
    let idx = list.findIndex((i) => i.id === LB.id);
    if (idx < 0) {
      idx = Math.min(LB.idx || 0, list.length - 1);
      LB.id = list[idx].id;
    }
    LB.idx = idx;
    const it = list[idx];
    if (LB.shown !== it.id) {
      LB.shown = it.id;
      els.lbMedia.innerHTML = it.preview
        ? `<img src="${esc(it.url)}" alt="">`
        : it.img
          ? `<div class="nopv">Pré-visualização indisponível para este formato.<br>${esc(it.file.name)}</div>`
          : `<iframe src="${esc(it.url)}" title="${esc(it.file.name)}"></iframe>`;
    }
    els.lbCap.textContent = `${idx + 1} de ${list.length} · ${it.file.name} · ${fmtSize(it.file.size)} · está em: ${targetLabel(it.target)}`;

    LB.dest = [];
    let html = '';
    for (const p of S.parts) {
      const ts = [...(p.targets || []), ...(p.partTarget ? [p.partTarget] : [])]
        .filter((t) => t.enabled && (!t.onlyImages || it.img));
      if (!ts.length) continue;
      html += `<div><div class="dpart">${esc(p.name)}${p.role ? ` · <span>${esc(p.role)}</span>` : ''}</div>`;
      for (const t of ts) {
        LB.dest.push(t.key);
        const k = LB.dest.length;
        const n = S.items.filter((i) => i.target === t.key).length;
        html += `<button type="button" class="dbtn${t.key === it.target ? ' cur' : ''}${t.kind === 'part' ? ' minor' : ''}" data-action="lb-move" data-target="${t.key}">`
          + `<span class="k">${k <= 9 ? k : ''}</span><span>${esc(t.title)}</span>${n ? `<span class="n">${n}</span>` : ''}</button>`;
      }
      html += '</div>';
    }
    html += `<div><button type="button" class="dbtn${it.target === 'tray' ? ' cur' : ''}" data-action="lb-move" data-target="tray"><span class="k">0</span><span>Bandeja</span></button></div>`;
    els.lbDest.innerHTML = html;
  }

  function lbNav(d) {
    const list = lbList();
    if (!list.length) return closePreview();
    LB.idx = (LB.idx + d + list.length) % list.length;
    LB.id = list[LB.idx].id;
    renderLb();
  }

  function lbMove(key) {
    const it = findItem(LB.id);
    if (!it || !key || key === it.target) return;
    const scope = LB.scope;
    moveItems([it.id], key);
    if (it.target === scope) return; // não foi movido (destino recusou)
    LB.id = null; // renderLb pega o próximo na mesma posição
    if (!lbList().length) {
      closePreview();
      toast(scope === 'tray' ? 'Bandeja vazia: tudo distribuído.' : 'Não há mais arquivos aqui.', 'ok');
      return;
    }
    renderLb();
  }

  // ---------- eventos
  function onClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      e.preventDefault();
      if (!btn.disabled) act(btn.dataset.action, btn);
      return;
    }
    const thumb = e.target.closest('.thumb.q');
    if (thumb) {
      if (!S.saving) {
        const id = thumb.dataset.item;
        if (S.selected.has(id)) S.selected.delete(id);
        else S.selected.add(id);
        render();
      }
      return;
    }
    const a = e.target.closest('[data-action]');
    if (a) act(a.dataset.action, a);
  }

  function onDblClick(e) {
    const thumb = e.target.closest('.thumb.q');
    if (thumb && !S.saving) preview(thumb.dataset.item);
  }

  function act(action, el) {
    switch (action) {
      case 'open': openPanel(); break;
      case 'close': closePanel(); break;
      case 'reload': if (!S.saving) loadAll(); break;
      case 'save': save(); break;
      case 'cancel-save': S.cancel = true; render(); break;
      case 'clear-queue': clearQueue(); break;
      case 'pick': pick(el.dataset.target || 'tray'); break;
      case 'remove': removeItems([el.dataset.item]); break;
      case 'preview': preview(el.dataset.item); break;
      case 'toggle-part': {
        const id = el.dataset.part;
        if (S.collapsed.has(id)) S.collapsed.delete(id);
        else S.collapsed.add(id);
        render();
        break;
      }
      case 'retry-part': {
        const p = S.parts.find((x) => x.id === el.dataset.part);
        if (p) loadPart(p);
        break;
      }
      case 'clear-sel': S.selected.clear(); render(); break;
      case 'move-here': moveItems(S.items.filter((i) => S.selected.has(i.id)).map((i) => i.id), el.dataset.target); break;
      case 'lb-close': closePreview(); break;
      case 'lb-prev': lbNav(-1); break;
      case 'lb-next': lbNav(1); break;
      case 'lb-move': lbMove(el.dataset.target); break;
      default: break;
    }
  }

  function pick(key) {
    if (S.saving) return;
    const t = targetOf(key);
    if (key !== 'tray' && (!t || !t.enabled)) {
      toast((t && t.reason) || 'Destino indisponível.', 'warn', 7000);
      return;
    }
    S.pickTarget = key;
    els.file.accept = t && t.onlyImages ? 'image/*' : 'image/*,application/pdf,.pdf';
    els.file.value = '';
    els.file.click();
  }

  function onFileChosen() {
    const files = Array.from(els.file.files || []);
    els.file.value = '';
    if (files.length) addFiles(files, S.pickTarget);
  }

  function onImgError(e) {
    const t = e.target;
    if (t && t.tagName === 'IMG') {
      const th = t.closest('.thumb');
      if (th) th.classList.add('noimg');
    }
  }

  function onHover(e) {
    const c = e.target.closest ? e.target.closest('.card[data-target]') : null;
    S.hoverTarget = c ? c.dataset.target : null;
  }

  // arrastar e soltar
  let hlEl = null;
  let insEl = null;
  function setHl(el, ins) {
    if (hlEl !== el) {
      if (hlEl) hlEl.classList.remove('over');
      hlEl = el;
      if (hlEl) hlEl.classList.add('over');
    }
    if (insEl !== ins) {
      if (insEl) insEl.classList.remove('ins');
      insEl = ins;
      if (insEl) insEl.classList.add('ins');
    }
  }
  function zoneFrom(e) {
    const z = e.target && e.target.closest ? e.target.closest('[data-target]') : null;
    return z && els.overlay.contains(z) && !els.lb.contains(z) ? z : null;
  }
  const hasFiles = (dt) => !!dt && Array.from(dt.types || []).indexOf('Files') !== -1;

  function onDragStart(e) {
    const th = e.target && e.target.closest ? e.target.closest('.thumb.q') : null;
    if (!th) return;
    if (S.saving) {
      e.preventDefault();
      return;
    }
    const id = th.dataset.item;
    const ids = S.selected.has(id) ? S.items.filter((i) => S.selected.has(i.id)).map((i) => i.id) : [id];
    S.drag = ids;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('application/x-nca', ids.join(',')); } catch (_) { /* ok */ }
    if (ids.length > 1) {
      els.ghost.textContent = `${ids.length} arquivos`;
      try { e.dataTransfer.setDragImage(els.ghost, 14, 14); } catch (_) { /* ok */ }
    }
    root.querySelectorAll('.thumb.q').forEach((t) => {
      if (ids.indexOf(t.dataset.item) !== -1) t.classList.add('dragging');
    });
  }

  function onDragEnd() {
    S.drag = null;
    setHl(null, null);
    if (root) root.querySelectorAll('.thumb.dragging').forEach((t) => t.classList.remove('dragging'));
  }

  function onDragOver(e) {
    if (!S.open) return;
    const internal = !!S.drag;
    if (!internal && !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (S.saving) {
      e.dataTransfer.dropEffect = 'none';
      setHl(null, null);
      return;
    }
    const z = zoneFrom(e);
    const key = z ? z.dataset.target : 'tray';
    const t = targetOf(key);
    const ok = key === 'tray' || !!(t && t.enabled);
    const box = z ? z.closest('.card') || z.closest('.tray') || els.tray : els.tray;
    const th = z ? e.target.closest('.thumb.q') : null;
    e.dataTransfer.dropEffect = ok ? (internal ? 'move' : 'copy') : 'none';
    setHl(ok ? box : null, ok ? th : null);
  }

  function onDragLeave(e) {
    if (!e.relatedTarget) setHl(null, null);
  }

  function onDrop(e) {
    if (!S.open) return;
    const internal = S.drag;
    const dt = e.dataTransfer;
    if (!internal && !hasFiles(dt)) return;
    e.preventDefault();
    e.stopPropagation();
    setHl(null, null);
    if (S.saving) return;
    const z = zoneFrom(e);
    const key = z ? z.dataset.target : 'tray';
    const th = z ? e.target.closest('.thumb.q') : null;
    const beforeId = th ? th.dataset.item : null;
    if (internal) {
      S.drag = null;
      moveItems(internal, key, beforeId);
      return;
    }
    collectDropped(dt).then((files) => {
      if (!files.length) return;
      const n = addFiles(files, key, beforeId);
      if (n && !z) toast(`${plural(n, 'arquivo foi', 'arquivos foram')} para a bandeja.`, 'info');
    });
  }

  // aceita pastas (lê os arquivos dentro delas)
  function collectDropped(dt) {
    const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
    const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
    if (entries.length && entries.every(Boolean) && entries.some((en) => en.isDirectory)) return readEntries(entries);
    return Promise.resolve(Array.from(dt.files || []));
  }
  async function readEntries(entries) {
    const out = [];
    const fileOf = (en) => new Promise((res) => en.file(res, () => res(null)));
    const readDir = (dir) => new Promise((res) => {
      const reader = dir.createReader();
      const acc = [];
      const step = () => reader.readEntries((batch) => {
        if (!batch.length) return res(acc);
        acc.push(...batch);
        step();
      }, () => res(acc));
      step();
    });
    const walk = async (en, depth) => {
      if (en.isFile) {
        const f = await fileOf(en);
        if (f) out.push(f);
      } else if (en.isDirectory && depth < 5) {
        for (const child of await readDir(en)) await walk(child, depth + 1);
      }
    };
    for (const en of entries) await walk(en, 0);
    return out;
  }

  // colar (Ctrl+V): vai para o cartão sob o mouse, senão para a bandeja
  function onPaste(e) {
    if (!S.open || S.saving) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const named = files.map((f, i) => {
      if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
      const ext = ((f.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], `colado-${stamp}${files.length > 1 ? '-' + (i + 1) : ''}.${ext}`, { type: f.type, lastModified: Date.now() });
    });
    let key = S.hoverTarget || 'tray';
    const t = targetOf(key);
    if (key !== 'tray' && (!t || !t.enabled)) key = 'tray';
    const n = addFiles(named, key);
    if (n) toast(`${plural(n, 'arquivo colado', 'arquivos colados')} em: ${targetLabel(key)}.`, 'ok');
  }

  function onKey(e) {
    if (!S.open) return;
    const tg = e.target;
    if (tg && tg !== host && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ''))) return;
    const lbOpen = !els.lb.hidden;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (lbOpen) closePreview();
      else if (S.selected.size) {
        S.selected.clear();
        render();
      } else closePanel();
      return;
    }
    if (lbOpen && !S.saving) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        lbNav(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        lbMove(e.key === '0' ? 'tray' : LB.dest[Number(e.key) - 1]);
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        if (LB.id) removeItems([LB.id]);
        return;
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected.size && !S.saving) {
      e.preventDefault();
      e.stopPropagation();
      removeItems([...S.selected]);
    }
  }

  function onBeforeUnload(e) {
    if (!S.items.length) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  // ---------- abrir / fechar
  let prevOverflow = '';

  async function openPanel() {
    ensureHost();
    const ctx = getContext();
    if (!ctx) {
      toast('Abra um ato (serviço) do NoCartório para anexar arquivos.', 'warn');
      return;
    }
    if (S.ctx && S.ctx.processId !== ctx.processId) {
      if (S.items.length && !confirm(`Há ${plural(S.items.length, 'arquivo', 'arquivos')} na fila de outro ato${S.ctx.processCode ? ` (${S.ctx.processCode})` : ''}.\n\nDescartar a fila e abrir este ato?`)) return;
      resetQueue();
      S.parts = [];
      S.collapsed.clear();
    }
    S.ctx = ctx;
    syncParts(ctx);
    S.open = true;
    els.overlay.hidden = false;
    try {
      const a = document.activeElement;
      if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    } catch (_) { /* ok */ }
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    rebuildTargets();
    render();
    if (!ctx.parts.length) toast('Não encontrei as partes deste ato.', 'warn');
    await loadAll();
  }

  function closePanel(force) {
    if (S.saving && !force) {
      toast('Aguarde o envio terminar (ou clique em "Parar envio").', 'warn');
      return;
    }
    closePreview();
    S.open = false;
    S.selected.clear();
    setHl(null, null);
    if (els.overlay) els.overlay.hidden = true;
    document.documentElement.style.overflow = prevOverflow || '';
    render();
    if (S.items.length && !force) {
      toast(`A fila ficou guardada (${plural(S.items.length, 'arquivo', 'arquivos')}). Abra o painel de novo para continuar.`, 'info', 6000);
    }
  }

  // ---------- ciclo de vida
  function tick() {
    ensureHost();
    updateFab();
    // saiu do ato com o painel aberto (voltar do navegador etc.)
    if (S.open && !S.saving && S.ctx && currentProcessId() !== S.ctx.processId) closePanel(true);
  }

  document.addEventListener('paste', onPaste, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  const timer = setInterval(tick, 800);
  tick();

  window.__nca = {
    version: VERSION,
    state: S,
    destroy() {
      clearInterval(timer);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (S.open) document.documentElement.style.overflow = prevOverflow || '';
      resetQueue();
      if (host) host.remove();
      delete window.__nca;
    },
  };
})();