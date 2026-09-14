"use client";

/**
 * Adapted from Blocks `@blocks-so/chat-01` (MIT, Ephraim Duncan).
 * Voni uses the conversation layout for live voice transcripts only. The
 * generated composer, attachments, editing, feedback, and fake streaming
 * have been removed.
 */

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { cn } from "@/lib/utils";

export type Chat01Turn = {
  role: "user" | "agent";
  text: string;
};

export function Chat01({
  turns,
  agentName,
  className,
}: {
  turns: Chat01Turn[];
  agentName: string;
  className?: string;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className={cn("min-h-0 flex-1", className)}>
        <MessageScrollerViewport
          aria-label="Call transcript"
          aria-live="polite"
        >
          <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-3 px-1.5 py-4">
            {turns.map((turn, index) => {
              const isUser = turn.role === "user";
              return (
                <MessageScrollerItem
                  key={`${index}-${turn.role}`}
                  messageId={`${index}-${turn.role}`}
                  className="px-2.5"
                >
                  <Message align={isUser ? "end" : "start"}>
                    <MessageContent className="gap-1">
                      <span
                        className={cn(
                          "px-1 text-xs font-medium text-muted-foreground",
                          isUser && "self-end",
                        )}
                      >
                        {isUser ? "You" : agentName}
                      </span>
                      <Bubble
                        align={isUser ? "end" : "start"}
                        variant={isUser ? "outline" : "muted"}
                        className="max-w-[85%]"
                      >
                        <BubbleContent>{turn.text}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
