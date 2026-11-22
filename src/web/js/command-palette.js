/* command-palette：全局 ⌘K / Ctrl+K 命令面板（模板 cmdk CommandDialog 的 vanilla 实现）
 * ─────────────────────────────────────────────────────────────────────────
 * 弹层用最厚档玻璃（.cmdk，样式见 app.css）；input 过滤 + 分组列表 + 键盘导航。
 *
 * 命令由宿主注册：PP.commandPalette.register({ id, label, hint, icon, group, run })
 *   - group   分组标题（"视图" / "端口" / "节点" / "系统"…），缺省 "其他"
 *   - run()   执行动作；动作失败自行提示（复用 ui.js 的 toast）
 * 内置：7 个页面跳转（app.js 注册）+ 建端口 / 开关选中端口 / 选节点 / 打开设置。
 *
 * 呼出：⌘K / Ctrl+K、侧栏搜索钮（#open-command）；Esc 关闭、↑↓ 选择、Enter 执行。
 */
(function () {
  'use strict';

  var PP = window.PP = window.PP || {};
  var esc = function (t) { return PP.util ? PP.util.escapeHtml(t) : String(t == null ? '' : t); };

  var mask = null;
  var input = null;
  var list = null;
  var activeIndex = 0;
  var filtered = [];
  var commands = [];

  /* ---------------------------------------------------------- 注册与检索 */
  function register(cmd) {
    if (!cmd || !cmd.id || typeof cmd.run !== 'function') return;
    for (var i = 0; i < commands.length; i++) {
      if (commands[i].id === cmd.id) { commands[i] = cmd; return; }
    }
    commands.push(cmd);
  }

  function registerBatch(list2) { (list2 || []).forEach(register); }

  function matches(cmd, q) {
    if (!q) return true;
    var hay = ((cmd.label || '') + ' ' + (cmd.hint || '') + ' ' + (cmd.group || '') + ' ' + (cmd.keywords || ''))
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  /* ------------------------------------------------------------ DOM 构建 */
  function build() {
    if (mask) return;
    mask = document.createElement('div');
    mask.className = 'cmdk-mask';
    mask.id = 'cmdk-mask';
    mask.innerHTML =
      '<div class="cmdk" role="dialog" aria-label="命令面板">' +
      '  <div class="cmdk-input-wrap">' +
      '    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '    <input type="text" class="cmdk-input" id="cmdk-input" placeholder="跳转页面、建端口、开关端口、选节点…" />' +
      '    <span class="cmdk-esc">Esc</span>' +
      '  </div>' +
      '  <div class="cmdk-list" id="cmdk-list"></div>' +
      '</div>';
    document.body.appendChild(mask);
    input = mask.querySelector('#cmdk-input');
    list = mask.querySelector('#cmdk-list');

    mask.addEventListener('mousedown', function (e) {
      if (e.target === mask) close();
    });
    input.addEventListener('input', function () { paint(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var cmd = filtered[activeIndex];
        if (cmd) exec(cmd);
      }
    });
  }

  /* ------------------------------------------------------------- 渲染列表 */
  function paint() {
    var q = (input.value || '').trim().toLowerCase();
    filtered = commands.filter(function (c) { return matches(c, q); });
    if (activeIndex >= filtered.length) activeIndex = 0;

    if (!filtered.length) {
      list.innerHTML = '<div class="cmdk-empty">没有匹配的命令。</div>';
      return;
    }

    var lastGroup = null;
    var html = '';
    filtered.forEach(function (cmd, idx) {
      var group = cmd.group || '其他';
      if (group !== lastGroup) {
        lastGroup = group;
        html += '<div class="cmdk-group-heading">' + esc(group) + '</div>';
      }
      html +=
        '<div class="cmdk-item' + (idx === activeIndex ? ' active' : '') + '" data-idx="' + idx + '">' +
        (cmd.icon ? '<svg viewBox="0 0 24 24">' + cmd.icon + '</svg>' : '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>') +
        '<span class="cmdk-item-label">' + esc(cmd.label) + '</span>' +
        (cmd.hint ? '<span class="cmdk-item-hint">' + esc(cmd.hint) + '</span>' : '') +
        '</div>';
    });
    list.innerHTML = html;

    list.querySelectorAll('.cmdk-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var cmd = filtered[parseInt(el.getAttribute('data-idx'), 10)];
        if (cmd) exec(cmd);
      });
      el.addEventListener('mousemove', function () {
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        if (idx !== activeIndex) { activeIndex = idx; mark(); }
      });
    });

    scrollActiveIntoView();
  }

  function mark() {
    list.querySelectorAll('.cmdk-item').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.getAttribute('data-idx'), 10) === activeIndex);
    });
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    var el = list.querySelector('.cmdk-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!filtered.length) return;
    activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
    mark();
  }

  /* ------------------------------------------------------------- 开合执行 */
  function open() {
    build();
    mask.classList.add('open');
    input.value = '';
    activeIndex = 0;
    paint();
    setTimeout(function () { input.focus(); }, 0);
  }

  function close() {
    if (!mask) return;
    mask.classList.remove('open');
    input.value = '';
  }

  function isOpen() { return !!(mask && mask.classList.contains('open')); }

  function exec(cmd) {
    close();
    try { cmd.run(); } catch (e) {
      if (PP.ui && PP.ui.toast) PP.ui.toast('err', e && e.message ? e.message : String(e));
    }
  }

  /* ------------------------------------------------------------- 全局键位 */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === 'k') {
      e.preventDefault();
      if (isOpen()) close(); else open();
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  PP.commandPalette = {
    register: register,
    registerBatch: registerBatch,
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
