import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let choosing = false;

export async function chooseStorageFolder() {
  if (process.platform !== 'win32') throw new Error('当前系统不支持选择文件夹，请手动输入绝对路径。');
  if (choosing) throw new Error('文件夹选择窗口已打开。');
  choosing = true;
  try {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择空目录存储角色卡和记忆'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write($dialog.SelectedPath) }";
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 180_000, maxBuffer: 16_384 });
    return { directory: stdout.trim() || null };
  } catch {
    throw new Error('无法打开文件夹选择窗口，请手动输入绝对路径。');
  } finally { choosing = false; }
}

export async function openStorageFolder(directory) {
  if (process.platform !== 'win32') throw new Error('当前系统不支持打开文件夹，请复制显示的路径。');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  const child = spawn(executable, [directory], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('无法打开文件夹，请复制显示的路径。'))); });
  child.unref();
  return { opened: true };
}
