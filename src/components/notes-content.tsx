import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";

import { cn } from "#/lib/utils.ts";

/**
 * Basic formatting only — bold, italic, links, lists, blockquotes,
 * paragraphs and line breaks. Anything else authored in the notes
 * (headings, tables, code blocks, raw HTML) is stripped rather than
 * rendered. react-markdown disables raw HTML by default, so this is
 * safe to render for admin-authored notes.
 *
 * `remark-breaks` makes a single newline a hard line break (a `<br>`)
 * rather than collapsing it to a space, so notes pasted with their own
 * line breaks — lyrics, addresses, lists of names — keep them.
 */
const ALLOWED_ELEMENTS = [
	"p",
	"br",
	"strong",
	"em",
	"a",
	"ul",
	"ol",
	"li",
	"blockquote",
];

interface NotesContentProps {
	children: string;
	className?: string;
}

export function NotesContent({ children, className }: NotesContentProps) {
	return (
		<div
			className={cn(
				"space-y-2 text-sm text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-0.5 [&_blockquote]:relative [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-yellow-700 dark:[&_blockquote]:text-yellow-400 [&_blockquote]:before:absolute [&_blockquote]:before:inset-y-0 [&_blockquote]:before:left-0 [&_blockquote]:before:w-0.5 [&_blockquote]:before:rounded-full [&_blockquote]:before:bg-brand/25 [&_blockquote]:before:content-['']",
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkBreaks]}
				allowedElements={ALLOWED_ELEMENTS}
				unwrapDisallowed
				components={{
					a: ({ node, ...props }) => (
						<a {...props} target="_blank" rel="noreferrer" />
					),
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
