import { useEffect, useRef } from 'react';
import { api } from '../api/client';

/**
 * 任务桌面通知（2026-08-25 对照 ZCode 设置补的缺口）：
 * 壳层轮询「最近终态任务」，对新增的完成/失败/等待输入任务发 Web Notification。
 * 开关存 localStorage（muster-desktop-notify），设置页「基础与行为」控制；
 * seen 集合持久化到 localStorage，刷新页面不重复弹。
 */
const ENABLED_KEY = 'muster-desktop-notify';
const SEEN_KEY = 'muster-notify-seen';
const SINCE_KEY = 'muster-notify-since';
const POLL_MS = 30_000;

export function desktopNotificationsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === '1';
}

/** 开关切换：开启时请求浏览器通知权限。 */
export async function setDesktopNotificationsEnabled(next: boolean): Promise<void> {
  localStorage.setItem(ENABLED_KEY, next ? '1' : '0');
  if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  // 只留最近 200 条，防无限膨胀
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
}

interface FinalizedTask {
  id: string;
  title: string;
  state: 'completed' | 'failed' | 'waiting_input';
  updatedAt: string;
}

function notify(task: FinalizedTask): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const head = task.state === 'completed' ? '✅ 任务完成' : task.state === 'failed' ? '❌ 任务失败' : '⏸ 任务等你确认';
  new Notification(`${head}：${task.title}`, { tag: task.id });
}

/**
 * 壳层挂载：仅当开关开启时轮询；首帧只记录基线不轰炸历史任务。
 */
export function useTaskNotifications(): void {
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!desktopNotificationsEnabled()) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return;
    seenRef.current = loadSeen();
    let since = localStorage.getItem(SINCE_KEY) ?? new Date(Date.now() - 5 * 60_000).toISOString();
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled || !desktopNotificationsEnabled()) return;
      try {
        const tasks = await api.get<FinalizedTask[]>(`/api/workbench/recent-finalized?since=${encodeURIComponent(since)}&limit=30`);
        if (tasks.length > 0) {
          since = tasks[0]!.updatedAt;
          localStorage.setItem(SINCE_KEY, since);
          const seen = seenRef.current ?? loadSeen();
          for (const task of [...tasks].reverse()) {
            if (!seen.has(task.id)) {
              seen.add(task.id);
              notify(task);
            }
          }
          saveSeen(seen);
          seenRef.current = seen;
        }
      } catch {
        /* 轮询失败静默，下个周期再来 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
}
