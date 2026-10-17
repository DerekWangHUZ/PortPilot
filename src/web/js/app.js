/* 应用外壳：导航、渲染、事件 */
(function () {
  'use strict';

  var PP = window.PP;

  var NAV = [
    { id: 'overview', label: '总览', icon: '<path d="M4 13h6V5H4zM14 19h6v-8h-6zM4 19h6v-3H4zM14 8h6V5h-6z"/>' },
    { id: 'ports', label: '端口', icon: '<path d="M4 7h16M4 12h16M4 17h10"/>' },
    { id: 'nodes', label: '节点', icon: '<path d="M12 3v6M12 15v6M5 12h14"/><circle cx="12" cy="12" r="3"/>' },
    { id: 'connections', label: '连接与流量', icon: '<path d="M3 12h4l3-7 4 14 3-7h4"/>' },
    { id: 'rules', label: '规则', icon: '<path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/>' },
    { id: 'settings', label: '设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>' },
    { id: 'logs', label: '运行记录', icon: '<path d="M12 8v5l3 2"/><circle cx="12" cy="12" r="9"/>' }
  ];

  var state = { page: 'overview', options: {}, view: null, booted: false, systemTheme: 'light', healTimer: null };
  var core = PP.core.createCore({ bridge: PP.bridge });
  var viewEl = document.getElementById('view');

  function effectiveTheme() {
    var want = core.state.settings.theme;
    if (want === 'system') return state.systemTheme;
    return want;
  }

  function applyTheme() {
    var dark = effectiveTheme() === 'dark';
    document.body.classList.toggle('theme-dark', dark);
    pushFrameColor();
  }

  var ctx = {
    core: core,
    bridge: PP.bridge,
    view: null,
    options: state.options,
    actions: {},
    go: function (page) {
      state.page = page;
      state.options = {};
      ctx.options = state.options;
      renderNav();
      renderPage(false);
      viewEl.scrollTop = 0;
      var mod = PP.pages[page];
      if (mod && mod.enter) {
        try { mod.enter(ctx); } catch (e) { }
      }
    },
    setOptions: function (opts) {
      Object.keys(opts || {}).forEach(function (k) { state.options[k] = opts[k]; });
      ctx.options = state.options;
    },
    rerender: function () { renderPage(true); },
    refresh: function (opts) {
      return core.refresh(opts);
    },
    run: function (factory, okText) {
      if (core.busy) {
        PP.ui.toast('info', '正在处理上一个操作，请稍候');
        return Promise.resolve(null);
      }
      var promise;
      try { promise = Promise.resolve(factory()); } catch (e) { promise = Promise.reject(e); }
      return promise.then(function (res) {
        if (okText) PP.ui.toast('ok', okText);
        return res;
      }, function (err) {
        PP.ui.toast('err', (err && err.message) ? err.message : String(err));
        return null;
      });
    },
    applyTheme: applyTheme
  };

  /* --------------------------------------------------------------- 渲染 */
  function renderNav() {
    var v = state.view;
    var count = v ? v.ports.length : 0;
    var listening = v ? v.ports.filter(function (p) { return p.status === 'on'; }).length : 0;
    var html = NAV.map(function (item) {
      var badge = '';
      if (item.id === 'ports' && count) badge = '<b>' + count + '</b>';
      if (item.id === 'connections' && listening) badge = '<b>' + listening + '</b>';
      return '<button class="nav-item' + (state.page === item.id ? ' active' : '') + '" data-page="' + item.id + '">' +
        '<svg viewBox="0 0 24 24">' + item.icon + '</svg><span>' + item.label + '</span>' + badge + '</button>';
    }).join('');
    var nav = document.getElementById('nav');
    nav.innerHTML = html;
    nav.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () { ctx.go(btn.getAttribute('data-page')); });
    });
  }

  function renderCoreCard() {
    var v = state.view;
    var dot = document.getElementById('core-dot');
    var text = document.getElementById('core-text');
    var detail = document.getElementById('core-detail');
    if (!v) return;
    if (!v.core.ok) {
      dot.className = 'dot bad';
      text.textContent = 'Clash Verge 未就绪';
      detail.textContent = v.core.error || '请先启动 Clash Verge';
      return;
    }
    dot.className = 'dot ok';
    text.textContent = 'Clash Verge 已就绪';
    detail.textContent = (v.core.version || '') + (v.core.mixedPort ? ' · 混合端口 ' + v.core.mixedPort : '');
  }

  function datasetOf(el) {
    var out = {};
    if (!el || !el.attributes) return out;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0) {
        var key = a.name.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
        out[key] = a.value;
      }
    }
    return out;
  }

  function renderPage(keepScroll) {
    var page = PP.pages[state.page];
    if (!page) return;
    var scrollTop = viewEl.scrollTop;
    ctx.view = state.view || core.view();
    var result = page.render(ctx);
    ctx.actions = result.handlers || {};
    viewEl.innerHTML = result.html;

    viewEl.onclick = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (!fn) return;
      e.preventDefault();
      fn(datasetOf(el), e);
    };

    var onChange = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (fn) fn(datasetOf(el), e);
    };
    viewEl.onchange = onChange;
    viewEl.oninput = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (fn && el.getAttribute('data-live') === '1') fn(datasetOf(el), e);
    };

    if (result.after) {
      try { result.after(viewEl); } catch (e) { }
    }
    if (keepScroll) viewEl.scrollTop = scrollTop;
  }

  function fullRender() {
    renderNav();
    renderCoreCard();
    renderPage(true);
  }

  /* --------------------------------------------------------------- 事件 */
  PP.bridge.on('theme', function (data) {
    state.systemTheme = data && data.mode ? data.mode : 'light';
    applyTheme();
    if (core.state.settings.theme === 'system') renderPage(true);
  });

  PP.bridge.on('config.changed', function () {
    if (state.healTimer) clearTimeout(state.healTimer);
    state.healTimer = setTimeout(function () {
      state.healTimer = null;
      if (!state.booted) return;
      core.refresh().then(function () {
        return core.heal('Clash Verge 配置变化后自动恢复');
      });
    }, 1500);
  });

  core.on('state', function (view) {
    state.view = view;
    if (!state.booted) return;
    fullRender();
  });

  core.on('busy', function (busy) {
    document.getElementById('progress').classList.toggle('on', !!busy);
    if (state.booted) renderPage(true);
  });

  document.querySelector('.nav.ghost').addEventListener('click', function () {
    PP.bridge.invoke('app.exit');
  });

  /* ------------------------------------------------ 窗口按钮 / 拖动 / 描边色 */
  function pushFrameColor() {
    var dark = document.body.classList.contains('theme-dark');
    PP.bridge.invoke('window.setFrame', { color: dark ? '#161617' : '#f7f7f9' }).catch(function () { });
  }

  document.querySelectorAll('[data-win]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var act = btn.getAttribute('data-win');
      if (act === 'close') PP.bridge.invoke('app.exit');
      else if (act === 'min') PP.bridge.invoke('window.minimize');
      else PP.bridge.invoke('window.toggleMaximize').then(function (r) { state.maximized = !!(r && r.maximized); });
    });
  });

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (!e.target.closest('[data-drag]')) return;
    PP.bridge.invoke('window.beginDrag');
  });

  document.addEventListener('dblclick', function (e) {
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (!e.target.closest('[data-drag]')) return;
    PP.bridge.invoke('window.toggleMaximize');
  });

  /* ------------------------------------------- 边缘拖动缩放（与示例项目同思路） */
  var EDGE = 6;
  var EDGE_CURSOR = {
    left: 'w-resize', right: 'e-resize', top: 'n-resize', bottom: 's-resize',
    topleft: 'nw-resize', topright: 'ne-resize', bottomleft: 'sw-resize', bottomright: 'se-resize'
  };
  var activeEdge = null;

  function edgeAt(x, y) {
    if (state.maximized) return null;
    var w = window.innerWidth, h = window.innerHeight;
    var left = x <= EDGE, right = x >= w - EDGE, top = y <= EDGE, bottom = y >= h - EDGE;
    if (top && left) return 'topleft';
    if (top && right) return 'topright';
    if (bottom && left) return 'bottomleft';
    if (bottom && right) return 'bottomright';
    if (left) return 'left';
    if (right) return 'right';
    if (top) return 'top';
    if (bottom) return 'bottom';
    return null;
  }

  document.addEventListener('mousemove', function (e) {
    var edge = edgeAt(e.clientX, e.clientY);
    if (edge === activeEdge) return;
    activeEdge = edge;
    document.body.style.cursor = edge ? EDGE_CURSOR[edge] : '';
  });

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !activeEdge) return;
    e.preventDefault();
    e.stopPropagation();
    PP.bridge.invoke('window.beginResize', { edge: activeEdge });
  }, true);

  window.addEventListener('resize', function () { activeEdge = null; document.body.style.cursor = ''; });

  /* --------------------------------------------------------------- 启动 */
  state.systemTheme = (window.PP_PREFERS_DARK === true) ? 'dark' : 'light';
  document.body.classList.add('theme-dark');

  PP.bridge.invoke('theme.get').then(function (res) {
    state.systemTheme = res && res.mode ? res.mode : 'light';
    applyTheme();
  }).catch(function () { });

  core.boot().then(function (view) {
    state.view = view;
    state.booted = true;
    applyTheme();
    fullRender();
    if (!view.core.ok) {
      PP.ui.toast('err', 'Clash Verge 未运行：请先启动它，PortPilot 会自动认出内核。', 7000);
    } else {
      setTimeout(function () { core.heal('启动时恢复端口'); }, 500);
    }
  }).catch(function (err) {
    document.getElementById('view').innerHTML =
      '<div class="card"><h3>启动失败</h3><p class="hint-line">' +
      PP.util.escapeHtml(err && err.message ? err.message : String(err)) + '</p></div>';
  });
})();
