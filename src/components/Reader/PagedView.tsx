import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Segment } from '@/stores/reader';
import type { ReaderSettings } from '@/types';
import SegmentView, { type CommentPara } from './SegmentView';

/** 分页后要停的位置：某章的某一段，或者最后一页（往回翻进上一章时） */
export interface PagedTarget {
  chapterId: string;
  para: number;
  edge?: 'last';
}

export interface PagedHandle {
  next: () => void;
  prev: () => void;
  /** 翻到这段文字所在的页（章内搜索用） */
  reveal: (range: Range) => void;
}

interface Props {
  seg: Segment | undefined;
  settings: ReaderSettings;
  fontStack: string;
  loggedIn: boolean;
  onComment: (p: CommentPara) => void;
  onRetry: (chapterId: string) => void;
  onLogin: () => void;
  /** 由阅读页写入，这里分页完成后消费 */
  pending: MutableRefObject<PagedTarget | null>;
  /** 当前页第一段，用来记住位置 */
  onPosition: (chapterId: string, para: number) => void;
  onPageChange: (page: number, count: number) => void;
  /** 翻过本章第一页或最后一页 */
  onEdge: (dir: 1 | -1) => void;
  onToggleChrome: () => void;
  marked?: Set<number>;
  /** 双击某段：从该段开始听书，透传给 SegmentView */
  onStartListen?: (chapterId: string, para: number) => void;
}

/** 两页之间、栏与栏之间的空隙 */
const GAP = 64;
/** 上下留给工具栏和进度的空间 */
const V_MARGIN = 72;

