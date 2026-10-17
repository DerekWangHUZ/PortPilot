using System;
using System.Runtime.InteropServices;

namespace PortPilot
{
    internal static class Native
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 2;

        /// <summary>让无边框窗口跟着鼠标走（由前端在标题栏按下时触发）。</summary>
        /// <summary>让系统接管缩放：把这次按下当作点在非客户区边框上（示例项目也是这个做法）。</summary>
        internal static void BeginWindowResize(IntPtr handle, int hitTestCode)
        {
            try
            {
                ReleaseCapture();
                SendMessage(handle, WM_NCLBUTTONDOWN, (IntPtr)hitTestCode, IntPtr.Zero);
            }
            catch { }
        }
        internal static void BeginWindowDrag(IntPtr handle)
        {
            try
            {
                ReleaseCapture();
                SendMessage(handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            }
            catch { }
        }

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value);

        private const int AttachParentProcess = -1;

        /// <summary>以 --selftest 运行时把输出接回父控制台。</summary>
        internal static void AttachParentConsole()
        {
            try { AttachConsole(AttachParentProcess); }
            catch { }
        }

        internal static void SetBestDpiAwareness()
        {
            try
            {
                if (Environment.OSVersion.Version.Major >= 6 &&
                    SetProcessDpiAwareness(2) == 0) return; // PROCESS_PER_MONITOR_DPI_AWARE
            }
            catch { }
            try { SetProcessDPIAware(); }
            catch { }
        }
    }
}
