/**
 * 系统级交互 API（workspace 治理批次4，2026-08-21）。
 *
 * pick-folder：浏览器沙盒拿不到绝对路径（File System Access/webkitdirectory 都不给），
 * "打开系统选择文件夹窗口"必须由本地服务进程代起原生对话框——macOS 用 osascript
 * choose folder（返回 POSIX 绝对路径）。仅 darwin；其他平台返回不支持（前端回落手填）。
 */
import { Router } from 'express';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { asyncHandler } from './middleware';

export const systemRouter = Router();

/** 原生选择文件夹（用户主动触发；10 分钟超时覆盖慢速浏览；取消返回 cancelled）。 */
systemRouter.post(
  '/pick-folder',
  asyncHandler(async (_req, res) => {
    if (platform() !== 'darwin') {
      res.status(501).json({ error: { code: 'validation', message: `当前平台（${platform()}）暂不支持系统选择窗口，请手动输入绝对路径` } });
      return;
    }
    const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择要用作项目目录的文件夹")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    try {
      const code = await new Promise<number>((resolve) => child.on('close', resolve));
      if (code !== 0) {
        // 用户点「取消」返回 1（osascript 报 User canceled）——不算错误
        if (/cancel/i.test(stderr)) {
          res.json({ cancelled: true, path: null });
        } else {
          res.status(500).json({ error: { code: 'internal', message: `系统选择窗口失败: ${stderr.slice(0, 200)}` } });
        }
        return;
      }
      const dir = stdout.trim().replace(/\/+$/, '');
      if (!dir.startsWith('/')) {
        res.status(500).json({ error: { code: 'internal', message: '系统选择窗口未返回有效路径' } });
        return;
      }
      res.json({ cancelled: false, path: dir });
    } finally {
      clearTimeout(timer);
    }
  }),
);
