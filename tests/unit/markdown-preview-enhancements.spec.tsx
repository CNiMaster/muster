/**
 * 批次 G.2：MarkdownPreview 增强——表格复制 TSV/下载 CSV、代码块复制、图片放大后下载入口。
 *
 * 注：按钮点击用 fireEvent——本组件的复制按钮上 userEvent.click 在 jsdom 下静默不发
 * （同 spec 中点击 img 正常，原因未深究）；fireEvent 直达 onClick 且行为等价。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPreview } from '../../src/client/components/MarkdownPreview';

const TABLE_MD = [
  '| 名称 | 数量 |',
  '| --- | --- |',
  '| 苹果 | 3 |',
  '| 香蕉, 黄色 | "5" |',
].join('\n');

describe('MarkdownPreview 增强（批次 G.2）', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let downloads: Array<{ name: string }>;
  let blobs: Blob[];

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom 的 navigator.clipboard 为 getter-only，需 defineProperty 覆盖
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText } });
    downloads = [];
    blobs = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((b: Blob) => {
          blobs.push(b);
          return 'blob:mock';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    // 拦截 a[download] 点击，避免 jsdom 导航报错并记录下载内容
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('表格：复制按钮产出 TSV（含表头）', () => {
    render(<MarkdownPreview source={TABLE_MD} />);
    fireEvent.click(screen.getByRole('button', { name: '复制表格' }));
    expect(writeText).toHaveBeenCalledWith('名称\t数量\n苹果\t3\n香蕉, 黄色\t"5"');
  });

  it('表格：下载 CSV 对含逗号/引号单元格正确转义', async () => {
    render(<MarkdownPreview source={TABLE_MD} />);
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^table-\d+\.csv$/);
    expect(blobs).toHaveLength(1);
    // CSV 转义规则——含逗号与引号的单元格加引号并双写内部引号
    expect(await blobs[0].text()).toBe('名称,数量\n苹果,3\n"香蕉, 黄色","""5"""');
  });

  it('代码块：复制按钮拿到纯文本代码', () => {
    render(<MarkdownPreview source={'```ts\nconst x = 1;\nconsole.log(x);\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;\nconsole.log(x);\n');
  });

  it('图片：放大 Modal 提供下载入口（文件名取自 URL 尾段）', async () => {
    const user = userEvent.setup();
    render(<MarkdownPreview source={'![示意图](/api/materials/m_abc/shot.png)'} />);
    await user.click(screen.getByRole('img', { name: '示意图' }));
    const link = screen.getByRole('link', { name: '下载图片' });
    expect(link).toHaveAttribute('download', 'shot.png');
    expect(link).toHaveAttribute('href', '/api/materials/m_abc/shot.png');
  });
});