/** 翻页模式：一章正文排成多栏，一栏是一页，横向平移翻页；窗口够宽时并排显示两页 */
const PagedView = forwardRef<PagedHandle, Props>(function PagedView(props, ref) {
  const { seg, settings, fontStack, pending } = props;
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(1);
  const [animate, setAnimate] = useState(false);
  // 当前页第一段：重新分页（改字号、改窗口、段评数到达）后回到它所在的页。
  // carried 表示这段从上一页延续过来，回到的应是它起始页的下一页
  const anchorRef = useRef<{ ch: string; para: number; carried: boolean } | null>(null);
  // 按锚点重新分页后不改写锚点，否则每次重排都退到新页的第一段，连续改字号会越漂越远
  const keepAnchor = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  // 页宽沿用 Aa 面板的“宽度”（减去原来的左右内边距）；放得下两页就并排
  const pageW0 = settings.pageWidth - 64;
  const avail = size.w - 96;
  const spread = avail >= pageW0 * 2 + GAP ? 2 : 1;
  const pageW = Math.max(240, Math.min(pageW0, avail));
  const viewW = spread * pageW + (spread - 1) * GAP;
  const step = viewW + GAP;
  const viewH = Math.max(200, size.h - V_MARGIN * 2);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 元素第一块排在第几页（横向位置相对正文起点，抵消平移） */
  const pageOf = (el: Element) => {
    const inner = innerRef.current;
    const r = el.getClientRects()[0];
    if (!inner || !r) return 0;
    return Math.max(0, Math.floor((r.left - inner.getBoundingClientRect().left + 1) / step));
  };

  const pageOfPara = (para: number) => {
    const list = innerRef.current?.querySelectorAll<HTMLElement>('.reader-anchor');
    if (!list) return 0;
    // 记下的那一行可能已被清洗掉（空行），取它之后的第一段
    const el = [...list].find((p) => Number(p.dataset.para) >= para);
    return el ? pageOf(el) : 0;
  };

  /** 第 p 页上开头的那一段；整页都是上一页延续下来的段落时，取这一段 */
  const firstOnPage = (p: number) => {
    const list = innerRef.current?.querySelectorAll<HTMLElement>('.reader-anchor');
    if (!list?.length) return null;
    let prev: HTMLElement | null = null;
    for (const el of list) {
      const at = pageOf(el);
      if (at === p) return { el, carried: false };
      if (at > p) break;
      prev = el;
    }
    return prev && { el: prev, carried: true };
  };

  // 正文、排版或窗口变化后重新分页，并停到该停的页
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || !seg) return;
    const cols = Math.max(1, Math.round((inner.scrollWidth + GAP) / (pageW + GAP)));
    const total = Math.max(1, Math.ceil(cols / spread));
    const target = pending.current;
    let p = 0;
    if (target && target.chapterId === seg.chapter.id) {
      if (seg.status === 'loading') p = 0;
      else {
        pending.current = null;
        keepAnchor.current = false;
        p = target.edge === 'last' ? total - 1 : target.para > 0 ? pageOfPara(target.para) : 0;
      }
    } else if (anchorRef.current?.ch === seg.chapter.id) {
      p = pageOfPara(anchorRef.current.para) + (anchorRef.current.carried ? 1 : 0);
      keepAnchor.current = true;
    }
    setAnimate(false);
    setCount(total);
    setPage(Math.min(p, total - 1));
  }, [seg, pageW, spread, viewH, settings.fontSize, settings.lineHeight, settings.fontFamily, settings.paraSpacing, settings.indent]); // eslint-disable-line react-hooks/exhaustive-deps

  // 翻到新的一页：记下这页开头的段落，报告页码
  useEffect(() => {
    if (!seg) return;
    const first = firstOnPage(page);
    const para = first ? Number(first.el.dataset.para) || 0 : 0;
    // 正文还没到时不改锚点，免得冲掉要恢复的位置
    if (keepAnchor.current) keepAnchor.current = false;
    else if (seg.status === 'ready') {
      anchorRef.current = { ch: seg.chapter.id, para, carried: !!first?.carried };
      propsRef.current.onPosition(seg.chapter.id, para);
    }
    propsRef.current.onPageChange(page, count);
  }, [page, count, seg]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageRef = useRef({ page, count });
  pageRef.current = { page, count };

  const flip = (dir: 1 | -1) => {
    const { page: cur, count: total } = pageRef.current;
    const nextPage = cur + dir;
    if (nextPage < 0 || nextPage >= total) {
      propsRef.current.onEdge(dir);
      return;
    }
    keepAnchor.current = false;
    setAnimate(true);
    setPage(nextPage);
  };

  const reveal = (range: Range) => {
    const inner = innerRef.current;
    const r = range.getClientRects()[0];
    if (!inner || !r) return;
    const p = Math.floor((r.left - inner.getBoundingClientRect().left + 1) / step);
    if (p === pageRef.current.page || p < 0 || p >= pageRef.current.count) return;
    keepAnchor.current = false;
    setAnimate(true);
    setPage(p);
  };

  useImperativeHandle(ref, () => ({ next: () => flip(1), prev: () => flip(-1), reveal }));

  // 点左右三分之一翻页，点中间切换工具栏；点到按钮或正在选字时不处理
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a') || window.getSelection()?.toString()) return;
    const w = outerRef.current?.clientWidth || window.innerWidth;
    const x = e.clientX - (outerRef.current?.getBoundingClientRect().left || 0);
    if (x < w / 3) flip(-1);
    else if (x > (w * 2) / 3) flip(1);
    else props.onToggleChrome();
  };

  // 滚轮和触控板：一次手势只翻一页，惯性滚动停下 250ms 后才接受下一次
  const wheelLock = useRef(false);
  const wheelTimer = useRef<number>();
  const onWheel = (e: React.WheelEvent) => {
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => { wheelLock.current = false; }, 250);
    if (wheelLock.current) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    wheelLock.current = true;
    flip(d > 0 ? 1 : -1);
  };

  return (
    <div className="reader-paged" ref={outerRef} onClick={onClick} onWheel={onWheel}>
      <div className="reader-page-view" style={{ width: viewW, height: viewH }}>
        <div
          ref={innerRef}
          className={`reader-text reader-columns${animate ? ' animate' : ''}`}
          style={{
            width: viewW,
            height: viewH,
            columnCount: spread,
            columnGap: GAP,
            transform: `translateX(${-page * step}px)`,
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
            fontFamily: fontStack,
          }}
        >
          {seg && (
            <SegmentView
              seg={seg}
              fontStack={fontStack}
              loggedIn={props.loggedIn}
              onComment={props.onComment}
              onRetry={props.onRetry}
              onLogin={props.onLogin}
              marked={props.marked}
              onStartListen={props.onStartListen}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default PagedView;
