import { Fragment, type ReactNode } from 'react';

/**
 * A deliberately small markdown renderer for CONSENT.md.
 *
 * Handles exactly the subset that document uses: headings, bold, inline code,
 * horizontal rules, tables, ordered and unordered lists, and paragraphs. No
 * dependency, and — more to the point — no raw HTML pass-through, so the
 * rendered consent text cannot contain markup at all.
 *
 * Links are rendered as plain text with the URL shown, not as anchors: a
 * consent screen should not be a place where tapping navigates somewhere.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on **bold** and `code`, keeping the delimiters.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const parts = text.split(pattern);

  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      // Recurse: bold spans routinely wrap inline code, and rendering the
      // inner text raw would print the backticks.
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(part.slice(2, -2), `${key}-b`)}
        </strong>,
      );
      return;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-line/50 px-1 py-0.5 text-[0.9em]">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // Em dashes read better than the double hyphen some editors leave behind.
    nodes.push(<Fragment key={key}>{part.replace(/--/g, '—')}</Fragment>);
  });

  return nodes;
}

interface TableBlock {
  header: string[];
  rows: string[][];
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function Markdown({ source }: { source: string }): ReactNode {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) {
      blocks.push(
        <p key={`p-${key++}`} className="mb-3 leading-relaxed">
          {renderInline(text, `p-${key}`)}
        </p>,
      );
    }
  };

  const flushList = (): void => {
    if (!list || list.items.length === 0) {
      list = null;
      return;
    }
    const { ordered, items } = list;
    list = null;
    const className = 'mb-3 space-y-1.5 pl-5 leading-relaxed';
    blocks.push(
      ordered ? (
        <ol key={`l-${key++}`} className={`${className} list-decimal`}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={`l-${key++}`} className={`${className} list-disc`}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
          ))}
        </ul>
      ),
    );
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      flushAll();
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushAll();
      blocks.push(<hr key={`hr-${key++}`} className="my-5 border-line" />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading?.[1] && heading[2] !== undefined) {
      flushAll();
      const level = heading[1].length;
      const content = renderInline(heading[2], `h-${key}`);
      const sizes: Record<number, string> = {
        1: 'text-xl font-semibold mt-1 mb-3',
        2: 'text-lg font-semibold mt-5 mb-2',
        3: 'text-base font-semibold mt-4 mb-2',
        4: 'text-sm font-semibold mt-3 mb-1.5',
      };
      const className = sizes[level] ?? sizes[4] ?? '';
      blocks.push(
        level === 1 ? (
          <h1 key={`h-${key++}`} className={className}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`h-${key++}`} className={className}>{content}</h2>
        ) : (
          <h3 key={`h-${key++}`} className={className}>{content}</h3>
        ),
      );
      continue;
    }

    // A table: header row, separator row, then body rows.
    if (trimmed.startsWith('|') && (lines[i + 1] ?? '').trim().startsWith('|---')) {
      flushAll();
      const table: TableBlock = { header: parseTableRow(trimmed), rows: [] };
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        table.rows.push(parseTableRow((lines[i] ?? '').trim()));
        i += 1;
      }
      i -= 1;
      blocks.push(
        <div key={`t-${key++}`} className="mb-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                {table.header.map((cell, c) => (
                  <th key={c} className="border-b border-line pb-2 pr-4 font-semibold">
                    {renderInline(cell, `th-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-b border-line/60 py-2 pr-4 align-top">
                      {renderInline(cell, `td-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numbered?.[1] !== undefined) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    // A continuation line inside the current list item.
    if (list && /^\s{2,}/.test(line)) {
      const last = list.items.length - 1;
      if (last >= 0) list.items[last] = `${list.items[last] ?? ''} ${trimmed}`;
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushAll();
  return <div className="text-[0.95rem] text-ink">{blocks}</div>;
}
