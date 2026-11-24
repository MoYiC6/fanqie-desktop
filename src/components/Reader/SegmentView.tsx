import { memo } from 'react';
import { CommentOutlined } from '@ant-design/icons';
import type { Segment } from '@/stores/reader';
import { splitParagraphs } from './text';

export type CommentPara = { chapterId: string; index: number; text: string; count: number };

/** 反爬字体按章生效：把字体名换成带章节 id 的名字，避免相邻两章的同名字体互相覆盖 */
function scopeFont(css: string, chapterId: string) {
  const name = css.match(/font-family:\s*([^;,}]+)/)?.[1]?.trim();
  if (!name) return null;
  const family = `fq-font-${chapterId}`;
  return { css: css.split(name).join(`"${family}"`), family };
}

/** 一章正文。滚动模式下是章节流里的一段，翻页模式下单独分页；单独 memo，更新进度时不重渲染段落 */
const SegmentView = memo(function SegmentView({ seg, fontStack, loggedIn, onComment, onRetry, onLogin, marked, onStartListen }: {
  seg: Segment;
  /** 本章有书签的段号 */
  marked?: Set<number>;
  fontStack: string;
  loggedIn: boolean;
  onComment: (p: CommentPara) => void;
  onRetry: (chapterId: string) => void;
  onLogin: () => void;
  /** 双击某段：从该段开始听书。点到按钮/链接时不触发，避免和段评双触发 */
  onStartListen?: (chapterId: string, para: number) => void;
}) {
  const { chapter, status, content, fontCss, paraIdx, commentStats } = seg;
  const font = fontCss ? scopeFont(fontCss, chapter.id) : null;
  return (
    <section
      className="reader-seg"
      data-seg={chapter.id}
      style={font ? { fontFamily: `"${font.family}", ${fontStack}` } : undefined}
    >
      <h2
        className={`reader-chapter-title reader-anchor${marked?.has(0) ? ' marked' : ''}`} data-ch={chapter.id} data-para={0}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a')) return;
          onStartListen?.(chapter.id, 0);
        }}
      >
        {chapter.title}
      </h2>
      {/* 放在标题后面，标题才是 first-child，不多出上边距 */}
      {font && <style dangerouslySetInnerHTML={{ __html: font.css }} />}
      {status === 'loading' && <div className="reader-seg-status">加载中…</div>}
      {status === 'error' && (
        <div className="reader-seg-status error">
          <p>{seg.error || '本章加载失败'}</p>
          <div className="reader-seg-actions">
            <button onClick={() => onRetry(chapter.id)}>重试</button>
            {!loggedIn && <button onClick={onLogin}>登录</button>}
          </div>
        </div>
      )}
      {/* data-para 用原始行号：清洗掉空行后，段评段号和记住的位置仍能对上 */}
      {status === 'ready' && splitParagraphs(content).map(({ text, line: i }) => {
        const idx = paraIdx[i] ?? -1;
        const count = commentStats[idx] || 0;
        return (
          <p
            key={i}
            className={`reader-para reader-anchor${marked?.has(i) ? ' marked' : ''}`} data-ch={chapter.id} data-para={i}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('button, a')) return;
              onStartListen?.(chapter.id, i);
            }}
          >
            {idx >= 0 ? (
              <>
                {text.slice(0, -1)}
                {/* 气泡和最后一个字绑在一起，避免单独掉到下一行；没有段评的段落悬停才显示 */}
                <span className="para-tail">
                  {text.slice(-1)}
                  <button
                    className={`para-comment${count ? '' : ' empty'}`}
                    title={count ? '查看段评' : '写段评'}
                    onClick={() => onComment({ chapterId: chapter.id, index: idx, text, count })}
                  >
                    {count ? (count > 999 ? '999+' : count) : <CommentOutlined />}
                  </button>
                </span>
              </>
            ) : text}
          </p>
        );
      })}
    </section>
  );
});

export default SegmentView;
