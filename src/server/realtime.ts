/**
 * 实时事件总线：WebSocket 推送 + 进程内 EventEmitter。
 *
 * 所有领域事件经此广播，前端通过单一 WebSocket 接收 RealtimeEvent。
 * Phase 0 仅建立骨架；Phase 1+ 接入领域事件。
 */
import { EventEmitter } from 'node:events';
import type { WebSocketServer, WebSocket } from 'ws';
import type { RealtimeEvent } from '../shared/types';

class RealtimeBus extends EventEmitter {
  private wss: WebSocketServer | null = null;

  attach(wss: WebSocketServer): void {
    this.wss = wss;
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', () => {
        // Phase 5 接入客户端订阅过滤
      });
    });
  }

  /** 广播事件到所有 WebSocket 客户端。 */
  broadcast(event: RealtimeEvent): void {
    if (!this.wss) return;
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    }
  }

  /** 领域层发布事件：进程内 + WebSocket。 */
  publish(event: RealtimeEvent): void {
    this.emit(event.type, event);
    this.emit('*', event);
    this.broadcast(event);
  }
}

export const realtime = new RealtimeBus();
