/* 总览 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  PP.pages.overview = {
    title: '总览',
    subtitle: '所有端口的现状',

    render: function (ctx) {
      var v = ctx.view;
      var ports = v.ports;
      var onCount = ports.filter(function (p) { return p.status === 'on'; }).length;
      var failed = ports.filter(function (p) { return p.status === 'failed'; });

      var head =
        '<div class="page-head"><div><h1>总览</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions">' +
        '<button class="button" data-act="open-all"' + (ports.length ? '' : ' disabled') + '>全部打开</button>' +
        '<button class="button" data-act="close-all"' + (ports.length ? '' : ' disabled') + '>全部关闭</button>' +
        '<button class="button primary" data-act="refresh">刷新</button>' +
        '</div></div>';

      if (!v.core.ok) {
        head += '<div class="err-box">Clash Verge 未运行，或内核管道连不上：' +
          esc(v.core.error || '请先启动 Clash Verge') + '</div>';
      }
      if (failed.length) {
        head += '<div class="warn-box">有 ' + failed.length + ' 个端口没有成功打开：' +
          failed.map(function (p) { return p.port; }).join('、') + '。请检查端口号是否被占用。</div>';
      }

      var cards =
        '<div class="grid cols-3" style="margin-bottom:14px">' +
        '<div class="stat"><span>端口</span><b>' + ports.length + '</b><small>已打开 ' + onCount + ' 个</small></div>' +
        '<div class="stat"><span>节点</span><b>' + v.nodes.length + '</b><small>可选节点</small></div>' +
        '<div class="stat"><span>Clash Verge</span><b>' + (v.core.ok ? '已就绪' : '未就绪') + '</b><small>' +
        esc(v.core.version || '—') + '</small></div>' +
        '</div>';

      var body;
      if (!ports.length) {
        body =
          '<div class="card"><div class="empty">' +
          '<div class="visual"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg></div>' +
          '<h2>还没有端口</h2>' +
          '<p>去「端口」页新建一个端口号（默认从 10801 起），打开开关、选好节点，这个端口就能代理流量了。</p>' +
          '<div style="margin-top:10px"><button class="button primary" data-act="goto-ports">去新建端口</button></div>' +
          '</div></div>';
      } else {
        body =
          '<div class="card"><h3>端口状态<span class="hint">端口号 / 开关 / 当前节点 / 状态</span></h3>' +
          '<div class="table-wrap"><table class="fixed"><colgroup><col style="width:22%"><col style="width:11%">' +
          '<col><col style="width:22%"><col style="width:12%"></colgroup><thead><tr>' +
          '<th>端口号</th><th>开关</th><th>当前节点</th><th>状态</th><th class="num">测速</th>' +
          '</tr></thead><tbody>' +
          ports.map(function (p) {
            return '<tr>' +
              '<td class="mono">127.0.0.1:' + p.port + '</td>' +
              '<td><label class="switch"><input type="checkbox" data-act="toggle"' +
              (p.enabled ? ' checked' : '') + ' data-port="' + p.port + '"' +
              (v.busy ? ' disabled' : '') + '><i></i></label></td>' +
              '<td>' + PP.ui.nodeCell(p) + '</td>' +
              '<td>' + PP.ui.statusBadge(p) + '</td>' +
              '<td class="num"><button class="button small" data-act="test" data-port="' + p.port + '"' +
              (p.enabled && p.node ? '' : ' disabled') + '>测速</button></td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div></div>';
      }

      return {
        html: head + cards + body,
        handlers: {
          'open-all': function () { ctx.run(function () { return ctx.core.setAllEnabled(true); }, '已经全部打开'); },
          'close-all': function () { ctx.run(function () { return ctx.core.setAllEnabled(false); }, '已经全部关闭'); },
          'refresh': function () { ctx.run(function () { return ctx.refresh({ withConnections: true }); }, null); },
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
