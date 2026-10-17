using System;
using System.Windows.Forms;

namespace PortPilot
{
    internal static class Dialogs
    {
        internal static string SaveText(string defaultName, string content, string filter)
        {
            using (var dlg = new SaveFileDialog())
            {
                dlg.Title = "导出 PortPilot 配置";
                dlg.FileName = string.IsNullOrEmpty(defaultName) ? "portpilot-config.json" : defaultName;
                dlg.Filter = string.IsNullOrEmpty(filter) ? "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*" : filter;
                dlg.AddExtension = true;
                dlg.OverwritePrompt = true;
                if (dlg.ShowDialog() != DialogResult.OK) return null;
                FileOps.WriteText(dlg.FileName, content);
                return dlg.FileName;
            }
        }

        internal static object OpenText()
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Title = "导入 PortPilot 配置";
                dlg.Filter = "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*";
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog() != DialogResult.OK) return null;
                var text = FileOps.ReadText(dlg.FileName);
                return Json.Map("path", dlg.FileName, "text", text);
            }
        }

        internal static string PickFolder(string title)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = string.IsNullOrEmpty(title) ? "选择文件夹" : title;
                dlg.ShowNewFolderButton = true;
                if (dlg.ShowDialog() != DialogResult.OK) return null;
                return dlg.SelectedPath;
            }
        }

        internal static string SaveFile(string title, string defaultName, string filter)
        {
            using (var dlg = new SaveFileDialog())
            {
                dlg.Title = title;
                dlg.FileName = defaultName;
                dlg.Filter = filter;
                if (dlg.ShowDialog() != DialogResult.OK) return null;
                return dlg.FileName;
            }
        }

        internal static void Info(string message, string title)
        {
            MessageBox.Show(message, string.IsNullOrEmpty(title) ? Program.AppName : title,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        internal static bool Confirm(string message, string title)
        {
            return MessageBox.Show(message, string.IsNullOrEmpty(title) ? Program.AppName : title,
                MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK;
        }
    }
}
