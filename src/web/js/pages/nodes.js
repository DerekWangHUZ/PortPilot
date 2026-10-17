/* 节点：为每个端口选节点、测速 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  PP.pages.nodes = {
    title: '节点',
    subtitle: '为每个端口指定走哪个节点',

    render: function (ctx) {
      var v = ctx.view;
      var ports = v.ports;

      var head =
        '<div class="page-head"><div><h1>节点</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions"><button class="button primary" data-act="refresh">刷新节点</button></div></div>';

      if (!v.core.ok) {
        head += '<div class="err-box">Clash Verge 未运行，读不到节点列表。启动后再回来即可。</div>';
      }

      if (!ports.length) {
        return {
          html: head + '<div class="card"><div class="empty">' +
            '<div class="visual"><svg viewBox="0 0 24 24"><path d="M12 3v18M5 8l7-5 7 5"/></svg></div>' +
            '<h2>还没有端口</h2><p>先去「端口」页新建一个端口，再回来选节点。</p>' +
            '<div style="margin-top:10px"><button class="button primary" data-act="goto-ports">去新建端口</button></div>' +
            '</div></div>',
          handlers: { 'goto-ports': function () { ctx.go('ports'); } }
        };
      }

      var rows = ports.map(function (p) {
        var saved = p.saved
          ? '<span class="badge on"><i></i>已保存</span>'
          : (p.node
            ? '<span class="badge warn"><i></i>待保存</span>'
            : '<span class="badge off"><i></i>未选择</span>');
        return '<tr>' +
          '<td class="mono">' + p.port + '</td>' +
          '<td><label class="switch"><input type="checkbox" data-act="toggle"' + (p.enabled ? ' checked' : '') +
          ' data-port="' + p.port + '"' + (v.busy ? ' disabled' : '') + '><i></i></label></td>' +
          '<td style="min-width:0"><div class="picker-host" data-port="' + p.port + '"></div></td>' +
          '<td>' + saved + '</td>' +
          '<td class="num"><button class="button small" data-act="test" data-port="' + p.port + '"' +
          (p.enabled && p.node ? '' : ' disabled') + '>测速</button></td>' +
          '</tr>';
      }).join('');

      var html = head +
        '<div class="card"><h3>每个端口的节点<span class="hint">共 ' + v.nodes.length + ' 个可选节点</span></h3>' +
        '<div class="table-wrap"><table class="fixed"><colgroup>' +
        '<col style="width:11%"><col style="width:8%"><col style="width:53%"><col style="width:14%"><col style="width:14%">' +
        '</colgroup><thead><tr>' +
        '<th>端口</th><th>开关</th><th>节点</th>' +
        '<th>保存</th><th class="num">测速</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="inline-note" style="margin-top:12px">选节点是即时生效的，不会打断已经在跑的连接。' +
        '「已保存」表示这个选择已经写进 Clash Verge，重启之后不用重新选。</p>' +
        '</div>';

      return {
        html: html,
        after: function (root) {
          ports.forEach(function (p) {
            var host = root.querySelector('.picker-host[data-port="' + p.port + '"]');
            if (!host) return;
            PP.ui.searchSelect(host, {
              options: v.nodes,
              value: p.node,
              placeholder: '选择节点',
              emptyText: v.core.ok ? '没有匹配的节点' : 'Clash Verge 未运行',
              onPick: function (name) {
                ctx.run(function () { return ctx.core.selectNode(p.port, name); },
                  '端口 ' + p.port + ' 已选择：' + name);
              }
            });
          });
        },
        handlers: {
          'refresh': function () { ctx.run(function () { return ctx.refresh(); }, '节点列表已刷新'); },
          'goto-ports': function () { ctx.go('ports'); },
          'toggle': function (data, e) {
            var on = e.target.checked;
            ctx.run(function () { return ctx.core.setEnabled(parseInt(data.port, 10), on); },
              on ? ('端口 ' + data.port + ' 已打开') : ('端口 ' + data.port + ' 已关闭'));
          },
          'test': function (data) {
            var port = parseInt(data.port, 10);
            ctx.run(function () {
              return ctx.core.testPort(port).then(function (delay) {
                PP.ui.toast('ok', '端口 ' + port + ' 测速：' + delay + ' 毫秒');
              });
            }, null);
          }
        }
      };
    }
  };
})();
