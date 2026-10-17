/* mihomo REST API 封装（走宿主的命名管道 HTTP） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.PP = root.PP || {}; root.PP.api = factory(root.PP.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  function makeError(message, res) {
    var err = new Error(message);
    err.status = res ? res.status : 0;
    err.body = res ? res.body : '';
    return err;
  }

  function messageFrom(res) {
    if (!res) return '内核没有响应';
    if (!res.status) return res.error || '内核没有响应（Clash Verge 可能没有运行）';
    var parsed = util.safeJson(res.body, null);
    if (parsed && parsed.message) return parsed.message;
    if (res.body && res.body.length < 200) return res.body;
    return 'HTTP ' + res.status + (res.reason ? ' ' + res.reason : '');
  }

  function createApi(bridge) {
    function raw(method, path, body, timeout) {
      return bridge.invoke('pipe.http', {
        method: method,
        path: path,
        body: body === undefined ? null : body,
        timeout: timeout || 20000
      }).then(function (res) {
        if (!res) throw makeError('内核没有响应', null);
        return res;
      });
    }

    function json(method, path, body, timeout) {
      return raw(method, path, body, timeout).then(function (res) {
        if (res.status < 200 || res.status >= 300) throw makeError(messageFrom(res), res);
        if (!res.body) return null;
        var parsed = util.safeJson(res.body, undefined);
        if (parsed === undefined) throw makeError('内核返回了无法解析的内容', res);
        return parsed;
      });
    }

    function seg(name) { return encodeURIComponent(String(name)); }

    return {
      raw: raw,
      json: json,

      version: function () { return json('GET', '/version'); },

      configs: function () { return json('GET', '/configs'); },

      proxies: function () {
        return json('GET', '/proxies').then(function (data) {
          return (data && data.proxies) || {};
        });
      },

      /* 只保留真实节点（去掉策略组与内置项） */
      nodes: function () {
        return json('GET', '/proxies').then(function (data) {
          var map = (data && data.proxies) || {};
          var list = [];
          Object.keys(map).forEach(function (name) {
            var proxy = map[name];
            if (!proxy) return;
            if (!util.isNodeCandidate(proxy)) return;
            list.push({
              name: proxy.name || name,
              type: proxy.type || '',
              delay: util.lastDelay(proxy),
              alive: proxy.alive !== false
            });
          });
          list.sort(function (a, b) {
            var da = a.delay === null ? 999999 : a.delay;
            var db = b.delay === null ? 999999 : b.delay;
            if (da !== db) return da - db;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
          });
          return list;
        });
      },

      proxyState: function (name) {
        return json('GET', '/proxies/' + seg(name)).then(function (data) {
          return {
            name: data.name || name,
            type: data.type || '',
            now: data.now || null,
            all: data.all || [],
            alive: data.alive !== false
          };
        });
      },

      selectNode: function (group, node) {
        return raw('PUT', '/proxies/' + seg(group), { name: node }, 15000).then(function (res) {
          if (res.status < 200 || res.status >= 300) throw makeError(messageFrom(res), res);
          return true;
        });
      },

      delay: function (name, url, timeoutMs) {
        var q = '/proxies/' + seg(name) + '/delay?timeout=' + (timeoutMs || 5000) +
          '&url=' + encodeURIComponent(url || 'http://cp.cloudflare.com/generate_204');
        return json('GET', q, null, (timeoutMs || 5000) + 5000).then(function (data) {
          return (data && data.delay) || 0;
        });
      },

      connections: function () {
        return json('GET', '/connections', null, 12000).then(function (data) {
          return data || { connections: [], downloadTotal: 0, uploadTotal: 0 };
        });
      },

      rules: function () {
        return json('GET', '/rules').then(function (data) {
          return (data && data.rules) || [];
        });
      },

      /* 应用完整配置文本：PUT /configs {"payload": ...} */
      applyPayload: function (text, timeout) {
        return raw('PUT', '/configs', { payload: text }, timeout || 25000).then(function (res) {
          if (res.status < 200 || res.status >= 300) throw makeError(messageFrom(res), res);
          return true;
        });
      }
    };
  }

  return { createApi: createApi, messageFrom: messageFrom };
});
