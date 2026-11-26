"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ActionState } from "@/app/(app)/actions";
import type { AskTurnResult } from "@/app/(app)/ask/actions";
import { answerBlocks, type AnswerPiece } from "@/lib/vault/ask";
import type { AskDetail } from "@/lib/vault/ask-service";
import type { AskCite, AskMessage } from "@/lib/vault/ask-store";
import { ActionForm } from "./action-form";

/**
 * 「问 Vault」的一次提问：一问一答从上往下排，每个回答下面是它的出处（收藏库里的内容，点了过去）和这次没看到的东西，
 * 最下面接着追问。回答里的 [1]、[2] 画成小标记，对应出处列表里的第几条；引用的内容后来删了的，标记和那一条不给链接。
 *
 * 追问要等模型（十几秒到一分钟），不是一个字一个字出来的：等的时候问的那句先显示出来，下面说明在做什么。
 * 动作（追问、删除）从页面传进来：都是 server action，逻辑在 lib/vault/ask-service.ts。
 */

export type AskApi = {
  followUp: (id: string, question: string) => Promise<AskTurnResult>;
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
};

type Answer = Extract<AskMessage, { role: "assistant" }>;

/** WORD JOINER：它两边都不许断行 */
const JOINER = "⁠";

function CiteMark({ n, cite, gone }: { n: number; cite: AskCite; gone: boolean }) {
  // 普通的行内文字，不是 inline-flex 的小方块：方块前后都能断行，后面的句号会被单独甩到下一行。
  // 前面垫一个不许断行的零宽字符，标记不会离开它跟着的那个字。
  const look = "ml-0.5 rounded-sm px-1 py-px align-[0.1em] text-[10px] leading-none font-medium whitespace-nowrap";
  const label = `${JOINER}${n}`;
  if (gone) {
    return (
      <span title={`${cite.title}（这条内容已经删了）`} className={`${look} bg-sunken text-ink-faint`}>
        {label}
      </span>
    );
  }
  return (
    <Link href={`/items/${cite.id}`} prefetch={false} title={cite.title} aria-label={`出处 ${n}：${cite.title}`} className={`${look} bg-accent-soft text-accent hover:bg-accent hover:text-on-accent`}>
      {label}
    </Link>
  );
}

function Pieces({ pieces, cites, gone }: { pieces: AnswerPiece[]; cites: AskCite[]; gone: Set<string> }) {
  return (
    <>
      {pieces.map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        const cite = cites[p.cite - 1];
        return <CiteMark key={i} n={p.cite} cite={cite} gone={gone.has(cite.id)} />;
      })}
    </>
  );
}

