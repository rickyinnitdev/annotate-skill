// Dev-only Babel plugin: tags every intrinsic JSX element with data-source="file:line"
// so Annotate can map a clicked element straight to its code.
// Vite:  react({ babel: { plugins: ['annotate-mcp/babel'] } })   (only in dev)
// Babel: { "env": { "development": { "plugins": ["annotate-mcp/babel"] } } }
const path = require('node:path');

module.exports = function annotateSource({ types: t }) {
  return {
    name: 'annotate-source',
    visitor: {
      JSXOpeningElement(p, state) {
        const n = p.node.name;
        if (n.type !== 'JSXIdentifier' || !/^[a-z]/.test(n.name)) return; // DOM elements only
        if (p.node.attributes.some((a) => a.type === 'JSXAttribute' && a.name.name === 'data-source')) return;
        const file = state.filename;
        const line = p.node.loc && p.node.loc.start.line;
        if (!file || !line || file.includes('node_modules')) return;
        const root = state.opts.root || state.cwd || process.cwd();
        const rel = path.relative(root, file).split(path.sep).join('/'); // forward slashes on Windows too
        p.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-source'), t.stringLiteral(`${rel}:${line}`)));
      },
    },
  };
};
