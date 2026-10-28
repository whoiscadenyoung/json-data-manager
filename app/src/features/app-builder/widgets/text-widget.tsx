import { Field, FieldDescription, FieldLabel } from "@caden/ui/components/field";
import { Textarea } from "@caden/ui/components/textarea";
import type { ReactNode } from "react";

import { WidgetMessage, type WidgetSettingsProps, type WidgetViewProps } from "./shared";

/**
 * Text blocks: headings, intros, and notes between data widgets. A tiny,
 * safe markdown subset — `#`/`##`/`###` headings, `-` bullets, blank-line
 * paragraphs — rendered as React elements (never HTML), so nothing an app
 * author types can inject markup into a viewer's page.
 */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/,
  BULLET = /^[-*]\s+(.*)$/;

function headingLevel(hashes: string): 1 | 2 | 3 {
  if (hashes.length === 1) {
    return 1;
  }
  return hashes.length === 2 ? 2 : 3;
}

/** Parses the subset into blocks. Exported for tests. */
export function parseTextBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim(),
      heading = HEADING.exec(line),
      bullet = BULLET.exec(line);
    if (line === "") {
      flush();
    } else if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: headingLevel(heading[1]), text: heading[2] });
    } else if (bullet !== null) {
      flush();
      const last = blocks.at(-1);
      if (last !== undefined && last.kind === "list") {
        last.items.push(bullet[1]);
      } else {
        blocks.push({ items: [bullet[1]], kind: "list" });
      }
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const HEADING_CLASSES = {
  1: "text-2xl font-semibold tracking-tight",
  2: "text-lg font-semibold",
  3: "text-base font-semibold",
} as const;

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag key={index} className={HEADING_CLASSES[block.level]}>
          {block.text}
        </Tag>
      );
    }
    case "list": {
      return (
        <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
          {block.items.map((item, itemIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- list items have no identity beyond their position in the text.
            <li key={itemIndex}>{item}</li>
          ))}
        </ul>
      );
    }
    case "paragraph": {
      return (
        <p key={index} className="text-muted-foreground">
          {block.text}
        </p>
      );
    }
  }
}

export function TextWidgetView({ widget }: WidgetViewProps<"text">) {
  const blocks = parseTextBlocks(widget.body);
  if (blocks.length === 0) {
    return <WidgetMessage>Empty text block — add text in the Widget panel.</WidgetMessage>;
  }
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto px-4 py-3 text-sm">
      {blocks.map(renderBlock)}
    </div>
  );
}

export function TextWidgetSettings({ widget, onChange }: WidgetSettingsProps<"text">) {
  return (
    <Field>
      <FieldLabel htmlFor={`text-body-${widget.id}`}>Text</FieldLabel>
      <Textarea
        id={`text-body-${widget.id}`}
        rows={8}
        value={widget.body}
        onChange={(event) => {
          onChange({ ...widget, body: event.target.value });
        }}
      />
      <FieldDescription>
        Start a line with # for a heading or - for a bullet. Leave a blank line between paragraphs.
      </FieldDescription>
    </Field>
  );
}
