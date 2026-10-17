/* 运行记录 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  PP.pages.logs = {
    title: '运行记录',
    subtitle: '每一次打开、关闭、选节点都记在这里',

    /* 进入页面时读一次记录文件 */
    enter: function (ctx) {
      ctx.run(function () {
        return ctx.core.runLog.read().then(function (items) {
          ctx.setOptions({ logEntries: items });
          ctx.rerender();
        });
      }, null);
    },

    render: function (ctx) {
      var entries = (ctx.options && ctx.options.logEntries) || [];

      var head =
        '<div class="page-head"><div><h1>运行记录</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions">' +
        '<button class="button primary" data-act="load">刷新</button>' +
        '<button class="button danger" data-act="clear">清空</button>' +
        '</div></div>';

      var body;
      if (!entries.length) {
        body = '<div class="card"><div class="empty">' +
          '<div class="visual"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></div>' +
          '<h2>还没有记录</h2><p>点右上角「刷新」读取记录文件。</p></div></div>';
      } else {
        body = '<div class="card"><h3>最近 ' + entries.length + ' 条</h3><div class="table-wrap">' +
          '<table class="fixed"><colgroup><col style="width:15%"><col style="width:19%"><col style="width:8%">' +
          '<col style="width:26%"><col style="width:10%"><col></colgroup><thead><tr><th>时间</th><th>操作</th>' +
          '<th>端口</th><th>节点</th><th>结果</th><th>说明</th>' +
          '</tr></thead><tbody>' +
          entries.slice().reverse().map(function (e) {
            return '<tr>' +
              '<td class="mono">' + esc(PP.util.formatTime(e.time)) + '</td>' +
              '<td>' + esc(e.action) + '</td>' +
              '<td class="mono">' + (e.port === null || e.port === undefined ? '—' : e.port) + '</td>' +
              '<td>' + esc(e.node || '—') + '</td>' +
              '<td><span class="badge ' + (e.ok ? 'on' : 'failed') + '"><i></i>' + (e.ok ? '成功' : '失败') + '</span></td>' +
              '<td>' + esc(e.detail || '') + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div></div>';
      }

      return {
        html: head + body,
        handlers: {
          'load': function () {
            ctx.run(function () {
              return ctx.core.runLog.read().then(function (items) {
                ctx.setOptions({ logEntries: items });
                ctx.rerender();
                PP.ui.toast('ok', '读取到 ' + items.length + ' 条记录');
              });
            }, null);
          },
          'clear': function () {
            PP.ui.confirmModal({ title: '清空运行记录？', body: '只删记录文件，不影响任何端口。', okText: '清空', danger: true })
              .then(function (ok) {
                if (!ok) return;
                ctx.run(function () {
                  return ctx.core.runLog.clear().then(function () {
                    ctx.setOptions({ logEntries: [] });
                    ctx.rerender();
                  });
                }, '运行记录已清空');
              });
          }
        }
      };
    }
  };
})();
