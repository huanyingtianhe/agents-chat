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
          for (const match of part.value.matchAll(/[^\s<>"'(),;]+(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)(?=$|[\s<>"'(),;.!?])/g)) {
            if (!parseFileReference(match[0])) continue;
            const index = match.index;
            if (index > start) result.push({ type: 'text', value: part.value.slice(start, index) });
            result.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] });
            start = index + match[0].length;
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
