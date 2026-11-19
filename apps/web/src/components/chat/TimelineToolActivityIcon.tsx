// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineToolActivityIcon.tsx
// Local changes: the timeline's items carry no tool favicon, themed logo or native app icon
// (event-model 2.2 leaves toolSurface, toolIcon and toolSource empty), so only the named lucide
// fallbacks remain. "t3-code" (system notices) draws lucide Info and "pull-request" draws lucide
// GitPullRequest in place of T3's own glyphs.
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  CircleAlertIcon,
  Code2Icon,
  EyeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HammerIcon,
  InfoIcon,
  ListTodoIcon,
  MessageCircleIcon,
  SearchIcon,
  SmartphoneIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

export const failedToolIconClassName = "text-tool-error-icon/40";

/** Every icon here is a tintable lucide glyph. */
export function toolIconAcceptsTint(_toolIcon: unknown): boolean {
  return true;
}

export type { WorkEntryIconName } from "./TimelineWorkEntryRow.logic.ts";
import type { WorkEntryIconName } from "./TimelineWorkEntryRow.logic.ts";

function BrowserAppIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ToolActivityIconView(props: {
  icon?: unknown;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  return (
    <WorkEntryIcon
      name={props.fallbackName}
      className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
    />
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "pull-request":
      return <GitPullRequestIcon className={className} aria-hidden />;
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
    case "computer":
      return <BrowserAppIcon className={className} />;
    case "code":
      return <Code2Icon className={className} aria-hidden />;
    case "device":
      return <SmartphoneIcon className={className} aria-hidden />;
    case "t3-code":
      return <InfoIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "list-todo":
      return <ListTodoIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}
