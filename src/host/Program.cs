using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace PortPilot
{
    internal static class Program
    {
        internal const string AppName = "PortPilot";
        internal const string AppVersion = "0.2.0";

        [STAThread]
        private static void Main(string[] args)
        {
            bool selftest = false;
            bool debug = false;
            foreach (var a in args)
            {
                if (string.Equals(a, "--selftest", StringComparison.OrdinalIgnoreCase)) selftest = true;
                if (string.Equals(a, "--debug", StringComparison.OrdinalIgnoreCase)) debug = true;
            }

            if (selftest)
            {
                Environment.ExitCode = SelfTest.Run();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { Native.SetBestDpiAwareness(); }
            catch { /* 老系统忽略 */ }

            Mutex mutex;
            bool created;
            try
            {
                mutex = new Mutex(true, @"Local\PortPilot.SingleInstance", out created);
            }
            catch
            {
                mutex = null;
                created = true;
            }

            if (!created)
            {
                MessageBox.Show(
                    "PortPilot 已经打开了，请使用已经打开的窗口。",
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            try
            {
                Paths.EnsureAppDirs();
                Application.Run(new MainForm(debug));
            }
            catch (Exception ex)
            {
                ErrorLog.Write("启动失败", ex);
                MessageBox.Show(
                    "PortPilot 无法启动：" + Environment.NewLine + ex.Message +
                    Environment.NewLine + Environment.NewLine +
                    "详细信息：" + ErrorLog.Path,
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (mutex != null)
                {
                    try { mutex.ReleaseMutex(); } catch { }
                    mutex.Close();
                }
            }
        }
    }

    internal static class ErrorLog
    {
        internal static string Path
        {
            get { return System.IO.Path.Combine(Paths.AppData, "error.log"); }
        }

        internal static void Write(string title, Exception ex)
        {
            try
            {
                Directory.CreateDirectory(Paths.AppData);
                File.AppendAllText(Path,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + title + Environment.NewLine +
                    ex + Environment.NewLine + new string('-', 60) + Environment.NewLine,
                    System.Text.Encoding.UTF8);
            }
            catch { }
        }

        internal static void WriteText(string title, string text)
        {
            try
            {
                Directory.CreateDirectory(Paths.AppData);
                File.AppendAllText(Path,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + title + Environment.NewLine +
                    text + Environment.NewLine + new string('-', 60) + Environment.NewLine,
                    System.Text.Encoding.UTF8);
            }
            catch { }
        }
    }
}
