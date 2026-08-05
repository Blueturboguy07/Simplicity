'use client';

/* eslint-disable @next/next/no-img-element */
import React, { MutableRefObject } from 'react';
import { cn } from '@/lib/utils';
import {
  Disc3,
  Volume2,
  StopCircle,
  Layers3,
  Plus,
  CornerDownRight,
} from 'lucide-react';
import Markdown, { MarkdownToJSX, RuleType } from 'markdown-to-jsx';
import Copy from './MessageActions/Copy';
import Rewrite from './MessageActions/Rewrite';
import Download from './MessageActions/Download';
import SearchImages from './SearchImages';
import SearchVideos from './SearchVideos';
import { useSpeech } from 'react-text-to-speech';
import ThinkBox from './ThinkBox';
import { useChat, Section } from '@/lib/hooks/useChat';
import Citation from './MessageRenderer/Citation';
import { annotateCitations } from './MessageRenderer/citationParser';
import AnswerTabs from './AnswerTabs';
import AssistantSteps from './AssistantSteps';
import {
  CouncilBlock,
  ResearchBlock,
  TextBlock,
  UsageBlock,
} from '@/lib/types';
import Renderer from './Widgets/Renderer';
import CodeBlock from './MessageRenderer/CodeBlock';
import UsageLine from './MessageRenderer/UsageLine';
import CouncilBlockRenderer from './MessageRenderer/CouncilBlock';
import MessageBoxLoading from './MessageBoxLoading';

/* Shown wherever the answer text will land, for as long as the turn is
   running with nothing written yet — the gap between "research done" and the
   writer's first token is otherwise completely silent. */
const AnswerPending = ({ label }: { label: string | null }) => (
  <div className="flex flex-col space-y-3">
    {label && (
      <div className="flex flex-row items-center space-x-2">
        <Disc3 className="w-4 h-4 text-black/50 dark:text-white/50 animate-spin" />
        <span className="text-sm text-black/60 dark:text-white/60 animate-pulse">
          {label}...
        </span>
      </div>
    )}
    <MessageBoxLoading />
  </div>
);

const ThinkTagProcessor = ({
  children,
  thinkingEnded,
}: {
  children: React.ReactNode;
  thinkingEnded: boolean;
}) => {
  return (
    <ThinkBox content={children as string} thinkingEnded={thinkingEnded} />
  );
};

