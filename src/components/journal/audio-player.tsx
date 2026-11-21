"use client";
import { Pause, Play } from "lucide-react";
import { useRef, useState } from "react";
import { clock } from "@/lib/media/transcript";
import type { Cue } from "@/lib/vault/journal-doc";

/** 一开始只列这么多句，多的收起来 */
const CUES_SHOWN = 8;

/**
 * 日记里一段录音的播放条：播放 / 暂停、拖进度、下面是转出来的一句句话（点时间跳到那一刻接着放）。
 * durationS 是服务器量出来的时长：浏览器刚录的那份文件里不带时长，读出来是无穷大，拖不了。
 * 换了文件（服务器转好了格式）时调用方给一个新的 key，从头来。
 */
export function AudioPlayer({ src, durationS, cues }: { src: string; durationS: number | null; cues: Cue[] }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const length = durationS ?? measured;

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const seek = (to: number, play = false) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = to;
    setTime(to);
    if (play && el.paused) void el.play().catch(() => setPlaying(false));
  };
  const shown = all ? cues : cues.slice(0, CUES_SHOWN);

  return (
    <div className="jn-player">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setMeasured(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
      />
      <div className="jn-player-row">
        <button type="button" className="jn-play" onClick={toggle} aria-label={playing ? "暂停" : "播放"}>
          {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        </button>
        <input type="range" className="jn-seek" aria-label="进度" min={0} max={length ?? 0} step={0.1} value={Math.min(time, length ?? time)} disabled={!length} onChange={(e) => seek(Number(e.target.value))} />
        <span className="jn-time">
          {clock(time)}
          {length ? ` / ${clock(length)}` : ""}
        </span>
      </div>
      {cues.length > 0 && (
        <ul className="jn-cues">
          {shown.map((cue, i) => (
            <li key={i}>
              {cue.at !== null && (
                <button type="button" className="jn-cue-at" onClick={() => seek(cue.at ?? 0, true)} title="从这里放">
                  {clock(cue.at)}
                </button>
              )}
              {cue.text}
            </li>
          ))}
          {cues.length > CUES_SHOWN && (
            <li>
              <button type="button" className="jn-link" onClick={() => setAll(!all)}>
                {all ? "收起" : `展开全部 ${cues.length} 句`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
