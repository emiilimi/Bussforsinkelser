import type { Plugin } from 'vite';

const REISE_TITLE = 'Sen Tur - reiseplanlegger og analyse';
const REISE_DESCRIPTION =
  'Reiseplanlegger for buss i Norge med historisk forsinkelsesstatistikk — se hvor lang forsinkelse du faktisk må regne med, ikke bare rutetiden.';

/**
 * Bytter <title>/og:title/og:description i client/index.html for
 * reise-bygget (VITE_APP=reise). index.html er delt mellom begge byggene,
 * og document.title settes riktignok om ved runtime i App.tsx — men det
 * skjer for sent til at sosiale lenkeforhåndsvisninger (iMessage, Slack,
 * osv.) ser det, siden de kun leser den statiske HTML-en, ikke kjører JS.
 * Full-bygget (dist/public) er uendret.
 */
export function reiseMetaPlugin(): Plugin {
  return {
    name: 'vite-plugin-reise-meta',
    transformIndexHtml(html) {
      if (process.env.VITE_APP !== 'reise') return html;

      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${REISE_TITLE}</title>`,
      );
      html = html.replace(
        /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:title" content="${REISE_TITLE}" />`,
      );
      html = html.replace(
        /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
        `<meta property="og:description" content="${REISE_DESCRIPTION}" />`,
      );

      return html;
    },
  };
}
