using System;
using System.IO;
using System.Reflection;

namespace PortPilot
{
    /// <summary>应用与 Clash Verge 的路径约定（全部集中在这里）。</summary>
    internal static class Paths
    {
        internal const string VergeDataFolderName = "io.github.clash-verge-rev.clash-verge-rev";

        internal static string ExeDir
        {
            get
            {
                var loc = Assembly.GetEntryAssembly() != null ? Assembly.GetEntryAssembly().Location : null;
                if (string.IsNullOrEmpty(loc)) loc = AppDomain.CurrentDomain.BaseDirectory;
                return Path.GetDirectoryName(loc);
            }
        }

        internal static string Roaming
        {
            get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); }
        }

        internal static string LocalAppData
        {
            get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); }
        }

        internal static string AppData
        {
            get { return Path.Combine(Roaming, "PortPilot"); }
        }

        internal static string BackupRoot
        {
            get { return Path.Combine(AppData, "backup"); }
        }

        internal static string StateFile
        {
            get { return Path.Combine(AppData, "state.json"); }
        }

        internal static string RunLogFile
        {
            get { return Path.Combine(AppData, "run-log.jsonl"); }
        }

        internal static string WebViewData
        {
            get { return Path.Combine(LocalAppData, "PortPilot", "webview"); }
        }

        internal static string VergeData
        {
            get { return Path.Combine(Roaming, VergeDataFolderName); }
        }

        internal static string ClashConfig
        {
            get { return Path.Combine(VergeData, "clash-verge.yaml"); }
        }

        internal static string VergeAppConfig
        {
            get { return Path.Combine(VergeData, "verge.yaml"); }
        }

        internal static string ProfilesYaml
        {
            get { return Path.Combine(VergeData, "profiles.yaml"); }
        }

        internal static string ProfilesDir
        {
            get { return Path.Combine(VergeData, "profiles"); }
        }

        internal static string WebDir
        {
            get { return Path.Combine(ExeDir, "web"); }
        }

        internal static string IndexHtml
        {
            get { return Path.Combine(WebDir, "index.html"); }
        }

        internal static void EnsureAppDirs()
        {
            Directory.CreateDirectory(AppData);
            Directory.CreateDirectory(BackupRoot);
            Directory.CreateDirectory(WebViewData);
        }
    }
}
