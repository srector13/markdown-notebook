import * as vscode from 'vscode';
import * as path from 'path';

type MarkdownIt = any;

export function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
  addMermaid(md);
  addTaskLists(md);
  addMark(md);
  addLinkTargets(md);
  addPreviewData(md);
  return md;
}

// ── Extension → preview data channel ──
// The preview webview can't receive messages from the extension directly, so
// dynamic data rides along in the rendered HTML as data attributes on a hidden
// element, which the preview scripts (theme-bootstrap.js, mermaid-preview.js)
// read from the DOM.

let previewScrollTarget: { line: number; timestamp: number } | undefined;

/** Ask the preview to scroll to a source line on its next render. */
export function setPreviewScrollTarget(line: number): void {
  previewScrollTarget = { line, timestamp: Date.now() };
}

function addPreviewData(md: MarkdownIt): void {
  md.core.ruler.push('notebook-preview-data', (state: any) => {
    const cfg = vscode.workspace.getConfiguration('markdownNotebook');
    const settings = {
      defaultPageWidth: cfg.get<string>('defaultPageWidth', 'standard'),
      defaultMermaidZoom: Number(cfg.get<number>('defaultMermaidZoom', 100)) || 100,
      previewTheme: cfg.get<string>('previewTheme', 'github'),
    };
    const scrollAttr = previewScrollTarget
      ? ` data-scroll-target="${escapeHtml(JSON.stringify(previewScrollTarget))}"`
      : '';
    const token = new state.Token('html_block', '', 0);
    token.content = `<div id="notebook-preview-data" style="display:none" data-settings="${escapeHtml(
      JSON.stringify(settings),
    )}"${scrollAttr}></div>\n`;
    state.tokens.push(token);
  });
}

/**
 * Turn ```mermaid fenced blocks into <pre class="mermaid"> so the preview
 * script can hand them to mermaid.run(). We override the fence renderer and
 * delegate everything else to the original.
 */