function AnswerView({ answer, gone }: { answer: Answer; gone: Set<string> }) {
  const blocks = answerBlocks(answer.text, answer.cites.length);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5 text-[15px] leading-relaxed text-ink-secondary">
        {blocks.map((b, i) =>
          b.type === "p" ? (
            <p key={i}>
              <Pieces pieces={b.pieces} cites={answer.cites} gone={gone} />
            </p>
          ) : (
            <ul key={i} className="flex list-disc flex-col gap-1.5 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Pieces pieces={item} cites={answer.cites} gone={gone} />
                </li>
              ))}
            </ul>
          )
        )}
      </div>

      {answer.cites.length > 0 && (
        <section aria-label="出处" className="flex flex-col gap-1.5">
          <h3 className="label">出处</h3>
          <ol className="flex flex-col gap-1">
            {answer.cites.map((c, i) => (
              <li key={c.id} className="flex items-baseline gap-2 text-sm">
                <span aria-hidden className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-1 text-[10px] leading-none font-medium ${gone.has(c.id) ? "bg-sunken text-ink-faint" : "bg-accent-soft text-accent"}`}>
                  {i + 1}
                </span>
                {gone.has(c.id) ? (
                  <span className="min-w-0 text-ink-muted">
                    {c.title}
                    <span className="text-ink-faint">（已经删了）</span>
                  </span>
                ) : (
                  <Link href={`/items/${c.id}`} prefetch={false} className="min-w-0 text-ink hover:text-accent hover:underline">
                    {c.title}
                  </Link>
                )}
                {c.origin && <span className="shrink-0 text-xs text-ink-faint">{c.origin}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {answer.notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 rounded-md bg-warning-soft py-1.5 pr-3 pl-7 text-xs text-warning">
          {answer.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <p className="text-xs text-ink-faint">
        {answer.seen === 0
          ? "这次没有从收藏库里找到能给 AI 看的内容，没有调用模型。"
          : `只根据收藏库里找出来的 ${answer.seen} 条回答${answer.total === null ? "" : `（处理好的一共 ${answer.total} 条）`}，看的是整理过的结果，不是原文全文：没提到不等于没存过。`}
      </p>
    </div>
  );
}

export function AskThread({ initial, api, max }: { initial: AskDetail; api: AskApi; max: number }) {
  const id = initial.ask.id;
  const [detail, setDetail] = useState(initial);
  const [text, setText] = useState("");
  /** 正在等回答的那句话 */
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef<HTMLDivElement>(null);
  const latest = useRef<HTMLElement>(null);
  const gone = new Set(detail.gone);
  const chat = detail.ask.chat;

  // 一问一答配成一轮（丢过旧对话的、数据不齐的：没有问题的回答、没有回答的问题各自成一轮）
  const turns: { question: string | null; answer: Answer | null; at: string }[] = [];
  for (const m of chat) {
    if (m.role === "user") turns.push({ question: m.text, answer: null, at: m.at });
    else if (turns.length > 0 && turns[turns.length - 1].answer === null) turns[turns.length - 1].answer = m;
    else turns.push({ question: null, answer: m, at: m.at });
  }

  // 问出去之后把「在找」那一块滚进来；答完把新的那一轮顶到上面（进页面时不动）
  const count = useRef(chat.length);
  useEffect(() => {
    if (asking) waiting.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [asking]);
  useEffect(() => {
    if (chat.length !== count.current) latest.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    count.current = chat.length;
  }, [chat.length]);

  const send = async () => {
    const question = text.trim();
    if (!question || asking) return;
    setAsking(question);
    setError(null);
    let res: AskTurnResult;
    try {
      res = await api.followUp(id, question);
    } catch {
      res = { error: "没连上服务器，请稍后重试" };
    }
    setAsking(null);
    if ("error" in res) {
      // 问的话留在框里，改一改还能再发
      setError(res.error);
      return;
    }
    setDetail(res.detail);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/ask" prefetch={false} className="self-start text-sm text-ink-muted hover:text-ink">
        ← 问
      </Link>

      <div className="flex flex-col gap-8">
        {turns.map((t, i) => (
          <article key={`${t.at}-${i}`} ref={i === turns.length - 1 ? latest : undefined} className="flex scroll-mt-4 flex-col gap-3">
            {t.question !== null &&
              (i === 0 ? (
                <h1 className="text-xl leading-snug font-semibold tracking-tight whitespace-pre-wrap">{t.question}</h1>
              ) : (
                <h2 className="border-t border-edge pt-6 text-lg leading-snug font-semibold tracking-tight whitespace-pre-wrap">{t.question}</h2>
              ))}
            {t.answer ? <AnswerView answer={t.answer} gone={gone} /> : <p className="text-sm text-ink-muted">这一句没有留下回答。</p>}
          </article>
        ))}

        {asking && (
          <div ref={waiting} className="flex scroll-mt-4 flex-col gap-3">
            <h2 className="border-t border-edge pt-6 text-lg leading-snug font-semibold tracking-tight whitespace-pre-wrap">{asking}</h2>
            <p role="status" className="rounded-md bg-accent-soft px-3.5 py-2.5 text-sm text-accent">
              正在从你的收藏里找相关的内容、写回答…一般要十几秒到一分钟。
            </p>
          </div>
        )}
      </div>

      <section aria-label="接着问" className="flex flex-col gap-2 border-t border-edge pt-5">
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            rows={2}
            maxLength={max}
            disabled={asking !== null}
            aria-label="接着问"
            placeholder="接着问：它记得上面问过的和引用过的内容"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            className="field max-h-48 min-w-0 flex-1 resize-none"
          />
          <button type="button" className="btn btn-primary" disabled={asking !== null || !text.trim()} onClick={() => void send()}>
            {asking ? "在找…" : "问"}
          </button>
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
        <Link href="/ask" prefetch={false} className="text-accent hover:underline">
          问一个新的问题
        </Link>
        {detail.ask.costUsd > 0 && <span>这次提问一共花了约 ${detail.ask.costUsd.toFixed(3)}</span>}
        <ActionForm action={api.remove} confirm="删掉这次提问和它的回答？删了不能恢复。" className="ml-auto">
          {(pending) => (
            <>
              <input type="hidden" name="id" value={id} />
              <button className="btn btn-danger h-8 px-2 text-xs" disabled={pending || asking !== null}>
                {pending ? "删除中…" : "删除"}
              </button>
            </>
          )}
        </ActionForm>
      </footer>
    </div>
  );
}
