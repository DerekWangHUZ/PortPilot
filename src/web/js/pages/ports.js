/* 端口：新建 / 改号 / 开关 / 删除 */
(function () {
  'use strict';
  var PP = window.PP;
  var esc = PP.util.escapeHtml;

  PP.pages = PP.pages || {};

  PP.pages.ports = {
    title: '端口',
    subtitle: '新建端口、改端口号、开关、删除',

    render: function (ctx) {
      var v = ctx.view;
      var ports = v.ports;
      var suggest = PP.model.nextFreePort(ctx.core.state.ports, ctx.core.state.settings.startPort);

      var head =
        '<div class="page-head"><div><h1>端口</h1><p>' + esc(this.subtitle) + '</p></div>' +
        '<div class="head-actions">' +
        '<button class="button" data-act="open-all"' + (ports.length ? '' : ' disabled') + '>全部打开</button>' +
        '<button class="button" data-act="close-all"' + (ports.length ? '' : ' disabled') + '>全部关闭</button>' +
        '</div></div>';

      var create =
        '<div class="card"><h3>新建端口</h3>' +
        '<div class="row">' +
        '<input type="text" id="new-ports" style="width:280px" placeholder="' + suggest + '，也可以写 10801,10802 或 10801-10805">' +
        '<button class="button primary" data-act="create">新建</button>' +
        '<span class="inline-note">端口只听本机 127.0.0.1，不会弹出防火墙提示，也不需要管理员权限。</span>' +
        '</div></div>';

      var body;
      if (!ports.length) {
        body = '<div class="card"><div class="empty">' +
          '<div class="visual"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div>' +
          '<h2>还没有端口</h2><p>在上面输入一个端口号开始。</p></div></div>';
      } else {
        body =
          '<div class="card"><h3>端口列表<span class="hint">改端口号后会自动重新打开</span></h3>' +
          '<div class="table-wrap"><table class="fixed"><colgroup><col style="width:19%"><col style="width:10%">' +
          '<col><col style="width:20%"><col style="width:14%"></colgroup><thead><tr>' +
          '<th>端口号</th><th>开关</th><th>当前节点</th><th>状态</th><th class="num">操作</th>' +
          '</tr></thead><tbody>' +
          ports.map(function (p) {
            return '<tr>' +
              '<td><input type="number" min="1" max="65535" value="' + p.port + '" data-act="retype" data-port="' + p.port + '"' +
              (v.busy ? ' disabled' : '') + '></td>' +
              '<td><label class="switch"><input type="checkbox" data-act="toggle"' + (p.enabled ? ' checked' : '') +
              ' data-port="' + p.port + '"' + (v.busy ? ' disabled' : '') + '><i></i></label></td>' +
              '<td>' + PP.ui.nodeCell(p) + '</td>' +
              '<td>' + PP.ui.statusBadge(p) + '</td>' +
              '<td class="num"><button class="button small danger" data-act="remove" data-port="' + p.port + '"' +
              (v.busy ? ' disabled' : '') + '>删除</button></td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div></div>';
      }

      return {
        html: head + create + body,
        after: function () {
          var input = document.getElementById('new-ports');
          if (input) {
            input.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') ctx.actions['create']();
            });
          }
        },
        handlers: {
          'create': function () {
            var input = document.getElementById('new-ports');
            var raw = input ? input.value : '';
            if (!raw.trim()) raw = String(PP.model.nextFreePort(ctx.core.state.ports, ctx.core.state.settings.startPort));
            var parsed = PP.util.parsePorts(raw);
            if (parsed.invalid.length) {
              PP.ui.toast('err', '看不懂这些写法：' + parsed.invalid.join('、'));
              return;
            }
            if (!parsed.ports.length) { PP.ui.toast('err', '请填写端口号'); return; }
            ctx.run(function () { return ctx.core.addPorts(parsed.ports); },
              '已新建：' + parsed.ports.join('、'));
          },
          'remove': function (data) {
            var port = parseInt(data.port, 10);
            PP.ui.confirmModal({
              title: '删除端口 ' + port + '？',
              body: '删除后会立刻停止监听这个端口。',
              okText: '删除', danger: true
            }).then(function (ok) {
              if (!ok) return;
              ctx.run(function () { return ctx.core.removePort(port); }, '端口 ' + port + ' 已删除');
            });
          },
          'toggle': function (data, e) {
            var on = e.target.checked;
            ctx.run(function () { return ctx.core.setEnabled(parseInt(data.port, 10), on); },
              on ? ('端口 ' + data.port + ' 已打开') : ('端口 ' + data.port + ' 已关闭'));
          },
          'open-all': function () { ctx.run(function () { return ctx.core.setAllEnabled(true); }, '已经全部打开'); },
          'close-all': function () { ctx.run(function () { return ctx.core.setAllEnabled(false); }, '已经全部关闭'); },
          'retype': function (data, e) {
            var oldPort = parseInt(data.port, 10);
            var next = parseInt(e.target.value, 10);
            if (!PP.util.isValidPort(next) || next === oldPort) { e.target.value = oldPort; return; }
            ctx.run(function () { return ctx.core.changePort(oldPort, next); },
              '端口 ' + oldPort + ' 已改为 ' + next);
          }
        }
      };
    }
  };
})();
