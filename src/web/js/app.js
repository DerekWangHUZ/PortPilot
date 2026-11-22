/* 应用外壳：导航、渲染、事件
 * ─────────────────────────────────────────────────────────────────────────
 * 结构对齐 macUI-SolidGlass（S1-S11）：
 *   - .window → .main → .page → .page-inner → .toolbar 外壳链路（index.html）
 *   - 侧栏 fixed 悬浮 + 五段解剖；导航 = 999px 胶囊
 *   - is-desktop 接线：拖拽带（.drag-strip + [data-drag]）、window.state → html.is-maximized
 *   - 自绘滚动条 PP.macScrollbar.attach(.page)；⌘K 命令面板 PP.commandPalette
 */
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
  var WORKBENCH_IDS = ['overview', 'ports', 'nodes', 'connections', 'rules'];
  var SYSTEM_IDS = ['settings', 'logs'];

  var state = { page: 'overview', options: {}, view: null, booted: false, systemTheme: 'light', healTimer: null, maximized: false };
  var core = PP.core.createCore({ bridge: PP.bridge });
  var viewEl = document.getElementById('view');
  var pageEl = document.getElementById('page');
  var toolbarTitle = document.getElementById('toolbar-title');
  var toolbarSubtitle = document.getElementById('toolbar-subtitle');
  var toolbarActions = document.getElementById('toolbar-actions');

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
      pageEl.scrollTop = 0;
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

  /* --------------------------------------------------------------- 导航 */
  /* S3/S4：侧栏分两组（工作台 / 系统），导航项 = 33px 胶囊 */
  function navItemHtml(item, count) {
    var badge = count ? '<b>' + count + '</b>' : '';
    return '<button class="nav-item' + (state.page === item.id ? ' active' : '') + '" data-page="' + item.id + '"' +
      (state.page === item.id ? ' aria-current="page"' : '') + '>' +
      '<svg viewBox="0 0 24 24">' + item.icon + '</svg><span>' + item.label + '</span>' + badge + '</button>';
  }

  function renderNav() {
    var v = state.view;
    var count = v ? v.ports.length : 0;
    var listening = v ? v.ports.filter(function (p) { return p.status === 'on'; }).length : 0;

    var workbench = WORKBENCH_IDS.map(function (id) {
      var item = NAV.filter(function (n) { return n.id === id; })[0];
      return navItemHtml(item, item.id === 'ports' ? count : (item.id === 'connections' ? listening : 0));
    }).join('');
    var system = SYSTEM_IDS.map(function (id) {
      return navItemHtml(NAV.filter(function (n) { return n.id === id; })[0], 0);
    }).join('');

    var nav = document.getElementById('nav');
    nav.innerHTML = workbench;
    var navSystem = document.getElementById('nav-system');
    navSystem.innerHTML = system;

    document.querySelectorAll('#nav-scroll [data-page]').forEach(function (btn) {
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
    detail.textContent = (v.core.version || '') +
      (v.core.mixedPort ? ' · 混合端口 ' + v.core.mixedPort : '') +
      (v.core.tunEnabled ? ' · TUN 已开启' : '');
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

  /* --------------------------------------------------------------- 页面渲染 */
  /* S8：页面只产出 .page-head 以下的内容；标题归 .toolbar（title1 22px），
     副标题进 .toolbar__subtitle，动作按钮进 .toolbar__actions。 */
  function renderPage(keepScroll) {
    var page = PP.pages[state.page];
    if (!page) return;
    var scrollTop = pageEl.scrollTop;
    ctx.view = state.view || core.view();
    var result = page.render(ctx);
    ctx.actions = result.handlers || {};

    var html = result.html;
    var head = extractHead(result);
    html = head.html;

    toolbarTitle.textContent = page.title || '';
    toolbarSubtitle.textContent = head.subtitle || '';
    toolbarActions.innerHTML = head.actions || '';
    viewEl.innerHTML = html;

    bindActionHost(viewEl);
    bindActionHost(toolbarActions);

    if (result.after) {
      try { result.after(viewEl); } catch (e) { }
    }
    if (keepScroll) pageEl.scrollTop = scrollTop;
    if (PP.macScrollbar) PP.macScrollbar.attach(pageEl).sync();
  }

  /* 从页面产出里摘出 .page-head 的副标题与动作，正文用剩余部分 */
  function extractHead(result) {
    var tmp = document.createElement('div');
    tmp.innerHTML = result.html;
    var headEl = tmp.querySelector('.page-head');
    var out = { html: result.html, subtitle: '', actions: '' };
    if (!headEl) return out;
    var p = headEl.querySelector('p');
    var acts = headEl.querySelector('.head-actions');
    out.subtitle = p ? p.textContent : '';
    out.actions = acts ? acts.innerHTML : '';
    headEl.parentNode.removeChild(headEl);
    out.html = tmp.innerHTML;
    return out;
  }

  function bindActionHost(host) {
    if (!host) return;
    host.onclick = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (!fn) return;
      e.preventDefault();
      fn(datasetOf(el), e);
    };
    host.onchange = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (fn) fn(datasetOf(el), e);
    };
    host.oninput = function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var fn = ctx.actions[el.getAttribute('data-act')];
      if (fn && el.getAttribute('data-live') === '1') fn(datasetOf(el), e);
    };
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

  /* S9：宿主推来的窗口最大化状态 → html.is-maximized（CSS 归零圆角与描边） */
  PP.bridge.on('window.state', function (data) {
    setMaximized(!!(data && data.maximized));
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
    syncPaletteLabels();
  });

  core.on('busy', function (busy) {
    document.getElementById('progress').classList.toggle('on', !!busy);
    if (state.booted) renderPage(true);
  });

  document.getElementById('nav-quit').addEventListener('click', function () {
    PP.bridge.invoke('app.exit');
  });

  /* ------------------------------------------------ 命令面板（S11） */
  function setMaximized(v) {
    state.maximized = !!v;
    document.documentElement.classList.toggle('is-maximized', state.maximized);
    var maxLight = document.querySelector('.light.max');
    if (maxLight) {
      maxLight.setAttribute('aria-label', state.maximized ? '还原' : '最大化');
      maxLight.title = state.maximized ? '还原' : '最大化';
    }
  }

  function syncPaletteLabels() {
    var v = state.view;
    if (!v || !PP.commandPalette) return;
    var toggle = v.ports.length
      ? { id: 'port-toggle-selected', group: '端口', icon: '<path d="M4 7h16M4 12h16M4 17h10"/>',
          label: (v.ports[0].enabled ? '关闭' : '打开') + '端口 ' + v.ports[0].port,
          hint: '第一个端口', keywords: 'port toggle on off 开关',
          run: function () {
            var p = state.view.ports[0];
            if (!p) return;
            ctx.run(function () { return core.setEnabled(p.port, !p.enabled); },
              '端口 ' + p.port + ' 已' + (p.enabled ? '关闭' : '打开'));
          } }
      : null;
    var nodeCmd = (v.ports.length && v.nodes.length)
      ? { id: 'node-select-first-port', group: '节点', icon: '<path d="M12 3v6M12 15v6M5 12h14"/><circle cx="12" cy="12" r="3"/>',
          label: '为端口 ' + v.ports[0].port + ' 选择节点',
          hint: '跳到节点页', keywords: 'node select 选择 节点',
          run: function () { ctx.go('nodes'); } }
      : null;
    if (toggle) PP.commandPalette.register(toggle);
    if (nodeCmd) PP.commandPalette.register(nodeCmd);
  }

  function registerCommands() {
    if (!PP.commandPalette) return;

    /* 视图跳转：7 页 */
    NAV.forEach(function (item) {
      PP.commandPalette.register({
        id: 'go-' + item.id,
        group: '视图',
        icon: item.icon,
        label: '跳转到「' + item.label + '」',
        hint: '页面',
        keywords: item.id + ' goto page',
        run: function () { ctx.go(item.id); }
      });
    });

    /* 建端口（跳到端口页并聚焦输入框） */
    PP.commandPalette.register({
      id: 'port-create',
      group: '端口',
      icon: '<path d="M12 5v14M5 12h14"/>',
      label: '新建端口…',
      hint: '端口页',
      keywords: 'create port 新建 端口 add',
      run: function () {
        ctx.go('ports');
        setTimeout(function () {
          var inputEl = document.getElementById('new-ports');
          if (inputEl) inputEl.focus();
        }, 60);
      }
    });

    /* 打开设置 */
    PP.commandPalette.register({
      id: 'open-settings',
      group: '系统',
      icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
      label: '打开设置',
      hint: '外观 / 配置 / 还原',
      keywords: 'settings 设置 open',
      run: function () { ctx.go('settings'); }
    });
  }

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
      else PP.bridge.invoke('window.toggleMaximize').then(function (r) { setMaximized(!!(r && r.maximized)); });
    });
  });

  /* 桌面接线：data-drag 拖动区（侧栏 chrome / header / drag-strip / 工具栏标题区） */
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (!e.target.closest('[data-drag], .drag-strip, .toolbar__heading')) return;
    PP.bridge.invoke('window.beginDrag');
  });

  document.addEventListener('dblclick', function (e) {
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (!e.target.closest('[data-drag], .drag-strip, .toolbar__heading')) return;
    PP.bridge.invoke('window.toggleMaximize').then(function (r) { setMaximized(!!(r && r.maximized)); });
  });

  /* 侧栏搜索钮 → 命令面板（S11） */
  document.getElementById('open-command').addEventListener('click', function () {
    if (PP.commandPalette) PP.commandPalette.open();
  });

  /* ------------------------------------------------ 桌面运行标记（S9） */
  var isDesktop = !!(window.go && window.go.main && window.go.main.App);
  document.documentElement.classList.toggle('is-desktop', isDesktop);

  /* 桌面端：内容区顶部 48px 拖拽带（模板 desktop.js ensureDragStrip） */
  function ensureDragStrip() {
    if (!document.body || document.querySelector('.drag-strip')) return;
    var strip = document.createElement('div');
    strip.className = 'drag-strip';
    strip.setAttribute('data-drag', '');
    strip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(strip);
  }
  if (isDesktop) ensureDragStrip();

  /* ------------------------------------------------ 边缘拖动缩放（保留既有机制） */
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

  registerCommands();

  PP.bridge.invoke('theme.get').then(function (res) {
    state.systemTheme = res && res.mode ? res.mode : 'light';
    applyTheme();
  }).catch(function () { });

  core.boot().then(function (view) {
    state.view = view;
    state.booted = true;
    applyTheme();
    fullRender();
    syncPaletteLabels();
    /* 初始最大化状态：宿主 window.state 事件会在 watcher 首次采样后推来 */
    if (PP.macScrollbar) PP.macScrollbar.attach(pageEl);
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
