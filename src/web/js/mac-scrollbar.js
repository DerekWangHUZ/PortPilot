/* mac-scrollbar：全局自绘 macOS 悬浮滚动条（模板 scrollbar.tsx 的 vanilla 移植）
 * ─────────────────────────────────────────────────────────────────────────
 * 原生 WebView2 滚动条会在窗口最右缘切出一道灰白矩形轨道，并在右上 / 右下
 * 32px 圆角处被裁切。这里改用透明轨道 + 胶囊滑块（.mac-scrollbar，样式见 app.css），
 * 上下各避让 44px 圆角区域，支持 1:1 拖拽与点击轨道跳转。
 *
 * API：PP.macScrollbar.attach(scroller) → 返回 { detach, sync }。
 *      attach 幂等：重复挂同一个容器直接返回已有实例。
 */
(function () {
  'use strict';

  var PP = window.PP = window.PP || {};

  function create(host, scroller) {
    var track = document.createElement('div');
    track.className = 'mac-scrollbar';
    track.setAttribute('aria-hidden', 'true');
    var thumb = document.createElement('div');
    thumb.className = 'mac-scrollbar__thumb';
    track.appendChild(thumb);
    host.appendChild(track);

    var raf = 0;
    var drag = null; // { startY, startScroll }
    var on = false;

    function visible(next) {
      if (on === next) return;
      on = next;
      track.classList.toggle('is-on', on);
    }

    /* 与模板一致：rAF 合帧同步滑块高度与位移 */
    function sync() {
      var view = scroller.clientHeight;
      var total = scroller.scrollHeight;
      if (total <= view + 1) { visible(false); return; }
      visible(true);

      var trackH = track.clientHeight;
      if (trackH <= 0) return;

      var thumbH = Math.max(32, Math.round((trackH * view) / total));
      var maxScroll = Math.max(1, total - view);
      var offset = (scroller.scrollTop / maxScroll) * Math.max(0, trackH - thumbH);

      thumb.style.height = thumbH + 'px';
      thumb.style.transform = 'translateY(' + offset + 'px)';
    }

    function scheduleSync() {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(sync);
    }

    /* ------------------------------------------------------------- 拖拽 */
    thumb.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { thumb.setPointerCapture(e.pointerId); } catch (err) { }
      drag = { startY: e.clientY, startScroll: scroller.scrollTop };
      track.classList.add('is-dragging');
    });

    thumb.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var span = Math.max(1, track.clientHeight - thumb.offsetHeight);
      var maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = drag.startScroll + (e.clientY - drag.startY) * (maxScroll / span);
    });

    function endDrag(e) {
      if (!drag) return;
      drag = null;
      track.classList.remove('is-dragging');
      if (e && e.pointerId !== undefined) {
        try {
          if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
        } catch (err) { }
      }
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);

    /* ------------------------------------------------------ 轨道点击跳转 */
    track.addEventListener('click', function (e) {
      if (e.target === thumb || drag) return;
      var rect = track.getBoundingClientRect();
      var clickY = e.clientY - rect.top;
      var thumbH = thumb.offsetHeight;
      var span = Math.max(1, track.clientHeight - thumbH);
      var maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      var ratio = Math.max(0, Math.min(1, (clickY - thumbH / 2) / span));
      scroller.scrollTo({ top: ratio * maxScroll, behavior: 'smooth' });
    });

    /* ------------------------------------------------------------ 监听 */
    scroller.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', scheduleSync);

    var ro = new ResizeObserver(scheduleSync);
    ro.observe(scroller);
    var inner = scroller.firstElementChild;
    if (inner) ro.observe(inner);

    var mo = null;
    if (inner) {
      mo = new MutationObserver(scheduleSync);
      mo.observe(inner, { childList: true, subtree: true });
    }

    scheduleSync();
    var t = window.setTimeout(sync, 250);

    return {
      detach: function () {
        if (raf) window.cancelAnimationFrame(raf);
        window.clearTimeout(t);
        scroller.removeEventListener('scroll', sync);
        window.removeEventListener('resize', scheduleSync);
        ro.disconnect();
        if (mo) mo.disconnect();
        if (track.parentNode) track.parentNode.removeChild(track);
      },
      sync: sync
    };
  }

  var instances = new WeakMap();

  PP.macScrollbar = {
    /** 挂到一个滚动容器（页面里是 .page）；返回 { detach, sync }。 */
    attach: function (scroller) {
      if (!scroller || !scroller.nodeType) return null;
      if (instances.has(scroller)) return instances.get(scroller);
      var inst = create(document.body, scroller);
      instances.set(scroller, inst);
      return inst;
    }
  };
})();
