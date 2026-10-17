using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PortPilot
{
    internal sealed class MainForm : Form
    {
        /* --------------------------------------------- 无边框窗口：拖拽/缩放常量 */
        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_ACTIVATE = 0x0006;
        private const int WM_ERASEBKGND = 0x0014;
        private const int WM_GETMINMAXINFO = 0x0024;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public POINT ptReserved;
            public POINT ptMaxSize;
            public POINT ptMaxPosition;
            public POINT ptMinTrackSize;
            public POINT ptMaxTrackSize;
        }

        private readonly bool _debug;
        private readonly WebView2 _web;
        private Bridge _bridge;
        private FileSystemWatcher _watcher;
        private System.Windows.Forms.Timer _watchTimer;

        internal MainForm(bool debug)
        {
            _debug = debug;
            Text = "PortPilot";
            var work = Screen.PrimaryScreen.WorkingArea;
            Width = Math.Min(1460, Math.Max(980, work.Width - 160));
            Height = Math.Min(940, Math.Max(640, work.Height - 140));
            MinimumSize = new Size(820, 540);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(28, 28, 30);
            Font = new Font("Microsoft YaHei UI", 9f);
            FormBorderStyle = FormBorderStyle.None;
            Padding = new Padding(0, 0, 0, 1);
            DoubleBuffered = true;

            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);

            Load += OnFormLoad;
            FormClosing += OnFormClosing;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style |= 0x00040000;  // WS_THICKFRAME：保留可缩放能力
                cp.Style |= 0x00010000;  // WS_MAXIMIZEBOX
                cp.Style |= 0x00020000;  // WS_MINIMIZEBOX
                cp.Style |= 0x00080000;  // WS_SYSMENU
                cp.Style &= ~0x00C00000; // 去掉 WS_CAPTION：标题栏由界面自己画
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                // 与示例项目相同的写法：非最大化时把客户区底部多算 1px，消除拖动缩放时的闪白
                if (WindowState != FormWindowState.Maximized)
                {
                    var rc = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                    rc.Bottom += 1;
                    Marshal.StructureToPtr(rc, m.LParam, false);
                }
                m.Result = IntPtr.Zero;   // 客户区铺满整个窗口
                return;
            }
            if (m.Msg == WM_ERASEBKGND)
            {
                m.Result = (IntPtr)1;     // 背景不擦除，避免缩放瞬间闪白
                return;
            }
            if (m.Msg == WM_ACTIVATE)
            {
                ApplyNativeFrame();
            }
            if (m.Msg == WM_GETMINMAXINFO)
            {
                var screen = Screen.FromControl(this);
                var mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
                mmi.ptMaxPosition.x = screen.WorkingArea.Left - screen.Bounds.Left;
                mmi.ptMaxPosition.y = screen.WorkingArea.Top - screen.Bounds.Top;
                mmi.ptMaxSize.x = screen.WorkingArea.Width;
                mmi.ptMaxSize.y = screen.WorkingArea.Height;
                mmi.ptMinTrackSize.x = MinimumSize.Width;
                mmi.ptMinTrackSize.y = MinimumSize.Height;
                Marshal.StructureToPtr(mmi, m.LParam, false);
                return;
            }
            base.WndProc(ref m);
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

        [StructLayout(LayoutKind.Sequential)]
        private struct MARGINS { public int cxLeftWidth, cxRightWidth, cyTopHeight, cyBottomHeight; }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        /// <summary>
        /// 与示例项目（Wails）完全一致的做法：把 DWM 边框向客户区延伸 1px。
        /// 于是照样有系统投影与 Win11 圆角，但没有标题栏，窗口四周也不会多出任何可见边框。
        /// </summary>
        private void ApplyNativeFrame()
        {
            try
            {
                var margins = new MARGINS { cxLeftWidth = 1, cxRightWidth = 1, cyTopHeight = 1, cyBottomHeight = 1 };
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            }
            catch { }
        }


        internal void WindowMinimize() { WindowState = FormWindowState.Minimized; }

        internal void WindowToggleMaximize()
        {
            WindowState = WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal
                : FormWindowState.Maximized;
        }

        internal void WindowBeginDrag() { Native.BeginWindowDrag(Handle); }
        internal void WindowBeginResize(int hitTestCode) { Native.BeginWindowResize(Handle, hitTestCode); }

        internal bool IsMaximized { get { return WindowState == FormWindowState.Maximized; } }

        /// <summary>描边颜色跟着主题走，避免浅色主题下留一圈黑边。</summary>
        internal void SetFrameColor(string color)
        {
            try
            {
                if (string.IsNullOrEmpty(color)) return;
                var text = color.TrimStart('#');
                if (text.Length < 6) return;
                int r = Convert.ToInt32(text.Substring(0, 2), 16);
                int g = Convert.ToInt32(text.Substring(2, 2), 16);
                int b = Convert.ToInt32(text.Substring(4, 2), 16);
                var frame = Color.FromArgb(r, g, b);
                BackColor = frame;
                if (_web != null && _web.CoreWebView2 != null) _web.DefaultBackgroundColor = frame;
            }
            catch { }
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                Paths.EnsureAppDirs();
                ApplyNativeFrame();
                if (!File.Exists(Paths.IndexHtml))
                    throw new FileNotFoundException("找不到界面文件，请重新运行 build.ps1：" + Paths.IndexHtml);

                var env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData, null);
                await _web.EnsureCoreWebView2Async(env);

                var core = _web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = _debug;
                core.Settings.AreBrowserAcceleratorKeysEnabled = _debug;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;

                _web.DefaultBackgroundColor = BackColor;
                _bridge = new Bridge(this, core);
                core.WebMessageReceived += _bridge.OnWebMessage;

                Theme.StartWatching(delegate (string mode)
                {
                    try
                    {
                        BeginInvoke((Action)delegate ()
                        {
                            if (_bridge != null) _bridge.PushEvent("theme", Json.Map("mode", mode));
                        });
                    }
                    catch { }
                });

                core.SetVirtualHostNameToFolderMapping(
                    "portpilot.local", Paths.WebDir, CoreWebView2HostResourceAccessKind.Allow);
                core.NavigationCompleted += OnNavigationCompleted;
                core.Navigate("https://portpilot.local/index.html");
            }
            catch (Exception ex)
            {
                ErrorLog.Write("界面初始化失败", ex);
                MessageBox.Show(
                    "PortPilot 界面初始化失败：" + Environment.NewLine + ex.Message +
                    Environment.NewLine + Environment.NewLine +
                    "请确认已安装 Microsoft Edge WebView2 运行时，且 dist 目录完整。",
                    Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess) return;
            StartConfigWatcher();
        }

        /// <summary>
        /// 只监听 Clash Verge 重写运行时配置这件事（事件驱动，不做定时轮询），
        /// 让前端有机会在端口被 Verge 重写配置冲掉之后自动补一次。
        /// </summary>
        private void StartConfigWatcher()
        {
            try
            {
                if (_watcher != null) return;
                _watchTimer = new System.Windows.Forms.Timer();
                _watchTimer.Interval = 1800;
                _watchTimer.Tick += delegate (object s, EventArgs a)
                {
                    _watchTimer.Stop();
                    if (_bridge != null) _bridge.PushEvent("config.changed", Json.Map("path", Paths.ClashConfig));
                };

                _watcher = new FileSystemWatcher(Paths.VergeData, "clash-verge.yaml");
                _watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName;
                FileSystemEventHandler onChange = delegate (object s, FileSystemEventArgs a)
                {
                    try { BeginInvoke((Action)delegate () { _watchTimer.Stop(); _watchTimer.Start(); }); }
                    catch { }
                };
                _watcher.Changed += onChange;
                _watcher.Created += onChange;
                _watcher.Renamed += delegate (object s, RenamedEventArgs a) { onChange(s, a); };
                _watcher.EnableRaisingEvents = true;
            }
            catch (Exception ex)
            {
                ErrorLog.Write("配置监听启动失败", ex);
            }
        }

        private void StopConfigWatcher()
        {
            try
            {
                if (_watcher != null)
                {
                    _watcher.EnableRaisingEvents = false;
                    _watcher.Dispose();
                    _watcher = null;
                }
                if (_watchTimer != null)
                {
                    _watchTimer.Stop();
                    _watchTimer.Dispose();
                    _watchTimer = null;
                }
            }
            catch { }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            StopConfigWatcher();
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (Bridge.Pending > 0 && DateTime.UtcNow < deadline)
            {
                Application.DoEvents();
                Thread.Sleep(30);
            }
            try { if (_bridge != null) _bridge.Detach(); }
            catch { }
        }
    }
}
