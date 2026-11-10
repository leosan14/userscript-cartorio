/* Scripts do Cartório — comportamento da página (sem dependências). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------------------------------------------------------- aviso curto */
  var toastEl = $('.toast');
  var toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  /* ---------------------------------------------------------------- navegador */
  // Abre a aba de instruções do navegador em uso.
  (function () {
    var ua = navigator.userAgent || '';
    var id = /Firefox\//.test(ua) ? 'nav-firefox' : /Edg\//.test(ua) ? 'nav-edge' : 'nav-chrome';
    var radio = document.getElementById(id);
    if (radio) radio.checked = true;
  })();

  /* ---------------------------------------------------------------- versões */
  // Lê o @version direto do arquivo publicado, para a página nunca ficar defasada.
  function readVersion(file) {
    return fetch('scripts/' + file, { cache: 'no-cache', headers: { Range: 'bytes=0-4095' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var m = text.slice(0, 6000).match(/^\/\/\s*@version\s+(\S+)/m);
        return m ? m[1] : '';
      })
      .catch(function () { return ''; });
  }
  $$('[data-version]').forEach(function (el) {
    readVersion(el.getAttribute('data-version')).then(function (v) {
      if (!v) return;
      el.textContent = 'v' + v;
      el.title = 'Versão publicada agora';
    });
  });

  /* ---------------------------------------------------------------- copiar */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      // dentro de um <dialog> aberto, o campo precisa estar nele para receber o foco
      var host = document.querySelector('dialog[open]') || document.body;
      host.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      host.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy'));
    });
  }

  function flash(btn, label) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label + ' ✓';
    btn.classList.add('done');
    clearTimeout(btn._t);
    btn._t = setTimeout(function () {
      btn.textContent = btn.dataset.label;
      btn.classList.remove('done');
    }, 2400);
  }

  // Textos curtos (ex.: chrome://extensions, que o navegador não deixa abrir por link)
  $$('[data-copy]').forEach(function (btn) {
    btn.title = 'Clique para copiar';
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      copyText(text).then(
        function () { toast('Copiado: ' + text + '. Cole na barra de endereço.'); },
        function () { toast('Não consegui copiar. Digite ' + text + ' na barra de endereço.'); }
      );
    });
  });

  // Arquivos (configuração do Trello, instruções da skill): busca e copia.
  var fileCache = {};
  function loadFile(src) {
    if (!fileCache[src]) {
      fileCache[src] = fetch(src, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
      fileCache[src].catch(function () { delete fileCache[src]; });
    }
    return fileCache[src];
  }

  function showFallback(btn, text, why) {
    var li = btn.closest('li') || btn.parentNode;
    var box = li.querySelector('.copy-fallback');
    if (!box) return;
    box.hidden = false;
    box.textContent = '';
    var p = document.createElement('p');
    p.textContent = why;
    box.appendChild(p);
    if (text) {
      var ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.rows = 5;
      ta.value = text;
      ta.setAttribute('aria-label', 'Texto para copiar');
      ta.addEventListener('focus', function () { ta.select(); });
      box.appendChild(ta);
      ta.focus();
    }
  }

  $$('[data-copy-src]').forEach(function (btn) {
    var src = btn.getAttribute('data-copy-src');
    btn.addEventListener('click', function () {
      loadFile(src).then(function (text) {
        text = text.trim();
        return copyText(text).then(
          function () { flash(btn, btn.getAttribute('data-copy-label') || 'Copiado'); },
          function () { showFallback(btn, text, 'O navegador não deixou copiar sozinho. Selecione o texto abaixo e copie com Ctrl+C.'); }
        );
      }).catch(function () {
        showFallback(btn, '', 'Não consegui baixar o arquivo agora. Recarregue a página e tente de novo.');
      });
    });
  });

  /* ---------------------------------------------------------------- guias */
  var canDialog = typeof HTMLDialogElement === 'function';

  function openGuide(id, push) {
    var dlg = document.getElementById(id);
    if (!dlg || dlg.tagName !== 'DIALOG') return false;
    if (dlg.open) return true;
    $$('dialog[open]').forEach(function (d) { d.close(); });
    if (canDialog) dlg.showModal(); else dlg.setAttribute('open', '');
    var body = $('.g-b', dlg);
    if (body) body.scrollTop = 0;
    // deixa a busca do que a pessoa talvez precise copiar já a caminho
    $$('[data-copy-src]', dlg).forEach(function (b) { loadFile(b.getAttribute('data-copy-src')).catch(function () {}); });
    if (push && location.hash !== '#' + id) {
      try { history.pushState(null, '', '#' + id); } catch (e) { /* file:// */ }
    }
    return true;
  }

  function closeGuide(dlg) {
    if (canDialog) dlg.close(); else dlg.removeAttribute('open');
  }

  $$('[data-guide]').forEach(function (btn) {
    btn.addEventListener('click', function () { openGuide(btn.getAttribute('data-guide'), true); });
  });

  $$('dialog.guide').forEach(function (dlg) {
    $$('[data-close]', dlg).forEach(function (b) {
      b.addEventListener('click', function () { closeGuide(dlg); });
    });
    // clique fora da folha (no fundo escurecido) fecha
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) closeGuide(dlg);
    });
    dlg.addEventListener('close', function () {
      if (location.hash === '#' + dlg.id) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
      }
    });
    // links para seções da página (ex.: "passo 1") fecham o guia antes de rolar
    $$('a[href^="#"]', dlg).forEach(function (a) {
      a.addEventListener('click', function () { closeGuide(dlg); });
    });
  });

  // Endereço com #guia-… abre o guia direto (para mandar o link a um colega).
  function fromHash() {
    var id = decodeURIComponent((location.hash || '').slice(1));
    if (/^guia-/.test(id)) {
      openGuide(id, false);
    } else {
      $$('dialog[open]').forEach(function (d) { closeGuide(d); });
    }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
