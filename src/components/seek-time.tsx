"use client";

/** 页面上那个视频 / 音频播放器的 id（详情页只有一个） */
export const PLAYER_ID = "item-player";

/**
 * 要点和口播文字里的一个时间（`1:05`）：点了让播放器跳到那一刻并开始播。
 * at 是 null、或者这条内容没有转存的视频 / 音频时，只是一段文字。
 */
export function SeekTime({ at, label, enabled = true, className = "" }: { at: number | null; label: string; enabled?: boolean; className?: string }) {
  if (at === null || !enabled) return <span className={className}>{label}</span>;
  return (
    <button
      type="button"
      title="跳到这一刻"
      onClick={() => {
        const player = document.getElementById(PLAYER_ID);
        if (!(player instanceof HTMLMediaElement)) return;
        player.currentTime = at;
        void player.play().catch(() => {});
        player.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }}
      className={`${className} cursor-pointer rounded-sm text-accent hover:underline`}
    >
      {label}
    </button>
  );
}