const MessageBox = ({
  section,
  sectionIndex,
  dividerRef,
  isLast,
}: {
  section: Section;
  sectionIndex: number;
  dividerRef?: MutableRefObject<HTMLDivElement | null>;
  isLast: boolean;
}) => {
  const {
    loading,
    sendMessage,
    rewrite,
    messages,
    researchEnded,
    chatHistory,
  } = useChat();

  const parsedMessage = section.parsedTextBlocks.join('\n\n');
  const speechMessage = section.speechMessage || '';
  const thinkingEnded = section.thinkingEnded;

  const sourceBlocks = section.message.responseBlocks.filter(
    (block): block is typeof block & { type: 'source' } =>
      block.type === 'source',
  );

  const sources = sourceBlocks.flatMap((block) => block.data);

  const hasContent = section.parsedTextBlocks.length > 0;

  const usageBlock = section.message.responseBlocks.find(
    (block): block is UsageBlock => block.type === 'usage',
  );

  const councilBlock = section.message.responseBlocks.find(
    (block): block is CouncilBlock => block.type === 'council',
  );

  // Citation rendering reads from the *raw* text blocks rather than
  // section.parsedTextBlocks: useChat's own citation regex can mangle
  // non-citation bracket content (e.g. "[10,000-40,000]") on its way to
  // parsedTextBlocks, and there's no way to recover the original characters
  // once that's happened. Working from the untouched raw text lets
  // annotateCitations apply a strictly-scoped, provably lossless transform
  // instead. The only bit of useChat's per-block logic worth mirroring here
  // is the unclosed-<think>-tag safety net, since that's what keeps a
  // streaming reasoning block from swallowing the rest of the message.
  const rawTextBlocks = section.message.responseBlocks.filter(
    (block): block is TextBlock => block.type === 'text',
  );

  const rawAnswerJoined = rawTextBlocks.map((block) => block.data).join('\n\n');

  /* Is the answer slot still blank? Neither `hasContent` nor `messageAppeared`
     can answer that: a reasoning model's first chunks arrive either as an
     empty text block (openaiLLM forwards `delta.content || ''`) or as <think>
     content that renders in its own collapsed box — both flip those flags
     while the place the answer goes is still empty. Strip reasoning (including
     an unterminated <think> that's still streaming) and see what's left. */
  const answerText = rawAnswerJoined
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
    .trim();

  const answerPending = isLast && loading && answerText.length === 0;

  const hasResearchSteps = section.message.responseBlocks.some(
    (b) => b.type === 'research' && b.data.subSteps.length > 0,
  );

  /* While the steps card is live it already narrates what's happening, so the
     placeholder stays silent and shows only the shimmer. Once research ends
     (or never ran) the card goes quiet and the placeholder has to say why
     nothing is on screen yet. */
  const pendingLabel = !researchEnded
    ? hasResearchSteps
      ? null
      : 'Brainstorming'
    : thinkingEnded
      ? 'Writing answer'
      : 'Thinking';

  let rawAnswerText = rawAnswerJoined;

  if (rawAnswerText.includes('<think>')) {
    const openThinkTag = rawAnswerText.match(/<think>/g)?.length || 0;
    const closeThinkTag = rawAnswerText.match(/<\/think>/g)?.length || 0;

    if (openThinkTag && !closeThinkTag) {
      rawAnswerText += '</think> <a> </a>';
    }
  }

  const answerMarkdown = annotateCitations(rawAnswerText, sources);

  const { speechStatus, start, stop } = useSpeech({ text: speechMessage });

  const markdownOverrides: MarkdownToJSX.Options = {
    renderRule(next, node, renderChildren, state) {
      if (node.type === RuleType.codeInline) {
        return `\`${node.text}\``;
      }

      if (node.type === RuleType.codeBlock) {
        return (
          <CodeBlock key={state.key} language={node.lang || ''}>
            {node.text}
          </CodeBlock>
        );
      }

      return next();
    },
    overrides: {
      think: {
        component: ThinkTagProcessor,
        props: {
          thinkingEnded: thinkingEnded,
        },
      },
      citation: {
        component: Citation,
        props: {
          sources,
        },
      },
    },
  };

  const answerBody = (
    <>
      {/* Identified by messageId so Download's PDF export can grab this
         rendered answer's actual innerHTML for the print window — it stays
         mounted (just CSS-hidden) even behind AnswerTabs' Links/Images tabs,
         see AnswerTabs.tsx. */}
      <div id={`answer-content-${section.message.messageId}`}>
        <Markdown
          className={cn(
            'prose prose-h1:mb-3 prose-h1:font-serif prose-h2:mb-2 prose-h2:mt-6 prose-h2:font-serif prose-h3:mt-4 prose-h3:mb-1.5 prose-h3:font-[600] dark:prose-invert prose-p:leading-relaxed prose-pre:p-0 font-[400]',
            'max-w-none break-words text-black dark:text-white',
          )}
          options={markdownOverrides}
        >
          {answerMarkdown}
        </Markdown>
      </div>

      {/* Deliberately outside the exported #answer-content div: a reasoning
          model streams <think> first, so this sits under the collapsed
          Thinking box until real prose starts. */}
      {answerPending && <AnswerPending label={pendingLabel} />}

      {loading && isLast ? null : (
        <div className="w-full py-4">
          {usageBlock && (
            <div className="mb-2 -ml-0.5">
              <UsageLine block={usageBlock} />
            </div>
          )}
          <div className="flex flex-row items-center justify-between w-full text-black dark:text-white">
            <div className="flex flex-row items-center -ml-2">
              <Rewrite
                rewrite={rewrite}
                messageId={section.message.messageId}
              />
            </div>
            <div className="flex flex-row items-center -mr-2">
              <Copy initialMessage={parsedMessage} section={section} />
              <Download
                query={section.message.query}
                markdown={rawAnswerText}
                sources={sources}
                messageId={section.message.messageId}
              />
              <button
                onClick={() => {
                  if (speechStatus === 'started') {
                    stop();
                  } else {
                    start();
                  }
                }}
                className="p-2 text-black/70 dark:text-white/70 rounded-full hover:bg-light-secondary dark:hover:bg-dark-secondary transition duration-200 hover:text-black dark:hover:text-white"
              >
                {speechStatus === 'started' ? (
                  <StopCircle size={16} />
                ) : (
                  <Volume2 size={16} />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <div className={'w-full pt-8 break-words'}>
        <h2 className="text-black dark:text-white font-medium text-3xl lg:w-9/12">
          {section.message.query}
        </h2>
      </div>

      <div className="flex flex-col space-y-9 lg:space-y-0 lg:flex-row lg:justify-between lg:space-x-9">
        <div
          ref={dividerRef}
          className="flex flex-col space-y-6 w-full lg:w-9/12"
        >
          {section.message.responseBlocks
            .filter(
              (block): block is ResearchBlock =>
                block.type === 'research' && block.data.subSteps.length > 0,
            )
            .map((researchBlock) => (
              <div key={researchBlock.id} className="flex flex-col space-y-2">
                <AssistantSteps
                  block={researchBlock}
                  status={section.message.status}
                  isLast={isLast}
                />
              </div>
            ))}

          {councilBlock && (
            <div className="flex flex-col space-y-2">
              <CouncilBlockRenderer block={councilBlock} />
            </div>
          )}

          {/* A failed turn stays visibly failed — the toast alone disappears
              and leaves a blank answer behind. */}
          {section.message.responseBlocks
            .filter((block) => block.type === 'error')
            .map((block) => (
              <div
                key={block.id}
                className="flex items-start gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/5"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">
                    This answer failed
                  </p>
                  <p className="text-sm text-black/70 dark:text-white/70 mt-1">
                    {String(block.data)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => rewrite(section.message.messageId)}
                  className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-light-secondary dark:bg-dark-secondary hover:bg-light-200 dark:hover:bg-dark-200 text-black dark:text-white transition"
                >
                  Retry
                </button>
              </div>
            ))}

          {section.widgets.length > 0 && <Renderer widgets={section.widgets} />}

          {/* No text block at all yet — nothing renders the answer slot, so the
              placeholder stands in for it here. Once a block exists (even an
              empty or reasoning-only one) the copy inside answerBody takes
              over, which keeps it inside the Answer tab. */}
          {answerPending && !hasContent && (
            <AnswerPending label={pendingLabel} />
          )}

          {hasContent && (
            <div className="flex flex-col space-y-2">
              {sources.length > 0 ? (
                <AnswerTabs
                  sources={sources}
                  query={section.message.query}
                  chatHistory={chatHistory}
                  messageId={section.message.messageId}
                >
                  {answerBody}
                </AnswerTabs>
              ) : (
                answerBody
              )}

              {isLast &&
                section.suggestions &&
                section.suggestions.length > 0 &&
                hasContent &&
                !loading && (
                  <div className="mt-6">
                    <div className="flex flex-row items-center space-x-2 mb-4">
                      <Layers3
                        className="text-black dark:text-white"
                        size={20}
                      />
                      <h3 className="text-black dark:text-white font-medium text-xl">
                        Related
                      </h3>
                    </div>
                    <div className="space-y-0">
                      {section.suggestions.map(
                        (suggestion: string, i: number) => (
                          <div key={i}>
                            <div className="h-px bg-light-200/40 dark:bg-dark-200/40" />
                            <button
                              onClick={() => sendMessage(suggestion)}
                              className="group w-full py-4 text-left transition-colors duration-200"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex flex-row space-x-3 items-center">
                                  <CornerDownRight
                                    size={15}
                                    className="group-hover:text-sky-400 transition-colors duration-200 flex-shrink-0"
                                  />
                                  <p className="text-sm text-black/70 dark:text-white/70 group-hover:text-sky-400 transition-colors duration-200 leading-relaxed">
                                    {suggestion}
                                  </p>
                                </div>
                                <Plus
                                  size={16}
                                  className="text-black/40 dark:text-white/40 group-hover:text-sky-400 transition-colors duration-200 flex-shrink-0"
                                />
                              </div>
                            </button>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>

        {hasContent && (
          <div className="lg:sticky lg:top-20 flex flex-col items-center space-y-3 w-full lg:w-3/12 z-30 h-full pb-4">
            <SearchImages
              query={section.message.query}
              chatHistory={chatHistory}
              messageId={section.message.messageId}
            />
            <SearchVideos
              chatHistory={chatHistory}
              query={section.message.query}
              messageId={section.message.messageId}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageBox;
