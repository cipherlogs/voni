"use client";

/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/ai-05` (https://blocks.so/r/ai-05.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Upstream commit 54f6cbfa2c91a4377c980d9b0ac787d6ce5750a0
 * ("feat(ai): redesign the ai-05 chat block (#79)"; the registry JSON
 * body was verified byte-identical to content/components/ai/ai-05.tsx
 * at that commit).
 * Adaptations for this project: MARKUP IDIOM ONLY — card shell (header /
 * thread / suggestion chips / composer) kept; COMPOSER + THREAD LOGIC NOT
 * adopted (no useState draft, no canned RESPONSES, no setTimeout fake
 * reply — everything renders controlled-by-parent via props, following
 * the ai-01 / chat-01 precedent); ai-elements primitives hand-ported
 * onto installed Base UI primitives (Conversation trio ->
 * MessageScroller* with Provider autoScroll end, Message duo -> Message
 * + MessageContent + Bubble, PromptInput set -> form + InputGroup +
 * InputGroupTextarea + block-end InputGroupAddon footer with
 * InputGroupButtons; submit icon swaps ArrowUp / LoaderCircle by
 * status); assistant MessageResponse (markdown) renders as plain text —
 * no markdown renderer is in scope, a renderer choice belongs to the
 * integration step; @tabler/icons-react REJECTED -> lucide
 * (Plus/SlidersHorizontal/Paperclip/Zap/ArrowUp/LoaderCircle),
 * stroke={1.5} -> strokeWidth={1.5}, icon size classes dropped (Button /
 * InputGroupButton CSS auto-sizes); ai-SDK ChatStatus REJECTED -> local
 * Ai05Status union ('submitted' | 'streaming' | 'ready' | 'error'),
 * SDK-parity with NO provider / hook / transport logic and no `ai`
 * dependency; presence dot emerald-500 ->
 * bg-primary (table-04 success-dot precedent); layered oklch card shadow
 * + dark: shadow -> border + shadow-lg token; suggestion chips rebuilt as
 * Button outline sm rounded-full (house composition rule).
 * NOT wired into any page — integration is a separate step.
 */

import {
  ArrowUp,
  LoaderCircle,
  Paperclip,
  Plus,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Message, MessageContent } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { cn } from '@/lib/utils';

export type Ai05Status = 'submitted' | 'streaming' | 'ready' | 'error';

export interface Ai05Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Ai05Props {
  messages: Ai05Message[];
  inputValue: string;
  onInputChange: (value: string) => void;
  status: Ai05Status;
  suggestions: string[];
  onSend: (text: string) => void;
  onReset: () => void;
  className?: string;
}

export default function Ai05({
  messages,
  inputValue,
  onInputChange,
  status,
  suggestions,
  onSend,
  onReset,
  className,
}: Ai05Props) {
  const canSend = inputValue.trim().length > 0 && status === 'ready';

  return (
    <div className={cn('w-full px-4', className)}>
      <div className="mx-auto flex h-[560px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border bg-card shadow-lg">
        <header className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex flex-col">
            <span className="font-semibold text-sm leading-tight">
              Assistant
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
              <span className="size-1.5 rounded-full bg-primary" />
              Online
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={onReset}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus strokeWidth={1.5} />
              New chat
            </Button>
            <Button
              aria-label="Settings"
              size="icon"
              title="Settings"
              type="button"
              variant="ghost"
            >
              <SlidersHorizontal strokeWidth={1.5} />
            </Button>
          </div>
        </header>

        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="border-t border-border/60">
            <MessageScrollerViewport aria-label="Conversation" aria-live="polite">
              <MessageScrollerContent className="gap-5 px-5 py-5">
                {messages.map((message) =>
                  message.role === 'assistant' ? (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                    >
                      <Message align="start">
                        <MessageContent>
                          <Bubble align="start" variant="ghost">
                            <BubbleContent className="max-w-prose">
                              <p className="whitespace-pre-wrap">
                                {message.content}
                              </p>
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                    >
                      <Message align="end">
                        <MessageContent>
                          <Bubble align="end" variant="default">
                            <BubbleContent>
                              <p className="whitespace-pre-wrap text-pretty">
                                {message.content}
                              </p>
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ),
                )}
                {status === 'submitted' && (
                  <MessageScrollerItem messageId="assistant-typing">
                    <Message align="start">
                      <output
                        aria-label="Assistant is typing"
                        className="flex h-7 items-center gap-1"
                      >
                        {[0, 1, 2].map((dot) => (
                          <span
                            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
                            key={dot}
                            style={{ animationDelay: `${dot * 150}ms` }}
                          />
                        ))}
                      </output>
                    </Message>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap gap-2 px-1">
            {suggestions.map((suggestion) => (
              <Button
                className="rounded-full px-3 text-xs"
                disabled={status !== 'ready'}
                key={suggestion}
                onClick={() => onSend(suggestion)}
                size="sm"
                type="button"
                variant="outline"
              >
                {suggestion}
              </Button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSend(inputValue);
            }}
          >
            <InputGroup className="rounded-xl border-border bg-muted/40">
              <InputGroupTextarea
                onChange={(event) =>
                  onInputChange(event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Message Assistant..."
                rows={1}
                value={inputValue}
              />
              <InputGroupAddon align="block-end">
                <div className="flex w-full items-center gap-0.5">
                  <InputGroupButton
                    aria-label="Attach file"
                    size="icon-sm"
                    type="button"
                  >
                    <Paperclip strokeWidth={1.5} />
                  </InputGroupButton>
                  <InputGroupButton
                    aria-label="Quick prompt"
                    size="icon-sm"
                    type="button"
                  >
                    <Zap strokeWidth={1.5} />
                  </InputGroupButton>
                  <InputGroupButton
                    aria-label="Send message"
                    className="ms-auto rounded-full transition-[scale,opacity] active:scale-[0.96]"
                    disabled={!canSend}
                    size="icon-sm"
                    type="submit"
                  >
                    {status === 'ready' ? (
                      <ArrowUp strokeWidth={1.5} />
                    ) : (
                      <LoaderCircle
                        className="animate-spin"
                        strokeWidth={1.5}
                      />
                    )}
                  </InputGroupButton>
                </div>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </div>
  );
}
