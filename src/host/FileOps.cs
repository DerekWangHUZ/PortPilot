using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PortPilot
{
    /// <summary>文件原语：读、原子写、备份、还原。</summary>
    internal static class FileOps
    {
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        internal static bool Exists(string path)
        {
            return !string.IsNullOrEmpty(path) && File.Exists(path);
        }

        internal static string ReadText(string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("找不到文件：" + path, path);
            var bytes = File.ReadAllBytes(path);
            // 容忍 BOM
            if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            {
                return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
            }
            return Encoding.UTF8.GetString(bytes);
        }

        internal static void WriteText(string path, string text)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, text ?? string.Empty, Utf8NoBom);
        }

        /// <summary>原子写：先写临时文件，再替换目标，避免出现半截文件。</summary>
        internal static void WriteTextAtomic(string path, string text)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var tmp = path + ".portpilot-tmp";
            File.WriteAllText(tmp, text ?? string.Empty, Utf8NoBom);
            if (File.Exists(path))
            {
                try
                {
                    File.Replace(tmp, path, null, true);
                    return;
                }
                catch (IOException)
                {
                    // 目标被占用等情况退回 Move
                }
                catch (PlatformNotSupportedException) { }
            }
            File.Copy(tmp, path, true);
            try { File.Delete(tmp); } catch { }
        }

        internal static string Backup(string path, string backupDir, string label)
        {
            if (!File.Exists(path)) return null;
            Directory.CreateDirectory(backupDir);
            var safe = string.IsNullOrEmpty(label) ? "file" : label;
            var dest = Path.Combine(backupDir, safe);
            File.Copy(path, dest, true);
            return dest;
        }

        internal static void Restore(string backupPath, string target)
        {
            if (!File.Exists(backupPath)) throw new FileNotFoundException("找不到备份：" + backupPath, backupPath);
            var dir = Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.Copy(backupPath, target, true);
        }

        internal static string[] ListFiles(string dir)
        {
            if (!Directory.Exists(dir)) return new string[0];
            var files = Directory.GetFiles(dir);
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            return files;
        }

        internal static void DeleteFile(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch { }
        }

        internal static void EnsureDir(string dir)
        {
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        }

        internal static long SizeOf(string path)
        {
            try { return new FileInfo(path).Length; }
            catch { return -1; }
        }

        internal static DateTime ModifiedOf(string path)
        {
            try { return File.GetLastWriteTime(path); }
            catch { return DateTime.MinValue; }
        }

        internal static List<string> DirectoryNames(string dir)
        {
            var result = new List<string>();
            if (!Directory.Exists(dir)) return result;
            foreach (var d in Directory.GetDirectories(dir)) result.Add(Path.GetFileName(d));
            result.Sort(StringComparer.OrdinalIgnoreCase);
            return result;
        }
    }
}
