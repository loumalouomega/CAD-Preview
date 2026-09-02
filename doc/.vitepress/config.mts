import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CAD Preview',
  description: 'Interactive 3D CAD and mesh previews in VS Code',
  base: '/CAD-Preview/',
  // Links out of doc/ to repo-root files (CLAUDE.md, README.md, LICENSE) are
  // valid on disk/GitHub but outside VitePress's srcDir, so its dead-link
  // checker can't resolve them — ignore just those.
  ignoreDeadLinks: [/\.\.\/(CLAUDE|README|LICENSE)/],
  markdown: {
    // ```parametric blocks are JSON, and are the ones `src/docExamples.test.ts`
    // actually compiles on every `npm test` (the fence is the opt-in marker —
    // a plain ```json block stays illustrative). Alias it so they still get
    // JSON syntax highlighting instead of falling back to plain text.
    languageAlias: { parametric: 'json' },
  },
  themeConfig: {
    nav: [
      { text: 'Home',            link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Tutorials',       link: '/tutorials/' },
      { text: 'Architecture',    link: '/architecture' },
      { text: 'GitHub', link: 'https://github.com/loumalouomega/CAD-Preview' },
    ],
    sidebar: [
      {
        text: 'User Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'File Formats',    link: '/file-formats' },
        ],
      },
      {
        text: 'Tutorials',
        items: [
          { text: 'Overview',                     link: '/tutorials/' },
          { text: 'Your first bracket',           link: '/tutorials/bracket' },
          { text: 'Parametric bolt-circle flange', link: '/tutorials/bolt-circle-flange' },
          { text: 'A shelled enclosure',          link: '/tutorials/enclosure' },
          { text: 'Prepare a part for FEA',       link: '/tutorials/fea-prep' },
          { text: 'Model with an AI agent',       link: '/tutorials/agent-mcp' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture',            link: '/architecture' },
          { text: 'Extension Host API',      link: '/extension-host-api' },
          { text: 'Webview API',             link: '/webview-api' },
          { text: 'Host ↔ Webview Protocol', link: '/protocol' },
          { text: 'GMSH Integration',        link: '/gmsh-integration' },
          { text: 'MCP Server',              link: '/mcp-server' },
        ],
      },
      {
        text: 'Development',
        items: [
          { text: 'Development Guide', link: '/development' },
          { text: 'Contributing',      link: '/contributing' },
          { text: 'Roadmap',           link: '/roadmap' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/loumalouomega/CAD-Preview' },
    ],
    footer: {
      message: 'Released under the GPL-2.0-or-later License.',
      copyright: 'Copyright © CAD-Preview contributors',
    },
    search: { provider: 'local' },
  },
})
