import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReader, prefetchChapter } from '@/stores/reader';
import { useBookshelf } from '@/stores/bookshelf';
import { useAccount } from '@/stores/account';
import { ConfigProvider, Popover, Slider } from 'antd';
import {
  CustomerServiceOutlined, FullscreenExitOutlined, FullscreenOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import type { Bookmark, Chapter } from '@/types';
import * as api from '@/services/api';
import CommentDrawer from '@/components/CommentDrawer';
import SettingsPanel from '@/components/Reader/SettingsPanel';
import TocDrawer from '@/components/Reader/TocDrawer';
import AudioBar from '@/components/Reader/AudioBar';
import { FONTS } from '@/components/Reader/options';
import { splitParagraphs } from '@/components/Reader/text';
import { BookmarkIcon } from '@/components/Reader/BookmarkIcon';
import SearchBar, { focusSearch } from '@/components/Reader/SearchBar';
import SegmentView, { type CommentPara } from '@/components/Reader/SegmentView';
import PagedView, { type PagedHandle, type PagedTarget } from '@/components/Reader/PagedView';
import { useTheme, antdConfig } from '@/stores/theme';

// macOS 隐藏式标题栏的红绿灯压在阅读页左上角，工具栏要让开
const isMac = navigator.userAgent.includes('Mac');

export default function Reader() {
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId: string }>();
  const nav = useNavigate();
  const bodyRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const appDark = useTheme((s) => s.dark);
  const [commentPara, setCommentPara] = useState<CommentPara | null>(null);
  // 段评抽屉关闭动画期间还要用到章节 id，单独留一份
  const [commentCh, setCommentCh] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  // 沉浸模式：往下读时收起工具栏，往上滚或鼠标移到上下边缘时出现
  const [chromeVisible, setChromeVisible] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [progress, setProgress] = useState(0);
  // 拖动进度条时预览的章节序号
  const [preview, setPreview] = useState<number | null>(null);
  // 听书从哪章哪段开始；null 表示没在听
  const [listenFrom, setListenFrom] = useState<{ chapterId: string; para: number } | null>(null);
  const lastTopRef = useRef(0);
  // 翻页模式的页码，用于右下角进度
  const [pageInfo, setPageInfo] = useState({ page: 0, count: 1 });
  const pagedRef = useRef<PagedHandle>(null);

  const {
    chapters, segments, currentId, settings,
    loadChapters, openAt, retry, setCurrent, addCommentCount, loadSettings,
  } = useReader();
  const loggedIn = useAccount((s) => !!s.user);
  const openLogin = useAccount((s) => s.openLogin);
  const bookTitle = useBookshelf((s) => s.items.find((i) => i.book.id === bookId)?.book.title) || '';
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // 当前位置（章 id:段号），书签按钮据此高亮。字符串相同时 setState 不会重渲染
  const [posKey, setPosKey] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const paged = settings.readingMode === 'page';

  const updateProgress = useBookshelf((s) => s.updateProgress);
  const savePosition = useBookshelf((s) => s.savePosition);

  // 打开阅读页时记下书架上的章内位置。必须在挂载时取：之后换章会把它清零
  const restoreRef = useRef<{ chapterId: string; para: number } | null | undefined>(undefined);
  if (restoreRef.current === undefined) {
    const item = useBookshelf.getState().items.find((i) => i.book.id === bookId);
    restoreRef.current = item?.lastReadParaIndex ? { chapterId: item.lastReadChapterId, para: item.lastReadParaIndex } : null;
  }
  // 章节流重置（或翻页模式换章）后要停的位置：等目标章正文到了再定位
  const pendingRef = useRef<PagedTarget | null>(null);
  // 视口顶部的那一段及其屏幕位置。章节流在上方增删内容、或改字号后，靠它把位置拉回来
  const anchorRef = useRef<{ el: HTMLElement; top: number } | null>(null);
  // 视口顶部是哪章第几段；滚动停下后再写盘
  const posRef = useRef<{ ch: string; para: number } | null>(null);
  const saveTimer = useRef<number>();
  const savePosRef = useRef(() => {});
  savePosRef.current = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const pos = posRef.current;
    if (bookId && pos) savePosition(bookId, pos.ch, pos.para);
  };

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    api.isFullScreen().then(setFullScreen);
    return api.onFullScreenChange(setFullScreen);
  }, []);

  /** 清空章节流，从指定章（的指定段）重新开始 */
  const jump = useCallback((chapter: Chapter, para = 0) => {
    if (saveTimer.current) savePosRef.current();
    pendingRef.current = { chapterId: chapter.id, para };
    anchorRef.current = null;
    openAt(chapter);
  }, [openAt]);

  // 从摸鱼窗口回来：从那边读到的章节和段落重新打开章节流
  useEffect(() => api.onMoyuExit(({ chapterId: ch, para }) => {
    const target = useReader.getState().chapters.find((c) => c.id === ch);
    if (target) jump(target, para);
  }), [jump]);

  useEffect(() => {
    if (!bookId) return;
    // 目录要等整本书的网页，正文不依赖它：并行先取当前章
    prefetchChapter(chapterId ?? '');
    loadChapters(bookId).then(() => {
      const ch = useReader.getState().chapters;
      const target = ch.find((c) => c.id === chapterId) || ch[0];
      if (!target) return;
      // 不在这里清空 restoreRef：StrictMode 下这个 effect 会跑两次，清掉后第二次就丢了位置
      const r = restoreRef.current;
      jump(target, r && r.chapterId === target.id ? r.para : 0);
    });
  }, [bookId, chapterId, loadChapters, jump]);

  // 切换滚动 / 翻页：按当前读到的段落重新打开。必须在渲染时就记下位置——
  // 新模式的视图先挂载，会把 posRef 改写成它的第一页 / 视口顶部。
  // 还没定位过（刚打开、设置刚读到）就交给新模式去消费待恢复的位置
  const modeRef = useRef(settings.readingMode);
  const switchRef = useRef<PagedTarget | null>(null);
  if (modeRef.current !== settings.readingMode) {
    modeRef.current = settings.readingMode;
    const pos = posRef.current;
    if (!pendingRef.current && pos) {
      switchRef.current = { chapterId: pos.ch, para: pos.para };
      // 翻页视图直接消费它；滚动视图要重置章节流，在下面的 effect 里跳
      pendingRef.current = switchRef.current;
    }
  }
  useEffect(() => {
    setChromeVisible(!paged);
    const t = switchRef.current;
    switchRef.current = null;
    if (!t || paged) return;
    const ch = useReader.getState().chapters.find((c) => c.id === t.chapterId);
    if (ch) jump(ch, t.para);
  }, [paged, jump]);

  // 翻页模式只渲染当前章，但前后章都要先加载好，翻过章首章末时没有等待
  useEffect(() => {
    if (!paged) return;
    const s = useReader.getState();
    const i = s.segments.findIndex((g) => g.chapter.id === s.currentId);
    if (i < 0) return;
    if (i === s.segments.length - 1) s.appendNext();
    if (i === 0) useReader.getState().prependPrev();
  }, [paged, segments, currentId]);

  useEffect(() => {
    if (bookId) api.getBookmarks(bookId).then(setBookmarks);
  }, [bookId]);

  // 每章有书签的段号，给正文画标记；没变的章沿用同一个 Set，段落不必重渲染
  const marks = useMemo(() => {
    const m = new Map<string, Set<number>>();
    bookmarks.forEach((b) => (m.get(b.chapterId) || m.set(b.chapterId, new Set()).get(b.chapterId)!).add(b.para));
    return m;
  }, [bookmarks]);
  const marked = bookmarks.some((b) => `${b.chapterId}:${b.para}` === posKey);

  /** 当前位置有书签就删掉，没有就加上 */
  const toggleBookmark = () => {
    const pos = posRef.current;
    if (!bookId || !pos) return;
    const { chapters: list, segments: segs } = useReader.getState();
    let next: Bookmark[];
    if (bookmarks.some((b) => b.chapterId === pos.ch && b.para === pos.para)) {
      next = bookmarks.filter((b) => !(b.chapterId === pos.ch && b.para === pos.para));
    } else {
      const seg = segs.find((g) => g.chapter.id === pos.ch);
      const text = seg ? splitParagraphs(seg.content).find((p) => p.line >= pos.para)?.text || '' : '';
      const order = (id: string) => list.findIndex((c) => c.id === id);
      next = [...bookmarks, {
        chapterId: pos.ch,
        chapterTitle: list.find((c) => c.id === pos.ch)?.title || '',
        para: pos.para,
        excerpt: text.slice(0, 40),
        createdAt: Date.now(),
      }].sort((a, b) => order(a.chapterId) - order(b.chapterId) || a.para - b.para);
    }
    setBookmarks(next);
    api.saveBookmarks(bookId, next);
  };

  const removeBookmark = (bm: Bookmark) => {
    if (!bookId) return;
    const next = bookmarks.filter((b) => b !== bm);
    setBookmarks(next);
    api.saveBookmarks(bookId, next);
  };

  // 当前章变了就更新书架进度（会同步云端）
  useEffect(() => {
    if (!bookId || !currentId) return;
    const list = useReader.getState().chapters;
    const i = list.findIndex((c) => c.id === currentId);
    if (i >= 0) updateProgress(bookId, list[i].id, list[i].title, i, list.length);
  }, [currentId, bookId, updateProgress]);

  // 登录后自动重试加载失败的章节
  useEffect(() => {
    if (!loggedIn) return;
    useReader.getState().segments.filter((g) => g.status === 'error').forEach((g) => retry(g.chapter.id));
  }, [loggedIn, retry]);

  // 离开阅读页时把还没写盘的位置存下来，并清空章节流
  useEffect(() => () => {
    if (saveTimer.current) savePosRef.current();
    useReader.getState().reset();
  }, []);

  /** 找视口顶部的那一段（二分，段落按文档顺序排列） */
  const topAnchor = () => {
    const body = bodyRef.current;
    if (!body) return null;
    const list = body.querySelectorAll<HTMLElement>('.reader-anchor');
    if (!list.length) return null;
    const top = body.getBoundingClientRect().top + 1;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
      else hi = mid;
    }
    return list[lo];
  };

  /** 记下锚点、当前章、章内进度 */
  const track = () => {
    const body = bodyRef.current;
    const a = topAnchor();
    if (!body || !a) return;
    anchorRef.current = { el: a, top: a.getBoundingClientRect().top };
    const ch = a.dataset.ch!;
    posRef.current = { ch, para: Number(a.dataset.para) || 0 };
    setPosKey(`${ch}:${posRef.current.para}`);
    setCurrent(ch);
    const seg = body.querySelector<HTMLElement>(`[data-seg="${CSS.escape(ch)}"]`);
    if (seg) {
      const passed = body.getBoundingClientRect().top - seg.getBoundingClientRect().top;
      const span = seg.offsetHeight - body.clientHeight;
      setProgress(span > 0 ? Math.min(1, Math.max(0, passed / span)) : 1);
    }
  };

  /** 离两头不到 1.5 屏时接上前后章 */
  const grow = () => {
    const body = bodyRef.current;
    if (!body) return;
    const s = useReader.getState();
    const screen = body.clientHeight * 1.5;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < screen) s.appendNext();
    if (body.scrollTop < screen) s.prependPrev();
  };

  // 章节流或排版变化后：先把阅读位置拉回原处，再看要不要接新章节
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const pending = pendingRef.current;
    if (pending) {
      const first = useReader.getState().segments[0];
      if (!first || first.chapter.id !== pending.chapterId) return;
      if (first.status === 'loading') {
        body.scrollTop = 0;
        lastTopRef.current = 0;
        return;
      }
      pendingRef.current = null;
      // 记下的那一行可能已被清洗掉（空行），取它之后的第一段
      const el = pending.para > 0
        ? [...body.querySelectorAll<HTMLElement>(`[data-seg="${CSS.escape(first.chapter.id)}"] .reader-para`)]
          .find((p) => Number(p.dataset.para) >= pending.para) || null
        : null;
      body.scrollTop = el ? body.scrollTop + el.getBoundingClientRect().top - body.getBoundingClientRect().top : 0;
      if (!el) setChromeVisible(true);
    } else {
      const a = anchorRef.current;
      if (a?.el.isConnected) {
        const d = a.el.getBoundingClientRect().top - a.top;
        if (Math.abs(d) > 0.5) body.scrollTop += d;
      }
    }
    lastTopRef.current = body.scrollTop;
    track();
    grow();
  }, [segments, settings.fontSize, settings.lineHeight, settings.pageWidth, settings.fontFamily, settings.paraSpacing, settings.indent]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body || pendingRef.current) return;
    const st = body.scrollTop;
    const delta = st - lastTopRef.current;
    lastTopRef.current = st;
    // 章首、往回滚、滚到流的尽头时显示
    if (st < 24 || delta < -4 || st >= body.scrollHeight - body.clientHeight - 2) setChromeVisible(true);
    else if (delta > 4) setChromeVisible(false);
    track();
    grow();

    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => savePosRef.current(), 600);
  };

  /** 翻页模式换章：已加载就直接切过去，否则重置章节流。往回翻进上一章时停在它的最后一页 */
  const turnChapter = (delta: number, toLast = false) => {
    const { chapters: list, currentId: cur, segments: segs } = useReader.getState();
    const target = list[list.findIndex((c) => c.id === cur) + delta];
    if (!target) return;
    const goal: PagedTarget = { chapterId: target.id, para: 0, ...(toLast && { edge: 'last' as const }) };
    if (segs.some((g) => g.chapter.id === target.id)) {
      pendingRef.current = goal;
      setCurrent(target.id);
    } else {
      jump(target);
      pendingRef.current = goal;
    }
  };

  /** 翻页模式下记下当前页开头的段落，翻停后再写盘 */
  const onPagedPosition = useCallback((ch: string, para: number) => {
    posRef.current = { ch, para };
    setPosKey(`${ch}:${para}`);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => savePosRef.current(), 600);
  }, []);

  /** 跳到前后章的章首：已经在流里就直接滚过去，否则重置章节流 */
  const goChapter = (delta: number) => {
    if (paged) return turnChapter(delta);
    const body = bodyRef.current;
    const { chapters: list, currentId: cur, segments: segs } = useReader.getState();
    const target = list[list.findIndex((c) => c.id === cur) + delta];
    if (!body || !target) return;
    const el = segs.some((g) => g.chapter.id === target.id && g.status === 'ready')
      ? body.querySelector<HTMLElement>(`[data-seg="${CSS.escape(target.id)}"]`)
      : null;
    if (el) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
    else jump(target);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F') && !commentPara && !tocOpen) {
        e.preventDefault();
        if (searchOpen) focusSearch();
        else setSearchOpen(true);
        return;
      }
      // 段评、目录抽屉打开时，按键留给抽屉；带修饰键的组合留给系统；输入框里打字不触发快捷键
      if (commentPara || tocOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest?.('input, textarea')) return;
      if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (fullScreen) api.toggleFullScreen();
        else nav(-1);
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        api.toggleFullScreen();
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        toggleBookmark();
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        setSettingsOpen(false);
        setTocOpen(true);
        return;
      }
      // 翻页模式：左右、上下、空格、PageUp/PageDown 都是翻页
      if (paged) {
        const flip = (dir: 1 | -1) => {
          e.preventDefault();
          if (dir > 0) pagedRef.current?.next();
          else pagedRef.current?.prev();
        };
        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowDown':
          case 'PageDown': return flip(1);
          case 'ArrowLeft':
          case 'ArrowUp':
          case 'PageUp': return flip(-1);
          case ' ': return flip(e.shiftKey ? -1 : 1);
        }
        return;
      }
      const body = bodyRef.current;
      if (!body) return;
      // 翻一屏时留出约两行重叠，方便接上文
      const overlap = settings.fontSize * settings.lineHeight * 2;
      const scroll = (top: number) => {
        e.preventDefault();
        body.scrollBy({ top, behavior: 'smooth' });
      };
      switch (e.key) {
        case 'ArrowDown': return scroll(60);
        case 'ArrowUp': return scroll(-60);
        case 'ArrowRight': e.preventDefault(); return goChapter(1);
        case 'ArrowLeft': e.preventDefault(); return goChapter(-1);
        case 'PageUp': return scroll(-(body.clientHeight - overlap));
        case 'PageDown':
        case ' ':
          return scroll((e.key === ' ' && e.shiftKey ? -1 : 1) * (body.clientHeight - overlap));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }); // 每次渲染重新绑定，拿到最新的状态

  /** 从视口顶部那一段开始听；段落序号换成段评同款 idx，和音频时间轴对得上 */
  const startListen = () => {
    const pos = posRef.current;
    if (!pos) return;
    const seg = useReader.getState().segments.find((g) => g.chapter.id === pos.ch);
    setListenFrom({ chapterId: pos.ch, para: Math.max(0, seg?.paraIdx[pos.para] ?? 0) });
  };

  /** 双击某段：从该段开始听。para 是原始行号，换算成段评同款 idx 和音频时间轴对上。
   *  只在已开启听书时生效，没开听书时双击不改状态，避免误触直接起播。
   *  回调必须稳定：SegmentView 有 memo，换新引用会让整章段落白渲染一遍，
   *  所以用函数式更新读当前是否在听，而不是把 listenFrom 放进依赖 */
  const startListenFrom = useCallback((chapterId: string, para: number) => {
    setListenFrom((cur) => {
      if (!cur) return cur;
      const seg = useReader.getState().segments.find((g) => g.chapter.id === chapterId);
      return { chapterId, para: Math.max(0, seg?.paraIdx[para] ?? 0) };
    });
  }, []);

  const onComment = useCallback((p: CommentPara) => {
    setCommentCh(p.chapterId);
    setCommentPara(p);
  }, []);

  const fontStack = FONTS.find((f) => f.value === settings.fontFamily)?.css || FONTS[0].css;
  // 阅读主题只作用于阅读页；antd 浮层（Aa 面板、抽屉）挂在容器内，才能拿到同一套颜色变量
  const readerDark = settings.theme === 'night' || (settings.theme === 'auto' && appDark);
  const showChrome = chromeVisible || settingsOpen || tocOpen || preview !== null;
  const curIdx = chapters.findIndex((c) => c.id === currentId);
  const curChapter = chapters[curIdx];
  const curReady = segments.some((g) => g.chapter.id === currentId && g.status === 'ready');

  return (
    <ConfigProvider theme={antdConfig(readerDark)} getPopupContainer={() => containerRef.current || document.body}>
      <div
        className={`reader-container${listenFrom ? ' listening' : ''}`}
        ref={containerRef}
        data-reader-theme={settings.theme === 'auto' ? undefined : settings.theme}
        style={{
          ['--para-spacing' as string]: `${settings.paraSpacing}em`,
          ['--para-indent' as string]: settings.indent ? '2em' : '0',
        }}
        onMouseMove={(e) => {
          if (e.clientY < 72 || e.clientY > window.innerHeight - 72) setChromeVisible(true);
        }}
      >
        <div
          className={`reader-header${showChrome ? '' : ' hidden'}`}
          data-tauri-drag-region
          style={isMac && !fullScreen ? { paddingLeft: 88 } : undefined}
        >
          <button className="reader-tool" onClick={() => nav(-1)}>← 返回</button>
          <button className="reader-tool" title="目录（T）" onClick={() => setTocOpen(true)}>
            <UnorderedListOutlined />
          </button>
          <span className="reader-title">{curChapter?.title || ''}</span>
          <div className="reader-tools">
            <button
              className={`reader-tool${marked ? ' marked' : ''}`}
              title={marked ? '删除书签（B）' : '添加书签（B）'}
              onClick={toggleBookmark}
            >
              <BookmarkIcon filled={marked} />
            </button>
            <button
              className="reader-tool"
              title="摸鱼：透明小窗只显示正文，⌥+Q 一键隐藏"
              onClick={() => {
                const pos = posRef.current;
                if (!bookId || !pos) return;
                // 先把章内位置写盘，摸鱼窗口从同一段接着读
                savePosRef.current();
                api.openMoyu(bookId, pos.ch, pos.para);
              }}
            >
              摸鱼
            </button>
            <button
              className={`reader-tool${listenFrom ? ' active' : ''}`}
              title={listenFrom ? '关闭听书' : '听书'}
              onClick={() => (listenFrom ? setListenFrom(null) : startListen())}
            >
              <CustomerServiceOutlined />
            </button>
            <button
              className="reader-tool"
              title={fullScreen ? '退出全屏（F）' : '全屏（F）'}
              onClick={() => api.toggleFullScreen()}
            >
              {fullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            </button>
            <Popover
              content={<SettingsPanel />}
              trigger="click"
              placement="bottomRight"
              arrow={false}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            >
              <button className="reader-tool reader-aa" title="阅读设置">Aa</button>
            </Popover>
          </div>
        </div>

        {paged && segments.length > 0 ? (
          <PagedView
            ref={pagedRef}
            seg={segments.find((g) => g.chapter.id === currentId)}
            settings={settings}
            fontStack={fontStack}
            loggedIn={loggedIn}
            onComment={onComment}
            onRetry={retry}
            onLogin={openLogin}
            pending={pendingRef}
            onPosition={onPagedPosition}
            onPageChange={(page, count) => {
              setPageInfo({ page, count });
              // 翻页时收起工具栏
              setChromeVisible(false);
            }}
            onEdge={(dir) => turnChapter(dir, dir < 0)}
            onToggleChrome={() => setChromeVisible((v) => !v)}
            marked={marks.get(currentId)}
            onStartListen={startListenFrom}
          />
        ) : (
        <div className="reader-body" ref={bodyRef} onScroll={onScroll}>
          {segments.length === 0 ? (
            <div className="loading">加载中...</div>
          ) : (
            <div
              className="reader-text"
              style={{
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
                fontFamily: fontStack,
                ['--reader-width' as string]: `${settings.pageWidth}px`,
              }}
            >
              {segments.map((seg) => (
                <SegmentView
                  key={seg.chapter.id}
                  seg={seg}
                  fontStack={fontStack}
                  loggedIn={loggedIn}
                  onComment={onComment}
                  onRetry={retry}
                  onLogin={openLogin}
                  marked={marks.get(seg.chapter.id)}
                  onStartListen={startListenFrom}
                />
              ))}
            </div>
          )}
        </div>
        )}

        {curIdx >= 0 && curReady && (
          <div className="reader-progress">
            第 {curIdx + 1}/{chapters.length} 章 · 本章 {paged
              ? `${pageInfo.page + 1}/${pageInfo.count} 页`
              : `${Math.round(progress * 100)}%`}
          </div>
        )}

        <div className={`reader-nav${showChrome ? '' : ' hidden'}`}>
          <button onClick={() => setTocOpen(true)}>目录</button>
          <button onClick={() => goChapter(-1)} disabled={curIdx <= 0}>上一章</button>
          <Slider
            className="reader-slider"
            min={0}
            max={Math.max(0, chapters.length - 1)}
            value={preview ?? Math.max(0, curIdx)}
            disabled={chapters.length < 2}
            tooltip={{ formatter: (v) => (v === undefined ? '' : chapters[v]?.title || '') }}
            onChange={setPreview}
            onChangeComplete={(v) => {
              setPreview(null);
              if (chapters[v] && v !== curIdx) jump(chapters[v]);
            }}
          />
          <button onClick={() => goChapter(1)} disabled={curIdx < 0 || curIdx >= chapters.length - 1}>下一章</button>
        </div>

        {searchOpen && (
          <SearchBar
            onClose={() => setSearchOpen(false)}
            getRoot={() => document.querySelector(`.reader-container [data-seg="${CSS.escape(currentId)}"]`)}
            version={segments.find((g) => g.chapter.id === currentId)}
            isAhead={(range) => {
              const r = range.getBoundingClientRect();
              if (paged) {
                const view = document.querySelector('.reader-page-view')?.getBoundingClientRect();
                return !view || r.left >= view.left - 1;
              }
              const body = bodyRef.current;
              return !body || r.top >= body.getBoundingClientRect().top;
            }}
            onReveal={(range) => {
              if (paged) return pagedRef.current?.reveal(range);
              const body = bodyRef.current;
              if (!body) return;
              const r = range.getBoundingClientRect();
              const b = body.getBoundingClientRect();
              body.scrollTop += r.top - b.top - body.clientHeight / 2;
            }}
          />
        )}

        {bookId && listenFrom && (
          <AudioBar
            bookId={bookId}
            bookTitle={bookTitle}
            bodyRef={bodyRef}
            start={listenFrom}
            onFollow={(id) => {
              const c = useReader.getState().chapters.find((x) => x.id === id);
              if (c) jump(c);
            }}
            onClose={() => setListenFrom(null)}
          />
        )}

        <TocDrawer
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          bookTitle={bookTitle}
          chapters={chapters}
          currentId={currentId}
          onSelect={(c) => c.id !== currentId && jump(c)}
          bookmarks={bookmarks}
          onSelectBookmark={(b) => {
            const ch = chapters.find((c) => c.id === b.chapterId);
            if (ch) jump(ch, b.para);
          }}
          onRemoveBookmark={removeBookmark}
          topInset={isMac && !fullScreen}
        />

        {bookId && (commentCh || currentId) && (
          <CommentDrawer
            bookId={bookId}
            itemId={commentCh || currentId}
            para={commentPara}
            onClose={() => setCommentPara(null)}
            onPosted={(idx) => {
              addCommentCount(commentCh, idx);
              setCommentPara((p) => p && { ...p, count: p.count + 1 });
            }}
          />
        )}
      </div>
    </ConfigProvider>
  );
}
