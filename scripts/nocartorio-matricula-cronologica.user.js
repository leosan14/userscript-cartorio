// ==UserScript==
// @name         NoCartório – Matrícula em ordem cronológica
// @namespace    cartorio-sja
// @version      1.3.0
// @description  Mostra todos os atos de uma matrícula (Registro Geral) em ordem cronológica, num texto corrido, com opção de imprimir e copiar e zoom estilo leitor de PDF (50%–400% e largura da folha).
// @author       Leonardo Santos Oliveira
// @match        https://app.nocartorio.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://leosan14.github.io/userscript-cartorio/
// @updateURL    https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-matricula-cronologica.user.js
// @downloadURL  https://leosan14.github.io/userscript-cartorio/scripts/nocartorio-matricula-cronologica.user.js
// ==/UserScript==

(function () {
  'use strict';

  const PATH = '/admin/manager/v2/ri-general-registry-book';
  const ID = 'ncc-crono';

  // ---------- estilos ----------
  const css = `
  #${ID}-btn{position:fixed;right:20px;bottom:90px;z-index:99998;background:#f26a1b;color:#fff;border:0;
    border-radius:999px;padding:10px 16px;font:600 13px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
  #${ID}-btn:hover{filter:brightness(1.08)}
  #${ID}-ov{position:fixed;inset:0;z-index:99999;background:rgba(30,30,30,.65);display:flex;flex-direction:column}
  #${ID}-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:#1f1f1f;color:#eee;
    font:13px system-ui,sans-serif}
  #${ID}-bar b{font-size:14px;margin-right:auto}
  #${ID}-bar button,#${ID}-bar label{background:#333;color:#eee;border:1px solid #555;border-radius:6px;padding:6px 10px;
    font:inherit;cursor:pointer}
  #${ID}-bar button:hover{background:#444}
  #${ID}-bar .${ID}-grp{display:inline-flex;align-items:center;gap:0;border:1px solid #555;border-radius:6px;overflow:hidden}
  #${ID}-bar .${ID}-grp button{border:0;border-radius:0;padding:6px 9px;min-width:30px}
  #${ID}-bar .${ID}-grp [data-a="zmenu"]{min-width:72px;font-variant-numeric:tabular-nums;border-left:1px solid #555;border-right:1px solid #555}
  .${ID}-zwrap{position:relative;display:inline-flex}
  .${ID}-menu{position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:2;min-width:190px;
    background:#2b2b2b;border:1px solid #555;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:6px 0;
    font:13px system-ui,sans-serif}
  .${ID}-menu[hidden]{display:none}
  #${ID}-bar .${ID}-menu button{display:block;width:100%;text-align:left;border:0;border-radius:0;background:none;
    padding:7px 14px 7px 34px;position:relative}
  #${ID}-bar .${ID}-menu button:hover{background:#3d3d3d}
  #${ID}-bar .${ID}-menu button.on::before{content:'✓';position:absolute;left:13px}
  .${ID}-menu hr{border:0;border-top:1px solid #444;margin:6px 0}
  #${ID}-scroll{flex:1;overflow:auto;padding:24px 12px}
  .${ID}-page{background:#fff;color:#000;max-width:var(--${ID}-w,800px);box-sizing:border-box;margin:0 auto;padding:48px 56px;box-shadow:0 2px 12px rgba(0,0,0,.4);
    font:14px/1.5 Arial,Helvetica,sans-serif;text-align:justify}
  .${ID}-page p{margin:0}
  .${ID}-txt,.${ID}-mat{zoom:var(--${ID}-z,1)}
  .${ID}-ato{padding:6px 0 10px;border-bottom:1px dashed #bbb;margin-bottom:10px}
  .${ID}-ato:last-child{border-bottom:0}
  .${ID}-meta{font:11px system-ui,sans-serif;color:#888;margin-bottom:4px;text-align:left;user-select:none}
  .${ID}-meta a{color:#f26a1b;text-decoration:none}
  .${ID}-mat{font:700 16px system-ui,sans-serif;margin:0 0 12px;text-align:left}
  .${ID}-sep{height:24px}
  .${ID}-hidemeta .${ID}-meta{display:none}
  .${ID}-hidemeta .${ID}-ato{border-bottom:0;padding:0;margin-bottom:6px}
  `;

  function addStyle() {
    if (document.getElementById(ID + '-css')) return;
    const s = document.createElement('style');
    s.id = ID + '-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---------- botão ----------
  function syncButton() {
    const onPage = location.pathname.startsWith(PATH);
    let btn = document.getElementById(ID + '-btn');
    if (onPage && !btn) {
      addStyle();
      btn = document.createElement('button');
      btn.id = ID + '-btn';
      btn.textContent = '⇅ Ordem cronológica';
      btn.title = 'Ver todos os atos desta busca em ordem cronológica';
      btn.addEventListener('click', open);
      document.body.appendChild(btn);
    } else if (!onPage && btn) {
      btn.remove();
    }
  }
  setInterval(syncButton, 1000);
  syncButton();

  // ---------- dados (Inertia) ----------
  function inertiaVersion() {
    try { if (history.state && history.state.page) return history.state.page.version || ''; } catch (e) {}
    const el = document.querySelector('[data-page]');
    try { return el ? JSON.parse(el.dataset.page).version || '' : ''; } catch (e) { return ''; }
  }

  async function fetchPage(n) {
    const u = new URL(location.href);
    u.searchParams.set('page', String(n));
    const r = await fetch(u.toString(), {
      credentials: 'same-origin',
      headers: {
        'X-Inertia': 'true',
        'X-Inertia-Version': inertiaVersion(),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html, application/xhtml+xml',
      },
    });
    if (r.status === 409) throw new Error('A versão do sistema mudou. Recarregue a página (F5) e tente de novo.');
    if (!r.ok) throw new Error('Erro HTTP ' + r.status);
    const j = await r.json();
    return j.props.entries;
  }

  async function fetchAll(onProgress) {
    const first = await fetchPage(1);
    let all = first.data.slice();
    const last = (first.meta && first.meta.last_page) || 1;
    const total = (first.meta && first.meta.total) || all.length;
    if (total > 400 && !confirm(`A busca atual tem ${total} registros. Carregar todos mesmo assim?`)) return null;
    for (let p = 2; p <= last; p++) {
      onProgress && onProgress(p, last);
      const pg = await fetchPage(p);
      all = all.concat(pg.data);
    }
    return all;
  }

  // ---------- sanitização simples do HTML do ato ----------
  function clean(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) el.removeAttribute(a.name);
      });
    });
    return doc.body.firstChild.innerHTML;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- montagem ----------
  function build(entries, asc) {
    // agrupa por matrícula (caso a busca traga mais de uma)
    const groups = new Map();
    entries.forEach(e => {
      const k = e.property_registry_number;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    const keys = [...groups.keys()].sort((a, b) => a - b);
    const multi = keys.length > 1;

    return keys.map(k => {
      const list = groups.get(k).sort((a, b) => asc ? a.index - b.index : b.index - a.index);
      const atos = list.map(e => `
        <div class="${ID}-ato">
          <div class="${ID}-meta">Índice ${esc(e.index)} · ${esc(e.number_label)}${e.number ? ' ' + esc(e.number) : ''}
            · registrado em ${esc(e.registered_at)}
            ${e.process && e.process.url
              ? ` · Ato <a href="${esc(e.process.url)}" target="_blank" rel="noopener" title="Abrir o serviço que gerou este ato">${esc(e.process.code)}</a>`
              : ''}</div>
          <div class="${ID}-txt">${clean(e.draft_html)}</div>
        </div>`).join('');
      return `<div class="${ID}-page">${multi ? `<div class="${ID}-mat">Matrícula ${esc(k)}</div>` : ''}${atos}</div>`;
    }).join(`<div class="${ID}-sep"></div>`);
  }

  // ---------- zoom e largura (lembrados neste navegador) ----------
  // Funciona como o zoom do leitor de PDF: menu com percentuais e larguras, e lupas −/+ que andam pelos percentuais.
  const PREF_KEY = ID + '-prefs';
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const LARGURAS = { padrao: ['Largura padrão', '912px'], larga: ['Largura ampla', '1300px'], janela: ['Largura da janela', 'none'] };
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) {}
    const z = ZOOMS.includes(Number(p.z)) ? Number(p.z) : 1;
    const w = LARGURAS[p.w] ? p.w : 'padrao';
    return { z, w };
  }
  function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {} }
  function stepZoom(z, dir) {
    if (dir > 0) return ZOOMS.find(v => v > z + 1e-9) || ZOOMS[ZOOMS.length - 1];
    return [...ZOOMS].reverse().find(v => v < z - 1e-9) || ZOOMS[0];
  }

  // ---------- overlay ----------
  async function open() {
    close();
    addStyle();
    const ov = document.createElement('div');
    ov.id = ID + '-ov';
    ov.innerHTML = `
      <div id="${ID}-bar">
        <b>Matrícula em ordem cronológica</b>
        <span id="${ID}-info">Carregando…</span>
        <span class="${ID}-zwrap">
          <span class="${ID}-grp">
            <button data-a="z-" title="Diminuir zoom (Ctrl + roda do mouse)">−</button><button data-a="zmenu" title="Zoom e largura" aria-haspopup="true"><span data-v="z"></span> ▾</button><button data-a="z+" title="Aumentar zoom (Ctrl + roda do mouse)">+</button>
          </span>
          <span class="${ID}-menu" role="menu" hidden>
            ${Object.entries(LARGURAS).map(([k, [nome]]) => `<button data-a="w" data-w="${k}" role="menuitemradio">${nome}</button>`).join('')}
            <hr>
            ${ZOOMS.map(z => `<button data-a="z" data-z="${z}" role="menuitemradio">${Math.round(z * 100)}%</button>`).join('')}
          </span>
        </span>
        <button data-a="ord">Inverter ordem</button>
        <button data-a="meta">Ocultar índices</button>
        <button data-a="copy">Copiar texto</button>
        <button data-a="print">Imprimir</button>
        <button data-a="close">Fechar ✕</button>
      </div>
      <div id="${ID}-scroll"></div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';

    const info = ov.querySelector('#' + ID + '-info');
    const scroll = ov.querySelector('#' + ID + '-scroll');
    let asc = true, entries = [];
    const prefs = loadPrefs();
    const menu = ov.querySelector('.' + ID + '-menu');
    const applyPrefs = () => {
      scroll.style.setProperty('--' + ID + '-z', String(prefs.z));
      scroll.style.setProperty('--' + ID + '-w', LARGURAS[prefs.w][1]);
      ov.querySelector('[data-v="z"]').textContent = Math.round(prefs.z * 100) + '%';
      ov.querySelector('[data-a="z-"]').disabled = prefs.z <= ZOOMS[0];
      ov.querySelector('[data-a="z+"]').disabled = prefs.z >= ZOOMS[ZOOMS.length - 1];
      menu.querySelectorAll('[data-z]').forEach(b => b.classList.toggle('on', Number(b.dataset.z) === prefs.z));
      menu.querySelectorAll('[data-w]').forEach(b => b.classList.toggle('on', b.dataset.w === prefs.w));
      savePrefs(prefs);
    };
    applyPrefs();
    const outside = ev => { if (!ev.target.closest('.' + ID + '-zwrap')) menu.hidden = true; };
    ov.addEventListener('mousedown', outside);
    scroll.addEventListener('wheel', ev => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      prefs.z = stepZoom(prefs.z, ev.deltaY < 0 ? 1 : -1);
      applyPrefs();
    }, { passive: false });

    const render = () => {
      scroll.innerHTML = build(entries, asc);
      info.textContent = `${entries.length} ato(s) · ${asc ? 'mais antigo → mais recente' : 'mais recente → mais antigo'}`;
    };

    ov.querySelector('#' + ID + '-bar').addEventListener('click', ev => {
      const a = ev.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'close') close();
      if (a === 'ord') { asc = !asc; render(); }
      if (a === 'zmenu') { menu.hidden = !menu.hidden; return; }
      if (a === 'z-' || a === 'z+') { prefs.z = stepZoom(prefs.z, a === 'z+' ? 1 : -1); applyPrefs(); }
      if (a === 'z') { prefs.z = Number(ev.target.dataset.z); menu.hidden = true; applyPrefs(); }
      if (a === 'w') { prefs.w = ev.target.dataset.w; menu.hidden = true; applyPrefs(); }
      if (a === 'meta') {
        const on = scroll.classList.toggle(ID + '-hidemeta');
        ev.target.textContent = on ? 'Mostrar índices' : 'Ocultar índices';
      }
      if (a === 'copy') {
        copyFormatted(scroll).then(
          () => { info.textContent = 'Texto copiado (com formatação)!'; setTimeout(render, 1500); },
          () => alert('Não foi possível copiar.'));
      }
      if (a === 'print') printView(scroll);
    });
    ov.addEventListener('click', ev => { if (ev.target.id === ID + '-scroll') close(); });
    document.addEventListener('keydown', escKey);

    try {
      const all = await fetchAll((p, l) => { info.textContent = `Carregando página ${p} de ${l}…`; });
      if (!all) { close(); return; }
      entries = all;
      render();
    } catch (err) {
      info.textContent = 'Erro: ' + err.message;
    }
  }

  // Copia como HTML (negrito, sublinhado, itálico etc.) + texto puro como alternativa.
  async function copyFormatted(scroll) {
    const clone = scroll.cloneNode(true);
    // se os índices estiverem ocultos, não leva as linhas de índice
    if (scroll.classList.contains(ID + '-hidemeta')) clone.querySelectorAll('.' + ID + '-meta').forEach(n => n.remove());
    clone.querySelectorAll('.' + ID + '-meta').forEach(n => n.setAttribute('style', 'font-size:8pt;color:#888'));
    clone.querySelectorAll('.' + ID + '-sep').forEach(n => n.replaceWith(document.createElement('br')));
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;text-align:justify">${clone.innerHTML}</div>`;
    const text = scroll.innerText;

    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
        return;
      } catch (e) { /* cai no método alternativo */ }
    }
    // alternativa: seleciona o conteúdo renderizado e usa execCommand('copy')
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.style.cssText = 'position:fixed;left:-99999px;top:0;background:#fff;color:#000';
    document.body.appendChild(tmp);
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents(tmp);
    sel.removeAllRanges(); sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges(); tmp.remove();
    if (!ok) throw new Error('copy failed');
  }

  function escKey(e) {
    if (e.key !== 'Escape') return;
    const m = document.querySelector('#' + ID + '-ov .' + ID + '-menu');
    if (m && !m.hidden) { m.hidden = true; return; }
    close();
  }

  function close() {
    const ov = document.getElementById(ID + '-ov');
    if (ov) ov.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escKey);
  }

  function printView(scroll) {
    const w = window.open('', '_blank');
    if (!w) { alert('Permita pop-ups para imprimir.'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Matrícula – ordem cronológica</title>
      <style>${css}
        body{margin:0;background:#fff}
        .${ID}-page{box-shadow:none;max-width:none;padding:0}
        .${ID}-meta a{display:none}
        .${ID}-sep{page-break-after:always;height:0}
        @page{margin:2cm}
      </style></head><body><div class="${scroll.className}">${scroll.innerHTML}</div></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }
})();