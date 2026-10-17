/* 界面小组件：提示、模态、可搜索下拉 */
(function () {
  'use strict';

  var PP = window.PP = window.PP || {};
  var esc = PP.util.escapeHtml;

  function toast(kind, text, ms) {
    var host = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.innerHTML = '<div>' + esc(text) + '</div>';
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, ms || (kind === 'err' ? 6000 : 3000));
  }

  function openModal(html) {
    var mask = document.getElementById('modal-mask');
    document.getElementById('modal').innerHTML = html;
    mask.classList.add('open');
  }

  function closeModal() {
    document.getElementById('modal-mask').classList.remove('open');
    document.getElementById('modal').innerHTML = '';
  }

  function confirmModal(opts) {
    return new Promise(function (resolve) {
      openModal(
        '<h2>' + esc(opts.title || '请确认') + '</h2>' +
        '<p>' + (opts.html || esc(opts.body || '')) + '</p>' +
        '<div class="modal-actions">' +
        '<button class="button" data-modal="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
        '<button class="button ' + (opts.danger ? 'danger' : 'primary') + '" data-modal="ok">' +
        esc(opts.okText || '确定') + '</button>' +
        '</div>'
      );
      var modal = document.getElementById('modal');
      modal.onclick = function (e) {
        var btn = e.target.closest('[data-modal]');
        if (!btn) return;
        var act = btn.getAttribute('data-modal');
        closeModal();
        resolve(act === 'ok');
      };
    });
  }

  function infoModal(title, html) {
    openModal(
      '<h2>' + esc(title) + '</h2><div class="hint-line">' + html + '</div>' +
      '<div class="modal-actions"><button class="button primary" data-modal="ok">知道了</button></div>'
    );
    document.getElementById('modal').onclick = function (e) {
      if (e.target.closest('[data-modal]')) closeModal();
    };
  }

  document.addEventListener('click', function (e) {
    var mask = document.getElementById('modal-mask');
    if (e.target === mask) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeModal();
      document.querySelectorAll('.picker.open').forEach(function (p) { p.classList.remove('open'); });
    }
  });

  /* --------------------------------------------------------- 可搜索下拉 */
  function searchSelect(host, opts) {
    opts = opts || {};
    var options = opts.options || [];
    var value = opts.value || null;
    var disabled = !!opts.disabled;
    var open = false;

    host.innerHTML =
      '<div class="picker">' +
      '  <button type="button" class="picker-button"' + (disabled ? ' disabled' : '') + '>' +
      '    <span class="value"></span>' +
      '    <svg class="caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>' +
      '  </button>' +
      '  <div class="picker-panel">' +
      '    <input type="text" placeholder="' + esc(opts.searchPlaceholder || '搜索节点…') + '" />' +
      '    <div class="picker-list"></div>' +
      '  </div>' +
      '</div>';

    var picker = host.querySelector('.picker');
    var button = host.querySelector('.picker-button');
    var valueEl = host.querySelector('.value');
    var panel = host.querySelector('.picker-panel');
    var input = host.querySelector('input');
    var list = host.querySelector('.picker-list');

    function label() { return value || (opts.placeholder || '未选择'); }

    function paintValue() {
      valueEl.textContent = label();
      valueEl.className = 'value' + (value ? '' : ' placeholder');
      button.title = value || '';
    }

    function paintList() {
      var q = (input.value || '').trim().toLowerCase();
      var matched = options.filter(function (o) {
        if (!q) return true;
        return o.name.toLowerCase().indexOf(q) >= 0 || (o.type || '').toLowerCase().indexOf(q) >= 0;
      });
      if (!matched.length) {
        list.innerHTML = '<div class="picker-empty">' + esc(opts.emptyText || '没有匹配的节点') + '</div>';
        return;
      }
      list.innerHTML = matched.slice(0, 400).map(function (o) {
        var delay = (o.delay === null || o.delay === undefined) ? '' :
          '<span class="delay">' + o.delay + 'ms</span>';
        return '<div class="picker-item' + (o.name === value ? ' active' : '') + '" data-name="' +
          esc(o.name) + '" title="' + esc(o.name) + '"><span class="name">' + esc(o.name) + '</span>' + delay + '</div>';
      }).join('');
    }

    function positionPanel() {
      var r = button.getBoundingClientRect();
      var spaceBelow = window.innerHeight - r.bottom - 12;
      var spaceAbove = r.top - 12;
      var openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      var room = Math.max(120, Math.min(300, (openUp ? spaceAbove : spaceBelow) - 58));
      var width = Math.max(r.width, 360);
      var left = Math.min(r.left, window.innerWidth - width - 10);
      panel.style.left = Math.round(Math.max(10, left)) + 'px';
      panel.style.width = Math.round(width) + 'px';
      if (openUp) {
        panel.style.top = 'auto';
        panel.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
      } else {
        panel.style.bottom = 'auto';
        panel.style.top = Math.round(r.bottom + 4) + 'px';
      }
      list.style.maxHeight = room + 'px';
    }

    function setOpen(next) {
      open = next;
      picker.classList.toggle('open', open);
      if (open) {
        positionPanel();
        input.value = '';
        paintList();
        setTimeout(function () { input.focus(); }, 0);
      }
    }

    function onViewportChange() { if (open) positionPanel(); }
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (disabled) return;
      setOpen(!open);
    });

    input.addEventListener('input', paintList);
    input.addEventListener('click', function (e) { e.stopPropagation(); });

    list.addEventListener('click', function (e) {
      var item = e.target.closest('.picker-item');
      if (!item) return;
      value = item.getAttribute('data-name');
      paintValue();
      setOpen(false);
      if (opts.onPick) opts.onPick(value);
    });

    document.addEventListener('click', function (e) {
      if (!picker.contains(e.target)) setOpen(false);
    });

    paintValue();
    return {
      setValue: function (v) { value = v; paintValue(); },
      setOptions: function (list2) { options = list2 || []; paintList(); },
      setDisabled: function (d) { disabled = d; button.disabled = d; if (d) setOpen(false); },
      getValue: function () { return value; }
    };
  }

  function statusBadge(view) {
    var cls = view.status;
    var extra = '';
    if (view.nodeMissing) extra = ' <span class="badge warn">节点已失效</span>';
    return '<span class="badge ' + cls + '"><i></i>' + esc(view.statusText) + '</span>' +
      (view.statusDetail ? ' <span class="inline-note">' + esc(view.statusDetail) + '</span>' : '') + extra;
  }

  function nodeCell(view) {
    if (!view.node) return '<span class="inline-note">未选择</span>';
    return esc(view.node) + (view.delay ? ' <span class="inline-note">' + view.delay + 'ms</span>' : '');
  }

  PP.ui = {
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    confirmModal: confirmModal,
    infoModal: infoModal,
    searchSelect: searchSelect,
    statusBadge: statusBadge,
    nodeCell: nodeCell
  };
})();
