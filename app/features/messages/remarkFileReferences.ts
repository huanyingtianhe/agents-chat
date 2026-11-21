import type { Root, PhrasingContent, Link } from 'mdast';
import { parseFileReference } from '../files/fileReference';

export function remarkFileReferences() {
  return (tree: Root) => {
    const visit = (node: { type: string; children?: unknown[] }) => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
      node.children = node.children.flatMap(child => {
        if (!child || typeof child !== 'object' || !('type' in child)) return [child];
        const part = child as PhrasingContent;
        if (part.type === 'inlineCode' && parseFileReference(part.value, true)) {
          return [{ type: 'link', url: part.value, children: [part] } satisfies Link];
        }
        if (part.type === 'text') {
          const result: PhrasingContent[] = [];
          let start = 0;
          // Consume each token once. Searching for a suffix from every character
          // stalls on long unbroken chat messages with no file references.
          for (const match of part.value.matchAll(/[^\s<>"'(),;]+/g)) {
            const token = match[0];
            let end = token.length;
            while (end > 0 && '.!?'.includes(token[end - 1])) end--;
            const reference = token.slice(0, end);
            if (!/\d$/.test(reference) || !parseFileReference(reference)) continue;
            const index = match.index;
            if (index > start) result.push({ type: 'text', value: part.value.slice(start, index) });
            result.push({ type: 'link', url: reference, children: [{ type: 'text', value: reference }] });
            start = index + reference.length;
          }
          if (start) {
            if (start < part.value.length) result.push({ type: 'text', value: part.value.slice(start) });
            return result;
          }
        }
        visit(part);
        return [part];
      });
    };
    visit(tree);
  };
}