function addMermaid(md: MarkdownIt): void {
  const defaultFence =
    md.renderer.rules.fence ||
    ((tokens: any[], idx: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
    const token = tokens[idx];
    const info = (token.info || '').trim().split(/\s+/g)[0].toLowerCase();
    if (info === 'mermaid') {
      // Store the raw graph text; the preview script renders it client-side.
      const code = token.content;
      const mapLine = token.map ? token.map[0] : -1;
      const cmdUri = `command:markdownNotebook.toggleMermaidOrientationAtLine?${encodeURIComponent(JSON.stringify(['', mapLine]))}`;
      return `<div class="mermaid-block-container" style="position: relative;">
        <a class="mermaid-toggle-cmd" href="${cmdUri}" style="display:none;" title="Toggle Orientation"></a>
        <pre class="notebook-mermaid" data-notebook-mermaid data-line="${mapLine}">${escapeHtml(code)}</pre>
      </div>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };
}

/** ==highlight== → <mark>highlight</mark>. */
function addMark(md: MarkdownIt): void {
  md.inline.ruler.after('emphasis', 'notebook-mark', (state: any, silent: boolean) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x3d /* = */ || src.charCodeAt(start + 1) !== 0x3d) {
      return false;
    }
    // The closing == must be non-adjacent and inside this inline run —
    // searching past posMax would pair with a == in a later construct and
    // swallow everything in between.
    const end = src.indexOf('==', start + 2);
    if (end < 0 || end === start + 2 || end + 2 > state.posMax) {
      return false;
    }
    if (!silent) {
      const content = src.slice(start + 2, end);
      const tokenOpen = state.push('mark_open', 'mark', 1);
      tokenOpen.markup = '==';
      const tokenText = state.push('text', '', 0);
      tokenText.content = content;
      const tokenClose = state.push('mark_close', 'mark', -1);
      tokenClose.markup = '==';
    }
    state.pos = end + 2;
    return true;
  });
}

/** Open external links in a new tab in the preview. */
function addLinkTargets(md: MarkdownIt): void {
  const defaultRender =
    md.renderer.rules.link_open ||
    ((tokens: any[], idx: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens: any[], idx: number, options: any, env: any, self: any) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultRender(tokens, idx, options, env, self);
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GitHub-style task list checkboxes: - [ ] / - [x], rendered as interactive links. */
function addTaskLists(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'notebook-task-lists', (state: any) => {
    const tokens = state.tokens;
    // Track the enclosing list item with a stack in a single pass. (Scanning
    // backwards from every inline token is O(n²) on documents without lists,
    // which froze the preview on large notes.)
    const itemStack: any[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'list_item_open') {
        itemStack.push(tokens[i]);
        continue;
      }
      if (tokens[i].type === 'list_item_close') {
        itemStack.pop();
        continue;
      }
      if (tokens[i].type !== 'inline' || itemStack.length === 0) {
        continue;
      }
      const parent = itemStack[itemStack.length - 1];

      const children = tokens[i].children;
      const text: string = tokens[i].content;
      const m = text.match(/^\[([ xX])\]\s+/);

      let targetFilePath = '';
      let targetLine = parent.map ? parent.map[0] : -1;
      
      if (children) {
        for (const c of children) {
          if (c.type === 'link_open') {
            const href = c.attrGet('href');
            if (href && href.includes('.md#L')) {
              const match = href.match(/^(.*\.md)#L(\d+)$/i);
              if (match) {
                targetFilePath = match[1];
                targetLine = parseInt(match[2], 10) - 1;
              }
            }
            break;
          }
        }
      }
      
      const args = encodeURIComponent(JSON.stringify([targetFilePath, targetLine]));
      const cmdUri = `command:markdownNotebook.toggleTaskAtLine?${args}`;
      
      const createTokens = (checked: boolean) => {
        const linkOpen = new state.Token('link_open', 'a', 1);
        linkOpen.attrs = [
          ['href', cmdUri],
          ['title', 'Toggle Task'],
          ['style', 'text-decoration: none; color: inherit; cursor: pointer;']
        ];
        
        const htmlTok = new state.Token('html_inline', '', 0);
        htmlTok.content = `<input class="task-list-item-checkbox" type="checkbox"${
          checked ? ' checked' : ''
        } style="margin-right: 12px; margin-top: 0; vertical-align: middle; cursor: pointer;">`;
        
        const linkClose = new state.Token('link_close', 'a', -1);
        return [linkOpen, htmlTok, linkClose];
      };
    
    if (m) {
      const checked = m[1].toLowerCase() === 'x';
      const tokensToInsert = createTokens(checked);

      if (children && children.length) {
        children.unshift(...tokensToInsert);
        for (const c of children.slice(tokensToInsert.length)) {
          if (c.type === 'text') {
            c.content = c.content.replace(/^\[([ xX])\]\s+/, '');
            break;
          }
        }
      }
      if (parent.attrJoin) {
        parent.attrJoin('class', 'task-list-item');
      }
    } else if (children) {
      const checkboxIdx = children.findIndex((c: any) => {
        if (!c) return false;
        const typeLower = (c.type || '').toLowerCase();
        if (typeLower === 'html_inline' && c.content) {
          const content = c.content.toLowerCase();
          return content.includes('type="checkbox"') || content.includes("type='checkbox'") || (content.includes('type=checkbox') && content.includes('input'));
        }
        if (typeLower.includes('checkbox')) return true;
        if (c.tag === 'input' && c.attrs && c.attrs.some((attr: any) => attr[0] === 'type' && attr[1] === 'checkbox')) return true;
        if (typeLower === 'html_inline' && c.content && c.content.includes('checkbox') && c.content.includes('<input')) return true;
        return false;
      });

      if (checkboxIdx !== -1) {
        const checkboxToken = children[checkboxIdx];
        const checked = (checkboxToken.content && checkboxToken.content.includes('checked')) ||
                        (checkboxToken.attrs && checkboxToken.attrs.some((attr: any) => attr[0] === 'checked' || attr[1] === 'checked'));
        const tokensToInsert = createTokens(checked);
        
        children.splice(checkboxIdx, 1, ...tokensToInsert);
        
        if (parent.attrJoin) {
          parent.attrJoin('class', 'task-list-item');
        }
      }
    }
    }
  });
}
