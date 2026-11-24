import { useEffect, useRef, useState, type RefObject } from 'react';
import { Select } from 'antd';
import {
  CaretRightFilled, CloseOutlined, LoadingOutlined, PauseOutlined, StepBackwardFilled, StepForwardFilled,
} from '@ant-design/icons';
import type { AudioTimepoint, AudioTone } from '@/types';
import { useReader } from '@/stores/reader';
import * as api from '@/services/api';

const TITLE_PARA = 10000;
const RATES = [0.75, 1, 1.25, 1.5, 2];
const TONE_KEY = 'fq-audio-tone';
const RATE_KEY = 'fq-audio-rate';

const loadStr = (key: string) => {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
};
const load = (key: string) => Number(loadStr(key)) || 0;
const keep = (key: string, v: number | string) => {
  try { localStorage.setItem(key, String(v)); } catch { /* 存不了就算了 */ }
};
const clock = (s: number) => {
  if (!isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** 阅读页的听书条：番茄服务端合成的 AI 朗读，按时间轴高亮正在读的段落，读完自动接下一章 */
export default function AudioBar({ bookId, bookTitle, bodyRef, start, onFollow, onClose }: {
  bookId: string;
  bookTitle: string;
  bodyRef: RefObject<HTMLDivElement>;
  /** 从哪章第几段（段评同款 idx）开始听 */
  start: { chapterId: string; para: number };
  /** 读到的章节不在章节流里时，让阅读页跳过去 */
  onFollow: (chapterId: string) => void;
  onClose: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const [tones, setTones] = useState<AudioTone[] | null>(null);
  const [toneKey, setToneKey] = useState('');
  const [rate, setRate] = useState(() => (RATES.includes(load(RATE_KEY)) ? load(RATE_KEY) : 1));
  const [chapterId, setChapterId] = useState(start.chapterId);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ cur: 0, total: NaN });
  const [error, setError] = useState('');

  const pointsRef = useRef<AudioTimepoint[]>([]);
  // 当前高亮的段落，以及正在读的章和段
  const hlRef = useRef<HTMLElement | null>(null);
  const posRef = useRef({ chapterId: start.chapterId, para: start.para });
  // 换章、换音色时作废还在路上的请求
  const tokenRef = useRef(0);
  // 最新音色：双击切段的 effect 从 ref 取，避免依赖 toneKey 导致换音色时重复播放
  const toneKeyRef = useRef(toneKey);
  toneKeyRef.current = toneKey;

  const chapters = useReader((s) => s.chapters);
  const chapter = chapters.find((c) => c.id === chapterId);

  const clearHighlight = () => {
    hlRef.current?.classList.remove('reader-listening');
    hlRef.current = null;
  };

  /** 读者是否在跟着听：没有高亮段，或高亮段还在屏幕里 */
  const following = () => {
    const body = bodyRef.current;
    const el = hlRef.current;
    if (!body || !el?.isConnected) return true;
    const view = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.bottom > view.top && r.top < view.bottom;
  };

  /** 高亮正在读的段落；读者在跟读时把它滚到视口上部 */
  const highlight = (chId: string, para: number) => {
    posRef.current = { chapterId: chId, para };
    const body = bodyRef.current;
    const seg = useReader.getState().segments.find((g) => g.chapter.id === chId);
    if (!body || !seg) return clearHighlight();
    const i = para === TITLE_PARA ? -1 : seg.paraIdx.indexOf(para);
    const root = body.querySelector<HTMLElement>(`[data-seg="${CSS.escape(chId)}"]`);
    const el = para === TITLE_PARA
      ? root?.querySelector<HTMLElement>('.reader-chapter-title')
      : i >= 0 ? root?.querySelector<HTMLElement>(`.reader-para[data-para="${i}"]`) : null;
    if (!el || el === hlRef.current) return;
    const follow = following();
    const view = body.getBoundingClientRect();
    clearHighlight();
    el.classList.add('reader-listening');
    hlRef.current = el;
    const r = el.getBoundingClientRect();
    if (follow && (r.top < view.top + 40 || r.bottom > view.bottom - 80)) {
      body.scrollBy({ top: r.top - view.top - body.clientHeight * 0.3, behavior: 'smooth' });
    }
  };

  /** 播放某章，从指定段落开始 */
  const playChapter = async (chId: string, para: number, tone: string) => {
    const token = ++tokenRef.current;
    const audio = audioRef.current;
    audio.pause();
    posRef.current = { chapterId: chId, para };
    setChapterId(chId);
    setLoading(true);
    setError('');
    setTime({ cur: 0, total: NaN });
    try {
      // 真人主播的音频和段落时间一次拿到；AI 朗读分两个接口，时间轴拿不到也能播
      const { url, backupUrl, points } = tone.startsWith('abook:')
        ? await api.audioNarration(bookId, chId, tone.slice(6))
        : await Promise.all([
          api.audioPlayInfo(chId, Number(tone)),
          api.audioTimepoints(bookId, chId, Number(tone)).catch(() => [] as AudioTimepoint[]),
        ]).then(([info, pts]) => ({ ...info, points: pts }));
      if (token !== tokenRef.current) return;
      pointsRef.current = points;
      const from = para > 0 ? points.find((p) => p.para !== TITLE_PARA && p.para >= para) : undefined;
      let backup = backupUrl;
      audio.onerror = () => {
        if (token !== tokenRef.current) return;
        if (backup) {
          audio.src = backup;
          backup = '';
          audio.play().catch(() => {});
        } else {
          setLoading(false);
          setError('音频加载失败');
        }
      };
      audio.onloadedmetadata = () => {
        if (from && token === tokenRef.current) audio.currentTime = from.start / 1000;
        audio.onloadedmetadata = null;
      };
      audio.src = url;
      audio.playbackRate = rate;
      await audio.play();
    } catch (e) {
      if (token !== tokenRef.current) return;
      setLoading(false);
      // 加载中点了暂停，play() 会被打断，不算出错；
      // 音源解不了（有的主地址是 MP4 封装的 MP3）交给 onerror 换备用地址，备用也失败才报错
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotSupportedError')) return;
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '播放失败');
    }
  };

  const step = (delta: number) => {
    const list = useReader.getState().chapters;
    const next = list[list.findIndex((c) => c.id === posRef.current.chapterId) + delta];
    if (!next) return false;
    const seg = useReader.getState().segments.some((g) => g.chapter.id === next.id);
    // 读者跟着听时，章节流里没有下一章就让阅读页跳过去
    if (!seg && following()) onFollow(next.id);
    clearHighlight();
    playChapter(next.id, 0, toneKey);
    return true;
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (error) playChapter(posRef.current.chapterId, posRef.current.para, toneKey);
    else if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  // 每次渲染都换上最新的闭包，音频事件里拿到的就是当前状态
  const handlers = useRef({ step, toggle, highlight });
  handlers.current = { step, toggle, highlight };
  // 先拿本书的音色，再开始播放
  useEffect(() => {
    let alive = true;
    api.audioTones(bookId).then((list) => {
      if (!alive) return;
      setTones(list);
      if (!list.length) {
        setLoading(false);
        setError('这本书暂不支持听书');
        return;
      }
      // 默认用 AI 朗读：主播通常比连载慢，最新几章往往还没录
      const saved = loadStr(TONE_KEY);
      const tone = list.find((t) => t.key === saved) || list.find((t) => t.kind === 'tts') || list[0];
      setToneKey(tone.key);
      playChapter(start.chapterId, start.para, tone.key);
    }).catch((e) => {
      if (!alive) return;
      setTones([]);
      setLoading(false);
      setError(e instanceof Error ? e.message : '获取音色失败');
    });
    return () => { alive = false; };
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 首次播放由上面的音色加载流程接管；之后 start 变化（双击切段）才从新段落重新播放
  const firstStartRef = useRef(true);
  useEffect(() => {
    if (firstStartRef.current) { firstStartRef.current = false; return; }
    playChapter(start.chapterId, start.para, toneKeyRef.current);
  }, [start]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    const onTime = () => {
      const ms = audio.currentTime * 1000;
      setTime({ cur: audio.currentTime, total: audio.duration });
      const p = pointsRef.current.find((t) => ms >= t.start && ms < t.end);
      if (p) handlers.current.highlight(posRef.current.chapterId, p.para);
    };
    const onPlay = () => { setPlaying(true); setLoading(false); };
    const onPause = () => setPlaying(false);
    const onWait = () => setLoading(true);
    const onEnded = () => {
      if (!handlers.current.step(1)) { setPlaying(false); clearHighlight(); }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('playing', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWait);
    audio.addEventListener('ended', onEnded);

    // 键盘媒体键、控制中心
    const ms = navigator.mediaSession;
    ms?.setActionHandler('play', () => handlers.current.toggle());
    ms?.setActionHandler('pause', () => handlers.current.toggle());
    ms?.setActionHandler('previoustrack', () => handlers.current.step(-1));
    ms?.setActionHandler('nexttrack', () => handlers.current.step(1));

    return () => {
      tokenRef.current++;
      audio.pause();
      audio.removeAttribute('src');
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('playing', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWait);
      audio.removeEventListener('ended', onEnded);
      (['play', 'pause', 'previoustrack', 'nexttrack'] as const).forEach((a) => ms?.setActionHandler(a, null));
      if (ms) ms.metadata = null;
      clearHighlight();
    };
  }, []);

  useEffect(() => {
    if (navigator.mediaSession && chapter) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: chapter.title, artist: bookTitle, album: bookTitle });
    }
  }, [chapter, bookTitle]);

  const changeTone = (key: string) => {
    setToneKey(key);
    keep(TONE_KEY, key);
    playChapter(posRef.current.chapterId, posRef.current.para, key);
  };

  // 下拉框里分成真人主播和 AI 朗读两组
  const toneGroups = ([['narrator', '真人主播'], ['tts', 'AI 朗读']] as const)
    .map(([kind, label]) => ({
      label,
      title: label,
      options: (tones || []).filter((t) => t.kind === kind)
        .map((t) => ({ value: t.key, label: t.title })),
    }))
    .filter((g) => g.options.length);
  const toneDesc = Object.fromEntries((tones || []).map((t) => [t.key, t.description]));

  const changeRate = (v: number) => {
    setRate(v);
    keep(RATE_KEY, v);
    audioRef.current.playbackRate = v;
  };

  const idx = chapters.findIndex((c) => c.id === chapterId);

  return (
    <div className="audio-bar">
      <button className="audio-btn" title="上一章" disabled={idx <= 0} onClick={() => step(-1)}>
        <StepBackwardFilled />
      </button>
      <button className="audio-btn audio-play" title={playing ? '暂停' : '播放'} onClick={toggle} disabled={!tones?.length}>
        {loading ? <LoadingOutlined /> : playing ? <PauseOutlined /> : <CaretRightFilled />}
      </button>
      <button className="audio-btn" title="下一章" disabled={idx < 0 || idx >= chapters.length - 1} onClick={() => step(1)}>
        <StepForwardFilled />
      </button>
      <div className="audio-info">
        <div className="audio-title">{chapter?.title || ''}</div>
        <div className={`audio-sub${error ? ' error' : ''}`}>
          {error || `${clock(time.cur)} / ${clock(time.total)}`}
        </div>
      </div>
      {!!tones?.length && (
        <Select
          size="small"
          variant="borderless"
          className="audio-select"
          popupMatchSelectWidth={false}
          value={toneKey}
          onChange={changeTone}
          options={toneGroups}
          optionRender={(o) => (
            <div className="audio-tone-option">
              <span>{o.label}</span>
              {toneDesc[o.value as string] && <span className="audio-tone-desc">{toneDesc[o.value as string]}</span>}
            </div>
          )}
        />
      )}
      <Select
        size="small"
        variant="borderless"
        className="audio-select"
        popupMatchSelectWidth={false}
        value={rate}
        onChange={changeRate}
        options={RATES.map((r) => ({ value: r, label: `${r}x` }))}
      />
      <button className="audio-btn" title="关闭听书" onClick={onClose}>
        <CloseOutlined />
      </button>
    </div>
  );
}
