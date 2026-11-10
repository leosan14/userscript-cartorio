// ==UserScript==
// @name         NoCartório — Barbie / Hot Wheels
// @namespace    https://app.nocartorio.com/
// @version      1.1.0
// @description  Troca o tema do NoCartório por Barbie ou Hot Wheels. Alterna ao vivo por um botão flutuante.
// @author       NoCartório Skin
// @match        https://app.nocartorio.com/*
// @match        https://*.nocartorio.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Como o tema do NoCartório funciona:
 *  - Vue 3 + Inertia + Tailwind CSS v4 + componentes shadcn-vue.
 *  - As cores são tokens CSS: --primary, --background, --card, --chart-1..5,
 *    e a rampa --color-surface-50..950 (usada pela sidebar/header escuros).
 *  - Os utilitários do Tailwind compilam para var(--color-surface-900) etc.,
 *    então basta sobrescrever esses tokens no <html> para repintar o app inteiro.
 *  - Os gráficos leem --chart-* e --primary-hex/--*-hex, por isso os dois grupos
 *    de variáveis são sobrescritos.
 *
 * Este script só adiciona CSS (nada de rede, nada de dados) e um seletor de tema.
 */

(function () {
  'use strict';

  // idempotente: se o script for injetado duas vezes, só garante o que já existe
  if (window.__ncSkin) {
    try { window.__ncSkin.refresh(); } catch (e) {}
    return;
  }

  const STORAGE_KEY = 'nc-skin:theme';
  const SWITCHER_KEY = 'nc-skin:switcher'; // 'visible' | 'hidden'
  const DEFAULT_THEME = 'barbie';

  const THEMES = {
    barbie: { label: 'Barbie', icon: '💖' },
    hotwheels: { label: 'Hot Wheels', icon: '🔥' },
  };

  /* ------------------------------------------------------------------ *
   *  CSS
   * ------------------------------------------------------------------ */

  const CSS = String.raw`
/* ============================================================
   BASE COMUM (só ativa quando data-nc-skin está no <html>)
   ============================================================ */
html[data-nc-skin] {
  --nc-radius: 0.9rem;
  --nc-transition: background-color .28s ease, color .28s ease,
                   border-color .28s ease, box-shadow .28s ease;
}

html[data-nc-skin] body {
  transition: var(--nc-transition);
}

html[data-nc-skin] ::selection {
  background: var(--nc-selection-bg);
  color: var(--nc-selection-fg);
}

/* barras de rolagem */
html[data-nc-skin] ::-webkit-scrollbar { width: 10px; height: 10px; }
html[data-nc-skin] ::-webkit-scrollbar-track { background: transparent; }
html[data-nc-skin] ::-webkit-scrollbar-thumb {
  background: var(--nc-scroll-thumb);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
html[data-nc-skin] ::-webkit-scrollbar-thumb:hover { filter: brightness(1.12); }

/* ============================================================
   SIDEBAR + HEADER  (área escura)
   ============================================================ */
html[data-nc-skin] [data-sidebar="sidebar"] {
  background: var(--nc-sidebar-bg) !important;
}

/* deixa o gradiente aparecer (esses blocos têm bg-surface-900 sólido) */
html[data-nc-skin] [data-sidebar="header"],
html[data-nc-skin] [data-sidebar="content"],
html[data-nc-skin] [data-sidebar="footer"],
html[data-nc-skin] .custom_sidebar--header::after {
  background-color: transparent !important;
}

/* cartão de usuário no topo da sidebar */
html[data-nc-skin] [data-sidebar="content"] > div > .rounded-xl {
  background-color: color-mix(in oklab, var(--nc-surface-50) 8%, transparent) !important;
  border-color: color-mix(in oklab, var(--nc-surface-50) 18%, transparent) !important;
  backdrop-filter: blur(6px);
}

/* item ativo do menu */
html[data-nc-skin] [data-sidebar="menu"] [data-active="true"] {
  background-image: var(--nc-active-bg) !important;
  background-color: transparent !important;
  box-shadow: var(--nc-active-shadow) !important;
  border-color: transparent !important;
}

/* faixa fina de brilho no rodapé/lateral do menu */
html[data-nc-skin] main > header {
  position: relative;
  z-index: 31;
}
html[data-nc-skin] main > header::after {
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 3px;
  background: var(--nc-accent-line);
  pointer-events: none;
}

/* barra de breadcrumb (fica sobre a área escura) */
html[data-nc-skin] .app-breadcrumb-bar {
  color: var(--nc-breadcrumb-text) !important;
  border-bottom: 1px solid var(--nc-breadcrumb-border) !important;
}

/* logo: recolore o desenho laranja sem tocar no texto (currentColor) */
html[data-nc-skin] .custom_sidebar--header svg[viewBox="0 0 220 256"] {
  filter: var(--nc-logo-filter);
}

/* ============================================================
   CARDS / SUPERFÍCIES CLARAS
   ============================================================ */
html[data-nc-skin] .bg-card {
  border-color: var(--nc-card-border) !important;
}
html[data-nc-skin] .bg-card.rounded-xl {
  box-shadow: var(--nc-card-shadow) !important;
}

/* botões primários ganham gradiente + brilho */
html[data-nc-skin] [data-slot="button"].bg-primary {
  background-image: var(--nc-primary-gradient) !important;
  border: 0 !important;
  box-shadow: var(--nc-primary-shadow) !important;
}
html[data-nc-skin] [data-slot="button"].bg-primary:hover {
  filter: brightness(1.06) saturate(1.04);
}

/* contadores/badges escuros */
html[data-nc-skin] .bg-secondary {
  background-image: var(--nc-badge-bg) !important;
}

/* foco consistente */
html[data-nc-skin] :focus-visible {
  outline-color: var(--nc-focus);
}

/* cantos mais arredondados/afiados conforme o tema */
html[data-nc-skin] { --radius: var(--nc-radius) !important; }

/* ============================================================
   TEMA BARBIE
   ============================================================ */
html[data-nc-skin="barbie"] {
  color-scheme: light;

  --nc-radius: 1rem;
  --nc-surface-50:  #ffe9f6;
  --nc-selection-bg: #ff8fc7;
  --nc-selection-fg: #3c0a29;
  --nc-scroll-thumb: linear-gradient(180deg, #ff5cb8, #a855f7);
  --nc-focus: #ff2d95;

  --nc-sidebar-bg:
    radial-gradient(95% 42% at 0% 0%,   rgba(255, 92, 184, .40) 0%, transparent 62%),
    radial-gradient(85% 42% at 100% 6%, rgba(168, 85, 247, .32) 0%, transparent 62%),
    linear-gradient(180deg, #5d0d40 0%, #3c0f29 55%, #2b081b 100%);
  --nc-accent-line: linear-gradient(90deg, #ff2d95, #ff9ecb 35%, #a855f7 65%, #ff2d95);
  --nc-breadcrumb-text: #ffd6ee;
  --nc-breadcrumb-border: rgba(255, 45, 149, .35);
  --nc-logo-filter: hue-rotate(-45deg) saturate(1.75) brightness(1.06)
                    drop-shadow(0 0 8px rgba(255, 45, 149, .55));

  --nc-primary-gradient: linear-gradient(135deg, #ff5cb8 0%, #f3127c 55%, #c80f78 100%);
  --nc-primary-shadow: 0 8px 22px -10px rgba(243, 18, 124, .75),
                       0 2px 6px -2px rgba(200, 15, 120, .45);
  --nc-active-bg: linear-gradient(135deg, #ffffff 0%, #ffeaf6 100%);
  --nc-active-shadow: inset 3px 0 0 #ff2d95, 0 4px 12px -6px rgba(0, 0, 0, .35);
  --nc-card-border: #fad7e9;
  --nc-card-shadow: 0 10px 28px -20px rgba(224, 33, 138, .45),
                    0 1px 2px rgba(224, 33, 138, .06);
  --nc-badge-bg: linear-gradient(135deg, #8a1257 0%, #5d0d40 100%);

  /* tokens do app */
  --primary: #f3127c !important;
  --primary-hex: #f3127c !important;
  --primary-foreground: #ffffff !important;
  --primary-foreground-hex: #ffffff !important;

  --background: #fff5fa !important;
  --background-hex: #fff5fa !important;
  --foreground: #3c0a29 !important;
  --foreground-hex: #3c0a29 !important;

  --card: #ffffff !important;
  --card-hex: #ffffff !important;
  --card-foreground: #3c0a29 !important;
  --card-foreground-hex: #3c0a29 !important;
  --popover: #ffffff !important;
  --popover-foreground: #3c0a29 !important;

  --secondary: #7a0f4a !important;
  --secondary-hex: #7a0f4a !important;
  --secondary-foreground: #ffe6f4 !important;
  --secondary-foreground-hex: #ffe6f4 !important;

  --muted: #fdf1f8 !important;
  --muted-hex: #fdf1f8 !important;
  --muted-foreground: #8f3f6a !important;
  --muted-foreground-hex: #8f3f6a !important;

  --accent: #ffe3f2 !important;
  --accent-hex: #ffe3f2 !important;
  --accent-foreground: #6b0b40 !important;
  --accent-foreground-hex: #6b0b40 !important;

  --destructive: #e11d48 !important;
  --destructive-hex: #e11d48 !important;
  --destructive-foreground: #ffffff !important;
  --destructive-foreground-hex: #ffffff !important;

  --info: #8b5cf6 !important;
  --info-hex: #8b5cf6 !important;
  --info-foreground: #ffffff !important;
  --info-foreground-hex: #ffffff !important;

  --success: #16a34a !important;
  --success-hex: #16a34a !important;
  --success-foreground: #ffffff !important;
  --success-foreground-hex: #ffffff !important;

  --warning: #f59e0b !important;
  --warning-hex: #f59e0b !important;
  --warning-foreground: #3c0a29 !important;
  --warning-foreground-hex: #3c0a29 !important;

  --border: #f7d3e7 !important;
  --border-hex: #f7d3e7 !important;
  --input: #f7d3e7 !important;
  --input-hex: #f7d3e7 !important;
  --ring: #ff5cb8 !important;
  --ring-hex: #ff5cb8 !important;

  /* rampa "surface" usada pela sidebar e pelo texto escuro */
  --color-surface-50: #ffe9f6 !important;
  --color-surface-100: #fbdaec !important;
  --color-surface-200: #f6c4dd !important;
  --color-surface-300: #eda5c8 !important;
  --color-surface-400: #de85b1 !important;
  --color-surface-500: #c46596 !important;
  --color-surface-600: #a44b79 !important;
  --color-surface-700: #82355d !important;
  --color-surface-800: #5c2340 !important;
  --color-surface-900: #3c0f29 !important;
  --color-surface-950: #28081a !important;

  /* laranjas do sistema viram rosa */
  --color-orange-400: #ff7ac2 !important;
  --color-orange-500: #ff2d95 !important;
  --color-orange-600: #e0117d !important;

  /* gráficos */
  --chart-1: #ff2d95 !important;
  --chart-2: #a855f7 !important;
  --chart-3: #ff9ecb !important;
  --chart-4: #6366f1 !important;
  --chart-5: #fbbf24 !important;

  /* sidebar tokens (shadcn) */
  --sidebar: #3c0f29 !important;
  --sidebar-foreground: #ffe9f6 !important;
  --sidebar-primary: #ff2d95 !important;
  --sidebar-primary-foreground: #ffffff !important;
  --sidebar-accent: #5c2340 !important;
  --sidebar-accent-foreground: #ffffff !important;
  --sidebar-border: rgba(255, 45, 149, .28) !important;
  --sidebar-ring: #ff5cb8 !important;

  /* data-viz */
  --vis-color0: #ff2d95 !important;
  --vis-color1: #a855f7 !important;
  --vis-color2: #ff9ecb !important;
  --vis-color3: #6366f1 !important;
  --vis-color4: #fbbf24 !important;
  --vis-color5: #14b8a6 !important;
  --vis-plotline-color: #ff2d95 !important;
  --vis-axis-grid-color: #f6d9ea !important;
}

/* ============================================================
   TEMA HOT WHEELS
   ============================================================ */
html[data-nc-skin="hotwheels"] {
  color-scheme: light;

  --nc-radius: 0.55rem;
  --nc-surface-50: #f4f5f7;
  --nc-selection-bg: #ff3b00;
  --nc-selection-fg: #ffffff;
  --nc-scroll-thumb: linear-gradient(180deg, #ff5a00, #e4002b);
  --nc-focus: #ff3b00;

  --nc-sidebar-bg:
    radial-gradient(90% 40% at 50% -10%, rgba(255, 59, 0, .38) 0%, transparent 60%),
    repeating-linear-gradient(135deg, rgba(255, 255, 255, .025) 0 14px, transparent 14px 28px),
    linear-gradient(180deg, #22262d 0%, #12151a 58%, #090b0e 100%);
  --nc-accent-line: linear-gradient(90deg, #ff3b00, #ffc300 34%, #ff6a00 62%, #e4002b);
  --nc-breadcrumb-text: #d8dbe2;
  --nc-breadcrumb-border: rgba(255, 59, 0, .40);
  --nc-logo-filter: hue-rotate(-12deg) saturate(1.5) brightness(1.02)
                    drop-shadow(0 0 8px rgba(255, 59, 0, .50));

  --nc-primary-gradient: linear-gradient(135deg, #ff5a00 0%, #ef1b00 55%, #c70020 100%);
  --nc-primary-shadow: 0 8px 22px -10px rgba(228, 0, 43, .80),
                       0 2px 6px -2px rgba(199, 0, 32, .50);
  --nc-active-bg: linear-gradient(135deg, #ffffff 0%, #ffe9e5 100%);
  --nc-active-shadow: inset 3px 0 0 #e4002b, 0 4px 12px -6px rgba(0, 0, 0, .5);
  --nc-card-border: #e3e6ed;
  --nc-card-shadow: 0 2px 0 rgba(20, 22, 26, .035),
                    0 12px 26px -24px rgba(20, 22, 26, .55);
  --nc-badge-bg: linear-gradient(135deg, #2c313a 0%, #11141a 100%);

  /* tokens do app */
  --primary: #e4002b !important;
  --primary-hex: #e4002b !important;
  --primary-foreground: #ffffff !important;
  --primary-foreground-hex: #ffffff !important;

  --background: #f4f5f7 !important;
  --background-hex: #f4f5f7 !important;
  --foreground: #14161a !important;
  --foreground-hex: #14161a !important;

  --card: #ffffff !important;
  --card-hex: #ffffff !important;
  --card-foreground: #14161a !important;
  --card-foreground-hex: #14161a !important;
  --popover: #ffffff !important;
  --popover-foreground: #14161a !important;

  --secondary: #1b1e24 !important;
  --secondary-hex: #1b1e24 !important;
  --secondary-foreground: #f5f6f8 !important;
  --secondary-foreground-hex: #f5f6f8 !important;

  --muted: #eef0f4 !important;
  --muted-hex: #eef0f4 !important;
  --muted-foreground: #5f6673 !important;
  --muted-foreground-hex: #5f6673 !important;

  --accent: #fdeceb !important;
  --accent-hex: #fdeceb !important;
  --accent-foreground: #7d1523 !important;
  --accent-foreground-hex: #7d1523 !important;

  --destructive: #d71920 !important;
  --destructive-hex: #d71920 !important;
  --destructive-foreground: #ffffff !important;
  --destructive-foreground-hex: #ffffff !important;

  --info: #0e9fff !important;
  --info-hex: #0e9fff !important;
  --info-foreground: #ffffff !important;
  --info-foreground-hex: #ffffff !important;

  --success: #0f9f6e !important;
  --success-hex: #0f9f6e !important;
  --success-foreground: #ffffff !important;
  --success-foreground-hex: #ffffff !important;

  --warning: #f5a300 !important;
  --warning-hex: #f5a300 !important;
  --warning-foreground: #14161a !important;
  --warning-foreground-hex: #14161a !important;

  --border: #e3e6ed !important;
  --border-hex: #e3e6ed !important;
  --input: #e3e6ed !important;
  --input-hex: #e3e6ed !important;
  --ring: #ff3b00 !important;
  --ring-hex: #ff3b00 !important;

  --color-surface-50: #f4f5f7 !important;
  --color-surface-100: #e7e9ee !important;
  --color-surface-200: #d3d7e0 !important;
  --color-surface-300: #b3b9c6 !important;
  --color-surface-400: #8b93a3 !important;
  --color-surface-500: #69707f !important;
  --color-surface-600: #4f5664 !important;
  --color-surface-700: #3a404b !important;
  --color-surface-800: #262b34 !important;
  --color-surface-900: #14171c !important;
  --color-surface-950: #0b0d10 !important;

  --color-orange-400: #ff6a2b !important;
  --color-orange-500: #ff3b00 !important;
  --color-orange-600: #d92b00 !important;

  --chart-1: #ff3b00 !important;
  --chart-2: #0e9fff !important;
  --chart-3: #ffc300 !important;
  --chart-4: #12b886 !important;
  --chart-5: #7c3aed !important;

  --sidebar: #14171c !important;
  --sidebar-foreground: #f4f5f7 !important;
  --sidebar-primary: #ff3b00 !important;
  --sidebar-primary-foreground: #ffffff !important;
  --sidebar-accent: #262b34 !important;
  --sidebar-accent-foreground: #ffffff !important;
  --sidebar-border: rgba(255, 59, 0, .30) !important;
  --sidebar-ring: #ff3b00 !important;

  --vis-color0: #ff3b00 !important;
  --vis-color1: #0e9fff !important;
  --vis-color2: #ffc300 !important;
  --vis-color3: #12b886 !important;
  --vis-color4: #7c3aed !important;
  --vis-color5: #ff7a00 !important;
  --vis-plotline-color: #ff3b00 !important;
  --vis-axis-grid-color: #e6e9ef !important;
}

/* ============================================================
   SELETOR FLUTUANTE
   ============================================================ */
#nc-skin-switcher {
  position: fixed;
  right: 18px;
  bottom: 92px;
  z-index: 2147483000;
}
`;

  /* ------------------------------------------------------------------ *
   *  ESTADO
   * ------------------------------------------------------------------ */

  let current = DEFAULT_THEME;
  let switcherHidden = false;

  function readStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'off') return 'off';
      if (v && THEMES[v]) return v;
    } catch (e) { /* modo privado */ }
    return DEFAULT_THEME;
  }

  function save(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }

  function readSwitcherHidden() {
    try { return localStorage.getItem(SWITCHER_KEY) === 'hidden'; } catch (e) { return false; }
  }

  function saveSwitcherHidden(hidden) {
    try { localStorage.setItem(SWITCHER_KEY, hidden ? 'hidden' : 'visible'); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  MOSTRAR / OCULTAR O SELETOR
   * ------------------------------------------------------------------ */

  function setSwitcherVisible(visible, persist) {
    switcherHidden = !visible;
    const host = document.getElementById('nc-skin-switcher');
    if (host) host.style.display = visible ? '' : 'none';
    if (persist !== false) saveSwitcherHidden(switcherHidden);
  }

  function toggleSwitcher(force) {
    const visible = typeof force === 'boolean' ? force : switcherHidden;
    setSwitcherVisible(visible);
    if (!visible) showHideHint();
  }

  // aviso rápido quando o usuário oculta o seletor (some sozinho)
  function showHideHint() {
    const old = document.getElementById('nc-skin-hint');
    if (old) old.remove();

    const hint = document.createElement('div');
    hint.id = 'nc-skin-hint';
    hint.textContent = 'Seletor oculto · Alt+S para exibir';
    hint.style.cssText = [
      'all:initial', 'position:fixed', 'right:18px', 'bottom:92px', 'z-index:2147483000',
      'padding:9px 13px', 'border-radius:999px',
      'background:rgba(18,18,22,.92)', 'color:#fff',
      'font:600 12px/1 "Open Sans",system-ui,-apple-system,sans-serif',
      'border:1px solid rgba(255,255,255,.16)',
      'box-shadow:0 14px 34px rgba(0,0,0,.38)',
      'backdrop-filter:blur(12px)', 'pointer-events:none',
      'opacity:0', 'transition:opacity .2s ease',
    ].join(';');
    document.body.appendChild(hint);

    requestAnimationFrame(() => { hint.style.opacity = '1'; });
    setTimeout(() => {
      hint.style.opacity = '0';
      setTimeout(() => hint.remove(), 250);
    }, 2400);
  }

  /* ------------------------------------------------------------------ *
   *  CSS injection
   * ------------------------------------------------------------------ */

  const CSS_VERSION = '1.1.0';

  function injectStyle() {
    const existing = document.getElementById('nc-skin-style');
    if (existing && existing.dataset.ncVersion === CSS_VERSION) return;

    if (existing) {
      // versão anterior do script: atualiza o CSS no lugar
      existing.textContent = CSS;
      existing.dataset.ncVersion = CSS_VERSION;
      return;
    }

    const style = document.createElement('style');
    style.id = 'nc-skin-style';
    style.dataset.ncVersion = CSS_VERSION;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ *
   *  APLICAR / ATUALIZAR
   * ------------------------------------------------------------------ */

  function syncThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute('content', theme === 'hotwheels' ? '#14171c'
      : theme === 'barbie' ? '#3c0f29' : '#ffffff');
  }

  function apply(theme, persist) {
    const root = document.documentElement;
    if (!root) return;

    current = theme;

    if (theme === 'off') {
      root.removeAttribute('data-nc-skin');
    } else {
      root.setAttribute('data-nc-skin', theme);
    }

    syncThemeColor(theme);

    if (persist !== false) save(theme);
    updateSwitcher();
  }

  function updateSwitcher() {
    const host = document.getElementById('nc-skin-switcher');
    if (!host || !host.shadowRoot) return;
    host.shadowRoot.querySelectorAll('button[data-skin]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.skin === current);
    });
  }

  /* ------------------------------------------------------------------ *
   *  UI (shadow DOM para não herdar o CSS do site)
   * ------------------------------------------------------------------ */

  const SWITCHER_CSS = `
    :host { all: initial; }
    .wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 9px;
      border-radius: 999px;
      background: rgba(18, 18, 22, .88);
      border: 1px solid rgba(255, 255, 255, .16);
      box-shadow: 0 14px 34px rgba(0, 0, 0, .38);
      backdrop-filter: blur(12px) saturate(1.2);
      font: 600 12px/1 "Open Sans", system-ui, -apple-system, sans-serif;
      color: #fff;
      user-select: none;
    }
    .tag {
      font-size: 9px;
      letter-spacing: .12em;
      text-transform: uppercase;
      opacity: .5;
      margin: 0 2px 0 4px;
    }
    button {
      appearance: none;
      border: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 7px 11px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .07);
      color: rgba(255, 255, 255, .78);
      font: inherit;
      transition: background .18s ease, color .18s ease, transform .12s ease;
    }
    button:hover { background: rgba(255, 255, 255, .14); color: #fff; }
    button:active { transform: scale(.96); }
    button[data-skin="barbie"].is-active {
      background: linear-gradient(135deg, #ff5cb8, #e0218a);
      color: #fff;
      box-shadow: 0 4px 14px -4px rgba(243, 18, 124, .85);
    }
    button[data-skin="hotwheels"].is-active {
      background: linear-gradient(135deg, #ff5a00, #e4002b);
      color: #fff;
      box-shadow: 0 4px 14px -4px rgba(228, 0, 43, .85);
    }
    button[data-skin="off"] { padding: 7px 9px; opacity: .55; }
    button[data-skin="off"]:hover { opacity: 1; }
    button[data-skin="off"].is-active { background: rgba(255, 255, 255, .22); color: #fff; opacity: 1; }
    button[data-action="hide"] {
      padding: 5px 10px 9px;
      font-size: 16px;
      line-height: 1;
      opacity: .55;
    }
    button[data-action="hide"]:hover { opacity: 1; }
  `;

  function buildSwitcher() {
    if (document.getElementById('nc-skin-switcher')) {
      updateSwitcher();
      setSwitcherVisible(!switcherHidden, false);
      return;
    }

    const host = document.createElement('div');
    host.id = 'nc-skin-switcher';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SWITCHER_CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'tema';
    wrap.appendChild(tag);

    Object.entries(THEMES).forEach(([id, meta]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.skin = id;
      btn.title = 'Aplicar tema ' + meta.label;
      btn.textContent = meta.icon + ' ' + meta.label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        apply(id);
      });
      wrap.appendChild(btn);
    });

    const off = document.createElement('button');
    off.type = 'button';
    off.dataset.skin = 'off';
    off.title = 'Voltar ao tema original do NoCartório';
    off.textContent = '⨯';
    off.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      apply('off');
    });
    wrap.appendChild(off);

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.dataset.action = 'hide';
    hide.title = 'Ocultar seletor (Alt+S para exibir de novo)';
    hide.setAttribute('aria-label', 'Ocultar seletor de tema');
    hide.textContent = '⌄';
    hide.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSwitcher(false);
    });
    wrap.appendChild(hide);

    root.append(style, wrap);
    document.body.appendChild(host);
    switcherHidden = readSwitcherHidden();
    updateSwitcher();
    setSwitcherVisible(!switcherHidden, false);
  }

  /* ------------------------------------------------------------------ *
   *  ATALHOS: Alt+B / Alt+H / Alt+0 / Alt+S
   * ------------------------------------------------------------------ */

  function onKeyDown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    if (e.code === 'KeyB') { e.preventDefault(); apply('barbie'); }
    else if (e.code === 'KeyH') { e.preventDefault(); apply('hotwheels'); }
    else if (e.code === 'KeyS') { e.preventDefault(); toggleSwitcher(); }
    else if (e.code === 'Digit0' || e.code === 'Numpad0') { e.preventDefault(); apply('off'); }
  }

  /* ------------------------------------------------------------------ *
   *  BOOT
   * ------------------------------------------------------------------ */

  function boot() {
    injectStyle();
    switcherHidden = readSwitcherHidden();
    if (document.body) buildSwitcher();
  }

  // aplica o tema o quanto antes (evita "flash" do laranja)
  apply(readStored(), false);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.addEventListener('keydown', onKeyDown, true);

  // SPA / Inertia: garante style e seletor mesmo após trocas de página
  setInterval(() => {
    injectStyle();
    syncThemeColor(current);
    if (document.body && !document.getElementById('nc-skin-switcher')) buildSwitcher();
    const host = document.getElementById('nc-skin-switcher');
    if (host) host.style.display = readSwitcherHidden() ? 'none' : '';
    if (current !== 'off' && document.documentElement.getAttribute('data-nc-skin') !== current) {
      document.documentElement.setAttribute('data-nc-skin', current);
    }
  }, 2000);

  // acesso externo opcional (console)
  window.__ncSkin = {
    apply,
    refresh: boot,
    showSwitcher: () => toggleSwitcher(true),
    hideSwitcher: () => toggleSwitcher(false),
    toggleSwitcher: () => toggleSwitcher(),
    get theme() { return current; },
    get switcherVisible() { return !switcherHidden; },
  };
})();
