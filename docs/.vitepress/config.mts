import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const githubRepo = "https://github.com/triyatna/warest-whatsapp-rest-api";
const currentYear = new Date().getFullYear();

const englishNav = [
  {
    text: "Guide",
    link: "/guide/overview",
  },
  {
    text: "Reference",
    items: [
      { text: "API Reference", link: "/reference/api" },
      { text: "Environment Variables", link: "/reference/environment" },
      { text: "NPM Scripts & CLI", link: "/reference/scripts" },
      { text: "Changelog", link: "/reference/changelog" },
    ],
  },
];

const englishSidebar = {
  "/": [
    {
      text: "Introduction",
      collapsed: false,
      items: [
        { text: "Overview", link: "/guide/overview" },
        { text: "Key Concepts & Terminology", link: "/guide/concepts" },
        { text: "Features", link: "/guide/feature" },
        { text: "Docker & Containers", link: "/guide/docker" },
      ],
    },
    {
      text: "Advanced",
      collapsed: false,
      items: [
        {
          text: "Authentication",
          link: "/guide/advanced/authentication",
        },
        { text: "Webhooks", link: "/guide/advanced/webhooks" },
        {
          text: "Scaling & Load Balancing",
          link: "/guide/advanced/scaling",
        },
        {
          text: "Security Best Practices",
          link: "/guide/advanced/security",
        },
      ],
    },
  ],
};

const indonesianNav = [
  {
    text: "Panduan",
    link: "/id/guide/overview",
  },
  {
    text: "Referensi",
    items: [
      { text: "Referensi API", link: "/reference/api" },
      { text: "Variabel Lingkungan", link: "/reference/environment" },
      { text: "NPM Scripts & CLI", link: "/reference/scripts" },
      { text: "Catatan Rilis", link: "/reference/changelog" },
    ],
  },
];

const indonesianSidebar = {
  "/id/": [
    {
      text: "Pengantar",
      collapsed: false,
      items: [
        { text: "Ikhtisar", link: "/id/guide/overview" },
        { text: "Konsep & Istilah Inti", link: "/id/guide/concepts" },
        { text: "Fitur", link: "/id/guide/feature" },
        { text: "Docker dan Kontainer", link: "/id/guide/docker" },
      ],
    },
    {
      text: "Lanjutan",
      collapsed: false,
      items: [
        {
          text: "Autentikasi",
          link: "/id/guide/advanced/authentication",
        },
        { text: "Webhook", link: "/id/guide/advanced/webhooks" },
        {
          text: "Skalabilitas dan Load Balancer",
          link: "/id/guide/advanced/scaling",
        },
        {
          text: "Keamanan",
          link: "/id/guide/advanced/security",
        },
      ],
    },
  ],
};

const buildFooter = (message: string) => ({
  message,
  copyright:
    "(c) " +
    currentYear +
    `<a href='${githubRepo}' target='_blank' style='text-decoration:none;color:#0091bd'> WAREST</a>.`,
});

const sharedThemeConfig = {
  logo: "/assets/favicon.png",
  socialLinks: [
    {
      icon: "github",
      link: githubRepo,
    },
  ],
};

export default withMermaid(
  defineConfig({
    cleanUrls: true,
    ignoreDeadLinks: true,
    head: [
      [
        "link",
        {
          rel: "icon",
          type: "image/png",
          href: "/assets/favicon.png",
        },
      ],
    ],
    locales: {
      root: {
        label: "English",
        lang: "en-US",
        title: "WAREST Docs",
        description:
          "Warehouse-grade WhatsApp REST API for automation, messaging, and integrations.",
        themeConfig: {
          nav: englishNav,
          sidebar: englishSidebar,
          footer: buildFooter("Released under the MIT License."),
        },
      },
      id: {
        label: "Bahasa Indonesia",
        lang: "id-ID",
        title: "Dokumentasi WAREST",
        description:
          "API WhatsApp REST untuk otomasi, pesan, dan integrasi berbasis multi-perangkat.",
        themeConfig: {
          nav: indonesianNav,
          sidebar: indonesianSidebar,
          footer: buildFooter("Dirilis di bawah Lisensi MIT."),
        },
      },
    },
    themeConfig: sharedThemeConfig,
  })
);
