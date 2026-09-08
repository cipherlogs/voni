"use client";

import { Bot, PartyPopper, Sparkles } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type MascotMood = "waving" | "thinking" | "celebrating";

const MOOD_META: Record<
  MascotMood,
  { icon: typeof Bot; bubble: string; label: string }
> = {
  waving: {
    icon: Bot,
    bubble: "bg-primary text-primary-foreground",
    label: "Voni guide waving hello",
  },
  thinking: {
    icon: Sparkles,
    bubble: "bg-muted text-foreground",
    label: "Voni guide thinking",
  },
  celebrating: {
    icon: PartyPopper,
    bubble: "bg-primary text-primary-foreground",
    label: "Voni guide celebrating",
  },
};

export function MascotAvatar({
  mood = "waving",
  size = "default",
  className,
}: {
  mood?: MascotMood;
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const meta = MOOD_META[mood];
  const Icon = meta.icon;
  return (
    <Avatar
      size={size}
      className={cn("shrink-0", meta.bubble, className)}
      aria-label={meta.label}
      role="img"
    >
      <AvatarFallback className={cn("border-0", meta.bubble)}>
        <Icon className="size-5" aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}

export function GuideMascot({
  mood = "waving",
  title,
  message,
  className,
}: {
  mood?: MascotMood;
  title: string;
  message: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <MascotAvatar mood={mood} size="lg" />
      <Card className="max-w-md gap-1 p-3">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{message}</p>
      </Card>
    </div>
  );
}
