# iHome API 接入（`src/server/api/novel` 域外协作）

状态：implemented（规范只读）

- 规范源：`/Users/master/Project/iHome/docs/Api规范/` 为唯一来源。
- 变更筛选：先读 `变更通知/INDEX.md` 的 `must_check` 项，再只读对应文件，不整包加载。
- 本项目维护"实际使用的 iHome API 清单"，变更前先搜这些端点；`/src` 内仅 `src/server/api/novel.ts` 等少数文件接触外部规范。
- STT WebSocket 必须发 16kHz / 16bit / mono PCM 分片；浏览器 MediaRecorder 的 webm/opus 不能直接按 PCM 发。
