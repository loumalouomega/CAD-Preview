import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CAD Preview',
  description: 'Interactive 3D CAD and mesh previews in VS Code',
  base: '/CAD-Preview/',
  themeConfig: {
    nav: [
      { text: 'Home',            link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
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
        text: 'Reference',
        items: [
          { text: 'Architecture',            link: '/architecture' },
          { text: 'Extension Host API',      link: '/extension-host-api' },
          { text: 'Webview API',             link: '/webview-api' },
          { text: 'Host ↔ Webview Protocol', link: '/protocol' },
          { text: 'GMSH Integration',        link: '/gmsh-integration' },
        ],
      },
      {
        text: 'Development',
        items: [
          { text: 'Development Guide', link: '/development' },
          { text: 'Contributing',      link: '/contributing' },
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
