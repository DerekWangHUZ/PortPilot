/* 与宿主（C# 侧）通信 */
(function () {
  'use strict';

  var seq = 0;
  var pending = {};
  var eventHandlers = {};

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.event) {
      (eventHandlers[msg.event] || []).forEach(function (fn) {
        try { fn(msg.data); } catch (e) { }
      });
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    var entry = pending[msg.id];
    if (!entry) return;
    delete pending[msg.id];
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || '宿主调用失败'));
  }

  var bridge = {
    available: !!(window.chrome && window.chrome.webview),
    invoke: function (method, params) {
      if (!bridge.available) return Promise.reject(new Error('当前不在 PortPilot 窗口里运行'));
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        try {
          window.chrome.webview.postMessage({ id: id, method: method, params: params || {} });
        } catch (e) {
          delete pending[id];
          reject(e);
        }
      });
    },
    on: function (name, fn) {
      (eventHandlers[name] = eventHandlers[name] || []).push(fn);
    }
  };

  if (bridge.available) {
    window.chrome.webview.addEventListener('message', function (e) { handle(e.data); });
  }

  window.PPBridge = bridge;
  window.PP = window.PP || {};
  window.PP.bridge = bridge;
})();
