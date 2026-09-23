/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/ai-01` (https://blocks.so/r/ai-01.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: MARKUP IDIOM ONLY — centered composer
 * + pill-to-card grid (header/primary/leading/trailing/footer slots) +
 * leading add-menu + trailing voice/waveform/submit slots kept as the
 * voice-preview pairing idiom; composer LOGIC NOT adopted (no draft
 * state, no autogrow resize, no Enter-to-send, no file picker — slots
 * render controlled-by-parent via optional props); ai-SDK install
 * REJECTED (+0 npm); @tabler/icons-react REJECTED -> lucide
 * (Mic/Paperclip/Send/AudioLines/Plus); DropdownMenuGroup wrapper
 * added (house composition rule); dark-mode + oklch shadow arithmetic
 * stripped to tokens; space-x rebuilt as flex+gap.
 */

import { AudioLines, Mic, Paperclip, Plus, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Ai01Props {
  expanded?: boolean;
  canSubmit?: boolean;
  onVoicePreview?: () => void;
}

export default function Ai01({
  expanded = false,
  canSubmit = false,
  onVoicePreview,
}: Ai01Props) {
  return (
    <div className="w-full">
      <h1 className="mx-auto mb-6 max-w-2xl text-balance text-center font-semibold text-3xl text-foreground leading-tight tracking-tight">
        Preview the voice
      </h1>

      <div className="group/composer w-full">
        <div
          className={cn(
            'mx-auto w-full max-w-2xl cursor-text overflow-clip border bg-background bg-clip-padding p-2.5 shadow-xs',
            expanded
              ? "grid rounded-[28px] [grid-template-areas:'header'_'primary'_'footer'] [grid-template-columns:1fr] [grid-template-rows:auto_1fr_auto]"
              : "grid rounded-full [grid-template-areas:'header_header_header'_'leading_primary_trailing'_'._footer_.'] [grid-template-columns:auto_1fr_auto] [grid-template-rows:auto_1fr_auto]",
          )}
        >
          <div
            className={cn(
              'flex overflow-x-hidden [grid-area:primary]',
              expanded
                ? 'px-2 pt-1.5 pb-2'
                : '-my-2.5 min-h-14 items-center px-1.5',
            )}
          >
            <div className="max-h-52 flex-1 overflow-auto">
              <Textarea
                className="min-h-0 resize-none rounded-none border-0 p-0 text-base placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 md:text-base"
                placeholder="Type a line for the agent to speak"
                readOnly
                rows={1}
                value=""
              />
            </div>
          </div>

          <div
            className={cn('flex items-center [grid-area:leading]', {
              hidden: expanded,
            })}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="Add attachments"
                    className="rounded-full transition-[scale,background-color] duration-150 ease-out active:scale-[0.96]"
                    size="icon-lg"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <Plus className="size-5 text-muted-foreground" />
              </DropdownMenuTrigger>

              <DropdownMenuContent
                align="start"
                className="w-64 rounded-[16px] p-1.5"
              >
                <DropdownMenuGroup className="flex flex-col gap-1">
                  <DropdownMenuItem className="rounded-[10px] px-2.5 py-2">
                    <Paperclip className="opacity-60" />
                    Attach a script
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="rounded-[10px] px-2.5 py-2"
                    onClick={onVoicePreview}
                  >
                    <Mic className="opacity-60" />
                    Preview voice
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div
            className={cn(
              'flex items-center gap-2',
              expanded ? '[grid-area:footer]' : '[grid-area:trailing]',
            )}
          >
            <div className="ms-auto flex items-center gap-1.5">
              <Button
                aria-label="Record audio message"
                className="rounded-full transition-[scale,background-color] duration-150 ease-out active:scale-[0.96]"
                onClick={onVoicePreview}
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <Mic className="size-5 text-muted-foreground" />
              </Button>

              <Button
                aria-label="Audio visualization"
                className="rounded-full transition-[scale,background-color] duration-150 ease-out active:scale-[0.96]"
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <AudioLines className="size-5 text-muted-foreground" />
              </Button>

              <Button
                aria-label="Send message"
                className="rounded-full transition-[scale,opacity,background-color] duration-150 ease-out active:scale-[0.96] disabled:opacity-40"
                disabled={!canSubmit}
                size="icon-lg"
                type="button"
              >
                <Send />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
